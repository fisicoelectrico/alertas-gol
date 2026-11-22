// =====================================================================
// Edge Function `respaldo` (DECISIONES 77, Fredy 22 nov 2026). Saca de la base el detalle completo de
// mercados de BetPlay/Rushbet (futbol.cuotas_casa.mercados, el 75 % de lo que pesa la tabla) y lo guarda
// en Supabase Storage, en un archivo comprimido por día. Fredy: "desde el storage podemos tomar los datos
// para analizarlos a futuro directamente".
//
// Cada corrida (cron futbol-respaldo, cada 5 min de madrugada):
//   1. Busca el día (hora Colombia) más viejo, con más de respaldo_dias_base días, que todavía tiene mercados.
//   2. Escribe las siguientes respaldo_filas_por_parte filas (TODAS las columnas, una fila JSON por línea,
//      gzip) en futbol-respaldo/cuotas_casa/AAAA/MM/AAAA-MM-DD/parte-NNN.jsonl.gz
//      Se lee directo con pandas: pd.read_json(ruta, lines=True, compression="gzip").
//   3. Poka-yoke: vuelve a bajar el archivo, lo descomprime y cuenta las líneas. Solo si el conteo coincide
//      vacía `mercados` de ESAS filas (rango de id de la parte). Las escaleras de Over (goles, goles_1t,
//      corners, corners_1t), el marcador y el minuto se quedan en la base.
//   4. Deja la huella en futbol.respaldos (día, parte, ruta, filas, bytes, rango de id, vaciadas).
//   Hace hasta respaldo_partes_por_llamada partes por llamada (tope de CPU de las Edge Functions); el cron
//   llama cada 5 min de 4 a 7 a. m. Colombia, así que el día del sábado sale en unos minutos.
//
// GET ?prueba=AAAA-MM-DD exporta un día a prueba/… y lo verifica sin vaciar nada.
// GET ?lista=1 devuelve los respaldos con un enlace firmado de descarga (válido 1 h), para el script del PC
// (herramientas/respaldo_mercados.py). Todo exige el header x-token = futbol.config.token_forzar.
// =====================================================================
import { sql, leerConfig } from "../_shared/db.ts";

const BUCKET = "futbol-respaldo";
const URL_SB = Deno.env.get("SUPABASE_URL")!;
const LLAVE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d, null, 2), { status, headers: { "Content-Type": "application/json" } });
const auth = { Authorization: `Bearer ${LLAVE}`, apikey: LLAVE };

async function subir(ruta: string, cuerpo: Uint8Array) {
  const r = await fetch(`${URL_SB}/storage/v1/object/${BUCKET}/${ruta}`, {
    method: "POST", body: cuerpo,
    headers: { ...auth, "Content-Type": "application/gzip", "x-upsert": "true" },
  });
  if (!r.ok) throw new Error(`subir ${ruta}: ${r.status} ${await r.text()}`);
}

/** Baja el archivo, lo descomprime en flujo y cuenta las líneas (sin cargarlo entero en memoria). */
/** Baja el archivo, lo descomprime en flujo y cuenta las líneas (sin cargarlo entero en memoria). */
async function contarLineas(ruta: string): Promise<number> {
  const r = await fetch(`${URL_SB}/storage/v1/object/${BUCKET}/${ruta}`, { headers: auth });
  if (!r.ok || !r.body) throw new Error(`bajar ${ruta}: ${r.status}`);
  let n = 0;
  const lector = r.body.pipeThrough(new DecompressionStream("gzip")).getReader();
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    for (let i = value.indexOf(10); i !== -1; i = value.indexOf(10, i + 1)) n++;
  }
  return n;
}

/**
 * Exporta UNA parte de un día: las siguientes `porParte` filas que aún tienen mercados (por id).
 * Por partes porque las Edge Functions tienen un tope de CPU por llamada: el día completo del sábado
 * (36 mil filas) lo pasaba ("CPU Time exceeded", 22 nov). La fila sale ya serializada desde Postgres
 * (to_jsonb(...)::text), así la función no gasta CPU armando JSON.
 */
