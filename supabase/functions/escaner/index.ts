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
//   Bitácora: futbol.escaneos (motivo "ok" = radar, "seguimiento" = solo candidatos).
// =====================================================================
import { sql, leerConfig, Config } from "../_shared/db.ts";
import { ApiFootball, estadoPresupuesto, SinPresupuesto, verificarCuotaReal } from "../_shared/apifootball.ts";
import * as A from "../_shared/algoritmo.ts";
import { notificarTodos } from "../_shared/notificar.ts";

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
    patrones_copa: Array.isArray(cfg.patrones_copa) ? cfg.patrones_copa : ["cup", "copa"],
  };
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
      ultimo_radar: cfg.ultimo_radar ?? null,
      ultimo_seguimiento: cfg.ultimo_seguimiento ?? null,
    });
  }

  const key = Deno.env.get("APIFOOTBALL_KEY")?.trim();
  if (!key) return json({ error: "falta el secreto APIFOOTBALL_KEY" }, 500);

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

  // ---------- 0. Guardas ----------
  if (cfg.escaneo_activo !== true) return json({ motivo: "escaneo_inactivo" });

  const ahora = new Date();
  const [{ cand: nCandidatos, pend: nPendientes }] = await sql`
    select (select count(*)::int from futbol.partidos where seguimiento) as cand,
           (select count(distinct fixture_id)::int from futbol.alertas where resultado = 'pendiente') as pend`;
  const horas: number[] = cfg.horas_activas_utc ?? [];
  const enHorario = horas.includes(ahora.getUTCHours());
  // Prueba manual: ignora horario e intervalo (NUNCA el presupuesto). Exige el token guardado en
  // futbol.config para que nadie pueda quemar la cuota llamando la URL pública con ?forzar=1.
  const forzar = url.searchParams.get("forzar") === "1" &&
    typeof cfg.token_forzar === "string" && req.headers.get("x-token") === cfg.token_forzar;
  if (!forzar && !enHorario && nCandidatos === 0 && nPendientes === 0) return json({ motivo: "fuera_de_horario" });

  let est = await estadoPresupuesto(cfg);
  // Poka-yoke del reinicio diario: si NUESTRA cuenta dice que hay cupo pero el último header de la
  // API dice que no, puede ser un header viejo (del día anterior). Se confirma con /status, que es
  // gratis, y se recalcula. Si la API de verdad está agotada, /status lo confirma y seguimos parados.
  const segunNosotros = Number(cfg.presupuesto_diario ?? 100) - Number(cfg.reserva_api ?? 6) - est.usadas_hoy;
  if (est.disponibles < 1 && segunNosotros > 0) {
    await verificarCuotaReal(key);
    est = await estadoPresupuesto(cfg);
  }
  if (est.disponibles < 1) return json({ motivo: "presupuesto_agotado", presupuesto: est });

  // Reloj del radar: reparte lo que queda del presupuesto entre las horas activas que faltan.
  // Lo que gaste el seguimiento baja `disponibles`, así que el radar se espacia solo: los
  // candidatos tienen prioridad sobre buscar partidos nuevos.
  const intervaloRadar = forzar ? 1 : A.intervaloEfectivo({
    intervaloBase: Number(cfg.intervalo_radar_min), disponibles: est.disponibles,
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

  let modo: "radar" | "seguimiento" | null = null;
  if ((enHorario || forzar) && await reservar("ultimo_radar", intervaloRadar)) modo = "radar";
  else if ((nCandidatos > 0 || nPendientes > 0) && await reservar("ultimo_seguimiento", intervaloSeg)) modo = "seguimiento";
  if (!modo) return json({ motivo: "intervalo", radar_min: intervaloRadar, seguimiento_min: intervaloSeg });
  // El radar también hace el detalle de los candidatos: reinicia el reloj del seguimiento
  if (modo === "radar") await marcar("ultimo_seguimiento");

  const api = new ApiFootball(key, est);
  const regla = reglaDesde(cfg);
  const detalle: Record<string, unknown> = {
    modo, intervalo_min: modo === "radar" ? intervaloRadar : intervaloSeg, regla: regla.version, eventos: [] as string[],
  };
  const log = (s: string) => (detalle.eventos as string[]).push(s);
  let alertasNuevas = 0, resueltas = 0, candidatosN = 0, vivos = 0;
  const maxDetalle = Number(cfg.max_detalle_escaneo ?? 3);
  // Datos para la foto del radar (se llenan a medida que avanza el escaneo)
  let lista: any[] = [];
  const info = new Map<number, any>();
  const favs = new Map<number, any>();
  const yaAlertados = new Set<number>();
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
          yaAlertado: yaAlertados.has(id), detalle: (resultadoDetalle.get(id) ?? null) as any,
        }, regla);
        return {
          id, lg: f.league.id, liga: f.league.name, pais: f.league.country,
          l: f.teams.home.name, v: f.teams.away.name, e: f.fixture.status.short, m: f.fixture.status.elapsed ?? null,
          gl: f.goals.home ?? 0, gv: f.goals.away ?? 0, fav: favorito,
          cf: Number.isFinite(cuotaFav) ? cuotaFav : null, mo: motivo,
          ...(evaluaciones.has(id) ? { ev: evaluaciones.get(id) } : {}),
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
      select a.id, a.fixture_id, a.minuto, a.goles_al_alertar, p.favorito
      from futbol.alertas a join futbol.partidos p using (fixture_id)
      where a.resultado = 'pendiente'`;
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
                  seguimiento = false, actualizado = now() where fixture_id = ${a.fixture_id}`;
      resueltas++;
      log(`resuelta alerta ${a.id}: ${r.resultado}`);
      await notificarTodos({
        titulo: r.resultado === "acierto" ? "✅ Acierto" : "❌ Fallo",
        cuerpo: `${f.teams.home.name} ${r.gl90}-${r.gv90} ${f.teams.away.name}` +
                (r.minuto_gol ? ` · gol al ${r.minuto_gol}' (${r.lado_gol})` : ""),
        url: "./#alertas", tag: `res-${a.id}`,
      });
    }
  };

  // Carga liga habilitada, favorito, cuotas prepartido y contador sin_stats de una lista de ids
  const cargarInfo = async (ids: number[]) => {
    if (!ids.length) return;
    for (const f of await sql`
      select p.fixture_id, p.favorito, p.cuota_pre_local, p.cuota_pre_visitante, p.cuota_pre_consultada,
             p.sin_stats, p.cuota_vivo_probada, coalesce(l.habilitada, true) as habilitada
      from futbol.partidos p left join futbol.ligas l on l.id = p.liga_id
      where p.fixture_id = any(${ids}::int[])`) { info.set(f.fixture_id, f); favs.set(f.fixture_id, f); }
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
      goles_local: f.goals.home ?? 0, goles_visitante: f.goals.away ?? 0, favorito: p.favorito,
    }, regla).ok;
  };
  // Poka-yoke de presupuesto: si la API ya respondió 2 veces seguidas sin estadísticas para este
  // partido, deja de gastar en él. Sin estadísticas no hay dominancia y la regla nunca dispararía.
  const sinCobertura = (id: number) => Number(info.get(id)?.sin_stats ?? 0) >= 2;

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
      let fuenteStats = "fixtures?id";
      if (!Array.isArray(f.statistics) && api.quedan() > 0) {
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
        if (cfg.cuotas_siempre === true && !p.cuota_vivo_probada && api.quedan() > 0) {
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
      const [prev] = await sql`
        select minuto, stats_local, stats_visitante from futbol.snapshots
        where fixture_id = ${id} and stats_local is not null and minuto <= ${minuto - regla.momentum_gap_min}::int
        order by abs(minuto - ${minuto - regla.momentum_ventana_min}::int) limit 1`;
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
      if ((vale || cfg.cuotas_siempre === true) && api.quedan() > 0) {
        rOdds = await api.get("/odds/live", { fixture: id });
        cuotaOver = A.parsearCuotaOver(rOdds, linea);
        if (!p.cuota_vivo_probada) {
          await sql`update futbol.partidos set cuota_vivo_probada = true where fixture_id = ${id}`;
          p.cuota_vivo_probada = true;
        }
      }

      const ev = A.evaluar({
        ctx: { estado: f.fixture.status.short, minuto, goles_local: gl, goles_visitante: gv, favorito: fav },
        regla, dominancia, momentum, cuotaOver,
      });
      const [snap] = await sql`
        insert into futbol.snapshots (fixture_id, minuto, goles_local, goles_visitante, stats_local, stats_visitante,
          ip_local, ip_visitante, dominancia, momentum, linea_over, cuota_over, regla_version, evaluacion, raw)
        values (${id}, ${minuto}, ${gl}, ${gv}, ${sql.json(sL as any)}, ${sql.json(sV as any)},
          ${ipL.toFixed(2)}, ${ipV.toFixed(2)}, ${dominancia.toFixed(3)}, ${momentum?.toFixed(3) ?? null},
          ${linea}, ${cuotaOver.cuota}, ${regla.version},
          ${sql.json({ ...ev.condiciones, mercado: cuotaOver.mercado, lineas: cuotaOver.lineas, usar_xg: usarXg, fuente_stats: fuenteStats } as any)},
          ${sql.json({ statistics: equipos, odds: rOdds?.response ?? null, fixture: { ...f, statistics: undefined, players: undefined, lineups: undefined } } as any)})
        returning id`;
      // Para la pestaña Radar: si se pidió la cuota en vivo y no vino el mercado, es un hueco de cobertura
      resultadoDetalle.set(id, rOdds && !(rOdds.response ?? []).length ? "sin_cuota_vivo" : "evaluado");
      evaluaciones.set(id, { ...ev.condiciones, d: Number(dominancia.toFixed(2)), mo: momentum === null ? null : Number(momentum.toFixed(2)), c: cuotaOver.cuota });
      log(`snap ${id} ${minuto}' D=${dominancia.toFixed(2)} M=${momentum?.toFixed(2) ?? "-"} cuota=${cuotaOver.cuota ?? "-"}`);

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
          const enviados = await notificarTodos({
            titulo: `⚽ ${favNombre} presiona y pierde ${gl}-${gv} (${minuto}')`,
            cuerpo: `Over ${linea} @ ${cuotaOver.cuota} · D ${dominancia.toFixed(2)} · M ${momentum!.toFixed(2)} · ${f.league.name}`,
            url: "./#alertas", tag: `alerta-${nueva[0].id}`,
          });
          await sql`update futbol.alertas set push_enviados = ${enviados} where id = ${nueva[0].id}`;
          log(`ALERTA ${nueva[0].id} ${favNombre} push=${enviados}`);
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

    if (modo === "seguimiento") {
      // ================= SEGUIMIENTO: solo candidatos y alertas pendientes =================
      const ids: number[] = [...new Set((await sql`
        select fixture_id, 0 as orden from futbol.partidos where seguimiento
        union all
        select fixture_id, 1 from futbol.alertas where resultado = 'pendiente'
        order by orden`).map((r: any) => r.fixture_id as number))];
      // Candidatos primero (los pendientes ya alertados solo necesitan saber si terminó)
      const alcance = ids.slice(0, maxDetalle + 2);
      const porId = await fixturesPorId(alcance);
      const fixtures: any[] = [...porId.values()];
      await guardarPartidos(fixtures);
      await resolverPendientes(porId, false);
      await cargarInfo(alcance);
      // Lo que ya no está en vivo o dejó de cumplir el filtro (gol, minuto 85, terminó) sale del seguimiento
      const candidatos = fixtures.filter((f) => esCandidato(f) && !sinCobertura(f.fixture.id))
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
    const sinFavorito = ligasOk
      .filter((f) => {
        const i = info.get(f.fixture.id);
        return i?.habilitada && !i.cuota_pre_consultada &&
          A.preCandidato(f.fixture.status.short, f.fixture.status.elapsed ?? 0, f.goals.home ?? 0, f.goals.away ?? 0, regla);
      })
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
    for (const f of filtrados) if (sinCobertura(f.fixture.id)) resultadoDetalle.set(f.fixture.id, "sin_estadisticas");
    const candidatos = filtrados.filter((f) => !sinCobertura(f.fixture.id))
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
