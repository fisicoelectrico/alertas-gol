// =====================================================================
// Edge Function `respaldo` (DECISIONES 77, Fredy 22 nov 2026). Saca de la base el detalle completo de
// mercados de BetPlay/Rushbet (futbol.cuotas_casa.mercados, el 75 % de lo que pesa la tabla) y lo guarda
// en Supabase Storage, en un archivo comprimido por día. Fredy: "desde el storage podemos tomar los datos
// para analizarlos a futuro directamente".
//
// Cada corrida (cron futbol-respaldo, una vez al día de madrugada):
//   1. Busca los días (hora Colombia) con más de respaldo_dias_base días de antigüedad que todavía tienen
//      mercados en la base. Máximo respaldo_dias_por_corrida días por corrida.
//   2. Escribe TODAS las columnas de esas filas, una fila JSON por línea (JSONL), comprimido con gzip:
//        futbol-respaldo/cuotas_casa/AAAA/MM/AAAA-MM-DD.jsonl.gz
//      Se lee directo con pandas: pd.read_json(ruta, lines=True, compression="gzip").
//   3. Poka-yoke: vuelve a bajar el archivo, lo descomprime y cuenta las líneas. Solo si el conteo coincide
//      con las filas exportadas vacía `mercados` de ESAS filas (id <= max_id del día). Las escaleras de Over
//      (goles, goles_1t, corners, corners_1t), el marcador y el minuto se quedan en la base.
//   4. Deja la huella en futbol.respaldos (día, ruta, filas, bytes, max_id, vaciadas).
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
async function contarLineas(ruta: string): Promise<number> {
  const r = await fetch(`${URL_SB}/storage/v1/object/${BUCKET}/${ruta}`, { headers: auth });
  if (!r.ok || !r.body) throw new Error(`bajar ${ruta}: ${r.status}`);
  let n = 0;
  const lector = r.body.pipeThrough(new DecompressionStream("gzip")).getReader();
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) if (value[i] === 10) n++;
  }
  return n;
}

async function respaldarDia(dia: string, prueba = false): Promise<Record<string, unknown>> {
  const ruta = `${prueba ? "prueba/" : ""}cuotas_casa/${dia.slice(0, 4)}/${dia.slice(5, 7)}/${dia}.jsonl.gz`;
  const desde = `${dia} 00:00:00-05`;
  // Comprimir en flujo: las filas entran de a 500 y lo comprimido se va juntando aparte
  const gz = new CompressionStream("gzip");
  const escritor = gz.writable.getWriter();
  const salida = new Response(gz.readable).arrayBuffer();
  const enc = new TextEncoder();
  let filas = 0, maxId = 0;
  const cursor = sql`select * from futbol.cuotas_casa
                     where ts >= ${desde}::timestamptz and ts < ${desde}::timestamptz + interval '1 day'
                       and mercados is not null
                     order by id`.cursor(500);
  for await (const lote of cursor) {
    let txt = "";
    for (const f of lote) { txt += JSON.stringify(f) + "\n"; filas++; if (Number(f.id) > maxId) maxId = Number(f.id); }
    await escritor.write(enc.encode(txt));
  }
  await escritor.close();
  const cuerpo = new Uint8Array(await salida);
  if (!filas) return { dia, filas: 0 };
  await subir(ruta, cuerpo);
  const lineas = await contarLineas(ruta);
  if (lineas !== filas) throw new Error(`${dia}: el archivo tiene ${lineas} líneas y se exportaron ${filas}; no se vacía nada`);
  if (prueba) return { dia, ruta, filas, lineas, bytes: cuerpo.length, prueba: true };   // no vacía nada
  const r = await sql`update futbol.cuotas_casa set mercados = null
                      where ts >= ${desde}::timestamptz and ts < ${desde}::timestamptz + interval '1 day'
                        and id <= ${maxId} and mercados is not null`;
  await sql`insert into futbol.respaldos (dia, tabla, ruta, filas, bytes, max_id, vaciadas)
            values (${dia}, 'cuotas_casa', ${ruta}, ${filas}, ${cuerpo.length}, ${maxId}, ${r.count})
            on conflict (dia, tabla) do update set ruta = excluded.ruta, filas = futbol.respaldos.filas + excluded.filas,
              bytes = excluded.bytes, max_id = excluded.max_id, vaciadas = futbol.respaldos.vaciadas + excluded.vaciadas, ts = now()`;
  return { dia, ruta, filas, bytes: cuerpo.length, vaciadas: r.count };
}

Deno.serve(async (req) => {
  const cfg = await leerConfig();
  if (typeof cfg.token_forzar !== "string" || req.headers.get("x-token") !== cfg.token_forzar) return json({ error: "token" }, 401);
  const u = new URL(req.url);

  if (u.searchParams.get("lista")) {
    const filas = await sql`select dia::text, ruta, filas, bytes, vaciadas, ts from futbol.respaldos order by dia`;
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
    try { return json(await respaldarDia(prueba, true)); } catch (e) { return json({ error: (e as Error).message }, 500); }
  }

  if (cfg.respaldo_activo === false && !u.searchParams.get("forzar")) return json({ ok: true, apagado: true });
  const dejar = Math.max(1, Number(cfg.respaldo_dias_base ?? 3));
  const maxDias = Math.max(1, Number(cfg.respaldo_dias_por_corrida ?? 2));
  const dias = await sql`select distinct (ts at time zone 'America/Bogota')::date::text as dia from futbol.cuotas_casa
                         where mercados is not null
                           and ts < ((now() at time zone 'America/Bogota')::date - ${dejar}::int)::timestamp at time zone 'America/Bogota'
                         order by 1 limit ${maxDias}`;
  const hechos = [];
  for (const { dia } of dias) {
    try { hechos.push(await respaldarDia(dia)); }
    catch (e) { hechos.push({ dia, error: (e as Error).message }); break; }
  }
  return json({ ok: !hechos.some((h: any) => h.error), dejar_dias: dejar, hechos });
});
