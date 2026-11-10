// =====================================================================
// Edge Function `escaner`
// La dispara pg_cron cada 5 minutos. Ella misma decide si "le toca" correr
// (horario, intervalo, presupuesto), así que llamarla de más no gasta cuota.
//
// Flujo de un escaneo:
//   0. Guardas: interruptor, horario activo, intervalo efectivo, presupuesto
//   1. Radar:      GET /fixtures?live=all            (1 consulta, todos los partidos en vivo)
//   2. Resolución: alertas pendientes de partidos ya terminados (0-1 consulta, en lote)
//   3. Favoritos:  GET /odds?fixture=X&bet=1         (1 por partido, una sola vez en la vida)
//   4. Detalle:    GET /fixtures/statistics + /odds/live para los candidatos
//   5. Regla:      IP, dominancia, momentum, cuota → snapshot → alerta + push
//   6. Bitácora:   futbol.escaneos (+ columna `radar`: cada partido en vivo con su motivo de descarte)
// =====================================================================
import { sql, leerConfig, Config } from "../_shared/db.ts";
import { ApiFootball, estadoPresupuesto, SinPresupuesto } from "../_shared/apifootball.ts";
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
  const [{ n: enSeguimiento }] = await sql`
    select count(*)::int as n from futbol.partidos p
    where p.seguimiento
       or exists (select 1 from futbol.alertas a where a.fixture_id = p.fixture_id and a.resultado = 'pendiente')`;
  const horas: number[] = cfg.horas_activas_utc ?? [];
  const enHorario = horas.includes(ahora.getUTCHours());
  // Prueba manual: ignora horario e intervalo (NUNCA el presupuesto). Exige el token guardado en
  // futbol.config para que nadie pueda quemar la cuota llamando la URL pública con ?forzar=1.
  const forzar = url.searchParams.get("forzar") === "1" &&
    typeof cfg.token_forzar === "string" && req.headers.get("x-token") === cfg.token_forzar;
  if (!forzar && !enHorario && enSeguimiento === 0) return json({ motivo: "fuera_de_horario" });

  const est = await estadoPresupuesto(cfg);
  if (est.disponibles < 1) return json({ motivo: "presupuesto_agotado", presupuesto: est });

  const intervalo = forzar ? 1 : enSeguimiento > 0
    ? Number(cfg.intervalo_seguimiento_min)
    : A.intervaloEfectivo({
        intervaloBase: Number(cfg.intervalo_radar_min), disponibles: est.disponibles,
        fraccionRadar: Number(cfg.fraccion_radar ?? 0.5), horasActivas: horas, ahora,
      });

  // Reserva atómica del turno: solo una ejecución concurrente logra actualizar la marca.
  // (El -30 s de tolerancia evita que un cron que llega 2 s antes pierda el turno completo.)
  await sql`insert into futbol.config (clave, valor, descripcion)
            values ('ultimo_radar', to_jsonb('2000-01-01T00:00:00Z'::text), 'Marca del último radar (la escribe el escáner)')
            on conflict do nothing`;
  const turno = await sql`
    update futbol.config set valor = to_jsonb(now()::text), actualizado = now()
    where clave = 'ultimo_radar'
      and (valor #>> '{}')::timestamptz <= now() - make_interval(secs => ${intervalo * 60 - 30}::float8)
    returning 1`;
  if (turno.length === 0) return json({ motivo: "intervalo", intervalo_min: intervalo });

  const api = new ApiFootball(key, est);
  const regla = reglaDesde(cfg);
  const detalle: Record<string, unknown> = { intervalo_min: intervalo, regla: regla.version, eventos: [] as string[] };
  const log = (s: string) => (detalle.eventos as string[]).push(s);
  let alertasNuevas = 0, resueltas = 0, candidatosN = 0, vivos = 0;
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

  try {
    // ---------- 1. Radar ----------
    const radar = await api.get("/fixtures", { live: "all" });
    lista = radar.response ?? [];
    vivos = lista.length;
    const porId = new Map<number, any>(lista.map((f) => [f.fixture.id, f]));
    const idsVivos = [...porId.keys()];

    if (lista.length) {
      const ligas = [...new Map(lista.map((f) => [f.league.id, f.league])).values()];
      await sql`insert into futbol.ligas ${sql(ligas.map((l: any) => ({ id: l.id, nombre: l.name, pais: l.country })))}
                on conflict (id) do update set nombre = excluded.nombre, pais = excluded.pais`;
      const filas = lista.map((f) => ({
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
    }

    // ---------- 2. Resolución de alertas ----------
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
    // Partidos que salieron del radar: se consultan en lote (hasta 20 ids = 1 consulta)
    if (faltan.length && api.quedan() > 0) {
      const ids = [...new Set(faltan)].slice(0, 20);
      const r = await api.get("/fixtures", { ids: ids.join("-") });
      for (const f of r.response ?? []) fixturesFinales.set(f.fixture.id, f);
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

    // Partidos en seguimiento que ya no están en vivo → se apaga el seguimiento
    await sql`update futbol.partidos set seguimiento = false
              where seguimiento and not (fixture_id = any(${idsVivos}::int[]))`;

    // ---------- 3. Favoritos (cuota prepartido, una sola vez por partido) ----------
    if (lista.length) {
      const filas = await sql`
        select p.fixture_id, p.favorito, p.cuota_pre_consultada, coalesce(l.habilitada, true) as habilitada
        from futbol.partidos p left join futbol.ligas l on l.id = p.liga_id
        where p.fixture_id = any(${idsVivos}::int[])`;
      for (const f of filas) info.set(f.fixture_id, f);
    }
    const sinFavorito = lista
      .filter((f) => {
        const i = info.get(f.fixture.id);
        return i?.habilitada && !i.cuota_pre_consultada &&
          A.preCandidato(f.fixture.status.short, f.fixture.status.elapsed ?? 0, f.goals.home ?? 0, f.goals.away ?? 0, regla);
      })
      // prioridad: 2T dentro de la ventana primero
      .sort((a, b) => (b.fixture.status.short === "2H" ? 1 : 0) - (a.fixture.status.short === "2H" ? 1 : 0));

    const maxDetalle = Number(cfg.max_detalle_escaneo ?? 4);
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
    if (lista.length) {
      for (const p of await sql`select fixture_id, favorito, cuota_pre_local, cuota_pre_visitante, cuota_pre_consultada
                                from futbol.partidos where fixture_id = any(${idsVivos}::int[])`) favs.set(p.fixture_id, p);
    }

    // ---------- 4. Candidatos ----------
    for (const r of await sql`select fixture_id from futbol.alertas where regla_version = ${regla.version}`) {
      yaAlertados.add(r.fixture_id);
    }
    const candidatos = lista.filter((f) => {
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
    }).sort((a, b) => (b.fixture.status.elapsed ?? 0) - (a.fixture.status.elapsed ?? 0));
    candidatosN = candidatos.length;

    const idsCand = candidatos.map((f) => f.fixture.id);
    await sql`update futbol.partidos set seguimiento = (fixture_id = any(${idsCand}::int[]))
              where seguimiento or fixture_id = any(${idsCand}::int[])`;

    // ---------- 5. Detalle + regla ----------
    for (const f of candidatos.slice(0, maxDetalle)) {
      if (api.quedan() < 1) { log("sin presupuesto para más detalle"); break; }
      const id = f.fixture.id;
      const p = favs.get(id);
      const fav: "home" | "away" = p.favorito;
      const gl = f.goals.home ?? 0, gv = f.goals.away ?? 0;
      const minuto = f.fixture.status.elapsed ?? 0;

      const rStats = await api.get("/fixtures/statistics", { fixture: id });
      const equipos: any[] = rStats.response ?? [];
      if (equipos.length < 2) { log(`sin estadísticas ${id}`); resultadoDetalle.set(id, "sin_estadisticas"); continue; }
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
      const linea = gl + gv + 0.5;
      let cuotaOver: A.CuotaOver = { linea, cuota: null, suspendida: false, mercado: null, lineas: {} };
      let rOdds: any = null;
      const vale = dominancia >= regla.dominancia_min && momentum !== null && momentum >= regla.dominancia_min;
      if ((vale || cfg.cuotas_siempre === true) && api.quedan() > 0) {
        rOdds = await api.get("/odds/live", { fixture: id });
        cuotaOver = A.parsearCuotaOver(rOdds, linea);
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
          ${sql.json({ ...ev.condiciones, mercado: cuotaOver.mercado, lineas: cuotaOver.lineas, usar_xg: usarXg } as any)},
          ${sql.json({ statistics: rStats.response, odds: rOdds?.response ?? null, fixture: f } as any)})
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

    return await bitacora("ok", { vivos, candidatos: candidatosN, llamadas: api.llamadas, alertas: alertasNuevas, resueltas, detalle, radar: fotoRadar() });
  } catch (e) {
    detalle.error = (e as Error).message;
    const motivo = e instanceof SinPresupuesto ? "presupuesto" : "error";
    return await bitacora(motivo, { vivos, candidatos: candidatosN, llamadas: api.llamadas, alertas: alertasNuevas, resueltas, detalle, radar: lista.length ? fotoRadar() : null });
  }
});
