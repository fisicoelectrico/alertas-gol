// =====================================================================
// Edge Function `api`: la única puerta de la PWA hacia la base de datos.
//
// ¿Por qué una función en vez de leer las tablas con supabase-js?
//  - El esquema `futbol` no necesita quedar "expuesto" en la API REST del proyecto
//    (no tocamos configuración global de central-ingenieria).
//  - Las lecturas salen ya armadas para cada pantalla (1 petición por pantalla).
//  - Las escrituras sensibles (umbrales, ligas) exigen el PIN de administrador
//    y quedan versionadas en futbol.reglas.
//
// Rutas (todas bajo /functions/v1/api):
//   GET  /resumen        pantalla "En vivo" + estado del escáner
//   GET  /radar          pestaña "Radar": todos los partidos en vivo del último barrido y por qué se descartan
//   GET  /alertas        pendientes y resueltas
//   GET  /rendimiento    acierto vs implícita, ROI (v_rendimiento) + historial por liga (v_ligas_historial)
//   GET  /ligas          ligas vistas y su rendimiento
//   GET  /config         parámetros, versiones de regla y consumo de API
//   GET  /vapid          llave pública para suscribirse a push
//   POST /suscribir      { endpoint, keys:{p256dh, auth} }
//   POST /desuscribir    { endpoint }
//   POST /admin/verificar   { pin }
//   POST /admin/config      { pin, cambios:{clave:valor}, nota? }
//   POST /admin/liga        { pin, id, habilitada }
//   POST /admin/push-prueba { pin }
//   POST /admin/pin         { pin, nuevo }
// =====================================================================
import { sql, leerConfig } from "../_shared/db.ts";
import { notificarTodos } from "../_shared/notificar.ts";
import { estadoPresupuesto } from "../_shared/apifootball.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Parámetros que se pueden cambiar desde la PWA (lista blanca)
const EDITABLES = new Set([
  "minuto_min", "minuto_max", "cuota_fav_max", "diferencia_min", "dominancia_min", "cuota_objetivo",
  "momentum_ventana_min", "momentum_gap_min", "pesos_ip",
  "escaneo_activo", "presupuesto_diario", "reserva_api", "intervalo_radar_min", "intervalo_seguimiento_min",
  "horas_activas_utc", "fraccion_radar", "max_detalle_escaneo", "stake", "cuotas_siempre",
]);
// Claves que nunca salen por la API pública
const OCULTAS = new Set(["token_forzar"]);

async function verificarPin(pin: unknown): Promise<{ ok: boolean; error?: string }> {
  if (typeof pin !== "string" || !/^\d{4,12}$/.test(pin)) return { ok: false, error: "PIN inválido" };
  const [a] = await sql`select pin_hash, fallos, bloqueado_hasta from futbol.admin where id = 1`;
  if (!a) return { ok: false, error: "No hay PIN configurado" };
  if (a.bloqueado_hasta && new Date(a.bloqueado_hasta) > new Date()) return { ok: false, error: "Bloqueado por intentos fallidos; espera 15 min" };
  const [{ ok }] = await sql`select extensions.crypt(${pin}, ${a.pin_hash}) = ${a.pin_hash} as ok`;
  if (ok) {
    await sql`update futbol.admin set fallos = 0, bloqueado_hasta = null where id = 1`;
    return { ok: true };
  }
  // 5 fallos seguidos → bloqueo de 15 min (y el contador vuelve a 0 para la siguiente ronda)
  await sql`update futbol.admin set
              bloqueado_hasta = case when fallos + 1 >= 5 then now() + interval '15 minutes' end,
              fallos = case when fallos + 1 >= 5 then 0 else fallos + 1 end
            where id = 1`;
  return { ok: false, error: "PIN incorrecto" };
}

