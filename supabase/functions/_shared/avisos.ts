// =====================================================================
// Avisos para las personas (ADN Soccer, especificación 1.6). Todo sale de la base: cero consultas a
// API-Football. Una alerta = UNA notificación en el celular: alerta, recordatorios, gol y resultado
// usan el mismo tag (`alerta-<id>`) y cada una reemplaza a la anterior.
//
//  1. Alerta:        "CRB 0–1 Ceará, minuto 66. CRB es favorito, va perdiendo y ataca mucho. Otro gol paga 1,33."
//  2. Recordatorios: hasta recordatorios_max (4), cada recordatorio_cada_min (5) minutos, mientras la alerta
//                    siga abierta, sin gol y antes de recordatorio_minuto_tope. No le llegan a quien ya marcó
//                    Entré o No entro. Son informativos: solo suben alertas.recordatorios.
//  3. Gol:           "¡Gooooool de CRB al 88'!" apenas el marcador cambia (sin esperar el final).
//  4. Resultado:     si no hubo gol, "No hubo gol" al resolver. Si hubo y ya se avisó, no se repite.
// =====================================================================
import { sql, Config } from "./db.ts";
import { cuotaTxt, Destinatario, notificar, pesos } from "./notificar.ts";

const favDe = (a: any): string =>
  a.favorito === "home" ? a.local : a.favorito === "away" ? a.visitante : a.local;

export async function avisoAlerta(alertaId: number) {
  const [a] = await sql`select a.id, a.minuto, a.cuota, a.marcador, p.local, p.visitante, p.favorito
                        from futbol.alertas a join futbol.partidos p using (fixture_id) where a.id = ${alertaId}`;
  if (!a) return 0;
  const [gl, gv] = String(a.marcador ?? "").split("-");
  return await notificar({
    titulo: "Nueva alerta · EN VIVO",
    cuerpo: `${a.local} ${gl ?? "?"}–${gv ?? "?"} ${a.visitante}, minuto ${a.minuto}. ${favDe(a)} es favorito, va perdiendo y ataca mucho. Otro gol paga ${cuotaTxt(a.cuota)}.`,
    url: "./#ahora", tag: `alerta-${a.id}`, alerta_id: a.id, acciones: true,
  }, { alertaId: a.id });
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
    cuerpo: `${a.local} ${gl}–${gv} ${a.visitante}.${textoGanancia(d, Number(a.cuota))}`,
    url: "./#historial", tag: `alerta-${a.id}`, alerta_id: a.id,
  }), { alertaId: a.id });
}

// Corre en cada ciclo del escáner (cron de 1 min). Solo lee y escribe la base.
export async function avisosEnVivo(cfg: Config, log: (s: string) => void) {
  // ---- Gol: el marcador ya tiene más goles que al alertar ----
  const conGol = await sql`
    select a.id, a.fixture_id, a.ts, a.cuota, a.goles_al_alertar, p.local, p.visitante, p.favorito,
           p.goles_local as gl, p.goles_visitante as gv
    from futbol.alertas a join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
    where a.resultado = 'pendiente' and a.gol_avisado is null and coalesce(l.habilitada, true)
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
    select a.id, a.cuota, a.recordatorios, p.local, p.visitante, p.favorito, p.minuto,
           p.goles_local as gl, p.goles_visitante as gv,
           (select s.cuota_over from futbol.snapshots s where s.fixture_id = a.fixture_id and s.ts > a.ts and s.cuota_over is not null
             order by s.ts desc limit 1) as cuota_actual,
           (select s.dominancia from futbol.snapshots s where s.fixture_id = a.fixture_id and s.dominancia is not null
             order by s.ts desc limit 1) as dominancia
    from futbol.alertas a join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
    where a.resultado = 'pendiente' and a.gol_avisado is null and coalesce(l.habilitada, true)
      and p.goles_local + p.goles_visitante = a.goles_al_alertar
      and p.estado in ('1H', '2H') and coalesce(p.minuto, 0) < ${tope}
      and a.recordatorios < ${max} and a.ts > now() - interval '3 hours'
      and a.ts + make_interval(mins => (a.recordatorios + 1) * ${cada}) <= now() + interval '20 seconds'`;
  for (const a of abiertas) {
    const n0 = Number(a.recordatorios);
    const ok = await sql`update futbol.alertas set recordatorios = recordatorios + 1 where id = ${a.id} and recordatorios = ${n0} returning id`;
    if (!ok.length) continue;
    const ataca = Number(a.dominancia) >= Number(cfg.dominancia_min ?? 1.3);
    const n = await notificar({
      titulo: `Sigue abierta · minuto ${a.minuto ?? "–"}`,
      cuerpo: `${a.local} ${a.gl}–${a.gv} ${a.visitante}.${ataca ? ` ${favDe(a)} sigue atacando.` : ""} Otro gol paga ${cuotaTxt(a.cuota_actual ?? a.cuota)}. (Recordatorio ${n0 + 1} de ${max})`,
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
  const base = { id: a.id, cuota: a.cuota, local, visitante, favorito };
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
      titulo: "No hubo gol",
      cuerpo: `${local} ${r.gl90}–${r.gv90} ${visitante} terminó sin otro gol (cuota ${cuotaTxt(c)}).${mio}`,
      url: "./#historial", tag: `alerta-${a.id}`, alerta_id: a.id,
    };
  }, { alertaId: a.id });
}
