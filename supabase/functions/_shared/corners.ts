// =====================================================================
// Mercado experimental de CÓRNERS (DECISIONES 37). Solo para administradores: ni push ni pantalla
// para visores. Vive aparte del radar de goles: tabla propia, versión propia (c1, c2…) y su propio
// interruptor (config.corners_activo). Si algo falla aquí, el radar de goles sigue igual.
// Tres llaves independientes (15 nov, Fredy quiere juntar datos un buen tiempo sin ruido ni gasto):
//   corners_activo  detecta y guarda los avisos (si se apaga, solo se terminan de resolver los pendientes)
//   corners_push    manda las push al administrador (apagada = el laboratorio corre en silencio)
//   corners_cuota   gasta 1 consulta de API-Football por aviso para leer la cuota (apagada = 0 consultas)
// Ninguna cambia la regla: la versión vigente sigue igual y los datos se comparan sin mezclar.
//
// Dos avisos, ambos para "entrar a 2 córners más" (objetivo = corners_objetivo, por defecto 2):
//   c1t_cero20  Partido con 0 córners entre el 20' y el 26' del 1T  → "más de 1,5 córners en el 1T".
//   c2t_fav77   Favorito perdiendo (por lo que sea, sin goles_fav_max ni presión) entre el 77' y el 80'
//               → "córners actuales + 1,5" del partido (en la práctica, 2 córners más en lo que queda del 2T).
//   c1t_uno     (19 nov, Fredy) Partido con EXACTAMENTE 1 córner entre el 28' y el 37' del 1T → "más de 1,5 córners
//               en el 1T": falta uno solo. Cuotas vistas por Fredy en esa franja: 1,40-1,70. Un partido tiene un
//               solo aviso del 1T: si ya avisó c1t_cero20, no avisa c1t_uno. Mientras vaya 0 córners se sigue
//               mirando en cada ciclo (puede llegar al primero dentro de la ventana); con 2 o más se descarta.
//
// Cuánto cuesta:
//   · Detectar y resolver: GRATIS. Lista en vivo y estadísticas de Flashscore (bloques Partido, 1T y 2T).
//   · Cuota: Flashscore no trae mercado de córners (verificado el 15 nov). API-Football sí, en /odds/live
//     ("Total Corners", "Asian Corners", "Match Corners"…). Se pide UNA vez por aviso, con tope diario
//     corners_api_max_dia. Sin cupo o sin pareja en API-Football, el aviso igual sale y queda "sin cuota".
//
// Por qué se guardan también los partidos que NO avisan (futbol.corners_chequeos): para tener la tasa base
// ("¿cuántos partidos llegan al 20' sin córners?") y poder comparar después.
// =====================================================================
import { sql, Config } from "./db.ts";
import * as FS from "./flashscore.ts";
import * as A from "./algoritmo.ts";
import { ApiFootball } from "./apifootball.ts";
import { notificar, cuotaTxt, ligaFS } from "./notificar.ts";
import { umbrales } from "./lab.ts";

type Mercado = "c1t_cero20" | "c1t_uno" | "c2t_fav77";
const es1T = (m: string) => m.startsWith("c1t");

const num = (x: unknown) => { const n = parseFloat(String(x ?? "")); return Number.isFinite(n) ? n : null; };
const coma = (x: number) => String(x).replace(".", ",");

/** Parámetros de la versión vigente (se congelan en cada aviso). */
export function parametrosCorners(cfg: Config) {
  return {
    version: String(cfg.corners_version ?? "c1"),
    t1_desde: Number(cfg.corners_1t_min_desde ?? 20),
    t1_hasta: Number(cfg.corners_1t_min_hasta ?? 26),
    t1u_desde: Number(cfg.corners_1t_uno_desde ?? 28),
    t1u_hasta: Number(cfg.corners_1t_uno_hasta ?? 37),
    t2_desde: Number(cfg.corners_2t_min_desde ?? 77),
    t2_hasta: Number(cfg.corners_2t_min_hasta ?? 80),
    objetivo: Number(cfg.corners_objetivo ?? 2),
  };
}

