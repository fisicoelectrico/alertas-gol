// =====================================================================
// Edge Function `escaner`
// La dispara pg_cron cada 5 minutos. Ella misma decide si "le toca" correr
// (horario, intervalo, presupuesto), así que llamarla de más no gasta cuota.
//
// Hay DOS relojes independientes (cada uno con su marca en futbol.config):
//
//   RADAR (ultimo_radar, intervalo = reparto del presupuesto, ~15-35 min en Free)
//     1. GET /fixtures?live=all            (1 consulta, todos los partidos en vivo)
//     2. Resolución de alertas pendientes  (0-1 consulta, en lote)
//     3. GET /odds?fixture=X&bet=1         (favorito: 1 por partido, una sola vez en la vida)
//     4. Candidatos → detalle (abajo)
//
//   SEGUIMIENTO (ultimo_seguimiento, intervalo_seguimiento_min = 5 min)
//     Solo corre si hay candidatos (o alertas pendientes) y el radar no tocaba.
//     1. GET /fixtures?id=X                (1 consulta por partido: marcador, minuto, estado, eventos
//                                           Y estadísticas; reemplaza al radar y a /statistics.
//                                           El plan Free NO permite ?ids=a-b-c en lote: se probó y
//                                           responde "Free plans do not have access to the Ids parameter")
//     2. Resolución de alertas con esa misma respuesta
//     3. Detalle (abajo) sin volver a pedir estadísticas
//
//   DETALLE de cada candidato
//     · estadísticas (vienen dentro de /fixtures?id) → IP, dominancia, momentum
//     · GET /odds/live?fixture=X           (1 por candidato, solo si la regla aún puede disparar
//                                           o si está el modo calibración)
//     · snapshot → regla → alerta + push
//
//   Costo con 1 candidato: 2 consultas cada 5 min (fixtures?id + odds/live). Con 3 candidatos: 6.
//
//   AHORRO (DECISIONES 27, 13 nov 2026)
//     · GET /leagues?current=true   1 por semana: cobertura por liga (¿trae cuotas? ¿estadísticas?).
//     · GET /fixtures?date=HOY      1 por día UTC: la agenda. El radar solo corre si algún partido de
//                                   una liga útil está entre el descanso y el minuto ~77, y reparte el
//                                   presupuesto solo entre esos minutos (antes: entre todas las horas activas).
//     · GET /odds?league&season&date&bet=1  cuotas prepartido EN BLOQUE (10 partidos por consulta) para
//                                   las ligas con 3+ partidos hoy, en vez de 1 consulta por partido.
//     · Sin consulta: ligas sin cobertura y partidos "tarde" (pasados del 77', ya no pueden tener momentum).
//   Bitácora: futbol.escaneos (motivo "ok" = radar, "seguimiento" = solo candidatos).
// =====================================================================
import { sql, leerConfig, Config } from "../_shared/db.ts";
import { ApiFootball, estadoPresupuesto, SinPresupuesto, verificarCuotaReal } from "../_shared/apifootball.ts";
import * as A from "../_shared/algoritmo.ts";
import { notificar } from "../_shared/notificar.ts";
import { avisoAlerta, avisoResultado, avisosEnVivo } from "../_shared/avisos.ts";
import * as FS from "../_shared/flashscore.ts";
import { cicloCorners, guardarCornersPartidos } from "../_shared/corners.ts";
import { fotoCornersApi } from "../_shared/cornersapi.ts";
import { cicloKambi, Kambi, casasJson, pasaPush } from "../_shared/kambi.ts";
import { cicloCuotasVivo, cuotaOverFS, salud } from "../_shared/cuotasvivo.ts";
import { cicloLab, vigilados } from "../_shared/lab.ts";
import { registrar } from "../_shared/identidad.ts";
import { cicloAgendaFS, favoritosDesdeAgenda } from "../_shared/agendafs.ts";
import { resolverConFS } from "../_shared/cierrefs.ts";

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });

function reglaDesde(cfg: Config): A.Regla {
  return {
    version: cfg.regla_version,
    minuto_min: Number(cfg.minuto_min),
    minuto_max: Number(cfg.minuto_max),
    cuota_fav_max: Number(cfg.cuota_fav_max),
    diferencia_min: Number(cfg.diferencia_min),
    dominancia_min: Number(cfg.dominancia_min),
    cuota_objetivo: Number(cfg.cuota_objetivo),
    momentum_ventana_min: Number(cfg.momentum_ventana_min),
    momentum_gap_min: Number(cfg.momentum_gap_min),
    pesos_ip: cfg.pesos_ip,
    excluir_reempate: cfg.excluir_reempate === true,
    excluir_roja_fav: cfg.excluir_roja_fav === true,
    goles_fav_max: Number.isFinite(Number(cfg.goles_fav_max)) ? Number(cfg.goles_fav_max) : 99,
    patrones_copa: Array.isArray(cfg.patrones_copa) ? cfg.patrones_copa : ["cup", "copa", "coupe", "taça", "pokal", "coppa", "trophy", "libertadores", "sudamericana", "champions league", "friendly", "amistoso"],
  };
}

// =====================================================================
// Pasos de ahorro (DECISIONES 27). Cada uno es "a prueba de fallos": si la API responde algo
// inesperado, se anota en la bitácora y el escáner sigue como antes (sin agenda / de a uno).
// Tope: entre todos gastan como máximo MAX_PREVIAS consultas por ejecución, porque el plan Free
// también limita a 10 consultas por minuto y el radar viene detrás.
// =====================================================================
const MAX_PREVIAS = 2;
const NO_JUGABLES = new Set(["PST", "CANC", "ABD", "AWD", "WO", "FT", "AET", "PEN", "SUSP"]);

/** 1 consulta por semana: qué ligas traen cuotas y estadísticas según la propia API. */
async function cargarCobertura(api: ApiFootball, cfg: Config, pre: string[]) {
  if (api.llamadas >= MAX_PREVIAS || api.quedan() < 10) return;
  // Reserva atómica: solo una ejecución la toma (marca a 7 días)
  const toma = await sql`
    update futbol.config set valor = to_jsonb(now()::text), actualizado = now()
    where clave = 'cobertura_ts' and (valor #>> '{}')::timestamptz < now() - interval '7 days'
    returning 1`;
  if (!toma.length) return;
  const r = await api.get("/leagues", { current: "true" });
  const filas = (r.response ?? []).map((x: any) => {
    const cov = x.seasons?.find((t: any) => t.current)?.coverage ?? x.seasons?.[0]?.coverage ?? {};
    return {
      id: x.league.id, nombre: x.league.name, pais: x.country?.name ?? null,
      cob_odds: typeof cov.odds === "boolean" ? cov.odds : null,
      cob_stats: typeof cov.fixtures?.statistics_fixtures === "boolean" ? cov.fixtures.statistics_fixtures : null,
    };
  });
  for (let i = 0; i < filas.length; i += 500) {
    await sql`insert into futbol.ligas ${sql(filas.slice(i, i + 500), "id", "nombre", "pais", "cob_odds", "cob_stats")}
      on conflict (id) do update set cob_odds = excluded.cob_odds, cob_stats = excluded.cob_stats, cob_actualizada = now()`;
  }
  await sql`update futbol.ligas set cob_actualizada = now() where id = any(${filas.map((f: any) => f.id)}::int[])`;
  const sinOdds = filas.filter((f: any) => f.cob_odds === false).length;
  const sinStats = filas.filter((f: any) => f.cob_stats === false).length;
  pre.push(`cobertura: ${filas.length} ligas (${sinOdds} sin cuotas, ${sinStats} sin estadísticas)`);
}

/** 1 consulta por día UTC: todos los partidos del día (sin copas), con hora de inicio. */
async function cargarAgenda(api: ApiFootball, hoy: string, regla: A.Regla, pre: string[]) {
  if (api.llamadas >= MAX_PREVIAS || api.quedan() < 10) return;
  const toma = await sql`
    update futbol.config set valor = to_jsonb(${hoy}::text), actualizado = now()
    where clave = 'agenda_fecha' and (valor #>> '{}') <> ${hoy}
    returning 1`;
  if (!toma.length) return;
  const r = await api.get("/fixtures", { date: hoy });
  const todos: any[] = r.response ?? [];
  const lista = todos.filter((f) => !A.esCopa(f.league?.name, regla.patrones_copa));
  if (lista.length) {
    const ligas = [...new Map(lista.map((f) => [f.league.id, f.league])).values()];
    await sql`insert into futbol.ligas ${sql(ligas.map((l: any) => ({ id: l.id, nombre: l.name, pais: l.country })))}
              on conflict (id) do update set nombre = excluded.nombre, pais = excluded.pais`;
    const filas = lista.map((f) => ({
      fixture_id: f.fixture.id, fecha: hoy, liga_id: f.league.id, temporada: f.league.season,
      local: f.teams.home.name, visitante: f.teams.away.name, kickoff: f.fixture.date, estado: f.fixture.status.short,
    }));
    for (let i = 0; i < filas.length; i += 500) {
      await sql`insert into futbol.agenda ${sql(filas.slice(i, i + 500))}
        on conflict (fixture_id) do update set kickoff = excluded.kickoff, estado = excluded.estado`;
    }
  }
  await sql`delete from futbol.agenda where fecha < (${hoy}::date - 3)`;
  await sql`delete from futbol.cuotas_bloque where fecha < (${hoy}::date - 3)`;
  pre.push(`agenda ${hoy}: ${todos.length} partidos, ${todos.length - lista.length} de copas fuera`);
}

/**
 * Horas de inicio de los partidos "útiles": ligas habilitadas, con cobertura de cuotas y estadísticas
 * (o sin dato), y sin favorito descartado por la cuota en bloque. `hay` = existe agenda de hoy.
 */
async function kickoffsUtiles(hoy: string, regla: A.Regla): Promise<{ hay: boolean; kickoffs: number[] }> {
  const [{ n }] = await sql`select count(*)::int as n from futbol.agenda where fecha = ${hoy}::date`;
  if (!n) return { hay: false, kickoffs: [] };
  const filas = await sql`
    select a.kickoff from futbol.agenda a
    left join futbol.ligas l on l.id = a.liga_id
    left join futbol.v_cobertura_liga c on c.liga_id = a.liga_id
    where a.kickoff > now() - make_interval(mins => ${A.ZONA_HASTA_MIN})
      and a.kickoff < (${hoy}::date + 1)::timestamptz
      and not (coalesce(a.estado, 'NS') = any(${[...NO_JUGABLES]}::text[]))
      and coalesce(l.habilitada, true) and coalesce(l.cob_odds, true) and coalesce(l.cob_stats, true)
      and not coalesce(c.sin_cuota_aprendida, false) and not coalesce(c.sin_stats_aprendida, false)
      and (a.cuota_pre_ts is null or least(a.cuota_pre_local, a.cuota_pre_visitante) <= ${regla.cuota_fav_max})`;
  return { hay: true, kickoffs: filas.map((f: any) => new Date(f.kickoff).getTime()) };
}

/**
 * Cuotas prepartido en bloque: /odds?league&season&date&bet=1 trae hasta 10 partidos por consulta.
 * Solo para ligas con N+ partidos útiles que empiezan en las próximas 3 horas (o empezaron hace
 * menos de 45 min). Con la consulta de a uno, cada partido que llega al descanso con alguien
 * ganando cuesta 1 consulta; una liga con 5 partidos costaba ~3-4. En bloque cuesta 1.
 */
