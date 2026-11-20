// =====================================================================
// Cuotas de BetPlay y Rushbet desde el escáner (DECISIONES 54, Fredy 20 nov 2026).
// Las dos casas usan la plataforma Kambi, que publica sus cuotas en un feed JSON público (sin login).
// El servidor de América (us.offering-api.kambicdn.com) le responde a Supabase; el de Europa da 429.
// Fredy autorizó leerlo para uso personal (19 nov). Pedidos normales, sin disfrazar cabeceras.
//
// Para qué (Fredy, 20 nov): "tengo dinero en BetPlay y Rushbet. Con eso sé si existen los partidos y así
// no me envías notificaciones de partidos que no tienen mercados… y me puede indicar de cuánto era la cuota".
//   · Goles (alerta principal y gol temprano) y córners: sin la línea en BetPlay ni Rushbet NO hay push.
//     La alerta igual se guarda, con el motivo, para el histórico.
//   · Cada push muestra la cuota de BetPlay y Rushbet en ese momento, y el monto sale con la más baja.
//
// Cuánto pide en cada ciclo:
//   1. La lista de partidos en vivo de cada casa (1 pedido por casa). Trae marcador, minuto y córners.
//   2. Las cuotas completas (1 pedido por partido) solo de los que importan: candidatos de goles, gol temprano
//      vigilado y las franjas de córners. Máximo kambi_max_eventos por casa y una lectura cada
//      kambi_intervalo_min por partido. Si una push necesita una cuota más fresca, se pide en ese momento.
// =====================================================================
import { sql, Config } from "./db.ts";
import * as FS from "./flashscore.ts";

type Log = (s: string) => void;
export type TipoCuota = "goles" | "goles_1t" | "corners" | "corners_1t";
export const NOMBRE_CASA: Record<string, string> = { betplay: "BetPlay", rushbet: "Rushbet" };
const CRITERIOS: Record<string, TipoCuota> = {
  "Total Goals": "goles", "Total Goals - 1st Half": "goles_1t",
  "Total Corners": "corners", "Total Corners - 1st Half": "corners_1t",
};
const PARAMS = "lang=en_GB&market=CO&client_id=2&channel_id=1";
const UA = "Mozilla/5.0 (compatible; ADN-Soccer/1.0)";

const entero = (x: unknown) => { const n = parseInt(String(x ?? ""), 10); return Number.isFinite(n) ? n : null; };
/** Clave de una línea en las escaleras: 2.5 → "2.5" (igual para 2,50 que viene de la base como texto). */
export const claveLinea = (l: number | string) => String(Number(l));

interface EventoKambi {
  casa: string; codigo: string; id: number; local: string; visitante: string; inicio: number; liga: string;
  periodo: string; minuto: number | null; gl: number | null; gv: number | null; cl: number | null; cv: number | null;
}

export interface OfertaCasa {
  /** ofrece = alguna casa tiene la línea · sin_linea = tienen el mercado, no esa línea · sin_mercado · sin_partido
   *  (ninguna casa tiene el partido en vivo) · sin_lectura (lo tienen, pero aún no hay cuotas leídas) · kambi_caido (no respondió) · apagado (kambi_activo = false) */
  estado: "ofrece" | "sin_linea" | "sin_mercado" | "sin_partido" | "sin_lectura" | "kambi_caido" | "apagado";
  casas: { casa: string; c: number }[];                       // la línea pedida, de mayor a menor
  cercana: { linea: number; casas: { casa: string; c: number }[] } | null;   // si no está, la más cercana por encima
  /** DECISIONES 67: sin_mercado, pero ese mercado sí estaba en una lectura de los últimos kambi_suspension_min
   *  minutos. Es una suspensión (gol, penal, VAR, córner a punto de cobrarse), no un partido sin córners. */
  suspendido?: boolean;
}

export interface Kambi {
  activo: boolean;
  /** Al menos una casa respondió la lista en vivo de este ciclo. */
  ok: boolean;
  pareja: Map<string, EventoKambi[]>;
  /** DECISIONES 66: fsId → "Local - Visitante" de Kambi cuando solo un equipo encaja (pareja dudosa, a revisar). */
  dudosos: Map<string, string>;
  resumen: Record<string, unknown>;
  oferta(fsId: string, tipo: TipoCuota, linea: number, opts?: { goles?: number }): Promise<OfertaCasa>;
}

