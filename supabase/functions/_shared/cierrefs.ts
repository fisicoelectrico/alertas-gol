// =====================================================================
// Cierre de alertas con Flashscore (DECISIONES 42, 18 nov 2026). Reemplaza a /fixtures?id de
// API-Football para resolver alertas.
//
// ¿Cómo se decide?
//   · El escáner ya marca el partido como terminado (FT) con el marcador final de la lista de
//     Flashscore (paso 4b). Acierto = el total final supera los goles que había al alertar.
//     Las ligas que sigue la app no tienen prórroga (copas fuera), así que final = 90'.
//   · Minuto del gol que hizo ganar la alerta: el gol número (goles_al_alertar + 1) en las
//     incidencias de Flashscore (feed df_sui, 1 consulta). Si no se puede leer, el minuto del ciclo
//     en que el trigger vio cambiar el marcador (futbol.cambios_marcador, ±2 min).
//   · Lado (favorito o rival): sale de cambios_marcador, que es seguro (qué contador subió). Así no
//     dependemos de cómo Flashscore anota los autogoles.
//   · Red de seguridad: una alerta que a las 8 horas sigue sin final se anula (partido suspendido,
//     cambio de id, etc.), con nota en la bitácora.
// =====================================================================
import { sql } from "./db.ts";
import * as FS from "./flashscore.ts";
import { avisoResultado } from "./avisos.ts";

type Log = (s: string) => void;

/** "45+2'" → 47 ; "78'" → 78 ; null si no se entiende */
export function minutoNum(m: string): number | null {
  const x = String(m ?? "").match(/(\d+)(?:\s*\+\s*(\d+))?/);
  return x ? Number(x[1]) + Number(x[2] ?? 0) : null;
}

export async function resolverConFS(log: Log): Promise<number> {
  let resueltas = 0;
  const pend = await sql`
    select a.id, a.fixture_id, a.minuto, a.goles_al_alertar, a.cuota, a.gol_avisado,
           p.favorito, p.local, p.visitante, p.goles_local, p.goles_visitante, p.estado,
           (select fs_id from futbol.fs_partidos f where f.fixture_id = a.fixture_id order by creado desc limit 1) as fs_id
    from futbol.alertas a join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
    where a.resultado = 'pendiente' and coalesce(l.habilitada, true)
      and p.estado in ('FT', 'AET', 'PEN') and p.goles_local is not null`;
  for (const a of pend) {
    const gl = Number(a.goles_local), gv = Number(a.goles_visitante);
    const acierto = gl + gv > Number(a.goles_al_alertar);
    let minuto_gol: number | null = null, lado_gol: "favorito" | "rival" | null = null;
    if (acierto) {
      // Lado y minuto aproximado: el primer cambio de marcador que pasó la línea
      const [c] = await sql`select minuto, gl, gv, gl_antes, gv_antes from futbol.cambios_marcador
                            where fixture_id = ${a.fixture_id} and gl + gv > ${a.goles_al_alertar}
                              and gl_antes + gv_antes <= ${a.goles_al_alertar}
                            order by ts, id limit 1`;
      if (c) {
        const subioLocal = Number(c.gl) > Number(c.gl_antes);
        lado_gol = (subioLocal ? "home" : "away") === a.favorito ? "favorito" : "rival";
        minuto_gol = c.minuto ?? null;
      }
      // Minuto exacto: incidencias de Flashscore
      if (a.fs_id) {
        try {
          const { lista } = await FS.incidencias(a.fs_id);
          const goles = lista.filter((i) => i.tipo === "gol" || i.tipo === "autogol" || i.tipo === "penal")
            .map((i) => ({ ...i, m: minutoNum(i.minuto) })).filter((i) => i.m !== null)
            .sort((x, y) => x.m! - y.m!);
          if (goles.length === gl + gv) {
            const g = goles[Number(a.goles_al_alertar)];
            if (g) {
              minuto_gol = g.m;
              if (!lado_gol && g.lado && g.tipo !== "autogol") lado_gol = (g.lado === "local" ? "home" : "away") === a.favorito ? "favorito" : "rival";
            }
          } else log(`cierre fs alerta ${a.id}: incidencias con ${goles.length} goles y marcador ${gl}-${gv}; se usa el minuto del ciclo`);
        } catch (e) { log(`cierre fs alerta ${a.id}: incidencias ${(e as Error).message}`); }
      }
    }
    const resultado = acierto ? "acierto" : "fallo";
    await sql`update futbol.alertas set resultado = ${resultado}, minuto_gol = ${minuto_gol}, lado_gol = ${lado_gol}, cerrada_ts = now()
              where id = ${a.id} and resultado = 'pendiente'`;
    await sql`update futbol.partidos set goles_local_90 = coalesce(goles_local_90, ${gl}), goles_visitante_90 = coalesce(goles_visitante_90, ${gv}),
                seguimiento = false, cierre_fuente = coalesce(cierre_fuente, 'flashscore') where fixture_id = ${a.fixture_id}`;
    resueltas++;
    log(`resuelta alerta ${a.id} con Flashscore: ${resultado}${minuto_gol ? ` (gol ${minuto_gol}')` : ""}`);
    try {
      await avisoResultado(a as any, { resultado, minuto_gol, lado_gol, gl90: gl, gv90: gv }, a.local, a.visitante, a.favorito);
    } catch (e) { log(`aviso resultado ${a.id}: ${(e as Error).message}`); }
  }
  // Red de seguridad: sin final a las 8 horas → anulada
  const anuladas = await sql`
    update futbol.alertas a set resultado = 'anulada', cerrada_ts = now()
    from futbol.partidos p
    where a.fixture_id = p.fixture_id and a.resultado = 'pendiente' and a.ts < now() - interval '8 hours'
      and coalesce(p.estado, '') not in ('FT', 'AET', 'PEN')
    returning a.id`;
  if (anuladas.length) log(`alertas anuladas (8 h sin final en Flashscore): ${anuladas.map((r: any) => r.id).join(", ")}`);
  return resueltas + anuladas.length;
}
