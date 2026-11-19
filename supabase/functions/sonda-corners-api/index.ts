// =====================================================================
// Edge Function `sonda-corners-api` (EXPERIMENTAL, 19 nov 2026).
// Pregunta: ¿API-Football trae cuotas EN VIVO de córners, en cuántos partidos y con qué líneas?
// Gasta exactamente 2 consultas (registradas en futbol.api_uso con el freno de presupuesto):
//   1. /fixtures?live=all  → partidos en vivo con nombres, liga y minuto
//   2. /odds/live          → cuotas en vivo de TODOS los partidos en una sola respuesta
// No escribe nada más en la base. Exige el header x-token = futbol.config.token_forzar.
// =====================================================================
import { sql, leerConfig } from "../_shared/db.ts";
import { ApiFootball, estadoPresupuesto } from "../_shared/apifootball.ts";

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const cfg = await leerConfig();
  if (typeof cfg.token_forzar !== "string" || req.headers.get("x-token") !== cfg.token_forzar) {
    return json({ error: "token" }, 401);
  }
  const key = Deno.env.get("APIFOOTBALL_KEY")?.trim() ?? "";
  const api = new ApiFootball(key, await estadoPresupuesto(cfg));
  const out: Record<string, unknown> = { ts: new Date().toISOString(), disponibles_antes: api.quedan() };
  try {
    const fx = await api.get("/fixtures", { live: "all" });
    const odds = await api.get("/odds/live", {});
    const info = new Map<number, any>();
    for (const f of fx.response ?? []) info.set(f.fixture.id, f);
    out.fixtures_vivo = fx.results ?? (fx.response ?? []).length;
    out.odds_resultados = odds.results;
    out.odds_paging = odds.paging ?? null;

    const conteoMercados: Record<string, number> = {};
    let conCorners = 0, conCorners1T = 0;
    const filas: any[] = [];
    for (const r of odds.response ?? []) {
      const id = r.fixture?.id;
      const f = info.get(id);
      const corners = (r.odds ?? []).filter((m: any) => /corner/i.test(String(m.name ?? "")));
      for (const m of corners) conteoMercados[m.name] = (conteoMercados[m.name] ?? 0) + 1;
      const m1t = corners.filter((m: any) => /1st|first/i.test(m.name) && !/first corner|race|team|home|away/i.test(m.name));
      if (corners.length) conCorners++;
      if (m1t.length) conCorners1T++;
      filas.push({
        fixture: id,
        partido: f ? `${f.teams.home.name} ${f.goals.home}-${f.goals.away} ${f.teams.away.name}` : null,
        liga: f ? `${f.league.country} · ${f.league.name}` : r.league?.id,
        minuto: r.fixture?.status?.elapsed ?? f?.fixture?.status?.elapsed ?? null,
        periodo: r.fixture?.status?.long ?? null,
        mercados_total: (r.odds ?? []).length,
        corners: corners.map((m: any) => ({
          mercado: m.name,
          valores: (m.values ?? []).filter((v: any) => !v.suspended).slice(0, 8)
            .map((v: any) => `${v.value}${v.handicap != null ? " " + v.handicap : ""}=${v.odd}`),
        })),
      });
    }
    out.resumen = { partidos_con_cuotas: filas.length, con_mercado_corners: conCorners, con_corners_1T: conCorners1T };
    out.mercados_corners = conteoMercados;
    // Nombres de todos los mercados vistos (para saber qué más ofrece /odds/live)
    const todos: Record<string, number> = {};
    for (const r of odds.response ?? []) for (const m of r.odds ?? []) todos[m.name] = (todos[m.name] ?? 0) + 1;
    out.todos_los_mercados = todos;
    out.partidos = filas.sort((a, b) => b.corners.length - a.corners.length);
  } catch (e) {
    out.error = (e as Error).message;
  }
  out.consultas_gastadas = api.llamadas;
  return json(out);
});