async function cuotasEnBloque(api: ApiFootball, cfg: Config, hoy: string, pre: string[]) {
  const minPartidos = Number(cfg.cuotas_bloque_min_partidos ?? 3);
  const maxDia = Number(cfg.cuotas_bloque_max_dia ?? 20);
  if (api.llamadas >= MAX_PREVIAS || api.quedan() < 15) return;
  const [{ usadas }] = await sql`select coalesce(sum(paginas), 0)::int as usadas from futbol.cuotas_bloque where fecha = ${hoy}::date`;
  if (usadas >= maxDia) return;
  const ligas = await sql`
    select a.liga_id, max(a.temporada) as temporada, count(*)::int as n
    from futbol.agenda a
    left join futbol.ligas l on l.id = a.liga_id
    left join futbol.v_cobertura_liga c on c.liga_id = a.liga_id
    where a.fecha = ${hoy}::date
      and a.kickoff between now() - interval '45 minutes' and now() + interval '3 hours'
      and not (coalesce(a.estado, 'NS') = any(${[...NO_JUGABLES]}::text[]))
      and coalesce(l.habilitada, true) and coalesce(l.cob_odds, true) and coalesce(l.cob_stats, true)
      and not coalesce(c.sin_cuota_aprendida, false) and not coalesce(c.sin_stats_aprendida, false)
      and not exists (select 1 from futbol.cuotas_bloque b where b.fecha = a.fecha and b.liga_id = a.liga_id)
    group by a.liga_id
    having count(*) >= ${minPartidos}
    order by count(*) desc
    limit 1`;
  if (!ligas.length) return;
  const { liga_id, temporada, n } = ligas[0];
  // Reserva atómica de la liga: si otra ejecución ya la tomó, no se repite
  const toma = await sql`insert into futbol.cuotas_bloque (fecha, liga_id, temporada) values (${hoy}::date, ${liga_id}, ${temporada})
                         on conflict do nothing returning 1`;
  if (!toma.length) return;
  let paginas = 0, conCuota = 0, error: string | null = null;
  try {
    let pagina = 1, total = 1;
    while (pagina <= total && pagina <= 3 && api.llamadas < MAX_PREVIAS && usadas + paginas < maxDia) {
      const r = await api.get("/odds", { league: liga_id, season: temporada, date: hoy, bet: 1, page: pagina });
      paginas++;
      total = Number(r.paging?.total ?? 1);
      for (const item of r.response ?? []) {
        const c = A.parsearCuotaPre({ response: [item] });
        if (!c || !item.fixture?.id) continue;
        const upd = await sql`update futbol.agenda set cuota_pre_local = ${c.local.toFixed(2)},
                     cuota_pre_empate = ${Number.isFinite(c.empate) ? c.empate.toFixed(2) : null},
                     cuota_pre_visitante = ${c.visitante.toFixed(2)}, cuota_pre_ts = now()
                   where fixture_id = ${item.fixture.id} returning 1`;
        conCuota += upd.length;
      }
      pagina++;
    }
    // Si quedaron páginas sin traer (por el tope por ejecución), se marca como error para que los
    // partidos que faltan se pidan de a uno, como antes, en vez de darlos por "sin cuotas".
    if (pagina <= Math.min(total, 3) || total > 3) error = `paginas incompletas ${paginas}/${total}`;
  } catch (e) {
    if (e instanceof SinPresupuesto) error = "sin presupuesto";
    else error = (e as Error).message.slice(0, 300);
  }
  await sql`update futbol.cuotas_bloque set paginas = ${paginas}, partidos = ${conCuota}, error = ${error}, ts = now()
            where fecha = ${hoy}::date and liga_id = ${liga_id}`;
  pre.push(`cuotas bloque liga ${liga_id}: ${conCuota}/${n} partidos en ${paginas} consulta(s)${error ? ` (${error})` : ""}`);
}