// Por dónde se pide. Kambi le responde 410 a las Edge Functions (DECISIONES 55) y un GET encolado en pg_net
// desde el escáner espera a que el escáner termine (DECISIONES 56). Por eso, con kambi_via = "cola" (por
// defecto), un cron de la base (futbol.kambi_encolar, cada minuto) hace los pedidos y aquí solo se leen las
// respuestas que ya llegaron. "fetch" pide directo desde la función (por si Kambi vuelve a responderle).
let via = "cola";
async function pedir(url: string): Promise<any> {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`kambi ${r.status}`);
  return await r.json();
}

function esEsports(e: any): boolean {
  const t = `${e?.group ?? ""} ${(e?.path ?? []).map((p: any) => p.englishName).join(" ")} ${e?.name ?? ""}`;
  return /e-?sports?|esoccer|cyber|virtual|\(.*esports.*\)/i.test(t);
}

async function listaVivo(servidor: string, casa: string, codigo: string): Promise<EventoKambi[]> {
  return parseLista(await pedir(`https://${servidor}/offering/v2018/${codigo}/listView/football/all/all/all/in-play.json?${PARAMS}&useCombined=true`), casa, codigo);
}
function parseLista(j: any, casa: string, codigo: string): EventoKambi[] {
  const out: EventoKambi[] = [];
  for (const x of j?.events ?? []) {
    const e = x.event ?? {}, live = x.liveData ?? {};
    if (!e.id || esEsports(e)) continue;
    const reloj = live.matchClock ?? {}, st = live.statistics?.football ?? {};
    out.push({
      casa, codigo, id: Number(e.id), local: String(e.homeName ?? ""), visitante: String(e.awayName ?? ""),
      inicio: Date.parse(e.start ?? "") || 0,
      liga: (e.path ?? []).slice(1).map((p: any) => p.englishName).join(" / ") || String(e.group ?? ""),
      periodo: String(reloj.period ?? ""), minuto: entero(reloj.minute),
      gl: entero(live.score?.home), gv: entero(live.score?.away),
      cl: entero(st.home?.corners), cv: entero(st.away?.corners),
    });
  }
  return out;
}

/** Cuotas de un partido: escaleras de Over por tipo y los mercados de goles y córners compactos. */
async function cuotasEvento(servidor: string, codigo: string, id: number) {
  return parseEvento(await pedir(`https://${servidor}/offering/v2018/${codigo}/betoffer/event/${id}.json?${PARAMS}&includeParticipants=true`));
}
function parseEvento(j: any) {
  const esc: Record<TipoCuota, Record<string, number>> = { goles: {}, goles_1t: {}, corners: {}, corners_1t: {} };
  const mercados: any[] = [];
  for (const bo of j?.betOffers ?? []) {
    const nombre = String(bo.criterion?.englishLabel ?? bo.criterion?.label ?? "");
    if (!/corner|^total goals|asian total/i.test(nombre) || /scorer|player/i.test(nombre)) continue;
    const tipo = CRITERIOS[nombre];
    const lineas: any[] = [];
    for (const o of bo.outcomes ?? []) {
      if ((o.status && o.status !== "OPEN") || o.odds == null) continue;
      const linea = o.line != null ? o.line / 1000 : null, cuota = o.odds / 1000;
      const lado = String(o.englishLabel ?? o.label ?? "");
      lineas.push({ lado, linea, cuota });
      if (tipo && linea !== null && /^over$/i.test(lado) && cuota > 1) esc[tipo][claveLinea(linea)] = cuota;
    }
    if (lineas.length) mercados.push({ nombre, lineas });
  }
  return { esc, mercados };
}

