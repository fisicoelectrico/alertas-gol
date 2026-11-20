// =====================================================================
// Avisos para las personas (ADN Soccer, especificación 1.6). Todo sale de la base: cero consultas a
// API-Football. Una alerta = UNA notificación en el celular: alerta, recordatorios, gol y resultado
// usan el mismo tag (`alerta-<id>`) y cada una reemplaza a la anterior.
//
//  1. Alerta:        "CRB 0–1 Ceará, minuto 66. CRB es favorito, va perdiendo y ataca mucho. Otro gol paga 1,33."
//                    + una línea con la cuota de cada casa ("Wplay 1,35 · Stake 1,33 · Betano 1,30"), DECISIONES 40.
//  2. Recordatorios: hasta recordatorios_max (4), cada recordatorio_cada_min (5) minutos, mientras la alerta
//                    siga abierta, sin gol y antes de recordatorio_minuto_tope. No le llegan a quien ya marcó
//                    Entré o No entro. Son informativos: solo suben alertas.recordatorios.
//                    Fredy (20 nov, DECISIONES 59): solo para alertas cuya push SÍ salió (push_enviados > 0 y sin
//                    motivo_sin_push) y solo con la cuota real de BetPlay/Rushbet leída en los últimos minutos, con
//                    el mismo marcador. Si Kambi no la tiene en ese momento, el recordatorio espera (no se envía).
//  3. Gol:           "¡Gooooool de CRB al 88'!" apenas el marcador cambia (sin esperar el final).
//  4. Resultado:     si no hubo gol, "No hubo gol" al resolver. Si hubo y ya se avisó, no se repite.
// =====================================================================
import { sql, Config } from "./db.ts";
import { cuotaTxt, Destinatario, ligaTxt, lineasEntrada, notificar, pesos } from "./notificar.ts";
import { claveLinea, NOMBRE_CASA } from "./kambi.ts";

const favDe = (a: any): string =>
  a.favorito === "home" ? a.local : a.favorito === "away" ? a.visitante : a.local;

export async function avisoAlerta(alertaId: number) {
  const [a] = await sql`select a.id, a.fixture_id, a.cuota_casas, a.linea_over, a.minuto, a.cuota, a.marcador, p.local, p.visitante, p.favorito, l.nombre as liga, l.pais
                        from futbol.alertas a join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
                        where a.id = ${alertaId}`;
  if (!a) return 0;
  const [gl, gv] = String(a.marcador ?? "").split("-");
  // Cuota de cada casa (DECISIONES 40): la última foto en vivo de esa línea, de mayor a menor
  const casas = await sql`select distinct on (casa_id) casa, cuota_over from futbol.cuotas_vivo
                          where fixture_id = ${a.fixture_id} and linea = ${a.linea_over} and activa and cuota_over is not null
                            and ts > now() - interval '6 minutes'
                          order by casa_id, ts desc`;
  casas.sort((x: any, y: any) => Number(y.cuota_over) - Number(x.cuota_over));
  // Monto sugerido con la casa que paga MENOS (Fredy, 18 nov: lo prudente); sin casas, la cuota de la alerta
  // BetPlay y Rushbet (DECISIONES 54): van primero y el monto sale de la más baja de ellas (es donde se entra)
  const propias = Object.entries((a.cuota_casas ?? {}) as Record<string, number>)
    .map(([casa, c]) => ({ casa, cuota_over: Number(c) })).sort((x, y) => y.cuota_over - x.cuota_over);
  // Fredy (20 nov): Wplay/Betano no le sirven. Con BetPlay/Rushbet, la push muestra y calcula SOLO con ellas;
  // Flashscore solo aparece si no hay lectura de Kambi (Kambi apagado o kambi_caido_avisa).
  const ref = propias.length ? propias : casas;
  const baja = ref.length ? ref[ref.length - 1] : null;
  const cuotaBaja = baja ? Number(baja.cuota_over) : Number(a.cuota);
  const [mx] = await sql`select (valor #>> '{}')::numeric as v from futbol.config where clave = 'monto_max_pct'`;
  const maxPct = Number(mx?.v ?? 10);
  // Formato de Fredy (18 nov): país, competencia, partido, mercado, monto y casas, una línea cada uno
  const pais = (a.pais ?? "").replace(/-/g, " ").trim();
  const listaCasas = ref.map((c: any) => ({ casa: c.casa, c: Number(c.cuota_over) }));
  if (!listaCasas.length && a.cuota) listaCasas.push({ casa: "Promedio", c: Number(a.cuota) });
  return await notificar((d) => ({
    titulo: `⚽ Entrada sugerida · ${favDe(a)} ataca`,
    cuerpo: lineasEntrada({
      pais: pais && pais.toLowerCase() !== "world" ? pais : null, liga: a.liga,
      partido: `${a.local} ${gl ?? "?"}–${gv ?? "?"} ${a.visitante} · min ${a.minuto}`,
      mercado: `Más de ${String(a.linea_over).replace(".", ",")} goles (otro gol)`,
      d, casas: listaCasas, cuotaMonto: cuotaBaja, casaMonto: baja?.casa ?? null, maxPct,
    }),
    url: "./#ahora", tag: `alerta-${a.id}`, alerta_id: a.id, acciones: true,
  }), { alertaId: a.id });
}

