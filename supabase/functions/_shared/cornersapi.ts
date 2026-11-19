// =====================================================================
// Fotos de cuotas de CÓRNERS desde API-Football (DECISIONES 51, 19 nov 2026).
// Por qué: Flashscore no trae mercado de córners y sin cuota no se puede saber si un mercado gana plata.
// La sonda del 19 nov mostró que UNA consulta a /odds/live (sin parámetros) devuelve TODOS los partidos
// en vivo con sus cuotas, córners incluidos. Así que cada "foto" cuesta 1 consulta, sin importar cuántos
// partidos haya.
//
// Cómo se reparte el cupo (poka-yoke contra quemarlo temprano):
//   intervalo = minutos de horario que quedan hasta las 00:00 UTC (cuando la API reinicia el cupo)
//               ÷ consultas que quedan, nunca menos de corners_api_fotos_min_intervalo.
//   Tope propio del módulo: corners_api_fotos_max_dia (85), siempre dentro del presupuesto general
//   (presupuesto_diario − reserva_api) y registrado en futbol.api_uso como toda consulta.
// Solo se toma foto si hay algún partido donde importa: 1T desde el 10' o 2T desde el 60'.
//
// De quién es cada cuota: /odds/live solo trae el id del fixture de API-Football. La primera vez que
// aparece un id se pide /fixtures?live=all (1 consulta, trae nombres) y se empareja con la lista de
// Flashscore (misma función que el emparejamiento de siempre). Queda en futbol.api_fs_pareja.
// Córners del momento: Flashscore df_st (gratis), hasta corners_api_stats_max partidos por foto.
// =====================================================================
import { sql, Config } from "./db.ts";
import * as FS from "./flashscore.ts";
import { ApiFootball, estadoPresupuesto } from "./apifootball.ts";

const num = (x: unknown) => { const n = parseFloat(String(x ?? "")); return Number.isFinite(n) ? n : null; };

/** Mercado de córners tal como lo da la API (solo los valores no suspendidos). */
export interface MercadoCorners { name: string; values: { value: string; handicap: string | null; odd: string }[] }

/** "Over 5.5" con handicap null, o value "Over" con handicap "5.5": devuelve [lado, línea]. */
function ladoLinea(v: { value: string; handicap: string | null }): [string, number | null] {
  const lado = String(v.value).trim().split(/\s+/)[0].toLowerCase();
  return [lado, num(v.handicap) ?? num(String(v.value).replace(/^\s*(over|under|exactly)\s*/i, ""))];
}

const esDe1T = (n: string) => /1st half|first half/i.test(n);
const esDe2T = (n: string) => /2nd half|second half/i.test(n);
/** Mercados de TOTAL de córners (no por equipo, no carreras, no "quién saca el siguiente"). */
const esTotal = (n: string) => /corner/i.test(n) && !/team|home|away|race|which|last|first corner|1x2/i.test(n) &&
  (!/handicap/i.test(n) || /corners asian handicap/i.test(n));
/** Líneas enteras de 3 vías: "Over 2" = 3 o más (equivale a la línea 2,5). */
const esEntera = (n: string) => /match corners|3 ?way/i.test(n);

export interface Oferta {
  hay: boolean;                                                   // la casa ofrece córners de ese tiempo
  exacta: { cuota: number; mercado: string } | null;              // la línea del aviso
  cercana: { linea: number; cuota: number; mercado: string } | null; // si no está, la más cercana por encima
}

/** Busca en los mercados de una foto la cuota del Over de córners para la línea pedida. */
export function ofertaCorners(mercados: MercadoCorners[], alcance: "1T" | "partido", linea: number): Oferta {
  const out: Oferta = { hay: false, exacta: null, cercana: null };
  for (const m of mercados ?? []) {
    const n = String(m.name ?? "");
    if (!esTotal(n)) continue;
    if (alcance === "1T" ? !esDe1T(n) : (esDe1T(n) || esDe2T(n))) continue;
    for (const v of m.values ?? []) {
      const [lado, l0] = ladoLinea(v);
      const o = num(v.odd);
      if (lado !== "over" || l0 === null || o === null || o <= 1) continue;
      out.hay = true;
      const l = esEntera(n) ? l0 + 0.5 : l0;   // "Over 2" de 3 vías = más de 2,5
      if (Math.abs(l - linea) < 1e-6) {
        // Si hay varias, gana "Total Corners" (la más estándar)
        if (!out.exacta || /total corners/i.test(n)) out.exacta = { cuota: o, mercado: n };
      } else if (l > linea && (!out.cercana || l < out.cercana.linea)) {
        out.cercana = { linea: l, cuota: o, mercado: n };
      }
    }
  }
  return out;
}

