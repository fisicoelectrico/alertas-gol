// =====================================================================
// Edge Function `sonda-flashscore` (EXPERIMENTAL). Prueba en seco del lector _shared/flashscore.ts:
// lee la lista del día, calcula estado y minuto de los partidos en vivo, empareja con los partidos
// de API-Football ya guardados y lee cuotas y estadísticas de unos pocos. NO escribe en la base
// y NO gasta cuota de API-Football. Exige el header x-token = futbol.config.token_forzar.
// =====================================================================
import { sql, leerConfig } from "../_shared/db.ts";
import * as FS from "../_shared/flashscore.ts";

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const cfg = await leerConfig();
  if (typeof cfg.token_forzar !== "string" || req.headers.get("x-token") !== cfg.token_forzar) {
    return json({ error: "token" }, 401);
  }
  const out: Record<string, unknown> = { ts: new Date().toISOString() };
  try {
    const lista = await FS.listaDia(0);
    out.lista = { total: lista.length, en_vivo: lista.filter((p) => p.estado === 2).length,
      detalles: [...new Set(lista.map((p) => `${p.estado}/${p.detalle}`))] };
    out.vivos = lista.filter((p) => p.estado === 2).slice(0, 12).map((p) => ({
      id: p.id, liga: p.liga, partido: `${p.local} ${p.gl}-${p.gv} ${p.visitante}`, ...FS.estadoYMinuto(p),
      inicio: new Date(p.inicio).toISOString(), periodo: p.periodoDesde ? new Date(p.periodoDesde).toISOString() : null,
    }));

    // Emparejar contra los partidos de API-Football guardados de las últimas 30 h
    const api = (await sql`select fixture_id, local, visitante, kickoff from futbol.partidos
                           where kickoff > now() - interval '30 hours'`)
      .map((r: any) => ({ fixture_id: r.fixture_id, local: r.local, visitante: r.visitante, kickoff: new Date(r.kickoff).getTime() }));
    const cerca = lista.filter((p) => api.some((a) => Math.abs(a.kickoff - p.inicio) < 20 * 60000));
    const mapa = FS.emparejar(cerca, api);
    const porId = new Map(api.map((a) => [a.fixture_id, a]));
    out.emparejamiento = {
      api_guardados: api.length, fs_con_hora_compatible: cerca.length, emparejados: mapa.size,
      muestra: [...mapa.entries()].slice(0, 25).map(([fsId, m]) => {
        const f = lista.find((p) => p.id === fsId)!; const a = porId.get(m.fixture_id)!;
        return `${m.puntaje} | ${f.local} - ${f.visitante} ⇄ ${a.local} - ${a.visitante}`;
      }),
      api_sin_pareja: api.filter((a) => ![...mapa.values()].some((m) => m.fixture_id === a.fixture_id)).slice(0, 15)
        .map((a) => `${a.local} - ${a.visitante} @ ${new Date(a.kickoff).toISOString().slice(11, 16)}`),
    };

    // Cuotas y estadísticas de hasta 2 partidos en vivo y 1 por jugar
    const prueba = [...lista.filter((p) => p.estado === 2).slice(0, 2), ...lista.filter((p) => p.estado === 1).slice(0, 1)];
    out.detalle = [];
    for (const p of prueba) {
      const d: Record<string, unknown> = { partido: `${p.local} - ${p.visitante}`, estado: p.estado };
      try { d.cuotas = await FS.cuotas(p.id, p.idLocal, p.idVisitante); } catch (e) { d.cuotas_error = (e as Error).message; }
      if (p.estado === 2) {
        try { const s = await FS.estadisticas(p.id); d.stats_local = s.local; d.stats_visitante = s.visitante; } catch (e) { d.stats_error = (e as Error).message; }
      }
      (out.detalle as any[]).push(d);
    }
    // Forma cruda de un mercado Over/Under (para confirmar dónde viene la línea)
    if (prueba[0]) {
      const r = await fetch(`https://global.ds.lsapp.eu/odds/pq_graphql?_hash=oce&eventId=${prueba[0].id}&projectId=2&geoIpCode=CO&geoIpSubdivisionCode=CODC`,
        { headers: { "Referer": "https://www.flashscore.com/", "User-Agent": "Mozilla/5.0" } });
      const j = await r.json();
      const ou = (j?.data?.findOddsByEventId?.odds ?? []).find((m: any) => m.bettingType === "OVER_UNDER" && m.bettingScope === "FULL_TIME");
      out.over_crudo = ou ? JSON.stringify(ou).slice(0, 1500) : null;
    }
  } catch (e) {
    out.error = (e as Error).message;
  }
  await sql.end({ timeout: 1 }).catch(() => {});
  return json(out);
});