/**
 * Busca en /odds/live la cuota del Over de córners para la línea pedida.
 *  · alcance "1T": mercados de córners del primer tiempo (nombre con 1st/first half).
 *  · alcance "partido": córners totales del partido (sin mitad, sin equipo).
 * "Match Corners" usa líneas enteras con Over/Exactly/Under: "Over 8" = 9 o más, igual que la línea 8,5.
 * Devuelve también todos los mercados de córners vistos (compactos) para estudiarlos después.
 */
export function parsearCuotaCorners(resp: any, alcance: "1T" | "partido", linea: number) {
  const mercados: any[] = resp?.response?.[0]?.odds ?? [];
  const vistos: Record<string, Record<string, number>> = {};
  let hayMercado = false;
  let elegida: { cuota: number; mercado: string } | null = null;
  for (const m of mercados) {
    const nombre = String(m.name ?? "");
    if (!/corner/i.test(nombre)) continue;
    const compacto: Record<string, number> = {};
    for (const v of m.values ?? []) {
      const o = num(v.odd);
      if (o !== null && !v.suspended) compacto[`${v.value}${v.handicap != null ? " " + v.handicap : ""}`] = o;
    }
    vistos[nombre] = compacto;
    const esMitad = /1st|first|half|2nd|second/i.test(nombre);
    const es1T = /1st|first/i.test(nombre);
    // Fuera: córners por equipo, carreras ("Race to the 9th"), quién saca el siguiente, 1x2 y hándicap de córners
    if (/team|home|away|race|which|last|first corner|1x2|handicap/i.test(nombre)) continue;
    if (alcance === "1T" ? !es1T : esMitad) continue;
    hayMercado = true;
    // Líneas enteras de 3 vías ("Match Corners", "Total Corners (3 way) (1st Half)"): "Over 2" = 3 o más,
    // igual que la línea 2,5. Visto el 15 nov en el primer aviso real: el 1T ofrecía "Over 2" (3 vías) y 2,5.
    const enteras = /match corners|3 ?way|exact/i.test(nombre);
    for (const v of m.values ?? []) {
      if (!/^over/i.test(String(v.value)) || v.suspended) continue;
      const l = num(v.handicap) ?? num(String(v.value).replace(/over/i, ""));
      const o = num(v.odd);
      if (l === null || o === null) continue;
      const igual = Math.abs(l - linea) < 1e-6 || (enteras && Math.abs(l - (linea - 0.5)) < 1e-6);
      if (igual && (!elegida || /total corners/i.test(nombre))) elegida = { cuota: o, mercado: nombre };
    }
  }
  return { hayMercado, cuota: elegida?.cuota ?? null, mercado: elegida?.mercado ?? null, vistos };
}

/** Texto con las cuotas de "exactamente N" y "más de N" (3 vías) del mismo tiempo, si la respuesta las trae. */
function alternativas(vistos: Record<string, Record<string, number>> | null, alcance: "1T" | "partido", meta: number): string | null {
  if (!vistos) return null;
  for (const [nombre, valores] of Object.entries(vistos)) {
    const es1T = /1st|first/i.test(nombre), esMitad = /half/i.test(nombre);
    if (!/3 ?way/i.test(nombre) || (alcance === "1T" ? !es1T : esMitad)) continue;
    const exacto = valores[`Exactly ${meta}`], mas = valores[`Over ${meta}`];
    const partes = [mas ? `más de ${meta} paga ${cuotaTxt(mas)}` : null, exacto ? `exactamente ${meta} paga ${cuotaTxt(exacto)}` : null].filter(Boolean);
    if (partes.length) return partes.join(", ");
  }
  return null;
}

