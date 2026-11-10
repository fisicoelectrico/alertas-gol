// =====================================================================
// Algoritmo (funciones puras, sin red ni base de datos → se pueden probar solas)
// Sección 4 de 02_ESPECIFICACION_TECNICA.md
// =====================================================================

export interface Stats {
  tiros_al_arco: number;
  tiros_fuera: number;
  tiros_totales: number;
  tiros_bloqueados: number;
  tiros_dentro_area: number;
  tiros_fuera_area: number;
  corners: number;
  posesion: number;        // 0-100
  atajadas: number;
  faltas: number;
  amarillas: number;
  rojas: number;
  pases_totales: number;
  pases_precisos: number;
  xg: number | null;       // solo en algunas ligas
}

export interface Pesos {
  tiros_al_arco: number;
  tiros_dentro_area: number;
  tiros_totales: number;
  corners: number;
  xg: number;
  posesion: number;
}

export interface Regla {
  version: string;
  minuto_min: number;
  minuto_max: number;
  cuota_fav_max: number;
  diferencia_min: number;
  dominancia_min: number;
  cuota_objetivo: number;
  momentum_ventana_min: number;
  momentum_gap_min: number;
  pesos_ip: Pesos;
}

// Nombres que usa API-Football en /fixtures/statistics → nuestras claves
const MAPA: Record<string, keyof Stats> = {
  "shots on goal": "tiros_al_arco",
  "shots off goal": "tiros_fuera",
  "total shots": "tiros_totales",
  "blocked shots": "tiros_bloqueados",
  "shots insidebox": "tiros_dentro_area",
  "shots outsidebox": "tiros_fuera_area",
  "corner kicks": "corners",
  "ball possession": "posesion",
  "goalkeeper saves": "atajadas",
  "fouls": "faltas",
  "yellow cards": "amarillas",
  "red cards": "rojas",
  "total passes": "pases_totales",
  "passes accurate": "pases_precisos",
  "expected_goals": "xg",
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

/** Convierte el arreglo `statistics` de un equipo en un objeto Stats. */
export function normalizarStats(lista: Array<{ type: string; value: unknown }> | undefined): Stats {
  const s: Stats = {
    tiros_al_arco: 0, tiros_fuera: 0, tiros_totales: 0, tiros_bloqueados: 0,
    tiros_dentro_area: 0, tiros_fuera_area: 0, corners: 0, posesion: 50,
    atajadas: 0, faltas: 0, amarillas: 0, rojas: 0, pases_totales: 0, pases_precisos: 0, xg: null,
  };
  for (const it of lista ?? []) {
    const clave = MAPA[String(it.type).toLowerCase()];
    if (!clave) continue;
    const v = num(it.value);
    if (clave === "xg") s.xg = v;
    else if (v !== null) (s as unknown as Record<string, number>)[clave] = v;
  }
  return s;
}

/**
 * Índice de Presión:
 * P = 3·tiros_al_arco + 2·tiros_dentro_area + 1·tiros_totales + 1.5·córners + 5·xG + 0.05·(posesión−50)
 * Si xG no existe en la liga, ese término vale 0 para AMBOS equipos (la razón sigue siendo justa).
 */
export function indicePresion(s: Stats, p: Pesos, usarXg: boolean): number {
  return p.tiros_al_arco * s.tiros_al_arco
    + p.tiros_dentro_area * s.tiros_dentro_area
    + p.tiros_totales * s.tiros_totales
    + p.corners * s.corners
    + (usarXg ? p.xg * (s.xg ?? 0) : 0)
    + p.posesion * (s.posesion - 50);
}

/** Diferencia entre dos fotos de estadísticas (lo que pasó entre ambas). La posesión se deja la actual. */
export function deltaStats(actual: Stats, previo: Stats): Stats {
  const d = { ...actual };
  for (const k of Object.keys(actual) as (keyof Stats)[]) {
    if (k === "posesion") continue;
    if (k === "xg") {
      d.xg = actual.xg !== null && previo.xg !== null ? Math.max(0, actual.xg - previo.xg) : null;
      continue;
    }
    (d as unknown as Record<string, number>)[k] = Math.max(0, (actual[k] as number) - (previo[k] as number));
  }
  return d;
}

export function razon(pFav: number, pRival: number): number {
  return pFav / Math.max(pRival, 1);
}

// ---------------- Cuotas ----------------

/** Cuota prepartido 1X2: promedio entre todas las casas que la ofrezcan (más robusto que una sola casa). */
export function parsearCuotaPre(resp: any): { local: number; empate: number; visitante: number; casas: number } | null {
  const casas = resp?.response?.[0]?.bookmakers ?? [];
  const acc = { Home: [] as number[], Draw: [] as number[], Away: [] as number[] };
  for (const b of casas) {
    const bet = (b.bets ?? []).find((x: any) => x.id === 1 || /match winner/i.test(x.name));
    for (const v of bet?.values ?? []) {
      const o = num(v.odd);
      if (o && v.value in acc) acc[v.value as keyof typeof acc].push(o);
    }
  }
  const prom = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const r = { local: prom(acc.Home), empate: prom(acc.Draw), visitante: prom(acc.Away), casas: acc.Home.length };
  return Number.isFinite(r.local) && Number.isFinite(r.visitante) ? r : null;
}

export function definirFavorito(c: { local: number; visitante: number } | null, cuotaFavMax: number): "home" | "away" | null {
  if (!c) return null;
  const fav = c.local <= c.visitante ? "home" : "away";
  const cuota = Math.min(c.local, c.visitante);
  return cuota <= cuotaFavMax ? fav : null;
}

export interface CuotaOver { linea: number; cuota: number | null; suspendida: boolean; mercado: string | null; lineas: Record<string, number> }

/**
 * Busca en /odds/live la cuota del Over de la línea pedida (goles actuales + 0.5).
 * Acepta los nombres de mercado que usa API-Football para goles totales del partido
 * ("Over/Under Line", "Match Goals", "Over/Under") y descarta mitades, equipos, córners y tarjetas.
 */
export function parsearCuotaOver(resp: any, linea: number): CuotaOver {
  const item = resp?.response?.[0];
  const mercados: any[] = item?.odds ?? [];
  const lineas: Record<string, number> = {};
  let elegida: { cuota: number; suspendida: boolean; mercado: string } | null = null;
  for (const m of mercados) {
    const nombre = String(m.name ?? "");
    if (!/over\/under|match goals|total goals/i.test(nombre)) continue;
    if (/half|1st|2nd|team|home|away|corner|card|asian|exact|odd\/even/i.test(nombre)) continue;
    for (const v of m.values ?? []) {
      if (!/^over/i.test(String(v.value))) continue;
      // La línea viene en `handicap` ("2.5") o dentro del texto ("Over 2.5")
      const l = num(v.handicap) ?? num(String(v.value).replace(/over/i, ""));
      const o = num(v.odd);
      if (l === null || o === null) continue;
      if (!v.suspended) lineas[String(l)] = o;
      if (Math.abs(l - linea) < 1e-6) {
        const susp = !!v.suspended;
        // Preferimos una cuota no suspendida y, entre varias, la del mercado principal
        if (!elegida || (elegida.suspendida && !susp) || (v.main && !susp)) {
          elegida = { cuota: o, suspendida: susp, mercado: nombre };
        }
      }
    }
  }
  return {
    linea,
    cuota: elegida ? elegida.cuota : null,
    suspendida: elegida ? elegida.suspendida : false,
    mercado: elegida?.mercado ?? null,
    lineas,
  };
}

// ---------------- Evaluación de la regla ----------------

export interface Contexto {
  estado: string;
  minuto: number;
  goles_local: number;
  goles_visitante: number;
  favorito: "home" | "away" | null;
}

/** Filtro de candidato (no necesita estadísticas ni cuotas: se decide con el radar + cuota prepartido). */
export function filtroCandidato(c: Contexto, r: Regla): { ok: boolean; motivo?: string; desventaja: number } {
  const desventaja = c.favorito === "home" ? c.goles_visitante - c.goles_local
                   : c.favorito === "away" ? c.goles_local - c.goles_visitante : 0;
  if (c.estado !== "2H") return { ok: false, motivo: "no_2T", desventaja };
  if (c.minuto < r.minuto_min || c.minuto > r.minuto_max) return { ok: false, motivo: "fuera_de_ventana", desventaja };
  if (!c.favorito) return { ok: false, motivo: "sin_favorito", desventaja };
  if (desventaja < r.diferencia_min) return { ok: false, motivo: "favorito_no_pierde", desventaja };
  return { ok: true, desventaja };
}

/** Partido "pre-candidato": 2T (o entretiempo) y alguien va perdiendo. Aún no sabemos si el que pierde es el favorito. */
export function preCandidato(estado: string, minuto: number, gl: number, gv: number, r: Regla): boolean {
  if (gl === gv) return false;
  if (estado === "HT") return true;                // conviene conocer al favorito antes de que arranque el 2T
  return estado === "2H" && minuto <= r.minuto_max;
}

export interface Evaluacion {
  candidato: boolean;
  dominancia: number;
  momentum: number | null;
  cuota_over: number | null;
  condiciones: Record<string, boolean | null>;
  disparar: boolean;
}

export function evaluar(args: {
  ctx: Contexto; regla: Regla;
  dominancia: number; momentum: number | null;
  cuotaOver: CuotaOver;
}): Evaluacion {
  const { ctx, regla, dominancia, momentum, cuotaOver } = args;
  const cand = filtroCandidato(ctx, regla);
  const condiciones = {
    candidato: cand.ok,
    dominancia: dominancia >= regla.dominancia_min,
    momentum: momentum === null ? null : momentum >= regla.dominancia_min,
    cuota: cuotaOver.cuota === null ? null : (!cuotaOver.suspendida && cuotaOver.cuota >= regla.cuota_objetivo),
  };
  // null cuenta como "no cumplido": sin historial de momentum o sin cuota, no se alerta (poka-yoke)
  const disparar = Object.values(condiciones).every((v) => v === true);
  return { candidato: cand.ok, dominancia, momentum, cuota_over: cuotaOver.cuota, condiciones, disparar };
}

// ---------------- Resolución ----------------

const TERMINADOS = new Set(["FT", "AET", "PEN"]);
const TIEMPO_REGLAMENTARIO_CUMPLIDO = new Set(["FT", "AET", "PEN", "ET", "BT", "P"]);
const ANULADOS = new Set(["PST", "CANC", "ABD", "AWD", "WO"]);

export function puedeResolverse(estado: string): "resolver" | "anular" | null {
  if (ANULADOS.has(estado)) return "anular";
  if (TIEMPO_REGLAMENTARIO_CUMPLIDO.has(estado)) return "resolver";
  return null;
}

export function terminado(estado: string) { return TERMINADOS.has(estado) || ANULADOS.has(estado); }

/**
 * El mercado Over en vivo se liquida con el tiempo reglamentario (90' + adición), sin prórroga.
 * Por eso usamos score.fulltime (marcador al 90') y no goals (que incluye la prórroga).
 */
export function resolverAlerta(fixture: any, alerta: { minuto: number; goles_al_alertar: number; favorito: "home" | "away" }):
  { resultado: "acierto" | "fallo"; minuto_gol: number | null; lado_gol: "favorito" | "rival" | null; gl90: number; gv90: number } {
  const ft = fixture?.score?.fulltime ?? {};
  const gl90 = ft.home ?? fixture?.goals?.home ?? 0;
  const gv90 = ft.away ?? fixture?.goals?.away ?? 0;
  const acierto = gl90 + gv90 > alerta.goles_al_alertar;
  let minuto_gol: number | null = null;
  let lado_gol: "favorito" | "rival" | null = null;
  if (acierto) {
    const favId = alerta.favorito === "home" ? fixture?.teams?.home?.id : fixture?.teams?.away?.id;
    const goles = (fixture?.events ?? [])
      .filter((e: any) => e.type === "Goal" && !/missed/i.test(e.detail ?? "") && (e.time?.elapsed ?? 0) <= 90)
      .filter((e: any) => (e.time?.elapsed ?? 0) >= alerta.minuto)
      .sort((a: any, b: any) => (a.time.elapsed + (a.time.extra ?? 0) / 100) - (b.time.elapsed + (b.time.extra ?? 0) / 100));
    const g = goles[0];
    if (g) {
      minuto_gol = g.time.elapsed + (g.time.extra ?? 0);
      // En un autogol, `team` es el equipo del jugador que lo hizo (el que lo sufre): se invierte.
      // (Supuesto pendiente de confirmar con el primer autogol real.)
      const delFav = g.team?.id === favId;
      const autogol = /own goal/i.test(g.detail ?? "");
      lado_gol = (delFav !== autogol) ? "favorito" : "rival";
    }
  }
  return { resultado: acierto ? "acierto" : "fallo", minuto_gol, lado_gol, gl90, gv90 };
}

/** Intervalo efectivo entre radares: reparte el presupuesto restante en las horas activas restantes del día. */
export function intervaloEfectivo(args: {
  intervaloBase: number; disponibles: number; fraccionRadar: number; horasActivas: number[]; ahora: Date;
}): number {
  const { intervaloBase, disponibles, fraccionRadar, horasActivas, ahora } = args;
  const h = ahora.getUTCHours();
  // minutos activos restantes hasta las 00:00 UTC (cuando se reinicia la cuota)
  let minutos = 0;
  for (let hh = h; hh < 24; hh++) if (horasActivas.includes(hh)) minutos += hh === h ? 60 - ahora.getUTCMinutes() : 60;
  const radares = Math.max(1, Math.floor(disponibles * fraccionRadar));
  return Math.max(intervaloBase, Math.ceil(minutos / radares));
}