function validarValor(clave: string, v: unknown): boolean {
  if (clave === "pesos_ip") {
    return typeof v === "object" && v !== null &&
      ["tiros_al_arco", "tiros_dentro_area", "tiros_totales", "corners", "xg", "posesion"]
        .every((k) => typeof (v as any)[k] === "number" && Number.isFinite((v as any)[k]));
  }
  if (clave === "horas_activas_utc") return Array.isArray(v) && v.every((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  if (clave === "escaneo_activo" || clave === "cuotas_siempre") return typeof v === "boolean";
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

async function resumen() {
  const cfg = await leerConfig();
  const enVivo = await sql`
    select p.fixture_id, p.local, p.visitante, p.estado, p.minuto, p.goles_local, p.goles_visitante,
           p.favorito, p.cuota_pre_local, p.cuota_pre_visitante, p.seguimiento, p.sin_stats, l.nombre as liga, l.pais,
           (select json_agg(s order by s.minuto) from (
              select minuto, ip_local, ip_visitante, dominancia, momentum, cuota_over, linea_over, evaluacion
              from futbol.snapshots where fixture_id = p.fixture_id order by ts desc limit 12) s) as serie,
           (select row_to_json(a) from futbol.alertas a where a.fixture_id = p.fixture_id
              order by ts desc limit 1) as alerta
    from futbol.partidos p left join futbol.ligas l on l.id = p.liga_id
    where p.seguimiento
       or exists (select 1 from futbol.alertas a where a.fixture_id = p.fixture_id and a.resultado = 'pendiente')
    order by p.minuto desc nulls last`;
  const [ultimo] = await sql`select ts, motivo, partidos_vivos, candidatos, llamadas, alertas, resueltas, detalle
                             from futbol.escaneos where motivo <> 'seguimiento' order by ts desc limit 1`;
  const [ultimoSeg] = await sql`select ts, candidatos, llamadas, alertas, detalle
                                from futbol.escaneos where motivo = 'seguimiento' order by ts desc limit 1`;
  return {
    en_vivo: enVivo, ultimo_escaneo: ultimo ?? null, ultimo_seguimiento: ultimoSeg ?? null,
    intervalo_seguimiento_min: cfg.intervalo_seguimiento_min,
    presupuesto: await estadoPresupuesto(cfg), presupuesto_diario: cfg.presupuesto_diario,
    regla_version: cfg.regla_version, escaneo_activo: cfg.escaneo_activo,
    horas_activas_utc: cfg.horas_activas_utc, cuota_objetivo: cfg.cuota_objetivo, dominancia_min: cfg.dominancia_min,
  };
}

// Pestaña Radar. No llama a API-Football: lee la foto que el escáner guardó en su último barrido.
async function radar() {
  const [ultimo] = await sql`select ts, motivo, partidos_vivos, llamadas, radar
                             from futbol.escaneos where radar is not null order by ts desc limit 1`;
  // Serie de las últimas 24 h: cuántos partidos en vivo vio cada radar (para la mini-gráfica)
  const historial = await sql`select ts, partidos_vivos as vivos from futbol.escaneos
                              where partidos_vivos is not null and ts > now() - interval '24 hours' order by ts`;
  // Ligas vistas en 24 h: cuántos partidos distintos y cuántos chocaron con cada tipo de hueco.
  // Un partido cuenta en una categoría si en ALGÚN barrido cayó ahí (no solo en el último).
  const ligas = await sql`
    with x as (
      select e.ts, j from futbol.escaneos e, jsonb_array_elements(e.radar) j
      where e.radar is not null and e.ts > now() - interval '24 hours')
    select (j->>'lg')::int as id, max(j->>'liga') as liga, max(j->>'pais') as pais,
           count(distinct j->>'id')::int as partidos,
           count(distinct j->>'id') filter (where j->>'mo' = 'sin_cuota_pre')::int as sin_cuota_pre,
           count(distinct j->>'id') filter (where j->>'mo' = 'sin_estadisticas')::int as sin_estadisticas,
           count(distinct j->>'id') filter (where j->>'mo' = 'sin_cuota_vivo')::int as sin_cuota_vivo,
           count(distinct j->>'id') filter (where j->>'mo' = 'aislada')::int as aislada,
           count(distinct j->>'id') filter (where j->>'mo' in ('evaluado','sin_cuota_vivo','sin_estadisticas','sin_cupo','ya_alertado'))::int as candidatos,
           max(ts) as visto
    from x group by 1 order by partidos desc, liga`;
  const cfg = await leerConfig();
  return { ultimo: ultimo ?? null, historial, ligas, horas_activas_utc: cfg.horas_activas_utc,
           minuto_min: cfg.minuto_min, minuto_max: cfg.minuto_max, cuota_fav_max: cfg.cuota_fav_max,
           diferencia_min: cfg.diferencia_min };
}

async function alertas() {
  return await sql`
    select a.*, p.local, p.visitante, p.favorito, p.goles_local_90, p.goles_visitante_90, l.nombre as liga
    from futbol.alertas a join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
    order by a.ts desc limit 200`;
}

async function rendimiento() {
  const filas = await sql`select * from futbol.v_rendimiento order by regla_version, liga, franja_minuto`;
  const [conteo] = await sql`select count(*) filter (where resultado='pendiente')::int as pendientes,
                                    count(*) filter (where resultado='anulada')::int as anuladas,
                                    count(*)::int as total from futbol.alertas`;
  const [datos] = await sql`select (select count(*)::int from futbol.snapshots) as snapshots,
                                   (select count(distinct fixture_id)::int from futbol.snapshots) as partidos_seguidos`;
  // Historial acumulado por liga (vista v_ligas_historial); la PWA lo agrupa por país.
  const historial = await sql`select * from futbol.v_ligas_historial
                              where precandidatos > 0 order by candidatos desc, precandidatos desc, vistos desc`;
  return { filas, conteo, datos, historial };
}

async function ligas() {
  return await sql`
    select l.id, l.nombre, l.pais, l.habilitada, l.notas,
           count(distinct p.fixture_id)::int as partidos,
           count(a.id) filter (where a.resultado in ('acierto','fallo'))::int as alertas_resueltas,
           count(a.id) filter (where a.resultado = 'acierto')::int as aciertos,
           round(sum(case when a.resultado='acierto' then a.cuota-1 when a.resultado='fallo' then -1 end), 2) as ganancia_u
    from futbol.ligas l
    left join futbol.partidos p on p.liga_id = l.id
    left join futbol.alertas a on a.fixture_id = p.fixture_id
    group by l.id order by alertas_resueltas desc, partidos desc, l.nombre limit 500`;
}

async function config() {
  const params = (await sql`select clave, valor, descripcion, es_regla, actualizado from futbol.config order by es_regla desc, clave`)
    .filter((p: any) => !OCULTAS.has(p.clave));
  const reglas = await sql`select version, parametros, creada, notas from futbol.reglas order by creada desc`;
  const uso = await sql`select fecha, endpoint, llamadas, restantes from futbol.api_uso
                        where fecha >= (now() at time zone 'utc')::date - 6 order by fecha desc, endpoint`;
  const escaneos = await sql`select ts, motivo, partidos_vivos, candidatos, llamadas, alertas, resueltas, duracion_ms
                             from futbol.escaneos order by ts desc limit 30`;
  const [subs] = await sql`select count(*) filter (where activa)::int as activas from futbol.push_suscripciones`;
  return { params, reglas, uso, escaneos, suscripciones: subs.activas, presupuesto: await estadoPresupuesto(await leerConfig()) };
}

async function cambiarConfig(cambios: Record<string, unknown>, nota?: string) {
  const actual = await sql`select clave, valor, es_regla from futbol.config`;
  const mapa = new Map(actual.map((f: any) => [f.clave, f]));
  const aplicar: [string, unknown][] = [];
  for (const [k, v] of Object.entries(cambios ?? {})) {
    if (!EDITABLES.has(k)) return { error: `parámetro no editable: ${k}` };
    if (!validarValor(k, v)) return { error: `valor inválido para ${k}` };
    if (JSON.stringify(mapa.get(k)?.valor) !== JSON.stringify(v)) aplicar.push([k, v]);
  }
  if (!aplicar.length) return { ok: true, sin_cambios: true };

  // Todo en una transacción: o se aplica completo (con su nueva versión) o nada.
  return await sql.begin(async (tx: any) => {
    for (const [k, v] of aplicar) {
      await tx`update futbol.config set valor = ${tx.json(v as any)}, actualizado = now() where clave = ${k}`;
    }
    const tocaRegla = aplicar.some(([k]) => mapa.get(k)?.es_regla);
    let version: string | null = null;
    if (tocaRegla) {
      // v1 → v2 → v3… (número máximo existente + 1)
      const [{ n }] = await tx`select coalesce(max(substring(version from 2)::int), 0) + 1 as n
                               from futbol.reglas where version ~ '^v[0-9]+$'`;
      version = `v${n}`;
      await tx`insert into futbol.reglas (version, parametros, notas)
               select ${version}, jsonb_object_agg(clave, valor), ${nota ?? null} from futbol.config where es_regla`;
      await tx`update futbol.config set valor = ${tx.json(version)}, actualizado = now() where clave = 'regla_version'`;
    }
    return { ok: true, cambiados: aplicar.map(([k]) => k), nueva_version: version };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const ruta = url.pathname.replace(/^.*\/api/, "") || "/";
  try {
    if (req.method === "GET") {
      if (ruta === "/resumen") return json(await resumen());
      if (ruta === "/alertas") return json(await alertas());
      if (ruta === "/radar") return json(await radar());
      if (ruta === "/rendimiento") return json(await rendimiento());
      if (ruta === "/ligas") return json(await ligas());
      if (ruta === "/config") return json(await config());
      if (ruta === "/vapid") return json({ publicKey: Deno.env.get("VAPID_PUBLIC")?.trim() ?? null });
      if (ruta === "/snapshots") {
        const id = Number(url.searchParams.get("fixture"));
        return json(await sql`select id, ts, minuto, goles_local, goles_visitante, stats_local, stats_visitante,
                                ip_local, ip_visitante, dominancia, momentum, linea_over, cuota_over, regla_version, evaluacion
                              from futbol.snapshots where fixture_id = ${id} order by ts`);
      }
      return json({ error: "ruta no encontrada" }, 404);
    }

    if (req.method !== "POST") return json({ error: "método no permitido" }, 405);
    const body = await req.json().catch(() => ({}));

    if (ruta === "/suscribir") {
      const { endpoint, keys } = body ?? {};
      if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || !keys?.p256dh || !keys?.auth) {
        return json({ error: "suscripción inválida" }, 400);
      }
      await sql`insert into futbol.push_suscripciones (endpoint, p256dh, auth)
                values (${endpoint}, ${keys.p256dh}, ${keys.auth})
                on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, activa = true, fallos = 0`;
      return json({ ok: true });
    }
    if (ruta === "/desuscribir") {
      await sql`update futbol.push_suscripciones set activa = false where endpoint = ${String(body?.endpoint ?? "")}`;
      return json({ ok: true });
    }

    if (ruta.startsWith("/admin/")) {
      const v = await verificarPin(body?.pin);
      if (!v.ok) return json({ error: v.error }, 401);
      if (ruta === "/admin/verificar") return json({ ok: true });
      if (ruta === "/admin/config") {
        const r = await cambiarConfig(body.cambios, body.nota);
        return json(r, (r as any).error ? 400 : 200);
      }
      if (ruta === "/admin/liga") {
        await sql`update futbol.ligas set habilitada = ${!!body.habilitada} where id = ${Number(body.id)}`;
        return json({ ok: true });
      }
      if (ruta === "/admin/push-prueba") {
        const n = await notificarTodos({ titulo: "🔔 Prueba de Alertas de Gol", cuerpo: "Si ves esto, las notificaciones funcionan.", url: "./#ajustes", tag: "prueba" });
        return json({ ok: true, enviados: n });
      }
      if (ruta === "/admin/pin") {
        if (typeof body.nuevo !== "string" || !/^\d{6,12}$/.test(body.nuevo)) return json({ error: "El PIN nuevo debe tener 6 a 12 dígitos" }, 400);
        await sql`update futbol.admin set pin_hash = extensions.crypt(${body.nuevo}, extensions.gen_salt('bf', 10)), actualizado = now() where id = 1`;
        return json({ ok: true });
      }
    }
    return json({ error: "ruta no encontrada" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