/** Un ciclo del mercado de córners. Se llama desde el ciclo Flashscore del escáner. */
export async function cicloCorners(args: {
  cfg: Config; vivosFS: FS.PartidoFS[]; conocidos: Map<string, any>; api: ApiFootball; log: (s: string) => void;
}) {
  const { cfg, vivosFS, conocidos, api, log } = args;
  await resolverCorners(vivosFS, log, cfg.corners_push !== false);
  if (cfg.corners_activo !== true) return;

  const P = parametrosCorners(cfg);
  const enVivo = vivosFS.filter((p) => p.estado === 2);
  if (!enVivo.length) return;

  // Ligas apagadas en la pestaña Ligas: tampoco avisan córners (solo se sabe si el partido tiene pareja)
  const fixtureDe = (p: FS.PartidoFS): number | null => conocidos.get(p.id)?.fixture_id ?? null;
  const ids = enVivo.map(fixtureDe).filter(Boolean) as number[];
  const infoP = new Map<number, any>();
  if (ids.length) {
    for (const r of await sql`select p.fixture_id, p.favorito, coalesce(l.habilitada, true) as habilitada
                              from futbol.partidos p left join futbol.ligas l on l.id = p.liga_id
                              where p.fixture_id = any(${ids}::int[])`) infoP.set(r.fixture_id, r);
  }

  // Ventanas de minutos. Un partido pasa por cada ventana (7 y 4 min) al menos una vez con ciclos de 2-5 min.
  const pendientes: { p: FS.PartidoFS; mercado: Mercado; minuto: number }[] = [];
  for (const p of enVivo) {
    const em = FS.estadoYMinuto(p);
    if (em.minuto === null) continue;
    const fx = fixtureDe(p);
    if (fx && infoP.get(fx)?.habilitada === false) continue;
    if (em.estado === "1H" && em.minuto >= P.t1_desde && em.minuto <= P.t1_hasta) pendientes.push({ p, mercado: "c1t_cero20", minuto: em.minuto });
    if (em.estado === "1H" && em.minuto >= P.t1u_desde && em.minuto <= P.t1u_hasta) pendientes.push({ p, mercado: "c1t_uno", minuto: em.minuto });
    // 2T: solo si alguien gana (el favorito tiene que ir perdiendo); el favorito se confirma abajo
    if (em.estado === "2H" && em.minuto >= P.t2_desde && em.minuto <= P.t2_hasta && p.gl !== p.gv) pendientes.push({ p, mercado: "c2t_fav77", minuto: em.minuto });
  }
  if (!pendientes.length) return;

  // Cada partido se revisa UNA vez por mercado (queda en corners_chequeos, avise o no)
  const hechos = new Set((await sql`select fs_id || '|' || mercado as k from futbol.corners_chequeos
                                    where fs_id = any(${pendientes.map((x) => x.p.id)}::text[])`).map((r: any) => r.k));
  // Un solo aviso del 1T por partido: el que ya avisó por 0 córners no avisa por 1 córner
  for (const r of await sql`select fs_id from futbol.alertas_corners where mercado = 'c1t_cero20'
                            and fs_id = any(${pendientes.map((x) => x.p.id)}::text[])`) hechos.add(`${r.fs_id}|c1t_uno`);
  const avisados1T = new Set<string>();
  const tope = Number(cfg.corners_stats_por_ciclo ?? 25);
  let leidos = 0;
  const [{ usadas }] = await sql`select count(*)::int as usadas from futbol.alertas_corners
                                 where api_consultada and ts >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;
  let cupoApi = Math.max(0, Number(cfg.corners_api_max_dia ?? 8) - Number(usadas));

  for (const { p, mercado, minuto } of pendientes) {
    if (hechos.has(`${p.id}|${mercado}`)) continue;
    if (mercado === "c1t_uno" && avisados1T.has(p.id)) continue;   // avisó c1t_cero20 en este mismo ciclo
    const fx = fixtureDe(p);

    // ---- Favorito (solo 2T): el de la base, o la cuota de apertura de Flashscore (gratis) ----
    let favorito: "home" | "away" | null = null;
    if (mercado === "c2t_fav77") {
      favorito = (fx ? infoP.get(fx)?.favorito : null) ?? null;
      if (!favorito) {
        const guardadas = conocidos.get(p.id)?.cuotas;
        let ap = guardadas?.apertura ?? guardadas?.actual ?? null;
        if (!ap) {
          try {
            const c = await FS.cuotas(p.id, p.idLocal, p.idVisitante);
            ap = c.apertura ?? c.actual;
            await sql`update futbol.fs_partidos set cuotas = ${sql.json(c as any)} where fs_id = ${p.id}`;
          } catch (e) { log(`córners: cuotas fs ${p.id}: ${(e as Error).message}`); }
        }
        favorito = ap ? A.definirFavorito(ap, Number.POSITIVE_INFINITY) : null;
      }
      const pierde = favorito === "home" ? p.gl < p.gv : favorito === "away" ? p.gv < p.gl : false;
      // Sin chequeo: si el favorito recibe un gol en el 78' todavía puede avisar en el siguiente ciclo
      if (!pierde) continue;
    }

    // ---- Córners actuales (Flashscore, gratis) ----
    if (leidos++ >= tope) { log(`córners: tope de ${tope} estadísticas por ciclo`); break; }
    let ck: FS.CornersFS;
    try { ck = await FS.corners(p.id); } catch (e) { log(`córners: stats ${p.id}: ${(e as Error).message}`); continue; }
    // En el 1T el bloque "1st Half" y el del partido son lo mismo; si falta uno se usa el otro
    const actual = es1T(mercado) ? (ck.t1 ?? ck.partido) : ck.partido;
    if (!actual) { await chequeo(p, mercado, minuto, null, false, ck.filas ? "sin_fila_corners" : "sin_stats"); continue; }
    const total = actual[0] + actual[1];
    if (mercado === "c1t_cero20" && total > 0) { await chequeo(p, mercado, minuto, actual, false, "con_corners"); continue; }
    // c1t_uno: con 0 córners no se cierra el chequeo (puede llegar el primero dentro de la ventana)
    if (mercado === "c1t_uno" && total === 0) continue;
    if (mercado === "c1t_uno" && total > 1) { await chequeo(p, mercado, minuto, actual, false, "dos_o_mas"); continue; }

    // ---- Aviso ----
    // c1t_uno busca UN córner más (1 → más de 1,5); los otros, corners_objetivo más
    const objetivo = mercado === "c1t_uno" ? 1 : P.objetivo;
    const linea = total + objetivo - 0.5;   // 0 córners → 1,5; 1 córner (c1t_uno) → 1,5; 7 córners → 8,5
    let cuota: number | null = null, mercadoNombre: string | null = null, hayMercado: boolean | null = null;
    let vistos: any = null, consultada = false, motivoSinCuota: string | null = null;
    if (cfg.corners_cuota === false) motivoSinCuota = "cuota_apagada";
    else if (!fx || fx < 0) motivoSinCuota = "sin_pareja_api";   // id negativo = solo Flashscore (DECISIONES 42)
    else if (cupoApi <= 0) motivoSinCuota = "tope_diario";
    else if (api.quedan() < 1) motivoSinCuota = "sin_presupuesto_api";
    else {
      try {
        cupoApi--; consultada = true;
        const r = await api.get("/odds/live", { fixture: fx });
        const c = parsearCuotaCorners(r, es1T(mercado) ? "1T" : "partido", linea);
        cuota = c.cuota; mercadoNombre = c.mercado; hayMercado = c.hayMercado; vistos = c.vistos;
        if (!c.hayMercado) motivoSinCuota = Object.keys(c.vistos).length ? "sin_mercado_de_ese_tiempo" : "sin_mercado";
        else if (c.cuota === null) motivoSinCuota = "sin_esa_linea";
      } catch (e) { motivoSinCuota = "error_api"; log(`córners: odds ${fx}: ${(e as Error).message}`); }
    }

    const fav = favorito === "home" ? p.local : favorito === "away" ? p.visitante : null;
    const [al] = await sql`
      insert into futbol.alertas_corners (mercado, version, parametros, fs_id, fixture_id, liga, local, visitante, favorito,
        minuto, goles_local, goles_visitante, corners_local, corners_visitante, linea, objetivo,
        api_consultada, hay_mercado, cuota, mercado_nombre, motivo_sin_cuota, mercados_vistos, stats)
      values (${mercado}, ${P.version}, ${sql.json(P as any)}, ${p.id}, ${fx}, ${p.liga}, ${p.local}, ${p.visitante}, ${favorito},
        ${minuto}, ${p.gl}, ${p.gv}, ${actual[0]}, ${actual[1]}, ${linea}, ${objetivo},
        ${consultada}, ${hayMercado}, ${cuota}, ${mercadoNombre}, ${motivoSinCuota}, ${vistos ? sql.json(vistos) : null}, ${sql.json(ck.extra as any)})
      on conflict (fs_id, mercado) do nothing
      returning id`;
    await chequeo(p, mercado, minuto, actual, true, null);
    if (es1T(mercado)) avisados1T.add(p.id);
    if (!al) continue;

    // Sin la línea exacta, las alternativas del mismo tiempo (visto en el 1T: "más de 2" y "exactamente 2").
    // La fuente de la cuota no se muestra (Fredy, 15 nov).
    const alt = cuota ? null : alternativas(vistos, es1T(mercado) ? "1T" : "partido", total + objetivo);
    const precio = cuota ? `, paga ${cuotaTxt(cuota)}` : alt ? `. Sin esa línea: ${alt}` : "";
    const cuerpo = mercado === "c1t_cero20"
      ? `Córners 1T: ${p.local} ${p.gl}–${p.gv} ${p.visitante}, min ${minuto}. Sin córners todavía. Entrada: más de ${coma(linea)} córners en el 1T${precio}.` +
        await cuotaMinimaCero(cfg, log)
      : mercado === "c1t_uno"
      ? `Córners 1T: ${p.local} ${p.gl}–${p.gv} ${p.visitante}, min ${minuto}. Va 1 córner. Todavía se puede entrar: más de ${coma(linea)} córners en el 1T (falta 1)${precio}.`
      : `Córners 2T: ${p.local} ${p.gl}–${p.gv} ${p.visitante}, min ${minuto}. ${fav} es favorito y va perdiendo. Van ${total} córners. Entrada: más de ${coma(linea)}${precio}.`;
    const n = cfg.corners_push === false ? 0 : await notificar({
      titulo: ligaFS(p.liga).txt,
      cuerpo, url: `./#corners/${al.id}`, tag: `corner-${al.id}`,
    }, { soloAdmin: true });
    await sql`update futbol.alertas_corners set push_enviados = ${n} where id = ${al.id}`;
    log(`córners: aviso ${mercado} ${p.local}-${p.visitante} min ${minuto}, línea ${linea}, cuota ${cuota ?? motivoSinCuota}`);
  }
}