async function respaldarParte(dia: string, porParte: number, prueba = false): Promise<Record<string, unknown>> {
  const desde = `${dia} 00:00:00-05`;
  const filasDb = await sql`select c.id, to_jsonb(c)::text as j from futbol.cuotas_casa c
                            where ts >= ${desde}::timestamptz and ts < ${desde}::timestamptz + interval '1 day'
                              and mercados is not null
                            order by id limit ${porParte}`;
  if (!filasDb.length) return { dia, filas: 0 };
  const [{ n }] = await sql`select count(*)::int as n from futbol.respaldos where dia = ${dia} and tabla = 'cuotas_casa'`;
  const parte = prueba ? 1 : n + 1;
  const ruta = `${prueba ? "prueba/" : ""}cuotas_casa/${dia.slice(0, 4)}/${dia.slice(5, 7)}/${dia}/parte-${String(parte).padStart(3, "0")}.jsonl.gz`;
  const minId = Number(filasDb[0].id), maxId = Number(filasDb[filasDb.length - 1].id);
  const texto = filasDb.map((f: any) => f.j).join("\n") + "\n";
  const cuerpo = new Uint8Array(await new Response(new Blob([texto]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const filas = filasDb.length;
  await subir(ruta, cuerpo);
  const lineas = await contarLineas(ruta);
  if (lineas !== filas) throw new Error(`${ruta}: el archivo tiene ${lineas} líneas y se exportaron ${filas}; no se vacía nada`);
  if (prueba) return { dia, ruta, filas, lineas, bytes: cuerpo.length, prueba: true };   // no vacía nada
  const r = await sql`update futbol.cuotas_casa set mercados = null
                      where ts >= ${desde}::timestamptz and ts < ${desde}::timestamptz + interval '1 day'
                        and id between ${minId} and ${maxId} and mercados is not null`;
  await sql`insert into futbol.respaldos (dia, tabla, parte, ruta, filas, bytes, min_id, max_id, vaciadas)
            values (${dia}, 'cuotas_casa', ${parte}, ${ruta}, ${filas}, ${cuerpo.length}, ${minId}, ${maxId}, ${r.count})`;
  return { dia, parte, ruta, filas, bytes: cuerpo.length, vaciadas: r.count };
}

Deno.serve(async (req) => {
  const cfg = await leerConfig();
  if (typeof cfg.token_forzar !== "string" || req.headers.get("x-token") !== cfg.token_forzar) return json({ error: "token" }, 401);
  const u = new URL(req.url);

  if (u.searchParams.get("lista")) {
    const filas = await sql`select dia::text, parte, ruta, filas, bytes, vaciadas, ts from futbol.respaldos order by dia, parte`;
    const out = [];
    for (const f of filas) {
      const r = await fetch(`${URL_SB}/storage/v1/object/sign/${BUCKET}/${f.ruta}`, {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 }),
      });
      const s = r.ok ? await r.json() : null;
      out.push({ ...f, url: s?.signedURL ? `${URL_SB}/storage/v1${s.signedURL}` : null });
    }
    return json(out);
  }

  // ?prueba=AAAA-MM-DD exporta ese día a prueba/… y verifica, SIN vaciar la base
  const prueba = u.searchParams.get("prueba");
  if (prueba && /^\d{4}-\d{2}-\d{2}$/.test(prueba)) {
    try { return json(await respaldarParte(prueba, Number(cfg.respaldo_filas_por_parte ?? 3000), true)); } catch (e) { return json({ error: (e as Error).message }, 500); }
  }

  if (cfg.respaldo_activo === false && !u.searchParams.get("forzar")) return json({ ok: true, apagado: true });
  const dejar = Math.max(1, Number(cfg.respaldo_dias_base ?? 3));
  const porParte = Math.max(100, Number(cfg.respaldo_filas_por_parte ?? 3000));
  const maxPartes = Math.max(1, Number(cfg.respaldo_partes_por_llamada ?? 2));
  const hechos: Record<string, unknown>[] = [];
  for (let i = 0; i < maxPartes; i++) {
    const [d] = await sql`select (min(ts) at time zone 'America/Bogota')::date::text as dia from futbol.cuotas_casa
                          where mercados is not null
                            and ts < ((now() at time zone 'America/Bogota')::date - ${dejar}::int)::timestamp at time zone 'America/Bogota'`;
    if (!d?.dia) break;
    try { hechos.push(await respaldarParte(d.dia, porParte)); }
    catch (e) { hechos.push({ dia: d.dia, error: (e as Error).message }); break; }
  }
  return json({ ok: !hechos.some((h: any) => h.error), dejar_dias: dejar, hechos });
});
