// =====================================================================
// Lector de Flashscore (EXPERIMENTAL, regla v4). Uso personal, poco volumen.
//
// Flashscore no tiene API pública: su página pide los datos a feeds internos. Verificado desde
// Supabase el 14 nov 2026 (sonda-flashscore):
//   · Lista del día   GET https://local-global.flashscore.ninja/2/x/feed/f_1_{día}_{tz}_en_1
//                     header x-fsign. Texto: registros "~", campos "¬", "clave÷valor".
//   · Estadísticas    GET .../df_st_1_{id}           (mismo formato; xG, tiros, córners, posesión…)
//   · Cuotas          GET https://global.ds.lsapp.eu/odds/pq_graphql?_hash=oce&eventId={id}
//                         &projectId=2&geoIpCode=CO&geoIpSubdivisionCode=CODC   (JSON, casas de Colombia)
//
// Poka-yoke: el formato puede cambiar sin aviso. Cada lector devuelve null/[] ante algo raro (nunca
// inventa datos) y el escáner lo deja en la bitácora para notarlo el mismo día.
// =====================================================================

const FEED = "https://local-global.flashscore.ninja/2/x/feed";
const ODDS = "https://global.ds.lsapp.eu/odds/pq_graphql";
const FSIGN = "SW9D1eZo";
const CABECERAS = {
  "x-fsign": FSIGN, "Referer": "https://www.flashscore.com/", "Origin": "https://www.flashscore.com",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "*/*",
};

export interface PartidoFS {
  id: string;            // AA
  liga: string;          // ZA: "COUNTRY: League - Round"
  local: string;         // AE
  visitante: string;     // AF
  idLocal: string | null;     // JA (participante, sirve para leer cuotas)
  idVisitante: string | null; // JB
  inicio: number;        // AD, ms
  estado: number;        // AB: 1 por jugar, 2 en vivo, 3 terminado
  detalle: number;       // AC: 12 = 1T, 13 = 2T, 38 = descanso (observado)
  periodoDesde: number | null; // AO, ms: inicio del periodo en curso
  gl: number; gv: number;      // AG / AH
}

function registros(texto: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const reg of texto.split("~")) {
    const c: Record<string, string> = {};
    for (const campo of reg.split("¬")) {
      const i = campo.indexOf("÷");
      if (i > 0) c[campo.slice(0, i)] = campo.slice(i + 1);
    }
    if (Object.keys(c).length) out.push(c);
  }
  return out;
}

async function texto(url: string): Promise<string> {
  const r = await fetch(url, { headers: CABECERAS });
  if (!r.ok) throw new Error(`flashscore ${r.status} ${url.split("/").pop()}`);
  return await r.text();
}

/** Lista de fútbol de un día (0 = hoy, 1 = mañana) en hora UTC. */
export async function listaDia(dia = 0): Promise<PartidoFS[]> {
  const t = await texto(`${FEED}/f_1_${dia}_0_en_1`);
  const lista: PartidoFS[] = [];
  let liga = "";
  for (const c of registros(t)) {
    if (c.ZA) liga = c.ZA;
    if (!c.AA) continue;
    lista.push({
      id: c.AA, liga, local: c.AE ?? "", visitante: c.AF ?? "",
      idLocal: c.JA ?? null, idVisitante: c.JB ?? null,
      inicio: Number(c.AD) * 1000, estado: Number(c.AB), detalle: Number(c.AC),
      periodoDesde: c.AO ? Number(c.AO) * 1000 : null,
      gl: Number(c.AG ?? 0) || 0, gv: Number(c.AH ?? 0) || 0,
    });
  }
  return lista;
}

/** Estado al estilo API-Football (1H, HT, 2H, FT, NS) y minuto aproximado. */
export function estadoYMinuto(p: PartidoFS, ahora = Date.now()): { estado: string; minuto: number | null } {
  if (p.estado === 1) return { estado: "NS", minuto: null };
  if (p.estado === 3) return { estado: "FT", minuto: 90 };
  const desde = p.periodoDesde ?? p.inicio;
  const transcurrido = Math.max(0, Math.floor((ahora - desde) / 60000)) + 1;
  if (p.detalle === 12) return { estado: "1H", minuto: Math.min(45, transcurrido) };
  if (p.detalle === 13) return { estado: "2H", minuto: Math.min(90, 45 + transcurrido) };
  if (p.detalle === 38) return { estado: "HT", minuto: 45 };
  return { estado: `FS${p.detalle}`, minuto: null };   // prórroga, penales, pausa: no aplica a la regla
}