/**
 * Cuota mínima para tomar en el aviso de 0 córners (DECISIONES 47, Fredy 19 nov). Mismo criterio que goles:
 * sale de la base (futbol.lab_umbrales, recalculada cada hora) y va condicionada a "iba 0 córners".
 *   justa    = 1 / acierto            (config corners_cuota_min_tipo = "justa", por defecto)
 *   prudente = 1 / límite bajo Wilson (= "umbral" del laboratorio de goles)
 * Solo líneas 1,5 y 2,5 del 1T (3,5 todavía no se maneja). Si algo falla, la push sale sin esta línea.
 */
async function cuotaMinimaCero(cfg: Config, log: (s: string) => void): Promise<string> {
  try {
    const U = await umbrales(log);
    const prudente = String(cfg.corners_cuota_min_tipo ?? "justa") === "prudente";
    const una = (est: string, txt: string) => {
      const u = U.get(est);
      const v = Number(prudente ? u?.umbral : u?.cuota_justa);
      if (!u || !Number.isFinite(v) || v <= 0) return null;
      return `${txt} desde ${coma(Number(v.toFixed(2)))} (${u.aciertos} de ${u.n})`;
    };
    const partes = [una("c1t_cero20", "más de 1,5"), una("c1t_cero20_o25", "más de 2,5")].filter(Boolean);
    return partes.length ? `\nCuota mínima${prudente ? " prudente" : ""} con 0 córners: ${partes.join(" · ")}.` : "";
  } catch (e) { log(`córners: cuota mínima: ${(e as Error).message}`); return ""; }
}