// Texto personal del gol: si marcó Entré, cuánto ganó
function textoGanancia(d: Destinatario, cuotaAlerta: number) {
  if (d.decision !== "entre") return "";
  const c = d.cuota ?? cuotaAlerta;
  return d.monto ? ` Entraste a ${cuotaTxt(c)}: con ${pesos(d.monto)} ganaste ${pesos(d.monto * (c - 1))}.` : ` Entraste a ${cuotaTxt(c)}: ¡salió!`;
}

async function enviarGol(a: any, minuto: number | null, equipo: string, gl: number, gv: number) {
  return await notificar((d) => ({
    titulo: `¡Gooooool de ${equipo}${minuto ? ` al ${minuto}'` : ""}!`,
    cuerpo: `${ligaTxt(a.pais, a.liga)}: ${a.local} ${gl}–${gv} ${a.visitante}.${textoGanancia(d, Number(a.cuota))}`,
    url: "./#historial", tag: `alerta-${a.id}`, alerta_id: a.id,
  }), { alertaId: a.id });
}

// Corre en cada ciclo del escáner (cron de 1 min). Solo lee y escribe la base.
export async function avisosEnVivo(cfg: Config, log: (s: string) => void) {
  // ---- Gol: el marcador ya tiene más goles que al alertar ----
  const conGol = await sql`
    select a.id, a.fixture_id, a.ts, a.cuota, a.goles_al_alertar, p.local, p.visitante, p.favorito,
           p.goles_local as gl, p.goles_visitante as gv, l.nombre as liga, l.pais
    from futbol.alertas a join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
    where a.resultado = 'pendiente' and a.gol_avisado is null and coalesce(l.habilitada, true)
      and coalesce(a.push_enviados, 0) > 0   -- si la alerta no salió (sin BetPlay/Rushbet), tampoco su gol
      and p.goles_local + p.goles_visitante > a.goles_al_alertar and a.ts > now() - interval '4 hours'`;
  for (const a of conGol) {
    // Se marca primero (atómico): si dos ciclos coinciden, solo uno envía
    const marcada = await sql`update futbol.alertas set gol_avisado = now() where id = ${a.id} and gol_avisado is null returning id`;
    if (!marcada.length) continue;
    const [g] = await sql`select minuto, gl_antes, gl from futbol.cambios_marcador
                          where fixture_id = ${a.fixture_id} and ts >= ${a.ts} and gl + gv > ${a.goles_al_alertar}
                          order by ts limit 1`;
    const equipo = g ? (g.gl > g.gl_antes ? a.local : a.visitante) : favDe(a);
    const n = await enviarGol(a, g?.minuto ?? null, equipo, a.gl, a.gv);
    log(`aviso gol alerta ${a.id} push=${n}`);
  }

  // ---- Recordatorios ----
  const cada = Math.max(Number(cfg.recordatorio_cada_min ?? 5), 1);
  const max = Math.max(Number(cfg.recordatorios_max ?? 4), 0);
  const tope = Number(cfg.recordatorio_minuto_tope ?? 85);
  if (!max) return;
  const abiertas = await sql`
    select a.id, a.fixture_id, a.linea_over, a.goles_al_alertar, a.cuota, a.recordatorios, p.local, p.visitante, p.favorito, p.minuto, l.nombre as liga, l.pais,
           p.goles_local as gl, p.goles_visitante as gv,
           (select s.cuota_over from futbol.snapshots s where s.fixture_id = a.fixture_id and s.ts > a.ts and s.cuota_over is not null
             order by s.ts desc limit 1) as cuota_actual,
           (select s.dominancia from futbol.snapshots s where s.fixture_id = a.fixture_id and s.dominancia is not null
             order by s.ts desc limit 1) as dominancia
    from futbol.alertas a join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
    where a.resultado = 'pendiente' and a.gol_avisado is null and coalesce(l.habilitada, true)
      and coalesce(a.push_enviados, 0) > 0 and a.motivo_sin_push is null
      and p.goles_local + p.goles_visitante = a.goles_al_alertar
      and p.estado in ('1H', '2H') and coalesce(p.minuto, 0) < ${tope}
      and a.recordatorios < ${max} and a.ts > now() - interval '3 hours'
      and a.ts + make_interval(mins => (a.recordatorios + 1) * ${cada}) <= now() + interval '20 seconds'`;
  const exigeKambi = cfg.kambi_activo !== false && cfg.kambi_exigir !== false;
  const vig = Math.max(Number(cfg.kambi_vigencia_min ?? 5), 1);
  for (const a of abiertas) {
    const n0 = Number(a.recordatorios);
    // Cuota real de BetPlay/Rushbet de ahora (tabla que llena el cron futbol-kambi), mismo marcador
    let casasTxt = "", cuotaRec: number | null = null;
    if (exigeKambi) {
      const k = claveLinea(a.linea_over);
      const filas = await sql`select distinct on (casa) casa, (goles ->> ${k})::numeric as c from futbol.cuotas_casa
                              where fixture_id = ${a.fixture_id} and ts > now() - make_interval(mins => ${vig})
                                and goles_local + goles_visitante = ${a.goles_al_alertar}
                              order by casa, ts desc`;
      const conCuota = filas.filter((f: any) => f.c != null && Number(f.c) > 1)
        .map((f: any) => ({ casa: NOMBRE_CASA[f.casa] ?? f.casa, c: Number(f.c) })).sort((x: any, y: any) => y.c - x.c);
      if (!conCuota.length) { log(`recordatorio alerta ${a.id} en espera: BetPlay/Rushbet sin esa línea ahora`); continue; }
      cuotaRec = conCuota[0].c;
      casasTxt = ` (${conCuota.map((x: any) => `${x.casa} ${cuotaTxt(x.c)}`).join(" · ")})`;
    }
    const ok = await sql`update futbol.alertas set recordatorios = recordatorios + 1 where id = ${a.id} and recordatorios = ${n0} returning id`;
    if (!ok.length) continue;
    const ataca = Number(a.dominancia) >= Number(cfg.dominancia_min ?? 1.3);
    const n = await notificar({
      titulo: ligaTxt(a.pais, a.liga),
      cuerpo: `Sigue abierta, minuto ${a.minuto ?? "–"}: ${a.local} ${a.gl}–${a.gv} ${a.visitante}.${ataca ? ` ${favDe(a)} sigue atacando.` : ""} Otro gol paga ${cuotaTxt(cuotaRec ?? a.cuota_actual ?? a.cuota)}${casasTxt}. (Recordatorio ${n0 + 1} de ${max})`,
      url: "./#ahora", tag: `alerta-${a.id}`, alerta_id: a.id, acciones: true,
    }, { alertaId: a.id, omitirMarcados: true });
    log(`recordatorio ${n0 + 1}/${max} alerta ${a.id} push=${n}`);
  }
}