/** Primer par Over/Under de un mercado: [línea, over, under]. */
function principal(mercados: MercadoCorners[], re: RegExp): [number | null, number | null, number | null] {
  const m = mercados.find((x) => re.test(x.name));
  if (!m) return [null, null, null];
  let l: number | null = null, over: number | null = null, under: number | null = null;
  for (const v of m.values) {
    const [lado, li] = ladoLinea(v);
    if (lado === "over" && over === null) { over = num(v.odd); l = li; }
    if (lado === "under" && under === null && (l === null || li === l)) { under = num(v.odd); l = l ?? li; }
  }
  return [l, over, under];
}
function tresVias(mercados: MercadoCorners[]): [number | null, number | null, number | null, number | null] {
  const m = mercados.find((x) => /total corners \(3 ?way\) \(1st half\)/i.test(x.name));
  if (!m) return [null, null, null, null];
  let l: number | null = null, o: number | null = null, e: number | null = null, u: number | null = null;
  for (const v of m.values) {
    const [lado, li] = ladoLinea(v);
    if (lado === "over") { o = num(v.odd); l = li; }
    if (lado === "exactly") e = num(v.odd);
    if (lado === "under") u = num(v.odd);
  }
  return [l, o, e, u];
}

/** Minutos de horario activo desde ahora hasta las 00:00 UTC (cuando la API reinicia el cupo). */
function minutosActivosHastaReinicio(horas: number[], ahora = new Date()): number {
  const h0 = ahora.getUTCHours();
  let min = 0;
  for (let h = h0; h < 24; h++) {
    if (!horas.includes(h)) continue;
    min += h === h0 ? 60 - ahora.getUTCMinutes() : 60;
  }
  return min;
}

async function contadorHoy(): Promise<{ fecha: string; n: number }> {
  const hoy = new Date().toISOString().slice(0, 10);
  const [r] = await sql`select valor from futbol.config where clave = 'corners_api_consultas_hoy'`;
  const v = r?.valor;
  return v && v.fecha === hoy ? { fecha: hoy, n: Number(v.n ?? 0) } : { fecha: hoy, n: 0 };
}
async function sumarContador(n: number) {
  if (!n) return;
  const c = await contadorHoy();
  const v = { fecha: c.fecha, n: c.n + n };
  await sql`insert into futbol.config (clave, valor, descripcion) values ('corners_api_consultas_hoy', ${sql.json(v)},
              'Córners: consultas de API usadas hoy (UTC) por las fotos (la escribe el escáner)')
            on conflict (clave) do update set valor = excluded.valor, actualizado = now()`;
}

/** Reserva atómica del turno de foto (solo un ciclo concurrente la gana). */
async function reservarTurno(minutos: number): Promise<boolean> {
  await sql`insert into futbol.config (clave, valor, descripcion)
            values ('corners_api_ultima_foto', to_jsonb('2000-01-01T00:00:00Z'::text), 'Córners: hora de la última foto de /odds/live (la escribe el escáner)')
            on conflict do nothing`;
  const r = await sql`update futbol.config set valor = to_jsonb(now()::text), actualizado = now()
                      where clave = 'corners_api_ultima_foto'
                        and (valor #>> '{}')::timestamptz <= now() - make_interval(secs => ${Math.max(0, minutos * 60 - 30)}::float8)
                      returning 1`;
  return r.length > 0;
}

export interface ResultadoFoto { tomada: boolean; motivo: string; filas: number; consultas: number; intervalo_min?: number }

/**
 * Toma una foto de las cuotas de córners de todos los partidos en vivo.
 * forzada = la pide un aviso de córners que no tiene foto reciente: ignora el reparto y la condición
 * de partidos útiles, pero nunca el presupuesto ni el tope diario.
 */
