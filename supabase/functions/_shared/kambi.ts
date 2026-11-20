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
   *  (ninguna casa tiene el partido en vivo) · kambi_caido (no respondió) · apagado (kambi_activo = false) */
  estado: "ofrece" | "sin_linea" | "sin_mercado" | "sin_partido" | "kambi_caido" | "apagado";
  casas: { casa: string; c: number }[];                       // la línea pedida, de mayor a menor
  cercana: { linea: number; casas: { casa: string; c: number }[] } | null;   // si no está, la más cercana por encima
}

export interface Kambi {
  activo: boolean;
  /** Al menos una casa respondió la lista en vivo de este ciclo. */
  ok: boolean;
  pareja: Map<string, EventoKambi[]>;
  resumen: Record<string, unknown>;
  oferta(fsId: string, tipo: TipoCuota, linea: number, opts?: { goles?: number }): Promise<OfertaCasa>;
}

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
  const j = await pedir(`https://${servidor}/offering/v2018/${codigo}/listView/football/all/all/all/in-play.json?${PARAMS}&useCombined=true`);
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
  const j = await pedir(`https://${servidor}/offering/v2018/${codigo}/betoffer/event/${id}.json?${PARAMS}&includeParticipants=true`);
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
    const { esc, mercados } = await cuotasEvento(servidor, e.codigo, e.id);
    const vacio = (o: Record<string, number>) => Object.keys(o).length ? sql.json(o) : null;
    const [r] = await sql`
      insert into futbol.cuotas_casa (casa, evento_id, fs_id, fixture_id, liga, local, visitante, periodo, minuto,
        goles_local, goles_visitante, corners_local, corners_visitante, goles, goles_1t, corners, corners_1t, mercados)
      values (${e.casa}, ${e.id}, ${fsId}, ${fixtureId}, ${e.liga}, ${e.local}, ${e.visitante}, ${e.periodo}, ${e.minuto},
        ${e.gl}, ${e.gv}, ${e.cl}, ${e.cv}, ${vacio(esc.goles)}, ${vacio(esc.goles_1t)}, ${vacio(esc.corners)}, ${vacio(esc.corners_1t)},
        ${sql.json(mercados)})
      returning casa, ts, goles_local, goles_visitante, goles, goles_1t, corners, corners_1t`;
    return r;
  } catch (err) {
    log(`kambi: ${e.casa} ${e.local}-${e.visitante}: ${(err as Error).message}`);
    return null;
  }
}

/** Partidos donde importa tener cuotas en este ciclo, por orden de prioridad. */
function franjaCorners(p: FS.PartidoFS): boolean {
  const em = FS.estadoYMinuto(p);
  if (em.minuto === null) return false;
  return (em.estado === "1H" && em.minuto >= 15 && em.minuto <= 38) || (em.estado === "2H" && em.minuto >= 72 && em.minuto <= 82);
}

/**
 * Un ciclo: lista en vivo de cada casa, emparejamiento con Flashscore y lectura de cuotas de los partidos
 * que importan. Devuelve el objeto con `oferta()` para preguntar, al momento de cada push, qué ofrecen.
 */
export async function cicloKambi(args: {
  cfg: Config; vivosFS: FS.PartidoFS[]; fixtureDe: (fsId: string) => number | null;
  prioridad: Set<string>; log: Log;
}): Promise<Kambi> {
  const { cfg, vivosFS, fixtureDe, prioridad, log } = args;
  const activo = cfg.kambi_activo !== false;
  const servidor = String(cfg.kambi_servidor ?? "us.offering-api.kambicdn.com");
  const casas: Record<string, string> = (cfg.kambi_casas && typeof cfg.kambi_casas === "object")
    ? cfg.kambi_casas as Record<string, string> : { betplay: "betplay", rushbet: "rsico" };
  const intervalo = Math.max(1, Number(cfg.kambi_intervalo_min ?? 3));
  const maxEv = Math.max(0, Number(cfg.kambi_max_eventos ?? 15));
  const vig = Math.max(1, Number(cfg.kambi_vigencia_min ?? 5));
  const pareja = new Map<string, EventoKambi[]>();
  const resumen: Record<string, unknown> = {};
  let ok = false;

  const enVivo = vivosFS.filter((p) => p.estado === 2);
  if (activo && enVivo.length) {
    const porFs = new Map(enVivo.map((p) => [p.id, p]));
    await Promise.all(Object.entries(casas).filter(([casa]) => NOMBRE_CASA[casa]).map(async ([casa, codigo]) => {
      let lista: EventoKambi[];
      try { lista = await listaVivo(servidor, casa, codigo); }
      catch (e) { log(`kambi: lista ${casa}: ${(e as Error).message}`); resumen[casa] = { error: (e as Error).message }; return; }
      ok = true;
      const porId = new Map(lista.map((e) => [e.id, e]));
      const pares = FS.emparejar(enVivo, lista.map((e) => ({ fixture_id: e.id, local: e.local, visitante: e.visitante, kickoff: e.inicio })));
      for (const [fsId, { fixture_id }] of pares) {
        const e = porId.get(fixture_id);
        if (e) pareja.set(fsId, [...(pareja.get(fsId) ?? []), e]);
      }
      // Qué leer: prioridad (candidatos, gol temprano) primero; luego las franjas de córners
      const quiere = [...pares.keys()].filter((fs) => prioridad.has(fs) || (porFs.get(fs) && franjaCorners(porFs.get(fs)!)))
        .sort((a, b) => Number(prioridad.has(b)) - Number(prioridad.has(a)));
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
    if (faltan.length) {
      await Promise.all(faltan.map((e) => leerYGuardar(servidor, e, fsId, fixtureDe(fsId), log)));
      filas = await frescas();
    }
    const exacta: { casa: string; c: number }[] = [];
    const otras = new Map<number, { casa: string; c: number }[]>();
    let conMercado = false;
    const k = claveLinea(linea);
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
    if (!conMercado) return vacia("sin_mercado");
    const l = [...otras.keys()].sort((a, b) => a - b)[0];
    return { estado: "sin_linea", casas: [], cercana: l !== undefined ? { linea: l, casas: otras.get(l)!.sort(orden) } : null };
  }

  return { activo, ok, pareja, resumen, oferta };
}

/** {"BetPlay": 1.85, "Rushbet": 1.83} para guardar en la base. */
export const casasJson = (o: OfertaCasa) => Object.fromEntries(o.casas.map((x) => [x.casa, x.c]));

/** ¿Sale la push? Regla de Fredy: solo si BetPlay o Rushbet ofrecen esa línea. Kambi caído: según config. */
export function pasaPush(cfg: Config, o: OfertaCasa, esGoles: boolean): { sale: boolean; motivo: string | null } {
  if (cfg.kambi_exigir === false || o.estado === "apagado") return { sale: true, motivo: null };
  if (o.estado === "ofrece") return { sale: true, motivo: null };
  if (o.estado === "kambi_caido" && esGoles && cfg.kambi_caido_avisa !== false) return { sale: true, motivo: "kambi_caido" };
  return { sale: false, motivo: o.estado === "kambi_caido" ? "kambi_caido" : `casas_${o.estado}` };
}