async function chequeo(p: FS.PartidoFS, mercado: Mercado, minuto: number, ck: [number, number] | null, alerto: boolean, motivo: string | null) {
  await sql`insert into futbol.corners_chequeos (fs_id, mercado, minuto, liga, local, visitante, goles_local, goles_visitante,
              corners_local, corners_visitante, alerto, motivo)
            values (${p.id}, ${mercado}, ${minuto}, ${p.liga}, ${p.local}, ${p.visitante}, ${p.gl}, ${p.gv},
              ${ck?.[0] ?? null}, ${ck?.[1] ?? null}, ${alerto}, ${motivo})
            on conflict (fs_id, mercado) do nothing`;
}

/**
 * Resolución gratis con las estadísticas de Flashscore:
 *  · 1T: acierto apenas el 1T suma `corners_al_avisar + objetivo`; fallo si llega el descanso sin eso.
 *  · 2T: acierto apenas el partido suma `corners_al_avisar + objetivo`; fallo al terminar sin eso.
 * Si el partido desaparece de la lista (se cambió el día UTC) se busca en la de ayer; a las 4 h sin
 * desenlace se anula (aplazado, suspendido o sin datos), y no cuenta para el acierto.
 */
async function resolverCorners(vivosFS: FS.PartidoFS[], log: (s: string) => void, conPush: boolean) {
  const pend = await sql`select id, mercado, fs_id, liga, local, visitante, corners_local + corners_visitante as ck0, objetivo, cuota, ts
                         from futbol.alertas_corners where resultado = 'pendiente' order by ts limit 20`;
  if (!pend.length) return;
  const hoy = new Map(vivosFS.map((p) => [p.id, p]));
  let ayer: Map<string, FS.PartidoFS> | null = null;
  for (const a of pend) {
    let p = hoy.get(a.fs_id);
    if (!p && !ayer) { try { ayer = new Map((await FS.listaDia(-1)).map((x) => [x.id, x])); } catch (_e) { ayer = new Map(); } }
    p = p ?? ayer?.get(a.fs_id);
    const viejo = Date.now() - new Date(a.ts).getTime() > 4 * 3600_000;
    if (!p || (p.estado !== 2 && p.estado !== 3)) {
      if (viejo) await sql`update futbol.alertas_corners set resultado = 'anulada', cerrada_ts = now(), nota = 'sin desenlace en Flashscore' where id = ${a.id}`;
      continue;
    }
    let ck: FS.CornersFS;
    try { ck = await FS.corners(a.fs_id); } catch (e) { log(`córners: resolver ${a.fs_id}: ${(e as Error).message}`); continue; }
    const em = FS.estadoYMinuto(p);
    const meta = Number(a.ck0) + Number(a.objetivo);
    let ahora: number | null, cerrado: boolean;
    if (es1T(a.mercado)) {
      const enPrimerTiempo = em.estado === "1H";
      const bloque = ck.t1 ?? (enPrimerTiempo || em.estado === "HT" ? ck.partido : null);
      ahora = bloque ? bloque[0] + bloque[1] : null;
      cerrado = !enPrimerTiempo;   // descanso, 2T o terminado: el 1T ya no cambia
    } else {
      ahora = ck.partido ? ck.partido[0] + ck.partido[1] : null;
      cerrado = p.estado === 3;
    }
    if (ahora === null) {
      if (viejo || (cerrado && p.estado === 3)) await sql`update futbol.alertas_corners set resultado = 'anulada', cerrada_ts = now(), nota = 'sin estadísticas de córners' where id = ${a.id}`;
      continue;
    }
    await sql`update futbol.alertas_corners set corners_final = ${ahora} where id = ${a.id}`;
    if (ahora < meta && !cerrado) continue;
    const gano = ahora >= meta;
    const r = await sql`update futbol.alertas_corners set resultado = ${gano ? "acierto" : "fallo"}, corners_final = ${ahora},
                          minuto_cierre = ${em.minuto}, cerrada_ts = now()
                        where id = ${a.id} and resultado = 'pendiente' returning id`;
    if (!r.length) continue;
    const tiempo = es1T(a.mercado) ? " en el 1T" : "";
    if (conPush) await notificar({
      titulo: ligaFS(a.liga).txt,
      cuerpo: `${gano ? "✅ Salió" : "❌ No salió"}, córners${tiempo}: ${a.local} ${p.gl}–${p.gv} ${a.visitante}: ${ahora} córners${tiempo} (necesitaba ${meta})${gano && em.minuto ? `, al ${em.minuto}'` : ""}.${a.cuota ? ` Cuota ${cuotaTxt(a.cuota)}.` : ""}`,
      url: `./#corners/${a.id}`, tag: `corner-${a.id}`,
    }, { soloAdmin: true });
    log(`córners: alerta ${a.id} ${gano ? "acierto" : "fallo"} (${ahora}/${meta})`);
  }
}