export async function fotoCornersApi(args: { cfg: Config; vivosFS: FS.PartidoFS[]; log: (s: string) => void; forzada?: boolean }): Promise<ResultadoFoto> {
  const { cfg, vivosFS, log, forzada = false } = args;
  const no = (motivo: string, extra: Partial<ResultadoFoto> = {}): ResultadoFoto => ({ tomada: false, motivo, filas: 0, consultas: 0, ...extra });
  if (cfg.corners_api_fotos !== true) return no("apagada");
  const key = Deno.env.get("APIFOOTBALL_KEY")?.trim() ?? "";
  if (!key) return no("sin_llave");

  const enVivo = vivosFS.filter((p) => p.estado === 2);
  const util = (p: FS.PartidoFS) => {
    const em = FS.estadoYMinuto(p);
    return em.minuto !== null && ((em.estado === "1H" && em.minuto >= 10) || (em.estado === "2H" && em.minuto >= 60));
  };
  if (!forzada && !enVivo.some(util)) return no("sin_partidos_utiles");

  const horas: number[] = cfg.horas_activas_utc ?? [];
  if (!forzada && !horas.includes(new Date().getUTCHours())) return no("fuera_de_horario");

  // Cupo: el menor entre el presupuesto general (con reserva) y el tope propio de las fotos
  const est = await estadoPresupuesto(cfg);
  const c = await contadorHoy();
  const cupo = Math.min(est.disponibles, Math.max(0, Number(cfg.corners_api_fotos_max_dia ?? 85) - c.n));
  if (cupo < 1) return no("sin_cupo");

  // Reparto: ~1 de cada 3 fotos necesita además emparejar partidos nuevos → se divide por 1,3
  const minIntervalo = Math.max(2, Number(cfg.corners_api_fotos_min_intervalo ?? 5));
  const activos = minutosActivosHastaReinicio(horas);
  const intervalo = Math.max(minIntervalo, Math.round(activos / (cupo / 1.3)));
  if (!(await reservarTurno(forzada ? 1 : intervalo))) return no("intervalo", { intervalo_min: intervalo });

  const api = new ApiFootball(key, { ...est, disponibles: cupo });
  try {
    const odds = await api.get("/odds/live", {});
    const ts = new Date().toISOString();
    // Solo partidos con algún mercado de córners
    const items = (odds.response ?? []).map((r: any) => ({
      id: Number(r.fixture?.id),
      minuto: num(r.fixture?.status?.elapsed),
      periodo: r.fixture?.status?.long ?? null,
      gl: num(r.teams?.home?.goals), gv: num(r.teams?.away?.goals),
      mercados: (r.odds ?? []).filter((m: any) => /corner/i.test(String(m.name ?? ""))).map((m: any) => ({
        name: String(m.name),
        values: (m.values ?? []).filter((v: any) => !v.suspended)
          .map((v: any) => ({ value: String(v.value), handicap: v.handicap == null ? null : String(v.handicap), odd: String(v.odd) })),
      })) as MercadoCorners[],
    })).filter((x: any) => Number.isFinite(x.id) && x.mercados.length);

    // ---- Emparejar los fixtures nuevos con Flashscore ----
    const pareja = new Map<number, any>();
    if (items.length) {
      for (const r of await sql`select * from futbol.api_fs_pareja where fixture_api = any(${items.map((x: any) => x.id)}::int[])`) pareja.set(r.fixture_api, r);
    }
    const nuevos = items.filter((x: any) => !pareja.has(x.id));
    if (nuevos.length && api.quedan() > 0) {
      try {
        const fx = await api.get("/fixtures", { live: "all" });
        const porId = new Map<number, any>((fx.response ?? []).map((f: any) => [Number(f.fixture.id), f]));
        const lista: FS.FixtureApi[] = nuevos.map((x: any) => porId.get(x.id)).filter(Boolean).map((f: any) => ({
          fixture_id: Number(f.fixture.id), local: String(f.teams.home.name), visitante: String(f.teams.away.name),
          kickoff: Date.parse(f.fixture.date),
        }));
        const yaUsados = new Set((await sql`select fs_id from futbol.api_fs_pareja where fs_id = any(${enVivo.map((p) => p.id)}::text[])`)
          .map((r: any) => r.fs_id));
        const mapa = FS.emparejar(enVivo.filter((p) => !yaUsados.has(p.id)), lista);
        const fsDe = new Map<number, { fs: string; puntaje: number }>();
        for (const [fs, m] of mapa) fsDe.set(m.fixture_id, { fs, puntaje: m.puntaje });
        for (const x of nuevos) {
          const f = porId.get(x.id);
          const m = fsDe.get(x.id);
          const [fila] = await sql`
            insert into futbol.api_fs_pareja (fixture_api, fs_id, puntaje, liga, local, visitante, inicio)
            values (${x.id}, ${m?.fs ?? null}, ${m?.puntaje ?? null},
                    ${f ? `${f.league?.country ?? ""}: ${f.league?.name ?? ""}` : null},
                    ${f?.teams?.home?.name ?? null}, ${f?.teams?.away?.name ?? null}, ${f ? f.fixture.date : null})
            on conflict (fixture_api) do nothing returning *`;
          if (fila) pareja.set(x.id, fila);
        }
        log(`córners api: ${fsDe.size}/${nuevos.length} fixtures nuevos emparejados con Flashscore`);
      } catch (e) { log(`córners api: emparejar: ${(e as Error).message}`); }
    }

    // ---- Córners del momento (Flashscore): primero los del 1T, luego el 2T ----
    const fsVivo = new Map(enVivo.map((p) => [p.id, p]));
    const prioridad = (x: any) => /first/i.test(String(x.periodo)) ? 0 : /second/i.test(String(x.periodo)) ? 1 : 2;
    const conCorners = new Map<string, FS.CornersFS>();
    const tope = Math.max(0, Number(cfg.corners_api_stats_max ?? 20));
    for (const x of [...items].sort((a: any, b: any) => prioridad(a) - prioridad(b))) {
      const fs = pareja.get(x.id)?.fs_id;
      if (!fs || !fsVivo.has(fs) || prioridad(x) > 1) continue;
      if (conCorners.size >= tope) break;
      try { conCorners.set(fs, await FS.corners(fs)); } catch (e) { log(`córners api: stats ${fs}: ${(e as Error).message}`); }
    }

    // ---- Guardar una fila por partido ----
    let filas = 0;
    for (const x of items) {
      const par = pareja.get(x.id);
      const fs: string | null = par?.fs_id ?? null;
      const p = fs ? fsVivo.get(fs) : null;
      const ck = fs ? conCorners.get(fs) : undefined;
      const t1 = ck ? (ck.t1 ?? (/first/i.test(String(x.periodo)) ? ck.partido : null)) : null;
      const [t1l, t1o, t1u] = principal(x.mercados, /corners asian handicap \(1st half\)/i);
      const [w3l, w3o, w3e, w3u] = tresVias(x.mercados);
      const [tl, to, tu] = principal(x.mercados, /^total corners$/i);
      await sql`
        insert into futbol.corners_cuotas_api (ts, fixture_api, fs_id, liga, local, visitante, periodo, minuto, goles_local, goles_visitante,
          corners_local, corners_visitante, corners_1t_local, corners_1t_visitante,
          t1_linea, t1_over, t1_under, t1_3w_linea, t1_3w_over, t1_3w_exacto, t1_3w_under, tot_linea, tot_over, tot_under, mercados)
        values (${ts}, ${x.id}, ${fs}, ${p?.liga ?? par?.liga ?? null}, ${p?.local ?? par?.local ?? null}, ${p?.visitante ?? par?.visitante ?? null},
          ${x.periodo}, ${x.minuto}, ${x.gl}, ${x.gv},
          ${ck?.partido?.[0] ?? null}, ${ck?.partido?.[1] ?? null}, ${t1?.[0] ?? null}, ${t1?.[1] ?? null},
          ${t1l}, ${t1o}, ${t1u}, ${w3l}, ${w3o}, ${w3e}, ${w3u}, ${tl}, ${to}, ${tu}, ${sql.json(x.mercados as any)})`;
      filas++;
    }
    log(`córners api: foto ${forzada ? "forzada " : ""}con ${filas} partidos (${conCorners.size} con córners leídos), ${api.llamadas} consulta(s), próxima en ~${intervalo} min`);
    return { tomada: true, motivo: forzada ? "forzada" : "turno", filas, consultas: api.llamadas, intervalo_min: intervalo };
  } catch (e) {
    log(`córners api: foto: ${(e as Error).message}`);
    return { tomada: false, motivo: "error", filas: 0, consultas: api.llamadas };
  } finally {
    await sumarContador(api.llamadas);
  }
}

/** La foto más reciente de un partido de Flashscore, si no es más vieja que `vigencia` minutos. */
export async function fotoReciente(fsId: string, vigenciaMin: number): Promise<{ id: number; mercados: MercadoCorners[]; minuto: number | null } | null> {
  const [f] = await sql`select id, mercados, minuto from futbol.corners_cuotas_api
                        where fs_id = ${fsId} and ts > now() - make_interval(mins => ${vigenciaMin}) order by ts desc limit 1`;
  return f ? { id: Number(f.id), mercados: f.mercados, minuto: f.minuto } : null;
}