// Nombres de Flashscore (idioma en) → nombres de API-Football, para reutilizar normalizarStats.
const NOMBRES: Record<string, string> = {
  "expected goals (xg)": "expected_goals",
  "ball possession": "Ball Possession",
  "total shots": "Total Shots",
  "shots on target": "Shots on Goal",
  "shots off target": "Shots off Goal",
  "blocked shots": "Blocked Shots",
  "shots inside the box": "Shots insidebox",
  "shots outside the box": "Shots outsidebox",
  "corner kicks": "Corner Kicks",
  "goalkeeper saves": "Goalkeeper Saves",
  "fouls": "Fouls",
  "yellow cards": "Yellow Cards",
  "red cards": "Red Cards",
};

/**
 * Estadísticas del partido completo, con la forma de API-Football: [{type, value}] por equipo.
 * Solo se lee el primer bloque ("Match"); los siguientes son por tiempo. [] si no hay.
 */
export async function estadisticas(id: string): Promise<{ local: any[]; visitante: any[]; extra: Record<string, [string, string]> }> {
  const t = await texto(`${FEED}/df_st_1_${id}`);
  const local: any[] = [], visitante: any[] = [];
  const extra: Record<string, [string, string]> = {};
  let bloques = 0;
  const vistos = new Set<string>();
  for (const c of registros(t)) {
    if (c.SE !== undefined) { bloques++; if (bloques > 1) break; continue; }
    if (!c.SG) continue;
    const nombre = c.SG.toLowerCase();
    if (vistos.has(nombre)) continue;   // "Top stats" repite filas
    vistos.add(nombre);
    extra[c.SG] = [c.SH ?? "", c.SI ?? ""];
    if (nombre === "passes") {
      const m1 = /\((\d+)\/(\d+)\)/.exec(c.SH ?? ""), m2 = /\((\d+)\/(\d+)\)/.exec(c.SI ?? "");
      if (m1) { local.push({ type: "Passes accurate", value: m1[1] }, { type: "Total passes", value: m1[2] }); }
      if (m2) { visitante.push({ type: "Passes accurate", value: m2[1] }, { type: "Total passes", value: m2[2] }); }
      continue;
    }
    const tipo = NOMBRES[nombre];
    if (!tipo) continue;
    local.push({ type: tipo, value: c.SH ?? null });
    visitante.push({ type: tipo, value: c.SI ?? null });
  }
  return { local, visitante, extra };
}

export interface CuotasFS {
  apertura: { local: number; empate: number; visitante: number; casas: number } | null;
  actual: { local: number; empate: number; visitante: number; casas: number } | null;
  over: Record<string, number>;   // línea → cuota Over actual (promedio de casas), tiempo completo
  casas: string[];
}

/** Cuotas 1X2 (apertura y actual) y Over/Under de tiempo completo, promedio de las casas colombianas. */
export async function cuotas(id: string, idLocal: string | null, idVisitante: string | null): Promise<CuotasFS> {
  const url = `${ODDS}?_hash=oce&eventId=${id}&projectId=2&geoIpCode=CO&geoIpSubdivisionCode=CODC`;
  const r = await fetch(url, { headers: CABECERAS });
  if (!r.ok) throw new Error(`flashscore odds ${r.status}`);
  const j = await r.json();
  const o = j?.data?.findOddsByEventId;
  const casasNombre = new Map<number, string>();
  for (const b of o?.settings?.bookmakers ?? []) casasNombre.set(b.bookmaker?.id, b.bookmaker?.name);
  const ap = { L: [] as number[], E: [] as number[], V: [] as number[] };
  const ac = { L: [] as number[], E: [] as number[], V: [] as number[] };
  const over: Record<string, number[]> = {};
  const casas = new Set<string>();
  for (const m of o?.odds ?? []) {
    if (m.bettingScope !== "FULL_TIME") continue;
    if (m.bettingType === "HOME_DRAW_AWAY") {
      casas.add(casasNombre.get(m.bookmakerId) ?? String(m.bookmakerId));
      for (const it of m.odds ?? []) {
        const lado = it.eventParticipantId === null ? "E" : it.eventParticipantId === idLocal ? "L" : it.eventParticipantId === idVisitante ? "V" : null;
        if (!lado) continue;
        const a = parseFloat(it.opening), v = parseFloat(it.value);
        if (Number.isFinite(a) && a > 1) ap[lado].push(a);
        if (Number.isFinite(v) && v > 1 && it.active !== false) ac[lado].push(v);
      }
    } else if (m.bettingType === "OVER_UNDER") {
      for (const it of m.odds ?? []) {
        if (String(it.selection ?? "").toUpperCase() !== "OVER") continue;
        const linea = it.handicap?.value ?? it.handicap;
        const v = parseFloat(it.value);
        if (linea === null || linea === undefined || !Number.isFinite(v)) continue;
        (over[String(linea)] ??= []).push(v);
      }
    }
  }
  const prom = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const armar = (g: typeof ap) => {
    const x = { local: prom(g.L), empate: prom(g.E), visitante: prom(g.V), casas: g.L.length };
    return Number.isFinite(x.local) && Number.isFinite(x.visitante) ? x : null;
  };
  const overProm: Record<string, number> = {};
  for (const [k, v] of Object.entries(over)) overProm[k] = Number(prom(v).toFixed(2));
  return { apertura: armar(ap), actual: armar(ac), over: overProm, casas: [...casas] };
}