// Al resolver con API-Football (marcador de los 90').
export async function avisoResultado(
  a: { id: number; cuota: any; gol_avisado: any },
  r: { resultado: "acierto" | "fallo"; minuto_gol: number | null; lado_gol: "favorito" | "rival" | null; gl90: number; gv90: number },
  local: string, visitante: string, favorito: string | null,
) {
  const [lg] = await sql`select l.nombre as liga, l.pais, x.push_enviados from futbol.alertas x join futbol.partidos p using (fixture_id)
                         left join futbol.ligas l on l.id = p.liga_id where x.id = ${a.id}`;
  // La alerta no salió como push (p. ej. BetPlay/Rushbet sin el mercado): tampoco se avisa su resultado
  if (!(Number(lg?.push_enviados) > 0)) return 0;
  const base = { id: a.id, cuota: a.cuota, local, visitante, favorito, liga: lg?.liga ?? null, pais: lg?.pais ?? null };
  if (r.resultado === "acierto") {
    if (a.gol_avisado) return 0;    // ya se avisó el gol en vivo: no se repite
    await sql`update futbol.alertas set gol_avisado = now() where id = ${a.id} and gol_avisado is null`;
    const fav = favDe(base), rival = fav === local ? visitante : local;
    return await enviarGol(base, r.minuto_gol, r.lado_gol === "rival" ? rival : fav, r.gl90, r.gv90);
  }
  return await notificar((d) => {
    const c = d.cuota ?? Number(a.cuota);
    const mio = d.decision !== "entre" ? "" : d.monto ? ` Esta vez no salió: −${pesos(d.monto)}.` : " Esta vez no salió.";
    return {
      titulo: ligaTxt(base.pais, base.liga),
      cuerpo: `No hubo gol: ${local} ${r.gl90}–${r.gv90} ${visitante} terminó sin otro gol (cuota ${cuotaTxt(c)}).${mio}`,
      url: "./#historial", tag: `alerta-${a.id}`, alerta_id: a.id,
    };
  }, { alertaId: a.id });
}