/** Bitácora de una ejecución que solo hizo pasos previos (agenda/cobertura/bloque) sin radar. */
async function bitacoraPrevia(llamadas: number, pre: string[], t0: number) {
  await sql`insert into futbol.escaneos (motivo, llamadas, duracion_ms, detalle)
            values ('previa', ${llamadas}, ${Date.now() - t0}, ${sql.json({ eventos: pre } as any)})`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const t0 = Date.now();
  const cfg = await leerConfig();

  // ---------- Modo diagnóstico: no llama a la API ----------
  if (url.searchParams.get("diag") === "1") {
    const est = await estadoPresupuesto(cfg);
    return json({
      secretos: {
        APIFOOTBALL_KEY: !!Deno.env.get("APIFOOTBALL_KEY"),
        VAPID_PUBLIC: !!Deno.env.get("VAPID_PUBLIC"),
        VAPID_PRIVATE: !!Deno.env.get("VAPID_PRIVATE"),
      },
      presupuesto: est,
      regla: reglaDesde(cfg),
      fuente_datos: cfg.fuente_datos ?? "api",
      api_football_activa: cfg.fuente_datos !== "flashscore" || cfg.api_football_activa === true,
      ultimo_radar: cfg.ultimo_radar ?? null,
      ultimo_seguimiento: cfg.ultimo_seguimiento ?? null,
    });
  }

  // 100 % Flashscore (DECISIONES 42): con fuente_datos = flashscore y api_football_activa = false el
  // escáner no hace NINGUNA consulta a API-Football (ni agenda, ni cuotas, ni cierre). La llave queda
  // guardada como respaldo: api_football_activa = true la vuelve a usar sin redeplegar nada.
  const usarApi = cfg.fuente_datos !== "flashscore" || cfg.api_football_activa === true;
  const key = Deno.env.get("APIFOOTBALL_KEY")?.trim() ?? "";
  if (!key && usarApi) return json({ error: "falta el secreto APIFOOTBALL_KEY" }, 500);

  const bitacora = async (motivo: string, extra: Record<string, any> = {}) => {
    await sql`insert into futbol.escaneos (motivo, partidos_vivos, candidatos, llamadas, alertas, resueltas, duracion_ms, detalle, radar)
      values (${motivo}, ${extra.vivos ?? null}, ${extra.candidatos ?? null}, ${extra.llamadas ?? 0},
              ${extra.alertas ?? 0}, ${extra.resueltas ?? 0}, ${Date.now() - t0}, ${sql.json((extra.detalle ?? {}) as any)},
              ${extra.radar ? sql.json(extra.radar) : null})`;
    // La foto del radar solo se guarda 7 días (pesa ~150 bytes por partido). El conteo
    // `partidos_vivos` queda para siempre; los partidos en sí ya viven en futbol.partidos.
    await sql`update futbol.escaneos set radar = null where radar is not null and ts < now() - interval '7 days'`;
    const { radar: _r, ...resto } = extra;
    return json({ motivo, ...resto, radar_partidos: extra.radar?.length ?? 0 });
  };

  // ---------- Anuncio único (DECISIONES 78) ----------
  // config.anuncio_pendiente = { desde, titulo, cuerpo }: al pasar "desde" se envía UNA vez a todas las personas
  // activas (pasa aunque haya silencio_total) y se borra; queda copia en anuncio_enviado. El borrado va primero
  // y con returning, así dos ejecuciones del cron que se crucen no lo mandan dos veces.
  const an = cfg.anuncio_pendiente as { desde?: string; titulo?: string; cuerpo?: string } | undefined;
  if (an?.titulo && (!an.desde || new Date(an.desde).getTime() <= Date.now())) {
    const tomado = await sql`delete from futbol.config where clave = 'anuncio_pendiente' returning valor`;
    if (tomado.length) {
      let n = 0;
      try {
        n = await notificar({ titulo: an.titulo, cuerpo: an.cuerpo ?? "", url: "./#ahora", tag: "anuncio" }, { forzar: true });
      } catch (e) { console.log(`anuncio: ${(e as Error).message}`); }
      await sql`insert into futbol.config (clave, valor, descripcion)
                values ('anuncio_enviado', ${sql.json({ ...an, enviado: new Date().toISOString(), push: n } as any)}, 'Último anuncio enviado (DECISIONES 78)')
                on conflict (clave) do update set valor = excluded.valor, actualizado = now()`;
      console.log(`anuncio enviado push=${n}`);
    }
  }

  // ---------- 0. Guardas ----------
  if (cfg.escaneo_activo !== true) return json({ motivo: "escaneo_inactivo" });

  const ahora = new Date();
  // Observados (DECISIONES 32): ex candidatos que siguen en vivo. Ya no se evalúan, pero se mira su
  // marcador al ritmo rápido para saber si hubo un gol más y en qué minuto (Flashscore, sin cuota).
  const [{ cand: nCandidatos, pend: nPendientes, obs: nObservados, lab: nLab, listos: nListos }] = await sql`
    select (select count(*)::int from futbol.partidos where seguimiento) as cand,
           (select count(*)::int from futbol.lab_oportunidades where vigilando) as lab,
           (select count(distinct a.fixture_id)::int from futbol.alertas a join futbol.partidos p using (fixture_id)
             left join futbol.ligas l on l.id = p.liga_id
             where a.resultado = 'pendiente' and coalesce(l.habilitada, true)) as pend,
           (select count(*)::int from futbol.partidos p left join futbol.ligas l on l.id = p.liga_id
             where not p.seguimiento and p.estado in ('1H', 'HT', '2H') and p.kickoff > now() - interval '4 hours'
               and coalesce(l.habilitada, true)
               and ${cfg.observar_ex_candidatos !== false}
               and exists (select 1 from futbol.snapshots s where s.fixture_id = p.fixture_id)) as obs,
           -- DECISIONES 62: candidatos que ya cumplen dominancia y momentum y solo esperan la cuota (sin alerta aún)
           (select count(*)::int from futbol.partidos p
             join lateral (select s.ts, s.evaluacion from futbol.snapshots s where s.fixture_id = p.fixture_id
                           order by s.ts desc limit 1) s on true
             where p.seguimiento and s.ts > now() - interval '5 minutes'
               and s.evaluacion->>'dominancia' = 'true' and s.evaluacion->>'momentum' = 'true'
               and coalesce(s.evaluacion->>'cuota', '') <> 'true'
               and not exists (select 1 from futbol.alertas a where a.fixture_id = p.fixture_id
                               and a.regla_version = ${String(cfg.regla_version ?? "")})) as listos`;
  const horas: number[] = cfg.horas_activas_utc ?? [];
  const enHorario = horas.includes(ahora.getUTCHours());
  // Prueba manual: ignora horario e intervalo (NUNCA el presupuesto). Exige el token guardado en
  // futbol.config para que nadie pueda quemar la cuota llamando la URL pública con ?forzar=1.
  const forzar = url.searchParams.get("forzar") === "1" &&
    typeof cfg.token_forzar === "string" && req.headers.get("x-token") === cfg.token_forzar;
  if (!forzar && !enHorario && nCandidatos === 0 && nPendientes === 0 && !(cfg.fuente_datos === "flashscore" && nObservados > 0)) return json({ motivo: "fuera_de_horario" });

  let est = await estadoPresupuesto(cfg);
  if (!usarApi) est = { ...est, disponibles: 0 };   // presupuesto en cero: cualquier api.get() se frena solo
  // Poka-yoke del reinicio diario: si NUESTRA cuenta dice que hay cupo pero el último header de la
  // API dice que no, puede ser un header viejo (del día anterior). Se confirma con /status, que es
  // gratis, y se recalcula. Si la API de verdad está agotada, /status lo confirma y seguimos parados.
  const segunNosotros = Number(cfg.presupuesto_diario ?? 100) - Number(cfg.reserva_api ?? 6) - est.usadas_hoy;
  if (usarApi && est.disponibles < 1 && segunNosotros > 0) {
    await verificarCuotaReal(key);
    est = await estadoPresupuesto(cfg);
  }
  // Modo Flashscore (regla v4): la lista, el favorito y las estadísticas salen de Flashscore sin gastar
  // cuota; API-Football queda para la agenda (1/día), la cuota en vivo del Over y resolver alertas.
  // Por eso sigue corriendo aunque la cuota de API-Football esté agotada (solo no podrá pedir la cuota en vivo).
  const modoFS = cfg.fuente_datos === "flashscore";
  if (est.disponibles < 1 && !modoFS) return json({ motivo: "presupuesto_agotado", presupuesto: est });

  const api = new ApiFootball(key, est);
  const regla = reglaDesde(cfg);
  const hoy = ahora.toISOString().slice(0, 10);
  const pre: string[] = [];   // eventos de los pasos previos (agenda, cobertura, cuotas en bloque)

  // Avisos a las personas (gol al instante y recordatorios): solo base de datos, en cada ciclo del cron
  if (nPendientes > 0) {
    try { await avisosEnVivo(cfg, (s) => pre.push(s)); } catch (e) { pre.push(`avisos: ${(e as Error).message}`); }
  }

  // ---------- Agenda, cobertura y cuotas en bloque (solo en horario) ----------
  let agenda: { hay: boolean; kickoffs: number[] } = { hay: false, kickoffs: [] };
  // En 100 % Flashscore la agenda sale de Flashscore dentro del ciclo FS (cicloAgendaFS), no de aquí.
  if (cfg.usar_agenda === true && (enHorario || forzar) && usarApi) {
    try {
      if (!modoFS) await cargarCobertura(api, cfg, pre);
      await cargarAgenda(api, hoy, regla, pre);
      agenda = await kickoffsUtiles(hoy, regla);
      if (!modoFS) await cuotasEnBloque(api, cfg, hoy, pre);
      if (pre.some((e) => e.startsWith("cuotas bloque"))) agenda = await kickoffsUtiles(hoy, regla);
    } catch (e) {
      if (!(e instanceof SinPresupuesto)) pre.push(`agenda: ${(e as Error).message}`);
    }
  }
  const enZona = agenda.hay ? A.hayPartidosEnZona(agenda.kickoffs, ahora) : null;

  // Reloj del radar. Con agenda: reparte lo que queda solo entre los minutos en que algún partido
  // útil está en zona (descanso → 77'). Sin agenda: entre las horas activas que faltan (como antes).
  // Lo que gaste el seguimiento baja `disponibles`, así que el radar se espacia solo: los
  // candidatos tienen prioridad sobre buscar partidos nuevos.
  const disponiblesAhora = api.quedan();
  const intervaloRadar = forzar ? 1 : agenda.hay
    ? A.intervaloPorZona({
        intervaloBase: Number(cfg.intervalo_radar_min), disponibles: disponiblesAhora,
        fraccionRadar: Number(cfg.fraccion_radar ?? 0.5),
        minutosZona: A.minutosZonaRestantes(agenda.kickoffs, ahora, horas),
      })
    : A.intervaloEfectivo({
        intervaloBase: Number(cfg.intervalo_radar_min), disponibles: disponiblesAhora,
        fraccionRadar: Number(cfg.fraccion_radar ?? 0.5), horasActivas: horas, ahora,
      });
  // Reloj del seguimiento: cada intervalo_seguimiento_min si hay candidatos. Si solo quedan
  // alertas pendientes por resolver, basta con mirar cada intervalo_radar_min.
  const intervaloSeg = nCandidatos > 0
    ? Number(cfg.intervalo_seguimiento_min ?? 5)
    : Number(cfg.intervalo_radar_min ?? 15);

  // Reserva atómica del turno: solo una ejecución concurrente logra actualizar la marca.
  // (El -30 s de tolerancia evita que un cron que llega 2 s antes pierda el turno completo.)
  const reservar = async (clave: string, minutos: number) => {
    await sql`insert into futbol.config (clave, valor, descripcion)
              values (${clave}, to_jsonb('2000-01-01T00:00:00Z'::text), 'Marca de tiempo (la escribe el escáner)')
              on conflict do nothing`;
    const r = await sql`
      update futbol.config set valor = to_jsonb(now()::text), actualizado = now()
      where clave = ${clave}
        and (valor #>> '{}')::timestamptz <= now() - make_interval(secs => ${minutos * 60 - 30}::float8)
      returning 1`;
    return r.length > 0;
  };
  const marcar = (clave: string) =>
    sql`update futbol.config set valor = to_jsonb(now()::text), actualizado = now() where clave = ${clave}`;

  let modo: "radar" | "seguimiento" | "fs" | null = null;
  // Sin partidos útiles en zona no hay nada que el radar pueda encontrar: no se gasta.
  const radarUtil = forzar || enZona === null || enZona > 0;
  // Modo FS con dos ritmos: sin candidatos basta con mirar la lista cada intervalo_fs_min (5);
  // con candidatos el ciclo corre cada intervalo_fs_seg_min (2) para tener snapshots de
  // estadísticas más seguidos (Flashscore no gasta cuota). La cuota en vivo tiene su propio tope.
  // DECISIONES 62: si un candidato ya cumple todo menos la cuota, el ciclo corre cada intervalo_fs_listo_min (1):
  // cada minuto se mira la cuota de BetPlay/Rushbet que trajo la cola. Solo en ese estado (0 a 2 partidos),
  // no en todos los partidos. intervalo_fs_listo_min = 2 lo devuelve al ritmo normal.
  const intervaloFS = nListos > 0 ? Math.min(Number(cfg.intervalo_fs_listo_min ?? 1), Number(cfg.intervalo_fs_seg_min ?? 2))
    : nCandidatos + nObservados + nLab > 0 ? Number(cfg.intervalo_fs_seg_min ?? 2) : Number(cfg.intervalo_fs_min ?? 5);
  if (modoFS) {
    if ((enHorario || forzar || nCandidatos > 0 || nPendientes > 0 || nObservados > 0 || nLab > 0) &&
        await reservar("ultimo_fs", forzar ? 0.5 : intervaloFS)) modo = "fs";
  } else if ((enHorario || forzar) && radarUtil && await reservar("ultimo_radar", intervaloRadar)) modo = "radar";
  else if ((nCandidatos > 0 || nPendientes > 0) && await reservar("ultimo_seguimiento", intervaloSeg)) modo = "seguimiento";
  if (!modo) {
    if (api.llamadas > 0) await bitacoraPrevia(api.llamadas, pre, t0);
    return json({ motivo: radarUtil ? "intervalo" : "sin_partidos_en_zona", radar_min: intervaloRadar, seguimiento_min: intervaloSeg, en_zona: enZona, pre });
  }
  // El radar también hace el detalle de los candidatos: reinicia el reloj del seguimiento
  if (modo === "radar") await marcar("ultimo_seguimiento");

  const detalle: Record<string, unknown> = {
    modo, intervalo_min: modo === "radar" ? intervaloRadar : modo === "fs" ? intervaloFS : intervaloSeg,
    regla: regla.version, eventos: [...pre] as string[],
    en_zona: enZona,
  };
  const log = (s: string) => (detalle.eventos as string[]).push(s);
  let alertasNuevas = 0, resueltas = 0, candidatosN = 0, vivos = 0;
  const maxDetalle = Number(cfg.max_detalle_escaneo ?? 3);
  // Datos para la foto del radar (se llenan a medida que avanza el escaneo)
  let lista: any[] = [];
  const info = new Map<number, any>();
  const favs = new Map<number, any>();
  const yaAlertados = new Set<number>();
  // Cuotas de BetPlay y Rushbet (DECISIONES 54): se arma en el ciclo Flashscore antes de córners y candidatos
  let kambi: Kambi | null = null;
  const resultadoDetalle = new Map<number, A.MotivoRadar>();
  const evaluaciones = new Map<number, Record<string, unknown>>();

  // Una fila compacta por partido en vivo: qué es y en qué filtro se quedó. Cero consultas extra.
  const fotoRadar = () => {
    try {
      return lista.map((f) => {
        const id = f.fixture.id;
        const i = info.get(id), p = favs.get(id);
        const favorito = p?.favorito ?? null;
        const cuotaFav = favorito === "home" ? Number(p.cuota_pre_local) : favorito === "away" ? Number(p.cuota_pre_visitante) : null;
        const motivo = A.motivoRadar({
          copa: A.esCopa(f.league.name, regla.patrones_copa),
          estado: f.fixture.status.short, minuto: f.fixture.status.elapsed ?? 0,
          gl: f.goals.home ?? 0, gv: f.goals.away ?? 0,
          habilitada: i?.habilitada ?? true, consultada: !!(p?.cuota_pre_consultada ?? i?.cuota_pre_consultada),
          favorito, cuotaFav: Number.isFinite(cuotaFav) ? cuotaFav : null,
          yaAlertado: yaAlertados.has(id), reempate: !!i?.reempate, detalle: (resultadoDetalle.get(id) ?? null) as any,
          sinCobertura: !!(i?.liga_sin_cuota || i?.liga_sin_stats),
        }, regla);
        return {
          id, lg: f.league.id, liga: f.league.name, pais: f.league.country,
          l: f.teams.home.name, v: f.teams.away.name, e: f.fixture.status.short, m: f.fixture.status.elapsed ?? null,
          gl: f.goals.home ?? 0, gv: f.goals.away ?? 0, fav: favorito,
          cf: Number.isFinite(cuotaFav) ? cuotaFav : null, mo: motivo,
          ...(evaluaciones.has(id) ? { ev: evaluaciones.get(id) } : {}),
          // kb: ¿BetPlay/Rushbet tienen el partido en su lista en vivo? (DECISIONES 64). Solo si se leyó la lista.
          // DECISIONES 66: "revisar" si solo uno de los dos equipos encaja con un evento de Kambi (kbn = cómo lo llama)
          ...(kambi?.ok && f.__fs?.id ? (kambi.pareja.has(f.__fs.id) ? { kb: true }
            : kambi.dudosos.has(f.__fs.id) ? { kb: "revisar", kbn: kambi.dudosos.get(f.__fs.id), kbd: kambi.dudososDet.get(f.__fs.id) } : { kb: false }) : {}),
        };
      });
    } catch (e) {
      (detalle.eventos as string[]).push(`foto radar: ${(e as Error).message}`);
      return null;
    }
  };

  // Guarda marcador, minuto y estado de una lista de fixtures (venga del radar o de /fixtures?id)
  const guardarPartidos = async (fixtures: any[]) => {
    if (!fixtures.length) return;
    const ligas = [...new Map(fixtures.map((f) => [f.league.id, f.league])).values()];
    await sql`insert into futbol.ligas ${sql(ligas.map((l: any) => ({ id: l.id, nombre: l.name, pais: l.country })))}
              on conflict (id) do update set nombre = excluded.nombre, pais = excluded.pais`;
    const filas = fixtures.map((f) => ({
      fixture_id: f.fixture.id, liga_id: f.league.id, temporada: f.league.season,
      local: f.teams.home.name, visitante: f.teams.away.name, kickoff: f.fixture.date,
      estado: f.fixture.status.short, minuto: f.fixture.status.elapsed ?? null,
      goles_local: f.goals.home ?? 0, goles_visitante: f.goals.away ?? 0,
    }));
    await sql`insert into futbol.partidos ${sql(filas)}
      on conflict (fixture_id) do update set
        estado = excluded.estado, minuto = excluded.minuto,
        goles_local = excluded.goles_local, goles_visitante = excluded.goles_visitante,
        actualizado = now()`;
  };

  // Trae fixtures completos (con estadísticas y eventos) de a uno: /fixtures?id=X.
  // Una consulta por partido. En Pro se podría usar ?ids=a-b-c (hasta 20 en una consulta).
  const fixturesPorId = async (ids: number[]) => {
    const m = new Map<number, any>();
    for (const id of ids) {
      if (api.quedan() < 1) { log(`sin presupuesto para /fixtures?id=${id}`); break; }
      const r = await api.get("/fixtures", { id });
      const f = r.response?.[0];
      if (f) m.set(f.fixture.id, f);
    }
    return m;
  };

  // Resuelve las alertas pendientes cuyos partidos aparecen en `porId` ya terminados
  const resolverPendientes = async (porId: Map<number, any>, permitirLote: boolean) => {
    const pendientes = await sql`
      select a.id, a.fixture_id, a.minuto, a.goles_al_alertar, a.cuota, a.gol_avisado, p.favorito
      from futbol.alertas a join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
      where a.resultado = 'pendiente' and coalesce(l.habilitada, true)`;  // ligas excluidas: sin gastar consultas (DECISIONES 33)
    const faltan: number[] = [];
    const fixturesFinales = new Map<number, any>();
    for (const a of pendientes) {
      const f = porId.get(a.fixture_id);
      if (f && A.puedeResolverse(f.fixture.status.short)) fixturesFinales.set(a.fixture_id, f);
      else if (!f) faltan.push(a.fixture_id);
    }
    // Partidos que salieron del radar: se consultan de a uno (máx. 3 por escaneo)
    if (permitirLote && faltan.length) {
      for (const [id, f] of await fixturesPorId([...new Set(faltan)].slice(0, 3))) fixturesFinales.set(id, f);
    }
    for (const a of pendientes) {
      const f = fixturesFinales.get(a.fixture_id);
      if (!f) continue;
      const accion = A.puedeResolverse(f.fixture.status.short);
      if (accion === "anular") {
        await sql`update futbol.alertas set resultado = 'anulada', cerrada_ts = now() where id = ${a.id}`;
        resueltas++; continue;
      }
      if (accion !== "resolver") continue;
      const r = A.resolverAlerta(f, { minuto: a.minuto, goles_al_alertar: a.goles_al_alertar, favorito: a.favorito });
      await sql`update futbol.alertas set resultado = ${r.resultado}, minuto_gol = ${r.minuto_gol},
                  lado_gol = ${r.lado_gol}, cerrada_ts = now() where id = ${a.id}`;
      await sql`update futbol.partidos set goles_local_90 = ${r.gl90}, goles_visitante_90 = ${r.gv90},
                  estado = ${f.fixture.status.short}, goles_local = ${f.goals.home}, goles_visitante = ${f.goals.away},
                  seguimiento = false, cierre_fuente = 'api', cerrado_ts = now(), actualizado = now() where fixture_id = ${a.fixture_id}`;
      resueltas++;
      log(`resuelta alerta ${a.id}: ${r.resultado}`);
      // "¡Gooooool de X al 88'!" (si no se avisó ya en vivo) o "No hubo gol", con el texto de cada persona
      await avisoResultado(a as any, r, f.teams.home.name, f.teams.away.name, a.favorito);
    }
  };

  // Carga liga habilitada, favorito, cuotas prepartido y contador sin_stats de una lista de ids
  const cargarInfo = async (ids: number[]) => {
    if (!ids.length) return;
    for (const f of await sql`
      select p.fixture_id, p.favorito, p.cuota_pre_local, p.cuota_pre_visitante, p.cuota_pre_consultada,
             p.sin_stats, p.cuota_vivo_probada, coalesce(l.habilitada, true) as habilitada,
             (l.cob_odds = false or coalesce(c.sin_cuota_aprendida, false)) as liga_sin_cuota,
             (l.cob_stats = false or coalesce(c.sin_stats_aprendida, false)) as liga_sin_stats,
             exists (select 1 from futbol.snapshots s where s.fixture_id = p.fixture_id and s.stats_local is not null) as con_snap
      from futbol.partidos p left join futbol.ligas l on l.id = p.liga_id
      left join futbol.v_cobertura_liga c on c.liga_id = p.liga_id
      where p.fixture_id = any(${ids}::int[])`) { info.set(f.fixture_id, f); favs.set(f.fixture_id, f); }
    // Regla v6 (DECISIONES 34): historial de goles para saber si el favorito ya empató y le volvieron a marcar.
    // Sale de futbol.cambios_marcador (lo llena un trigger con cada ciclo), no gasta consultas.
    if (regla.excluir_reempate) {
      const porId = new Map<number, any[]>();
      for (const c of await sql`select fixture_id, gl_antes, gv_antes, gl, gv from futbol.cambios_marcador
                                where fixture_id = any(${ids}::int[]) order by ts`) {
        (porId.get(c.fixture_id) ?? porId.set(c.fixture_id, []).get(c.fixture_id)!).push(c);
      }
      for (const id of ids) {
        const i = info.get(id);
        if (i) i.reempate = A.reempateRoto(porId.get(id) ?? [], i.favorito);
      }
    }
  };

  // ¿Este fixture es candidato ahora mismo? (sin consultas: radar/fixture + cuota prepartido en caché)
  const esCandidato = (f: any) => {
    if (A.esCopa(f.league?.name, regla.patrones_copa)) return false;
    const p = favs.get(f.fixture.id);
    const i = info.get(f.fixture.id);
    if (!p?.favorito || !i?.habilitada) return false;
    const cuotaFav = p.favorito === "home" ? Number(p.cuota_pre_local) : Number(p.cuota_pre_visitante);
    if (!(cuotaFav <= regla.cuota_fav_max)) return false;
    if (yaAlertados.has(f.fixture.id)) return false; // ya alertado con esta versión: solo se espera la resolución
    return A.filtroCandidato({
      estado: f.fixture.status.short, minuto: f.fixture.status.elapsed ?? 0,
      goles_local: f.goals.home ?? 0, goles_visitante: f.goals.away ?? 0, favorito: p.favorito, reempate: !!i?.reempate,
    }, regla).ok;
  };
  // Poka-yoke de presupuesto: si la API ya respondió 2 veces seguidas sin estadísticas para este
  // partido, deja de gastar en él. Sin estadísticas no hay dominancia y la regla nunca dispararía.
  const sinCobertura = (id: number) => Number(info.get(id)?.sin_stats ?? 0) >= 2 || info.get(id)?.liga_sin_stats === true;
  // "Tarde": todavía sin snapshot con estadísticas y ya pasó el 77'. El momentum exige un snapshot
  // 8+ minutos anterior, así que este partido ya no puede alertar antes del 85'. No se gasta en él.
  const tarde = (f: any) => !info.get(f.fixture.id)?.con_snap && (f.fixture.status.elapsed ?? 0) > A.limiteTarde(regla);

  // ¿El favorito va perdiendo y todavía no es candidato? (1T, descanso o 2T antes de minuto_min)
  const enHistorial = (f: any) => {
    const st = f.fixture.status, minuto = st.elapsed ?? 0;
    if (!(st.short === "1H" || st.short === "HT" || (st.short === "2H" && minuto < regla.minuto_min))) return false;
    if (A.esCopa(f.league?.name, regla.patrones_copa)) return false;
    const p = favs.get(f.fixture.id);
    if (!p?.favorito || info.get(f.fixture.id)?.habilitada === false) return false;
    const cuotaFav = p.favorito === "home" ? Number(p.cuota_pre_local) : Number(p.cuota_pre_visitante);
    if (!(cuotaFav <= regla.cuota_fav_max)) return false;
    const gl = f.goals.home ?? 0, gv = f.goals.away ?? 0;
    return (p.favorito === "home" ? gv - gl : gl - gv) >= regla.diferencia_min;
  };

  const fotosHistorial = async (vivos: any[]) => {
    const lista = vivos.filter((f) => f.__fs?.id && enHistorial(f));
    if (!lista.length) return;
    const ids = lista.map((f) => f.fixture.id);
    const ult = new Map<number, any>();
    for (const r of await sql`select distinct on (fixture_id) fixture_id, ts, estado from futbol.historial_stats
                              where fixture_id = any(${ids}::int[]) order by fixture_id, ts desc`) ult.set(r.fixture_id, r);
    const intervalo = Number(cfg.historial_intervalo_min ?? 4) * 60000 - 30000;
    let cupo = Number(cfg.historial_max_ciclo ?? 6), n = 0;
    for (const f of lista) {
      const u = ult.get(f.fixture.id);
      const st = f.fixture.status.short;
      if (u && st === "HT" && u.estado === "HT") continue;               // al descanso basta una foto
      if (u && st !== "HT" && Date.now() - new Date(u.ts).getTime() < intervalo) continue;
      if (cupo-- <= 0) break;
      try {
        const e = await FS.estadisticas(f.__fs.id);
        if (!e.local.length) continue;
        const sL = A.normalizarStats(e.local), sV = A.normalizarStats(e.visitante);
        const usarXg = sL.xg !== null && sV.xg !== null;
        await sql`insert into futbol.historial_stats (fixture_id, estado, minuto, goles_local, goles_visitante,
                    stats_local, stats_visitante, ip_local, ip_visitante)
                  values (${f.fixture.id}, ${st}, ${f.fixture.status.elapsed ?? 0}, ${f.goals.home ?? 0}, ${f.goals.away ?? 0},
                    ${sql.json(sL as any)}, ${sql.json(sV as any)},
                    ${A.indicePresion(sL, regla.pesos_ip, usarXg).toFixed(2)}, ${A.indicePresion(sV, regla.pesos_ip, usarXg).toFixed(2)})`;
        n++;
      } catch (e) { log(`historial fs ${f.__fs.id}: ${(e as Error).message}`); }
    }
    if (n) log(`historial: ${n} fotos (${lista.length} favoritos perdiendo antes de ser candidatos)`);
  };

  /**
   * Detalle de los candidatos. `conStats` trae los fixtures de /fixtures?id (con estadísticas
   * adentro). Si no viene, se piden aquí (1 consulta por candidato).
   */
  const detallarCandidatos = async (candidatos: any[], conStats: Map<number, any> | null) => {
    const lote = candidatos.slice(0, maxDetalle);
    if (!lote.length) return;
    if (!conStats) conStats = await fixturesPorId(lote.map((f) => f.fixture.id));
    for (const f0 of lote) {
      const id = f0.fixture.id;
      const f = conStats.get(id) ?? f0;
      const p = favs.get(id);
      const fav: "home" | "away" = p.favorito;
      const gl = f.goals.home ?? 0, gv = f.goals.away ?? 0;
      const minuto = f.fixture.status.elapsed ?? 0;
      const linea = gl + gv + 0.5;

      // Estadísticas: vienen dentro del fixture. Si la clave ni siquiera existe (respuesta distinta
      // a la esperada), se cae al endpoint dedicado para no quedarnos ciegos.
      let equipos: any[] = Array.isArray(f.statistics) ? f.statistics : [];
      let fuenteStats = f.__fuente ?? "fixtures?id";
      if (!Array.isArray(f.statistics) && id > 0 && api.quedan() > 0) {
        equipos = (await api.get("/fixtures/statistics", { fixture: id })).response ?? [];
        fuenteStats = "fixtures/statistics";
      }

      if (equipos.length < 2) {
        const n = Number(p.sin_stats ?? 0) + 1;
        // Al segundo intento vacío sale del seguimiento: no se gasta otra consulta en él
        await sql`update futbol.partidos set sin_stats = ${n}, seguimiento = ${n < 2} where fixture_id = ${id}`;
        p.sin_stats = n;
        resultadoDetalle.set(id, "sin_estadisticas");
        log(`sin estadísticas ${id} (${n}/2)`);
        // Modo calibración: una sola vez por partido se pide la cuota en vivo igual, para saber
        // si la liga la tiene. Queda en snapshots.raw (sin estadísticas no hay IP ni dominancia).
        if (cfg.cuotas_siempre === true && !p.cuota_vivo_probada && id > 0 && api.quedan() > 0) {
          const rOdds = await api.get("/odds/live", { fixture: id });
          const co = A.parsearCuotaOver(rOdds, linea);
          await sql`update futbol.partidos set cuota_vivo_probada = true where fixture_id = ${id}`;
          p.cuota_vivo_probada = true;
          await sql`
            insert into futbol.snapshots (fixture_id, minuto, goles_local, goles_visitante, linea_over, cuota_over,
              regla_version, evaluacion, raw)
            values (${id}, ${minuto}, ${gl}, ${gv}, ${linea}, ${co.cuota}, ${regla.version},
              ${sql.json({ sin_estadisticas: true, mercado: co.mercado, lineas: co.lineas } as any)},
              ${sql.json({ statistics: equipos, odds: rOdds?.response ?? null, fixture: f } as any)})`;
          log(`cuota en vivo ${id} sin stats: ${co.cuota ?? "sin mercado"} (${(rOdds?.response ?? []).length ? "hay odds" : "odds vacío"})`);
        }
        continue;
      }
      if (Number(p.sin_stats ?? 0) > 0) await sql`update futbol.partidos set sin_stats = 0 where fixture_id = ${id}`;

      const eLocal = equipos.find((e) => e.team?.id === f.teams.home.id) ?? equipos[0];
      const eVisit = equipos.find((e) => e.team?.id === f.teams.away.id) ?? equipos[1];
      const sL = A.normalizarStats(eLocal?.statistics);
      const sV = A.normalizarStats(eVisit?.statistics);
      const usarXg = sL.xg !== null && sV.xg !== null;
      const ipL = A.indicePresion(sL, regla.pesos_ip, usarXg);
      const ipV = A.indicePresion(sV, regla.pesos_ip, usarXg);
      const [pFav, pRiv] = fav === "home" ? [ipL, ipV] : [ipV, ipL];
      const dominancia = A.razon(pFav, pRiv);

      // Momentum: delta contra el snapshot más cercano a (minuto − ventana), con separación ≥ gap
      // DECISIONES 44: también vale una foto de historial (tomada desde el gol, antes de ser candidato).
      // Una foto del 1T (minuto ≤ 45) cuenta como anterior a cualquier minuto del 2T.
      const [prev] = await sql`
        select minuto, stats_local, stats_visitante, fuente from (
          select minuto, stats_local, stats_visitante, 'snapshot' as fuente from futbol.snapshots
          where fixture_id = ${id} and stats_local is not null
          union all
          select minuto, stats_local, stats_visitante, 'historial' from futbol.historial_stats
          where fixture_id = ${id} and ${cfg.historial_desde_gol !== false}::boolean
        ) x
        where minuto <= ${minuto - regla.momentum_gap_min}::int
        order by abs(minuto - ${minuto - regla.momentum_ventana_min}::int), (fuente = 'snapshot') desc limit 1`;
      let momentum: number | null = null;
      if (prev) {
        const dL = A.deltaStats(sL, prev.stats_local), dV = A.deltaStats(sV, prev.stats_visitante);
        const xgD = dL.xg !== null && dV.xg !== null;
        const mL = A.indicePresion(dL, regla.pesos_ip, xgD), mV = A.indicePresion(dV, regla.pesos_ip, xgD);
        momentum = fav === "home" ? A.razon(mL, mV) : A.razon(mV, mL);
      }

      // Cuota en vivo: solo se gasta la consulta si la alerta todavía puede dispararse
      let cuotaOver: A.CuotaOver = { linea, cuota: null, suspendida: false, mercado: null, lineas: {} };
      let rOdds: any = null;
      const vale = dominancia >= regla.dominancia_min && momentum !== null && momentum >= regla.dominancia_min;
      // Tope de la cuota en vivo: como mucho una consulta cada intervalo_cuota_min (3) por partido,
      // aunque los snapshots de estadísticas sean más seguidos. Sin cuota fresca ese ciclo no alerta.
      const [cuotaReciente] = await sql`select 1 from futbol.snapshots where fixture_id = ${id} and cuota_over is not null
        and ts > now() - make_interval(secs => ${Number(cfg.intervalo_cuota_min ?? 3) * 60 - 30}::float8) limit 1`;
      if (cuotaReciente) log(`cuota ${id}: tope, la última tiene menos de ${cfg.intervalo_cuota_min ?? 3} min`);
      // Regla v8 (DECISIONES 40): primero la cuota en vivo de Flashscore (gratis, promedio de las casas
      // colombianas); API-Football solo si Flashscore no tiene esa línea.
      let casasVivo: Record<string, number> | null = null;
      // La de Flashscore se lee también con solo la dominancia (Glasgow City, 18 nov): no gasta consultas
      // (cicloCuotasVivo ya tomó la foto del candidato este ciclo) y así la tarjeta muestra qué líneas hay
      // aunque el momentum todavía no exista. No cambia la regla: sin momentum evaluar() no dispara.
      const verCuotaFS = vale || dominancia >= regla.dominancia_min || cfg.cuotas_siempre === true;
      // DECISIONES 62 (Dinamo Tbilisi 0-1 Torpedo Kutaisi, 20 nov): la cuota que DECIDE es la de BetPlay/Rushbet
      // (Kambi), la mejor de las dos, que es la que Fredy puede tomar. Antes se evaluaba con Flashscore
      // (Wplay/Betano/Stake): si ninguna de esas tenía la línea, la tarjeta decía "sin cuota" y la alerta nunca
      // disparaba aunque BetPlay pagara 1,30-1,33. Flashscore queda solo de respaldo (Kambi sin lectura o caído;
      // en ese caso la push igual la frena pasaPush) y sus casas se guardan aparte como referencia.
      let casasKambi: Record<string, number> | null = null, estadoKambi: string | null = null;
      if (kambi && f0.__fs?.id && cfg.cuota_decide_kambi !== false) {
        try {
          const o = await kambi.oferta(f0.__fs.id, "goles", linea, { goles: gl + gv });
          estadoKambi = o.estado;
          if (o.estado === "ofrece") {
            casasKambi = casasJson(o);
            const lineasK: Record<string, number> = {};
            if (o.cercana) lineasK[String(o.cercana.linea)] = o.cercana.casas[0].c;
            cuotaOver = { linea, cuota: Math.max(...o.casas.map((x) => x.c)), suspendida: false, mercado: "kambi", lineas: lineasK };
          } else if (o.estado === "sin_linea" && o.cercana) {
            cuotaOver = { ...cuotaOver, mercado: "kambi", lineas: { [String(o.cercana.linea)]: o.cercana.casas[0].c } };
          }
        } catch (e) { log(`kambi cuota ${id}: ${(e as Error).message}`); }
      }
      if (cuotaOver.cuota === null && verCuotaFS && cfg.cuota_vivo_fuente === "flashscore" && f0.__fs?.id) {
        try {
          const c = await cuotaOverFS(f0, linea, cfg, log);
          casasVivo = c.casas;
          if (c.cuota !== null || c.suspendida) cuotaOver = { linea, cuota: c.cuota, suspendida: c.suspendida, mercado: c.mercado, lineas: c.lineas };
        } catch (e) { log(`cuota fs ${id}: ${(e as Error).message}`); }
      }
      if ((vale || cfg.cuotas_siempre === true) && cuotaOver.cuota === null && !cuotaOver.suspendida && !cuotaReciente && id > 0 && api.quedan() > 0) {
        rOdds = await api.get("/odds/live", { fixture: id });
        cuotaOver = A.parsearCuotaOver(rOdds, linea);
        if (!p.cuota_vivo_probada) {
          await sql`update futbol.partidos set cuota_vivo_probada = true where fixture_id = ${id}`;
          p.cuota_vivo_probada = true;
        }
      }

      const ev = A.evaluar({
        ctx: { estado: f.fixture.status.short, minuto, goles_local: gl, goles_visitante: gv, favorito: fav, reempate: !!info.get(id)?.reempate,
               rojas_fav: Number((fav === "home" ? sL : sV).rojas) || 0 },
        regla, dominancia, momentum, cuotaOver,
      });
      const [snap] = await sql`
        insert into futbol.snapshots (fixture_id, minuto, goles_local, goles_visitante, stats_local, stats_visitante,
          ip_local, ip_visitante, dominancia, momentum, linea_over, cuota_over, regla_version, evaluacion, raw)
        values (${id}, ${minuto}, ${gl}, ${gv}, ${sql.json(sL as any)}, ${sql.json(sV as any)},
          ${ipL.toFixed(2)}, ${ipV.toFixed(2)}, ${dominancia.toFixed(3)}, ${momentum?.toFixed(3) ?? null},
          ${linea}, ${cuotaOver.cuota}, ${regla.version},
          ${sql.json({ ...ev.condiciones, mercado: cuotaOver.mercado, lineas: cuotaOver.lineas, casas: casasKambi ?? casasVivo, casas_fs: casasVivo, kambi: estadoKambi, usar_xg: usarXg, fuente_stats: fuenteStats,
                       momentum_base: prev ? { minuto: prev.minuto, fuente: prev.fuente } : null } as any)},
          ${sql.json({ statistics: equipos, odds: rOdds?.response ?? null, fixture: { ...f, statistics: undefined, players: undefined, lineups: undefined } } as any)})
        returning id`;
      // Para la pestaña Radar: si se pidió la cuota en vivo y no vino el mercado, es un hueco de cobertura
      resultadoDetalle.set(id, rOdds && !(rOdds.response ?? []).length ? "sin_cuota_vivo" : "evaluado");
      evaluaciones.set(id, { ...ev.condiciones, d: Number(dominancia.toFixed(2)), mo: momentum === null ? null : Number(momentum.toFixed(2)), c: cuotaOver.cuota });
      log(`snap ${id} ${minuto}' D=${dominancia.toFixed(2)} M=${momentum?.toFixed(2) ?? "-"} cuota=${cuotaOver.cuota ?? "-"}`);

      // Aviso de candidato nuevo (DECISIONES 32): el primer snapshot con estadísticas = entra como
      // candidato (la misma definición de v_candidatos). Push "suave" (una vibración corta, distinta
      // de la doble de la alerta) para poder mirar el partido. Se apaga con push_candidatos = false.
      if (!info.get(id)?.con_snap && cfg.push_candidatos !== false && !ev.disparar) {
        if (info.get(id)) info.get(id).con_snap = true;
        const favNombre = fav === "home" ? f.teams.home.name : f.teams.away.name;
        const enviados = await notificar({
          titulo: `👀 Candidato: ${favNombre} pierde ${gl}-${gv} (${minuto}')`,
          cuerpo: `${f.teams.home.name} vs ${f.teams.away.name} · ${f.league.name} · D ${dominancia.toFixed(2)} · aún sin alerta`,
          url: "./#candidatos", tag: `cand-${id}`, suave: true,
        }, { soloAdmin: true });   // aviso técnico: solo administradores
        log(`aviso candidato ${id} push=${enviados}`);
      }

      if (ev.disparar) {
        const nueva = await sql`
          insert into futbol.alertas (fixture_id, snapshot_id, minuto, marcador, goles_al_alertar, linea_over, cuota,
                                      dominancia, momentum, regla_version)
          values (${id}, ${snap.id}, ${minuto}, ${`${gl}-${gv}`}, ${gl + gv}, ${linea}, ${cuotaOver.cuota},
                  ${dominancia.toFixed(3)}, ${momentum!.toFixed(3)}, ${regla.version})
          on conflict (fixture_id, regla_version) do nothing
          returning id`;
        if (nueva.length) {
          alertasNuevas++;
          const favNombre = fav === "home" ? f.teams.home.name : f.teams.away.name;
          // Texto para gente común (spec 1.6), con botones Entré / No entro
          // DECISIONES 54/57 (Fredy, 20 nov): solo hay push si BetPlay o Rushbet ofrecen esa línea y pagan la
          // cuota objetivo de la regla; la alerta
          // igual queda guardada con lo que ofrecían y el motivo. La regla de disparo no cambia.
          let gate = { sale: true, motivo: null as string | null }, casasK: Record<string, number> | null = null;
          if (kambi && f0.__fs?.id) {
            try {
              const o = await kambi.oferta(f0.__fs.id, "goles", linea, { goles: gl + gv });
              gate = pasaPush(cfg, o, true, Number(regla.cuota_objetivo)); casasK = casasJson(o);
            } catch (e) { log(`kambi alerta ${id}: ${(e as Error).message}`); }
          }
          // DECISIONES 75 (Fredy, 21 nov): la push principal se puede apagar sin dejar de registrar la alerta
          if (cfg.alerta_push === false) gate = { sale: false, motivo: "push_apagada" };
          await sql`update futbol.alertas set cuota_casas = ${casasK ? sql.json(casasK) : null}, motivo_sin_push = ${gate.motivo}
                    where id = ${nueva[0].id}`;
          const enviados = gate.sale ? await avisoAlerta(Number(nueva[0].id)) : 0;
          await sql`update futbol.alertas set push_enviados = ${enviados} where id = ${nueva[0].id}`;
          log(`ALERTA ${nueva[0].id} ${favNombre} push=${enviados}${gate.sale ? "" : ` (sin push: ${gate.motivo})`}`);
        }
      }
    }
  };

  const actualizarSeguimiento = async (idsCand: number[], alcance: number[]) => {
    // Solo toca partidos del alcance (los vistos en esta consulta) para no apagar otros por error
    await sql`update futbol.partidos set seguimiento = (fixture_id = any(${idsCand}::int[]))
              where fixture_id = any(${alcance}::int[]) and (seguimiento or fixture_id = any(${idsCand}::int[]))`;
  };

  try {
    for (const r of await sql`select fixture_id from futbol.alertas where regla_version = ${regla.version}`) {
      yaAlertados.add(r.fixture_id);
    }


    if (modo === "fs") {
      // ================= CICLO FLASHSCORE (regla v4) =================
      // 1. Lista del día (gratis). Copas fuera por nombre, igual que en v3.
      // Si Flashscore no responde, cuenta para el aviso al administrador (DECISIONES 40) y el ciclo cae como antes.
      let listaCruda: FS.PartidoFS[];
      try { listaCruda = await FS.listaDia(0); }
      catch (e) {
        await salud(cfg, "lista", false, (e as Error).message, log).catch(() => {});
        throw e;
      }
      await salud(cfg, "lista", true, "", log).catch((e) => log(`fs salud: ${(e as Error).message}`));
      const listaFS = listaCruda.filter((p) => !A.esCopa(p.liga, regla.patrones_copa));
      const vivosFS = listaFS.filter((p) => p.estado === 2 || p.estado === 3);
      vivos = listaFS.filter((p) => p.estado === 2).length;

      // 2. Emparejar con API-Football usando la agenda (cada partido una sola vez; queda en fs_partidos)
      const conocidos = new Map<string, any>();
      if (vivosFS.length) {
        for (const r of await sql`select * from futbol.fs_partidos where fs_id = any(${vivosFS.map((p) => p.id)}::text[])`) conocidos.set(r.fs_id, r);
      }
      const nuevos = vivosFS.filter((p) => p.estado === 2 && !conocidos.get(p.id)?.fixture_id);
      if (nuevos.length && usarApi) {
        const desde = new Date(Math.min(...nuevos.map((p) => p.inicio)) - 20 * 60000).toISOString();
        const hasta = new Date(Math.max(...nuevos.map((p) => p.inicio)) + 20 * 60000).toISOString();
        // Un fixture que ya quedó emparejado con otro partido de Flashscore no se vuelve a ofrecer:
        // dos fs_id con el mismo fixture_id rompían el guardado de todo el ciclo (15 nov 2026).
        const ag = (await sql`select a.fixture_id, a.local, a.visitante, a.kickoff from futbol.agenda a
                              where a.kickoff between ${desde} and ${hasta}
                                and not exists (select 1 from futbol.fs_partidos f where f.fixture_id = a.fixture_id)`)
          .map((r: any) => ({ fixture_id: r.fixture_id, local: r.local, visitante: r.visitante, kickoff: new Date(r.kickoff).getTime() }));
        const mapa = FS.emparejar(nuevos, ag);
        for (const p of nuevos) {
          const m = mapa.get(p.id);
          const [fila] = await sql`
            insert into futbol.fs_partidos (fs_id, fixture_id, puntaje, liga, local, visitante, inicio, id_local, id_visitante)
            values (${p.id}, ${m?.fixture_id ?? null}, ${m?.puntaje ?? null}, ${p.liga}, ${p.local}, ${p.visitante},
                    ${new Date(p.inicio).toISOString()}, ${p.idLocal}, ${p.idVisitante})
            on conflict (fs_id) do update set fixture_id = coalesce(futbol.fs_partidos.fixture_id, excluded.fixture_id),
              puntaje = coalesce(futbol.fs_partidos.puntaje, excluded.puntaje)
            returning *`;
          conocidos.set(p.id, fila);
        }
        log(`fs: ${mapa.size}/${nuevos.length} partidos nuevos emparejados con API-Football`);
      }
      // 2b. Identidad propia (DECISIONES 42): todo partido en vivo sin fixture (o sin liga) recibe un
      // fixture_id negativo y su liga. Ya no existen los "sin_cruce": todos se pueden evaluar.
      try {
        const registrados = await registrar(vivosFS.filter((p) => p.estado === 2), conocidos, true);
        if (registrados) log(`fs: ${registrados} partidos nuevos con id propio de Flashscore`);
      } catch (e) { log(`fs registrar: ${(e as Error).message}`); }   // si falla, esos partidos quedan "sin_cruce" este ciclo

      // 3. Convertir a la forma de API-Football para reutilizar todo el resto del escáner
      // Liga de cada partido: la de la agenda, la que quedó en fs_partidos o la del partido ya guardado
      const agendaInfo = new Map<number, any>();
      const idsApi = [...conocidos.values()].map((r) => r.fixture_id).filter(Boolean);
      if (idsApi.length) {
        for (const r of await sql`
          select f.fixture_id, coalesce(a.liga_id, f.liga_id, p.liga_id) as liga_id, coalesce(a.temporada, p.temporada) as temporada, l.nombre, l.pais
          from (select distinct on (fixture_id) fixture_id, liga_id from futbol.fs_partidos
                where fixture_id = any(${idsApi}::int[]) order by fixture_id, creado desc) f
          left join futbol.agenda a on a.fixture_id = f.fixture_id
          left join futbol.partidos p on p.fixture_id = f.fixture_id
          left join futbol.ligas l on l.id = coalesce(a.liga_id, f.liga_id, p.liga_id)
          where coalesce(a.liga_id, f.liga_id, p.liga_id) is not null`) agendaInfo.set(r.fixture_id, r);
      }
      const comoApi = (p: FS.PartidoFS, fixtureId: number) => {
        const em = FS.estadoYMinuto(p);
        const ai = agendaInfo.get(fixtureId);
        return {
          __fs: p, __fuente: "flashscore",
          fixture: { id: fixtureId, date: new Date(p.inicio).toISOString(), status: { short: em.estado, elapsed: em.minuto } },
          league: { id: ai?.liga_id ?? 0, name: ai?.nombre ?? p.liga, country: ai?.pais ?? null, season: ai?.temporada ?? null },
          teams: { home: { id: 1, name: p.local }, away: { id: 2, name: p.visitante } },
          goals: { home: p.gl, away: p.gv },
        };
      };
      // Poka-yoke: si por cualquier razón dos partidos de Flashscore apuntan al mismo fixture, se queda
      // el de mejor parecido de nombres y se avisa. Un duplicado tumbaba el ciclo entero con
      // "ON CONFLICT DO UPDATE command cannot affect row a second time".
      const elegido = new Map<number, FS.PartidoFS>();
      for (const p of vivosFS) {
        const c = conocidos.get(p.id);
        if (p.estado !== 2 || !c?.fixture_id || !agendaInfo.has(c.fixture_id)) continue;
        const otro = elegido.get(c.fixture_id);
        if (otro) {
          log(`fs: fixture ${c.fixture_id} repetido (${otro.local}-${otro.visitante} / ${p.local}-${p.visitante}); se usa el más parecido`);
          if (Number(conocidos.get(otro.id)?.puntaje ?? 0) >= Number(c.puntaje ?? 0)) continue;
        }
        elegido.set(c.fixture_id, p);
      }
      const enVivo = [...elegido.entries()].map(([fid, p]) => comoApi(p, fid));
      lista = enVivo;
      const porIdFS = new Map<number, any>(enVivo.map((f) => [f.fixture.id, f]));
      const idsVivosFS = [...porIdFS.keys()];
      await guardarPartidos(enVivo);
      await sql`update futbol.partidos set seguimiento = false where seguimiento and not (fixture_id = any(${idsVivosFS}::int[]))`;

      // 4. Resolver alertas pendientes cuyo partido Flashscore ya dio por terminado (1 consulta API cada una)
      const terminados = new Set(vivosFS.filter((p) => p.estado === 3).map((p) => conocidos.get(p.id)?.fixture_id).filter(Boolean));
      // Solo ligas activas: una alerta de liga excluida no gasta consultas de API-Football (DECISIONES 33)
      const pend = (await sql`select distinct a.fixture_id from futbol.alertas a join futbol.partidos p using (fixture_id)
                              left join futbol.ligas l on l.id = p.liga_id
                              where a.resultado = 'pendiente' and coalesce(l.habilitada, true)`).map((r: any) => r.fixture_id);
      // Red de seguridad: si Flashscore ya no lista el partido (cambió el día UTC), a las 2,5 h de la alerta se pregunta igual
      const viejas = (await sql`select distinct a.fixture_id from futbol.alertas a join futbol.partidos p using (fixture_id)
                                left join futbol.ligas l on l.id = p.liga_id
                                where a.resultado = 'pendiente' and coalesce(l.habilitada, true) and a.ts < now() - interval '150 minutes'
                                and extract(minute from now()) < 5`)  // como mucho una vez por hora
        .map((r: any) => r.fixture_id);
      // Con API-Football apagada no se pregunta nada: las alertas se cierran con Flashscore más abajo (4d).
      // Los ids negativos (partidos que nacieron en Flashscore) nunca se le preguntan a API-Football.
      const aResolver = usarApi ? [...new Set([...pend.filter((id: number) => terminados.has(id)), ...viejas])].filter((id) => id > 0) : [];
      if (aResolver.length) await resolverPendientes(await fixturesPorId(aResolver.slice(0, 3)), false);

      // 4b. Cierre gratis de los partidos terminados (DECISIONES 32). Antes solo se cerraban los que
      // tenían alerta (con API-Football); los demás quedaban congelados en "2H 90'" y no se sabía
      // cómo terminaron los candidatos. Flashscore da el marcador final en la misma lista del día.
      // El trigger partidos_cambio_marcador anota el último gol si cayó entre el último ciclo y el final.
      const finFS = new Map<number, FS.PartidoFS>();
      for (const p of vivosFS) if (p.estado === 3 && conocidos.get(p.id)?.fixture_id) finFS.set(conocidos.get(p.id).fixture_id, p);
      // Candidatos que empezaron ayer (UTC) y siguen abiertos: su partido vive en la lista de ayer
      const abiertosAyer = await sql`
        select p.fixture_id, f.fs_id from futbol.partidos p join futbol.fs_partidos f using (fixture_id)
        where coalesce(p.estado, '') not in ('FT', 'AET', 'PEN') and p.kickoff < ${hoy}::date
          and p.kickoff > now() - interval '36 hours'
          and exists (select 1 from futbol.snapshots s where s.fixture_id = p.fixture_id)`;
      if (abiertosAyer.length) {
        try {
          const ayer = new Map((await FS.listaDia(-1)).map((p) => [p.id, p]));
          for (const r of abiertosAyer) { const p = ayer.get(r.fs_id); if (p?.estado === 3) finFS.set(r.fixture_id, p); }
        } catch (e) { log(`fs lista de ayer: ${(e as Error).message}`); }
      }
      if (finFS.size) {
        const abiertos = await sql`select fixture_id from futbol.partidos
          where fixture_id = any(${[...finFS.keys()]}::int[]) and coalesce(estado, '') not in ('FT', 'AET', 'PEN')`;
        for (const { fixture_id } of abiertos) {
          const p = finFS.get(fixture_id)!;
          await sql`update futbol.partidos set estado = 'FT', minuto = greatest(coalesce(minuto, 0), 90),
                      goles_local = ${p.gl}, goles_visitante = ${p.gv}, seguimiento = false,
                      cierre_fuente = coalesce(cierre_fuente, 'flashscore'), cerrado_ts = now(), actualizado = now()
                    where fixture_id = ${fixture_id}`;
        }
        if (abiertos.length) log(`cerrados con Flashscore: ${abiertos.length}`);
      }
      // 4c. Alertas pendientes de ligas excluidas (DECISIONES 33): no se gasta API-Football en ellas;
      // se cierran gratis con el marcador final de Flashscore (acierto si hubo más goles que al alertar).
      // Quedan guardadas (ocultas en la PWA) por si la liga se vuelve a activar. No se envía push.
      const cerradasExcl = await sql`
        update futbol.alertas a set resultado = case when p.goles_local + p.goles_visitante > a.goles_al_alertar
                                                     then 'acierto' else 'fallo' end, cerrada_ts = now()
        from futbol.partidos p left join futbol.ligas l on l.id = p.liga_id
        where a.fixture_id = p.fixture_id and a.resultado = 'pendiente' and l.habilitada = false
          and p.estado in ('FT', 'AET', 'PEN') and p.goles_local is not null
        returning a.id`;
      if (cerradasExcl.length) {
        await sql`update futbol.partidos p set goles_local_90 = coalesce(p.goles_local_90, p.goles_local),
                    goles_visitante_90 = coalesce(p.goles_visitante_90, p.goles_visitante)
                  from futbol.alertas a where a.fixture_id = p.fixture_id and a.id = any(${cerradasExcl.map((r: any) => r.id)}::int[])`;
        log(`alertas de ligas excluidas cerradas con Flashscore: ${cerradasExcl.length}`);
      }
      // 4d. Cierre de alertas con Flashscore (DECISIONES 42): marcador final + incidencias, sin API-Football.
      try { resueltas += await resolverConFS(log); } catch (e) { log(`cierre fs: ${(e as Error).message}`); }

      // 5. Favorito con la cuota de APERTURA de las casas colombianas (gratis, una vez por partido).
      // Primero la agenda: si la cuota ya se pidió antes del partido (cicloAgendaFS), se copia sin consultar.
      try {
        const copiados = await favoritosDesdeAgenda(idsVivosFS);
        if (copiados.length) log(`favorito desde la agenda: ${copiados.length} partidos`);
      } catch (e) { log(`favorito agenda: ${(e as Error).message}`); }
      await cargarInfo(idsVivosFS);
      let cupoCuotas = Number(cfg.fs_cuotas_por_ciclo ?? 8);
      for (const f of enVivo) {
        const i = info.get(f.fixture.id);
        if (!i?.habilitada || i.cuota_pre_consultada) continue;
        const st = f.fixture.status;
        if (st.short === "2H" && (st.elapsed ?? 0) > A.limiteTarde(regla)) continue;
        const golEn1T = cfg.historial_desde_gol !== false && st.short === "1H" && f.goals.home !== f.goals.away;
        if (!golEn1T && !A.preCandidato(st.short, st.elapsed ?? 0, f.goals.home, f.goals.away, regla)) continue;
        if (cupoCuotas-- <= 0) break;
        const p: FS.PartidoFS = f.__fs;
        let c: FS.CuotasFS | null = null;
        try { c = await FS.cuotas(p.id, p.idLocal, p.idVisitante); } catch (e) { log(`fs cuotas ${p.id}: ${(e as Error).message}`); continue; }
        const ap = c.apertura ?? c.actual;
        const fav = ap ? A.definirFavorito(ap, Number.POSITIVE_INFINITY) : null;
        await sql`update futbol.partidos set cuota_pre_consultada = true, favorito = ${fav},
                    cuota_pre_local = ${ap ? ap.local.toFixed(2) : null},
                    cuota_pre_empate = ${ap && Number.isFinite(ap.empate) ? ap.empate.toFixed(2) : null},
                    cuota_pre_visitante = ${ap ? ap.visitante.toFixed(2) : null}
                  where fixture_id = ${f.fixture.id}`;
        await sql`update futbol.fs_partidos set cuotas = ${sql.json(c as any)} where fs_id = ${p.id}`;
        log(`favorito ${f.fixture.id} (fs, ${c.casas.length} casas): ${fav ?? "sin cuotas"}`);
      }
      await cargarInfo(idsVivosFS);

      // 5b. Mercado experimental de córners, solo admin (DECISIONES 37). Aislado: si falla, el radar de goles sigue.
      // 5a'. Foto de cuotas de córners de TODOS los partidos en vivo (1 consulta de /odds/live, DECISIONES 51).
      // Tiene su propio cupo dentro del presupuesto: funciona aunque api_football_activa = false.
      try { (detalle as any).corners_api = await fotoCornersApi({ cfg, vivosFS, log }); }
      catch (e) { log(`córners api: ${(e as Error).message}`); }
      // 5a''. Cuotas de BetPlay y Rushbet (DECISIONES 54): lista en vivo de cada casa y cuotas de los partidos
      // que importan (candidatos, gol temprano vigilado y franjas de córners). Gratis; aislado si falla.
      try {
        // Desde el gol que deja al favorito perdiendo (1T, descanso o 2T antes de la ventana: enHistorial), en la
        // ventana (esCandidato) y con la alerta ya enviada y abierta (para los recordatorios), cada ciclo. Antes solo
        // entraban los candidatos: el partido llegaba a la ventana sin ninguna lectura y, tras la alerta, salía de
        // la cola y los recordatorios se quedaban sin cuota (Shakhtar - Livyi Bereg, 20 nov).
        const abiertas = new Set<number>((await sql`select fixture_id from futbol.alertas
            where resultado = 'pendiente' and ts > now() - interval '3 hours'`).map((r: any) => Number(r.fixture_id)));
        // DECISIONES 65 (Fredy, 20 nov): también todo favorito perdiendo en vivo, aunque su cuota previa pase
        // cuota_fav_max (Chrobry - Puszcza a 2,27 no se leía): Ahora y el widget muestran su cuota desde el gol.
        const favPierdeVivo = (f: any) => {
          const st = f.fixture.status.short, p = favs.get(f.fixture.id);
          if (!(st === "1H" || st === "HT" || st === "2H") || !p?.favorito || info.get(f.fixture.id)?.habilitada === false) return false;
          const gl = f.goals.home ?? 0, gv = f.goals.away ?? 0;
          return p.favorito === "home" ? gv > gl : gl > gv;
        };
        const prioridad = new Set<string>(enVivo.filter((f) => esCandidato(f) || enHistorial(f) || favPierdeVivo(f) || abiertas.has(f.fixture.id))
          .map((f) => f.__fs?.id).filter(Boolean));
        // Urgentes (DECISIONES 62): la cuota de goles decide una push ya → el cron los pide cada 30 s
        const urgente = new Set<string>(enVivo.filter((f) => esCandidato(f) || abiertas.has(f.fixture.id))
          .map((f) => f.__fs?.id).filter(Boolean));
        for (const r of await sql`select fs_id from futbol.lab_oportunidades where vigilando and fs_id is not null`) { prioridad.add(r.fs_id); urgente.add(r.fs_id); }
        kambi = await cicloKambi({ cfg, vivosFS, fixtureDe: (fs) => conocidos.get(fs)?.fixture_id ?? null, prioridad, urgente, log });
        (detalle as any).kambi = kambi.resumen;
      } catch (e) { log(`kambi: ${(e as Error).message}`); }
      try { await cicloCorners({ cfg, vivosFS, conocidos, api, log, kambi, fotoForzada: () => fotoCornersApi({ cfg, vivosFS, log, forzada: true }) }); }
      catch (e) { log(`córners: ${(e as Error).message}`); }
      // 5b'. Córners del 1T, 2T y total de cada partido terminado de ligas habilitadas (DECISIONES 45)
      try { await guardarCornersPartidos(cfg, log); }
      catch (e) { log(`córners por tiempo: ${(e as Error).message}`); }

      // 5c. Cuotas en vivo de Flashscore (DECISIONES 40): foto en cada gol, en el laboratorio cada 2 min,
      // al descanso, candidatos cada 2 min y el resto cada 10, con tope de consultas. Luego el laboratorio
      // de goles compara la mejor cuota con el umbral calculado desde la base. Aislado: si falla, el radar sigue.
      try {
        const hab = (id: number) => info.get(id)?.habilitada !== false;
        const lab = await vigilados(cfg);
        const r = await cicloCuotasVivo({ cfg, enVivo, habilitada: hab, candidatos: new Set(enVivo.filter(esCandidato).map((f) => f.fixture.id)), lab, log });
        if (r.consultas) log(`fs vivo: ${r.fotos} fotos, ${r.consultas} consultas, ${r.errores} errores`);
        (detalle as any).fs_vivo = r;
        await cicloLab({ cfg, vivos: enVivo, habilitada: hab, log, kambi });
      } catch (e) { log(`cuotas vivo/lab: ${(e as Error).message}`); }

      // 5d. Historial desde el gol (DECISIONES 44): si el favorito va perdiendo antes de ser candidato (1T,
      // descanso o el arranque del 2T), se guardan fotos de estadísticas cada historial_intervalo_min. No es
      // candidato ni alerta: solo le da al momentum una foto anterior para que exista desde el 46'.
      if (cfg.historial_desde_gol !== false) {
        try { await fotosHistorial(enVivo); } catch (e) { log(`historial: ${(e as Error).message}`); }
      }

      // 6. Candidatos y detalle: estadísticas de Flashscore (gratis); cuota en vivo desde Flashscore (API de respaldo)
      const filtradosFS = enVivo.filter(esCandidato);
      for (const f of filtradosFS) if (tarde(f)) resultadoDetalle.set(f.fixture.id, "tarde" as any);
      const candidatosFS = filtradosFS.filter((f) => !tarde(f) && Number(info.get(f.fixture.id)?.sin_stats ?? 0) < 2)
        .sort((a, b) => (b.fixture.status.elapsed ?? 0) - (a.fixture.status.elapsed ?? 0));
      candidatosN = candidatosFS.length;
      await actualizarSeguimiento(candidatosFS.map((f) => f.fixture.id), idsVivosFS);
      const conStatsFS = new Map<number, any>();
      for (const f of candidatosFS.slice(0, maxDetalle)) {
        try {
          const s = await FS.estadisticas(f.__fs.id);
          // __extra: todas las estadísticas de Flashscore (xGOT, ocasiones claras, toques en el área…). Quedan en
          // snapshots.raw.fixture.__extra para calibrar la v5 con datos reales; hoy no pesan en la fórmula.
          conStatsFS.set(f.fixture.id, { ...f, __extra: s.extra, statistics: s.local.length ? [{ team: { id: 1 }, statistics: s.local }, { team: { id: 2 }, statistics: s.visitante }] : [] });
        } catch (e) {
          log(`fs stats ${f.__fs.id}: ${(e as Error).message}`);
          conStatsFS.set(f.fixture.id, { ...f, statistics: [] });
        }
      }
      await detallarCandidatos(candidatosFS, conStatsFS);
      // 7. Agenda de hoy y mañana con sus favoritos (DECISIONES 42). Al final: lo en vivo va primero.
      if (!usarApi && (enHorario || forzar)) {
        try { await cicloAgendaFS({ cfg, hoyLista: listaCruda, regla, log }); }
        catch (e) { log(`agenda fs: ${(e as Error).message}`); }
      }
      // Desde DECISIONES 42 casi no debería haber: todo partido en vivo recibe id propio. Solo quedan aquí
      // los que no se pudieron registrar (p. ej. falló la base al crear la liga). Antes eran los sin pareja en API-Football:
      // así la lista del Radar suma lo mismo que el conteo `vivos`. No se pueden evaluar (sin fixture
      // no hay cuota en vivo), por eso van con motivo "sin_cruce".
      const enLista = new Set(enVivo.map((f) => f.__fs.id));
      const sinCruce = vivosFS.filter((p) => p.estado === 2 && !enLista.has(p.id)).map((p) => {
        const em = FS.estadoYMinuto(p);
        const [paisFS, resto] = p.liga.includes(": ") ? p.liga.split(/: (.*)/s) : [null, p.liga];
        return {
          id: `fs:${p.id}`, lg: 0, liga: (resto ?? p.liga).replace(/ - .*$/, ""),
          pais: paisFS ? paisFS.charAt(0) + paisFS.slice(1).toLowerCase() : null,
          l: p.local, v: p.visitante, e: em.estado, m: em.minuto, gl: p.gl, gv: p.gv,
          fav: null, cf: null, mo: "sin_cruce", ...(kambi?.ok ? { kb: kambi.pareja.has(p.id) } : {}),
        };
      });
      const foto = fotoRadar();
      return await bitacora("fs", { vivos, candidatos: candidatosN, llamadas: api.llamadas, alertas: alertasNuevas, resueltas, detalle,
        radar: foto ? [...foto, ...sinCruce] : null });
    }

    if (modo === "seguimiento") {
      // ================= SEGUIMIENTO: solo candidatos y alertas pendientes =================
      const ids: number[] = [...new Set((await sql`
        select fixture_id, 0 as orden from futbol.partidos where seguimiento
        union all
        select a.fixture_id, 1 from futbol.alertas a join futbol.partidos p using (fixture_id)
        left join futbol.ligas l on l.id = p.liga_id where a.resultado = 'pendiente' and coalesce(l.habilitada, true)
        order by orden`).map((r: any) => r.fixture_id as number))];
      // Candidatos primero (los pendientes ya alertados solo necesitan saber si terminó)
      const alcance = ids.slice(0, maxDetalle + 2);
      const porId = await fixturesPorId(alcance);
      const fixtures: any[] = [...porId.values()];
      await guardarPartidos(fixtures);
      await resolverPendientes(porId, false);
      await cargarInfo(alcance);
      // Lo que ya no está en vivo o dejó de cumplir el filtro (gol, minuto 85, terminó) sale del seguimiento
      const candidatos = fixtures.filter((f) => esCandidato(f) && !sinCobertura(f.fixture.id) && !tarde(f))
        .sort((a, b) => (b.fixture.status.elapsed ?? 0) - (a.fixture.status.elapsed ?? 0));
      candidatosN = candidatos.length;
      await actualizarSeguimiento(candidatos.map((f) => f.fixture.id), [...porId.keys()]);
      await detallarCandidatos(candidatos, porId);
      return await bitacora("seguimiento", { vivos: null, candidatos: candidatosN, llamadas: api.llamadas, alertas: alertasNuevas, resueltas, detalle });
    }

    // ================= RADAR =================
    // ---------- 1. Radar ----------
    const radar = await api.get("/fixtures", { live: "all" });
    lista = radar.response ?? [];
    vivos = lista.length;
    // Copas: se ven en la foto del radar (motivo "copa") pero no se guardan ni gastan consultas
    const ligasOk = lista.filter((f) => !A.esCopa(f.league?.name, regla.patrones_copa));
    if (ligasOk.length < lista.length) log(`copas descartadas: ${lista.length - ligasOk.length}`);
    const porId = new Map<number, any>(ligasOk.map((f) => [f.fixture.id, f]));
    const idsVivos = [...porId.keys()];
    await guardarPartidos(ligasOk);

    // ---------- 2. Resolución de alertas ----------
    await resolverPendientes(porId, true);

    // Partidos en seguimiento que ya no están en vivo → se apaga el seguimiento
    await sql`update futbol.partidos set seguimiento = false
              where seguimiento and not (fixture_id = any(${idsVivos}::int[]))`;

    // ---------- 3. Favoritos (cuota prepartido, una sola vez por partido) ----------
    await cargarInfo(idsVivos);
    // 3a. Primero la caché de cuotas en bloque (agenda): cero consultas
    const pedibles = (f: any) => {
      const i = info.get(f.fixture.id);
      if (!i?.habilitada || i.cuota_pre_consultada) return false;
      if (i.liga_sin_cuota || i.liga_sin_stats) return false;          // la liga no tiene con qué alertar
      if (f.fixture.status.short === "2H" && (f.fixture.status.elapsed ?? 0) > A.limiteTarde(regla)) return false; // tarde
      return A.preCandidato(f.fixture.status.short, f.fixture.status.elapsed ?? 0, f.goals.home ?? 0, f.goals.away ?? 0, regla);
    };
    const idsPedibles = ligasOk.filter(pedibles).map((f) => f.fixture.id);
    if (idsPedibles.length) {
      const deCache = await sql`
        select a.fixture_id, a.cuota_pre_local, a.cuota_pre_empate, a.cuota_pre_visitante, a.cuota_pre_ts,
               (b.error is null) as bloque_ok
        from futbol.agenda a join futbol.cuotas_bloque b on b.liga_id = a.liga_id and b.fecha = a.fecha
        where a.fixture_id = any(${idsPedibles}::int[])`;
      for (const c of deCache) {
        let fav: "home" | "away" | null = null;
        if (c.cuota_pre_ts) {
          fav = A.definirFavorito({ local: Number(c.cuota_pre_local), visitante: Number(c.cuota_pre_visitante) }, Number.POSITIVE_INFINITY);
        } else if (!c.bloque_ok) continue;   // el bloque falló: se pide de a uno como antes
        // Si el bloque de su liga llegó bien y este partido no venía, es que no tiene cuotas: igual que una consulta vacía
        await sql`update futbol.partidos set cuota_pre_consultada = true, favorito = ${fav},
                    cuota_pre_local = ${c.cuota_pre_local}, cuota_pre_empate = ${c.cuota_pre_empate}, cuota_pre_visitante = ${c.cuota_pre_visitante}
                  where fixture_id = ${c.fixture_id}`;
        log(`favorito ${c.fixture_id} desde bloque: ${fav ?? "sin cuotas"}`);
      }
      if (deCache.length) await cargarInfo(idsVivos);
    }
    const sinFavorito = ligasOk
      .filter(pedibles)
      // prioridad: 2T dentro de la ventana primero
      .sort((a, b) => (b.fixture.status.short === "2H" ? 1 : 0) - (a.fixture.status.short === "2H" ? 1 : 0));

    // A los favoritos se les permite usar como máximo la mitad de lo que queda en este escaneo
    let cupoFav = Math.min(maxDetalle, Math.floor(api.quedan() / 2));
    for (const f of sinFavorito) {
      if (cupoFav-- <= 0) break;
      let cuotas = null;
      try {
        const r = await api.get("/odds", { fixture: f.fixture.id, bet: 1 });
        cuotas = A.parsearCuotaPre(r);
      } catch (e) {
        if (e instanceof SinPresupuesto) break;
        log(`odds pre ${f.fixture.id}: ${(e as Error).message}`);
      }
      const fav = A.definirFavorito(cuotas, Number.POSITIVE_INFINITY); // se guarda siempre; el umbral se aplica al filtrar
      await sql`update futbol.partidos set cuota_pre_consultada = true, favorito = ${fav},
                  cuota_pre_local = ${cuotas?.local?.toFixed(2) ?? null}, cuota_pre_empate = ${cuotas && Number.isFinite(cuotas.empate) ? cuotas.empate.toFixed(2) : null},
                  cuota_pre_visitante = ${cuotas?.visitante?.toFixed(2) ?? null}
                where fixture_id = ${f.fixture.id}`;
      log(`favorito ${f.fixture.id}: ${fav ?? "sin cuotas"}`);
    }

    // Releer favoritos y cuotas (incluye los que se acaban de consultar)
    await cargarInfo(idsVivos);

    // ---------- 4. Candidatos ----------
    const filtrados = ligasOk.filter(esCandidato);
    for (const f of filtrados) {
      if (sinCobertura(f.fixture.id)) resultadoDetalle.set(f.fixture.id, "sin_estadisticas");
      else if (tarde(f)) resultadoDetalle.set(f.fixture.id, "tarde" as any);
    }
    const candidatos = filtrados.filter((f) => !sinCobertura(f.fixture.id) && !tarde(f))
      .sort((a, b) => (b.fixture.status.elapsed ?? 0) - (a.fixture.status.elapsed ?? 0));
    candidatosN = candidatos.length;
    await actualizarSeguimiento(candidatos.map((f) => f.fixture.id), idsVivos);

    // ---------- 5. Detalle + regla (1 consulta de estadísticas para todos + odds/live por candidato) ----------
    await detallarCandidatos(candidatos, null);

    return await bitacora("ok", { vivos, candidatos: candidatosN, llamadas: api.llamadas, alertas: alertasNuevas, resueltas, detalle, radar: fotoRadar() });
  } catch (e) {
    detalle.error = (e as Error).message;
    const motivo = e instanceof SinPresupuesto ? "presupuesto" : "error";
    return await bitacora(motivo, { vivos: modo === "radar" ? vivos : null, candidatos: candidatosN, llamadas: api.llamadas, alertas: alertasNuevas, resueltas, detalle, radar: lista.length ? fotoRadar() : null });
  }
});