/** Lee las cuotas de un partido en una casa y guarda la fila. Devuelve la fila guardada (o null si falló). */
async function leerYGuardar(servidor: string, e: EventoKambi, fsId: string, fixtureId: number | null, log: Log) {
  try {
    return await guardar(e, fsId, fixtureId, await cuotasEvento(servidor, e.codigo, e.id));
  } catch (err) {
    log(`kambi: ${e.casa} ${e.local}-${e.visitante}: ${(err as Error).message}`);
    return null;
  }
}
async function guardar(e: EventoKambi, fsId: string | null, fixtureId: number | null, c: ReturnType<typeof parseEvento>) {
  {
    const { esc, mercados } = c;
    const vacio = (o: Record<string, number>) => Object.keys(o).length ? sql.json(o) : null;
    const [r] = await sql`
      insert into futbol.cuotas_casa (casa, evento_id, fs_id, fixture_id, liga, local, visitante, periodo, minuto,
        goles_local, goles_visitante, corners_local, corners_visitante, goles, goles_1t, corners, corners_1t, mercados)
      values (${e.casa}, ${e.id}, ${fsId}, ${fixtureId}, ${e.liga}, ${e.local}, ${e.visitante}, ${e.periodo}, ${e.minuto},
        ${e.gl}, ${e.gv}, ${e.cl}, ${e.cv}, ${vacio(esc.goles)}, ${vacio(esc.goles_1t)}, ${vacio(esc.corners)}, ${vacio(esc.corners_1t)},
        ${sql.json(mercados)})
      returning casa, ts, goles_local, goles_visitante, goles, goles_1t, corners, corners_1t`;
    return r;
  }
}

/**
 * Franjas de córners para pedir cuotas ANTES de que el aviso dispare (20 nov, Fredy: "mañana se viene mucho
 * fútbol"). Antes la franja estaba fija (15'-38' y 72'-82') y empezaba justo en el minuto del aviso (15' y 70'
 * en la config actual): el aviso preguntaba por la cuota en el mismo ciclo en que el partido entraba a la cola,
 * y la lectura llegaba 2 min después ("sin lectura" en 19 de 27 casos el 20 nov). Ahora la franja sale de la
 * config de córners y empieza kambi_anticipo_min antes. Devuelve los minutos que faltan para la ventana
 * (0 = ya está dentro) o null si no hace falta leerlo.
 */
function franjaCorners(cfg: Config, p: FS.PartidoFS, cornersKambi: number | null): number | null {
  const em = FS.estadoYMinuto(p);
  if (em.minuto === null) return null;
  const m = em.minuto, ant = Math.max(0, Number(cfg.kambi_anticipo_min ?? 8));
  if (em.estado === "1H") {
    // Con 2 o más córners ya no puede avisar ningún mercado del 1T (0 córners o exactamente 1)
    if (cornersKambi !== null && cornersKambi >= 2) return null;
    const desde = Math.min(Number(cfg.corners_1t_min_desde ?? 20), Number(cfg.corners_1t_uno_desde ?? 28));
    const hasta = Math.max(Number(cfg.corners_1t_min_hasta ?? 26), Number(cfg.corners_1t_uno_hasta ?? 37)) + 1;
    return m >= desde - ant && m <= hasta ? Math.max(0, desde - m) : null;
  }
  if (em.estado === "2H") {
    const desde = Number(cfg.corners_2t_min_desde ?? 77), hasta = Number(cfg.corners_2t_min_hasta ?? 80) + 1;
    return m >= desde - ant && m <= hasta ? Math.max(0, desde - m) : null;
  }
  return null;
}

/**
 * Un ciclo: lista en vivo de cada casa, emparejamiento con Flashscore y lectura de cuotas de los partidos
 * que importan. Devuelve el objeto con `oferta()` para preguntar, al momento de cada push, qué ofrecen.
 */