// ---------------- Emparejar Flashscore ↔ API-Football ----------------
// Los ids no se parecen, así que se empareja por hora de inicio (±20 min) y parecido de nombres.
// Palabras de relleno que no distinguen equipos (fc, club, deportivo…) se quitan antes de comparar.
const RELLENO = new Set(["fc", "cf", "sc", "cd", "ac", "as", "ca", "club", "de", "del", "la", "el", "the", "afc", "fk",
  "sk", "nk", "if", "bk", "cs", "us", "sd", "ud", "rc", "ss", "sv", "deportivo", "atletico", "atl", "real", "city", "united", "utd"]);
export function fichas(nombre: string): string[] {
  return nombre.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !RELLENO.has(w));
}
function parecido(a: string, b: string): number {
  const A = fichas(a), B = fichas(b);
  if (!A.length || !B.length) return 0;
  let comun = 0;
  for (const x of A) if (B.some((y) => y === x || (x.length >= 4 && y.length >= 4 && (y.startsWith(x) || x.startsWith(y))))) comun++;
  return comun / Math.max(A.length, B.length);
}
// Marcas de categoría: si una tiene "U21"/"W"/"II" y la otra no, NO son el mismo partido.
function categoria(n: string): string {
  const s = ` ${n.toLowerCase()} `;
  const m = s.match(/ (u\d{2}) /) ?? s.match(/ (w|women|femenino|fem) /) ?? s.match(/ (ii|b|reserves?|reserva) /);
  return m ? m[1].replace(/women|femenino|fem/, "w").replace(/reserves?|reserva/, "ii") : "";
}

export interface FixtureApi { fixture_id: number; local: string; visitante: string; kickoff: number }

/** Devuelve, para cada partido de Flashscore, el fixture de API-Football más parecido (o nada). */
export function emparejar(fs: PartidoFS[], api: FixtureApi[]): Map<string, { fixture_id: number; puntaje: number }> {
  const out = new Map<string, { fixture_id: number; puntaje: number }>();
  const usados = new Set<number>();
  const candidatos: { fs: string; api: number; p: number }[] = [];
  for (const f of fs) {
    for (const a of api) {
      if (Math.abs(a.kickoff - f.inicio) > 20 * 60000) continue;
      if (categoria(f.local) !== categoria(a.local) || categoria(f.visitante) !== categoria(a.visitante)) continue;
      const pl = parecido(f.local, a.local), pv = parecido(f.visitante, a.visitante);
      const p = Math.min(pl, pv) * 0.6 + ((pl + pv) / 2) * 0.4;
      if (p >= 0.5) candidatos.push({ fs: f.id, api: a.fixture_id, p });
    }
  }
  // El mejor par primero; cada partido se usa una sola vez (evita cruzar dos juegos del mismo equipo)
  candidatos.sort((x, y) => y.p - x.p);
  for (const c of candidatos) {
    if (out.has(c.fs) || usados.has(c.api)) continue;
    out.set(c.fs, { fixture_id: c.api, puntaje: Number(c.p.toFixed(2)) });
    usados.add(c.api);
  }
  return out;
}