// =====================================================================
// Córners por tiempo de CADA partido terminado (DECISIONES 45, 19 nov 2026).
// Un pedido a Flashscore (df_st) por partido de liga habilitada. Si Flashscore aún no tiene
// estadísticas (o la liga no las publica) se reintenta hasta 3 veces, con 30 min entre intentos,
// y luego queda como 'sin_datos'. Busca hacia atrás corners_partido_dias, así que se rellena solo.
// =====================================================================
export async function guardarCornersPartidos(cfg: Config, log: (s: string) => void): Promise<number> {
  if (String(cfg.corners_partido_activo ?? "true") === "false") return 0;
  const max = Math.max(0, Number(cfg.corners_partido_max_ciclo ?? 12));
  const dias = Math.max(1, Number(cfg.corners_partido_dias ?? 7));
  if (!max) return 0;
  const lista = await sql`
    select p.fixture_id, p.liga_id, p.kickoff, f.fs_id, c.intentos
    from futbol.partidos p join futbol.ligas l on l.id = p.liga_id and l.habilitada
    join lateral (select fs_id from futbol.fs_partidos f where f.fixture_id = p.fixture_id order by creado desc limit 1) f on true
    left join futbol.corners_partido c on c.fixture_id = p.fixture_id
    where p.estado in ('FT', 'AET', 'PEN') and p.kickoff > now() - make_interval(days => ${dias})
      and (c.fixture_id is null or (c.estado = 'pendiente' and c.intentos < 3 and c.ultimo_intento < now() - interval '30 minutes'))
    order by c.fixture_id is not null, p.kickoff desc
    limit ${max}`;
  let ok = 0;
  for (const r of lista) {
    let c: FS.CornersFS | null = null;
    try { c = await FS.corners(r.fs_id); } catch (e) { log(`córners partido ${r.fixture_id}: ${(e as Error).message}`); }
    const tiene = !!c?.partido;
    const intentos = Number(r.intentos ?? 0) + 1;
    const estado = tiene ? "ok" : intentos >= 3 ? "sin_datos" : "pendiente";
    // Si Flashscore trae el total y el 1T pero no el 2T, el 2T es la resta
    const t1 = c?.t1 ?? null, tot = c?.partido ?? null;
    const t2 = c?.t2 ?? (t1 && tot ? [tot[0] - t1[0], tot[1] - t1[1]] : null);
    await sql`insert into futbol.corners_partido (fixture_id, fs_id, liga_id, kickoff, t1_local, t1_visitante, t2_local, t2_visitante,
                total_local, total_visitante, estado, intentos, ultimo_intento, leido_ts)
              values (${r.fixture_id}, ${r.fs_id}, ${r.liga_id}, ${r.kickoff}, ${t1?.[0] ?? null}, ${t1?.[1] ?? null},
                ${t2?.[0] ?? null}, ${t2?.[1] ?? null}, ${tot?.[0] ?? null}, ${tot?.[1] ?? null}, ${estado}, ${intentos}, now(),
                ${tiene ? new Date() : null})
              on conflict (fixture_id) do update set t1_local = excluded.t1_local, t1_visitante = excluded.t1_visitante,
                t2_local = excluded.t2_local, t2_visitante = excluded.t2_visitante, total_local = excluded.total_local,
                total_visitante = excluded.total_visitante, estado = excluded.estado, intentos = excluded.intentos,
                ultimo_intento = excluded.ultimo_intento, leido_ts = excluded.leido_ts`;
    if (tiene) ok++;
  }
  if (lista.length) log(`córners por tiempo: ${ok}/${lista.length} partidos guardados`);
  return ok;
}