export async function cicloKambi(args: {
  cfg: Config; vivosFS: FS.PartidoFS[]; fixtureDe: (fsId: string) => number | null;
  prioridad: Set<string>; log: Log;
  /** DECISIONES 62: los que deciden una push de goles (candidatos, alertas abiertas, gol temprano): el cron los pide cada 30 s. */
  urgente?: Set<string>;
}): Promise<Kambi> {
  const { cfg, vivosFS, fixtureDe, prioridad, log } = args;
  const urgente = args.urgente ?? new Set<string>();
  const activo = cfg.kambi_activo !== false;
  via = String(cfg.kambi_via ?? "cola") === "fetch" ? "fetch" : "cola";
  const servidor = String(cfg.kambi_servidor ?? "us.offering-api.kambicdn.com");
  const casas: Record<string, string> = (cfg.kambi_casas && typeof cfg.kambi_casas === "object")
    ? cfg.kambi_casas as Record<string, string> : { betplay: "betplay", rushbet: "rsico" };
  const intervalo = Math.max(1, Number(cfg.kambi_intervalo_min ?? 3));
  const maxEv = Math.max(0, Number(cfg.kambi_max_eventos ?? 40));
  const vig = Math.max(1, Number(cfg.kambi_vigencia_min ?? 5));
  const pareja = new Map<string, EventoKambi[]>();
  const dudosos = new Map<string, string>();
  const resumen: Record<string, unknown> = {};
  let ok = false;

  const enVivo = vivosFS.filter((p) => p.estado === 2);
  if (activo && enVivo.length) {
    const porFs = new Map(enVivo.map((p) => [p.id, p]));
    await Promise.all(Object.entries(casas).filter(([casa]) => NOMBRE_CASA[casa]).map(async ([casa, codigo]) => {
      let lista: EventoKambi[];
      try {
        if (via === "fetch") lista = await listaVivo(servidor, casa, codigo);
        else {
          // La lista más nueva que trajo el cron (máximo 3 min)
          const [r] = await sql`select ts, status_code, content from futbol.kambi_listas(3) where casa = ${casa}`;
          if (!r) throw new Error("sin lista reciente en la cola");
          if (r.status_code !== 200) throw new Error(`kambi ${r.status_code}`);
          lista = parseLista(JSON.parse(r.content), casa, codigo);
        }
      }
      catch (e) { log(`kambi: lista ${casa}: ${(e as Error).message}`); resumen[casa] = { error: (e as Error).message }; return; }
      ok = true;
      const porId = new Map(lista.map((e) => [e.id, e]));
      const comoApi = lista.map((e) => ({ fixture_id: e.id, local: e.local, visitante: e.visitante, kickoff: e.inicio }));
      const pares = FS.emparejar(enVivo, comoApi);
      for (const [fsId, evId] of FS.dudosos(enVivo, comoApi, pares)) {
        const e = porId.get(evId);
        if (e && !dudosos.has(fsId)) dudosos.set(fsId, `${e.local} - ${e.visitante}`);
      }
      for (const [fsId, { fixture_id }] of pares) {
        const e = porId.get(fixture_id);
        if (e) pareja.set(fsId, [...(pareja.get(fsId) ?? []), e]);
      }
      // Qué leer: prioridad (candidatos, gol temprano) primero; luego las franjas de córners
      // (dentro de las franjas, el que está más cerca de su ventana primero, por si se llega al tope)
      const falta = new Map<string, number>();
      for (const fs of pares.keys()) {
        const p = porFs.get(fs), e = porId.get(pares.get(fs)!.fixture_id);
        const ck = e && e.cl !== null && e.cv !== null ? e.cl + e.cv : null;
        const f = p ? franjaCorners(cfg, p, ck) : null;
        if (prioridad.has(fs)) falta.set(fs, -1);
        else if (f !== null) falta.set(fs, f);
      }
      const quiere = [...falta.keys()].sort((a, b) => falta.get(a)! - falta.get(b)!);
      if (quiere.length > maxEv) log(`kambi: ${casa} quiere ${quiere.length} partidos, tope kambi_max_eventos = ${maxEv}`);
      if (via === "cola") {
        // 1. Guardar las cuotas que trajo el cron desde el ciclo anterior (la más nueva de cada partido)
        let guardadas = 0;
        for (const r of await sql`select * from futbol.kambi_eventos() where casa = ${casa}`) {
          try {
            if (r.status_code !== 200) continue;
            const e = porId.get(Number(r.evento_id));   // minuto, marcador y córners de la lista actual
            if (!e) continue;                          // ya no está en vivo
            const fs = [...pares.entries()].find(([, v]) => v.fixture_id === e.id)?.[0] ?? r.fs_id;
            if (await guardar(e, fs, fs ? fixtureDe(fs) ?? r.fixture_id : r.fixture_id, parseEvento(JSON.parse(r.content)))) guardadas++;
          } catch (err) { log(`kambi: evento ${casa} ${r.evento_id}: ${(err as Error).message}`); }
          finally {
            await sql`update futbol.kambi_pedidos set procesado = true
                      where casa = ${casa} and evento_id = ${r.evento_id} and not procesado and ts <= ${r.ts}`;
          }
        }
        // 2. Pedirle al cron los partidos que importan durante los próximos 6 min
        const pedir = quiere.slice(0, maxEv);
        for (const fs of pedir) {
          const e = pareja.get(fs)!.find((x) => x.casa === casa)!;
          // La columna urgente la crea la migración futbol_kambi_urgente (junto con kambi_urgente_seg en config):
          // sin esa fila de config se inserta como antes, para no romper la cola si la migración no está.
          if (cfg.kambi_urgente_seg == null) {
            await sql`insert into futbol.kambi_quiero (casa, evento_id, fs_id, fixture_id, hasta)
                      values (${casa}, ${e.id}, ${fs}, ${fixtureDe(fs)}, now() + interval '6 minutes')
                      on conflict (casa, evento_id) do update set hasta = excluded.hasta, fs_id = excluded.fs_id, fixture_id = excluded.fixture_id`;
            continue;
          }
          await sql`insert into futbol.kambi_quiero (casa, evento_id, fs_id, fixture_id, hasta, urgente)
                    values (${casa}, ${e.id}, ${fs}, ${fixtureDe(fs)}, now() + interval '6 minutes', ${urgente.has(fs)})
                    on conflict (casa, evento_id) do update set hasta = excluded.hasta, fs_id = excluded.fs_id,
                      fixture_id = excluded.fixture_id, urgente = excluded.urgente`;
        }
        resumen[casa] = { en_vivo: lista.length, emparejados: pares.size, guardadas, pedidos: pedir.length, quiere: quiere.length };
        return;
      }
      const recientes = quiere.length ? new Set((await sql`select distinct fs_id from futbol.cuotas_casa
          where casa = ${casa} and fs_id = any(${quiere}::text[])
            and ts > now() - make_interval(secs => ${intervalo * 60 - 30}::float8)`).map((r: any) => r.fs_id)) : new Set();
      const leer = quiere.filter((fs) => !recientes.has(fs)).slice(0, maxEv);
      let leidas = 0;
      for (let i = 0; i < leer.length; i += 3) {   // de a 3 pedidos a la vez
        const r = await Promise.all(leer.slice(i, i + 3).map((fs) => {
          const e = pareja.get(fs)!.find((x) => x.casa === casa)!;
          return leerYGuardar(servidor, e, fs, fixtureDe(fs), log);
        }));
        leidas += r.filter(Boolean).length;
      }
      resumen[casa] = { en_vivo: lista.length, emparejados: pares.size, leidas };
    }));
    log(`kambi: ${JSON.stringify(resumen)}`);
  }

  async function oferta(fsId: string, tipo: TipoCuota, linea: number, opts?: { goles?: number }): Promise<OfertaCasa> {
    const vacia = (estado: OfertaCasa["estado"]): OfertaCasa => ({ estado, casas: [], cercana: null });
    if (!activo) return vacia("apagado");
    if (!ok) return vacia("kambi_caido");
    const evs = pareja.get(fsId) ?? [];
    if (!evs.length) return vacia("sin_partido");
    const goles = opts?.goles;
    const frescas = async () => await sql`
      select distinct on (casa) casa, ts, goles_local, goles_visitante, goles, goles_1t, corners, corners_1t
      from futbol.cuotas_casa
      where fs_id = ${fsId} and ts > now() - make_interval(mins => ${vig})
        and (${goles ?? null}::int is null or goles_local + goles_visitante = ${goles ?? null}::int)
      order by casa, ts desc`;
    let filas = await frescas();
    // Falta alguna casa (o la lectura es vieja / de otro marcador): se pide ahora
    const tienen = new Set(filas.map((f: any) => f.casa));
    const faltan = evs.filter((e) => !tienen.has(e.casa));
    if (faltan.length && via === "fetch") {
      await Promise.all(faltan.map((e) => leerYGuardar(servidor, e, fsId, fixtureDe(fsId), log)));
      filas = await frescas();
    }
    const exacta: { casa: string; c: number }[] = [];
    const otras = new Map<number, { casa: string; c: number }[]>();
    let conMercado = false;
    const k = claveLinea(linea);
    if (!filas.length) return vacia("sin_lectura");   // emparejado, pero el cron todavía no trajo sus cuotas
    for (const f of filas) {
      const esc = (f[tipo] ?? {}) as Record<string, number>;
      if (!Object.keys(esc).length) continue;
      conMercado = true;
      const nombre = NOMBRE_CASA[f.casa] ?? f.casa;
      if (esc[k] != null) exacta.push({ casa: nombre, c: Number(esc[k]) });
      for (const [l, c] of Object.entries(esc)) {
        const n = Number(l);
        if (n > linea) otras.set(n, [...(otras.get(n) ?? []), { casa: nombre, c: Number(c) }]);
      }
    }
    const orden = (a: { c: number }, b: { c: number }) => b.c - a.c;
    if (exacta.length) return { estado: "ofrece", casas: exacta.sort(orden), cercana: null };
    if (!conMercado) {
      // DECISIONES 67 (Al Ahli–Al Nassr, 20 nov): la casa cierra el mercado unos segundos tras un gol o en una
      // jugada de peligro. Si lo tenía hace poco, se marca como suspendido para que el aviso espere.
      const min = Math.max(1, Number(cfg.kambi_suspension_min ?? 10));
      const [r] = await sql`
        select exists (select 1 from futbol.cuotas_casa c
                       where c.fs_id = ${fsId} and c.ts > now() - make_interval(mins => ${min})
                         and jsonb_typeof(to_jsonb(c) -> ${tipo}::text) = 'object'
                         and to_jsonb(c) -> ${tipo}::text <> '{}'::jsonb) as habia`;
      return { ...vacia("sin_mercado"), suspendido: !!r?.habia };
    }
    const l = [...otras.keys()].sort((a, b) => a - b)[0];
    return { estado: "sin_linea", casas: [], cercana: l !== undefined ? { linea: l, casas: otras.get(l)!.sort(orden) } : null };
  }

  for (const fsId of pareja.keys()) dudosos.delete(fsId);   // si una casa sí lo emparejó, no es dudoso
  return { activo, ok, pareja, dudosos, resumen, oferta };
}

