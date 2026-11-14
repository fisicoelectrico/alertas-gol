// =====================================================================
// Edge Function `sonda-flashscore` (EXPERIMENTAL, 14 nov 2026)
// Una sola lectura del feed interno de Flashscore para saber si responde desde Supabase y qué trae.
// No toca API-Football ni escribe en la base. Exige el header x-token = futbol.config.token_forzar.
// Formato del feed (texto, no JSON): registros separados por "~", campos por "¬", clave÷valor.
//   AA = id del partido · AE/AF = local/visitante · AG/AH = goles · AB = estado (1 por jugar, 2 en vivo, 3 terminado)
//   ZA = "PAÍS: Liga" en los registros de encabezado de competición.
// =====================================================================
import { sql, leerConfig } from "../_shared/db.ts";

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });

const FSIGN = "SW9D1eZo";
// Verificado el 14 nov 2026: d.flashscore.com responde "0"; el feed vivo está en flashscore.ninja.
const VARIANTES = [
  { dom: "https://local-global.flashscore.ninja/2/x/feed", feed: "f_1_0_1_en_1", ref: "https://www.flashscore.com/" },
];

function parsear(texto: string) {
  const partidos: any[] = [];
  let liga = "";
  for (const reg of texto.split("~")) {
    const campos: Record<string, string> = {};
    for (const c of reg.split("¬")) {
      const i = c.indexOf("÷");
      if (i > 0) campos[c.slice(0, i)] = c.slice(i + 1);
    }
    if (campos.ZA) liga = campos.ZA;
    if (campos.AA) partidos.push({ liga, ...campos });
  }
  return partidos;
}

Deno.serve(async (req) => {
  const cfg = await leerConfig();
  if (typeof cfg.token_forzar !== "string" || req.headers.get("x-token") !== cfg.token_forzar) {
    return json({ error: "token" }, 401);
  }
  const resultados: any[] = [];
  const fsign = FSIGN;
  for (const v of VARIANTES) {
    const url = v.dom.endsWith("/feed") ? `${v.dom}/${v.feed}` : `${v.dom}/x/feed/${v.feed}`;
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: { "x-fsign": fsign, "Referer": v.ref, "Origin": v.ref.replace(/\/$/, ""), "User-Agent": "Mozilla/5.0", "Accept": "*/*" },
      });
      const texto = await res.text();
      const partidos = parsear(texto);
      const enVivo = partidos.filter((p) => p.AB === "2");
      resultados.push({
        url, status: res.status, ms: Date.now() - t0, bytes: texto.length,
        cabeceras: { server: res.headers.get("server"), cf: res.headers.get("cf-ray") },
        partidos: partidos.length, en_vivo: enVivo.length,
        claves_vistas: [...new Set(partidos.flatMap((p) => Object.keys(p)))].sort(),
        muestra_en_vivo: enVivo.slice(0, 5),
        inicio: partidos.length ? undefined : texto.slice(0, 300),
      });
      if (enVivo.length) {
        // Con una variante que funcione basta. Se prueba además, para UN partido en vivo, el feed de
        // estadísticas y el de cuotas (prepartido y en vivo), para ver si llegan desde Supabase.
        const id = enVivo[0].AA;
        // Cuotas: Flashscore las sirve por otra API (lsapp.eu). Se prueban variantes forzando Colombia.
        for (const u of [
          `https://global.ds.lsapp.eu/odds/pq_graphql?_hash=oce&eventId=${id}&projectId=2&geoIpCode=CO&geoIpSubdivisionCode=CODC`,
        ]) {
          try {
            const r = await fetch(u, { headers: { "Referer": v.ref, "Origin": "https://www.flashscore.com", "User-Agent": "Mozilla/5.0", "Accept": "*/*" } });
            const j = await r.json();
            const o = j?.data?.findOddsByEventId ?? {};
            const resumen: any = { claves: Object.keys(o) };
            for (const k of Object.keys(o)) {
              if (k === "settings") continue;
              const val = o[k];
              resumen[k] = Array.isArray(val)
                ? { n: val.length, tipos: [...new Set(val.map((x: any) => `${x.bettingType}|${x.bettingScope}`))], primero: JSON.stringify(val[0]).slice(0, 2500) }
                : JSON.stringify(val).slice(0, 500);
            }
            resultados.push({ feed: u, partido: `${enVivo[0].AE} - ${enVivo[0].AF}`, status: r.status, resumen });
          } catch (e) {
            resultados.push({ feed: u, error: (e as Error).message });
          }
        }
        for (const f of [] as string[]) {
          try {
            const base = v.dom.endsWith("/feed") ? v.dom : `${v.dom}/x/feed`;
            const r = await fetch(`${base}/${f}`, {
              headers: { "x-fsign": fsign, "Referer": v.ref, "User-Agent": "Mozilla/5.0", "Accept": "*/*" },
            });
            const t = await r.text();
            resultados.push({ feed: f, partido: `${enVivo[0].AE} - ${enVivo[0].AF}`, status: r.status, bytes: t.length, inicio: t.slice(0, 1500) });
          } catch (e) {
            resultados.push({ feed: f, error: (e as Error).message });
          }
        }
        break;
      }
    } catch (e) {
      resultados.push({ url, error: (e as Error).message, ms: Date.now() - t0 });
    }
  }
  await sql.end({ timeout: 1 }).catch(() => {});
  return json({ ts: new Date().toISOString(), resultados });
});