/** {"BetPlay": 1.85, "Rushbet": 1.83} para guardar en la base. */
export const casasJson = (o: OfertaCasa) => Object.fromEntries(o.casas.map((x) => [x.casa, x.c]));

/** ¿Sale la push? Regla de Fredy: solo si BetPlay o Rushbet ofrecen esa línea. Kambi caído: según config. */
export function pasaPush(cfg: Config, o: OfertaCasa, esGoles: boolean, umbral?: number | null): { sale: boolean; motivo: string | null } {
  if (cfg.kambi_exigir === false || o.estado === "apagado") return { sale: true, motivo: null };
  if (o.estado === "ofrece") {
    // Fredy (20 nov): BetPlay o Rushbet tienen que pagar el umbral; si solo lo paga Wplay/Betano no es una
    // entrada real para él. kambi_exigir_umbral = false vuelve a exigir solo que tengan la línea.
    const mejor = Math.max(...o.casas.map((x) => x.c));
    if (cfg.kambi_exigir_umbral !== false && umbral != null && Number.isFinite(umbral) && mejor < umbral)
      return { sale: false, motivo: "casas_bajo_umbral" };
    return { sale: true, motivo: null };
  }
  // Sin saber (Kambi caído o el partido recién entró a la cola): las de goles salen igual, con el motivo
  if ((o.estado === "kambi_caido" || o.estado === "sin_lectura") && esGoles && cfg.kambi_caido_avisa !== false) return { sale: true, motivo: o.estado };
  return { sale: false, motivo: o.estado === "kambi_caido" ? "kambi_caido" : `casas_${o.estado}` };
}
