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
//   GET  /widget         conteo y lista compacta para el widget de Android
//   GET  /radar          pestaña "Radar": todos los partidos en vivo del último barrido y por qué se descartan
//   GET  /alertas        pendientes y resueltas
//   GET  /partido?id=…   ficha de un partido (incidencias + estadísticas) para cualquier usuario; id = fixture
//                        de API-Football o "fs:<id Flashscore>". Lee Flashscore a pedido: 0 consultas de API-Football
//   GET  /rendimiento    acierto vs implícita, ROI (v_rendimiento) + historial por liga (v_ligas_historial)
//   GET  /ligas          ligas vistas y su rendimiento
//   GET  /candidatos?dias=14  candidatos (con y sin alerta), su desenlace y la serie de snapshots
//   GET  /config         parámetros, versiones de regla y consumo de API
//   GET  /vapid          llave pública para suscribirse a push
//   POST /suscribir      { endpoint, keys:{p256dh, auth} }
//   POST /desuscribir    { endpoint }
//   POST /admin/verificar   { pin }
//   POST /admin/config      { pin, cambios:{clave:valor}, nota? }
//   POST /admin/liga        { pin, id, habilitada }
//   POST /admin/push-prueba { pin }
//   POST /admin/pin         { pin, nuevo }
//
// Acceso de amigos (especificación 1.6). Cada petición puede traer el header `x-sesion` (token del
// celular). Con config.modo_acceso = 'abierto' todo funciona como antes, sin sesión; con 'cerrado'
// solo entra quien tiene sesión, y lo técnico (radar, candidatos, ligas, rendimiento, ajustes) es
// solo para administradores. Lo de administrador acepta la sesión admin o el PIN (respaldo).
//   GET  /yo                  quién soy (o usuario null) y el modo de acceso
//   GET  /mi-banca            mi yield, el del radar en el mismo periodo, mis movimientos
//   POST /mi-banca            { banca_inicial } y/o { ganancia_pct } (monto sugerido, DECISIONES 41)
//   POST /entradas            { alerta_id, decision: entre|no_entro|borrar, monto?, cuota?, origen? }
//   POST /acceso/canjear      { token } → { sesion, usuario }   (público: el enlace de WhatsApp)
//   POST /admin/usuarios      { accion: listar|crear|enlace|activo|editar, ... }
//   POST /admin/acceso        { modo: abierto|cerrado }
// =====================================================================
import { sql, leerConfig } from "../_shared/db.ts";
import { notificar } from "../_shared/notificar.ts";
import { canjear, enlaceNuevo, leerSesion, modoAcceso, normalizarTelefono, Sesion, sha256, tokenNuevo } from "../_shared/acceso.ts";
import { estadoPresupuesto } from "../_shared/apifootball.ts";
import * as FS from "../_shared/flashscore.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-sesion",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Parámetros que se pueden cambiar desde la PWA (lista blanca)
// Parámetros que definen la versión de córners: cambiar uno sube corners_version (c1 → c2…)
const CORNERS_REGLA = ["corners_1t_min_desde", "corners_1t_min_hasta", "corners_2t_min_desde", "corners_2t_min_hasta", "corners_objetivo"];
const EDITABLES = new Set([
  "minuto_min", "minuto_max", "cuota_fav_max", "diferencia_min", "dominancia_min", "cuota_objetivo",
  "momentum_ventana_min", "momentum_gap_min", "pesos_ip",
  "escaneo_activo", "presupuesto_diario", "reserva_api", "intervalo_radar_min", "intervalo_seguimiento_min",
  "horas_activas_utc", "fraccion_radar", "max_detalle_escaneo", "stake", "cuotas_siempre", "excluir_reempate", "excluir_roja_fav", "goles_fav_max",
  // Córners (lab, DECISIONES 37)
  "corners_activo", "corners_push", "corners_cuota", "corners_api_max_dia", ...CORNERS_REGLA,
  // Cuotas en vivo de Flashscore y laboratorio de goles (DECISIONES 40)
  "fs_vivo_activo", "fs_vivo_max_consultas", "fs_vivo_intervalo_min", "fs_vivo_intervalo_cand_min", "fs_fallos_aviso",
  "lab_activo", "lab_push", "lab_gt_minuto", "lab_gt_ventana_min", "lab_intervalo_min", "lab_intervalo_largo_min", "lab_n_min",
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
  if (clave === "corners_activo" || clave === "corners_push" || clave === "corners_cuota") return typeof v === "boolean";
  if (clave === "fs_vivo_activo" || clave === "lab_activo" || clave === "lab_push") return typeof v === "boolean";
  if (clave === "fs_vivo_max_consultas") return typeof v === "number" && Number.isInteger(v) && v >= 3 && v <= 60;
  if (clave === "escaneo_activo" || clave === "cuotas_siempre" || clave === "excluir_reempate" || clave === "excluir_roja_fav") return typeof v === "boolean";
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

// ---------- Ligas excluidas (DECISIONES 33) ----------
// Apagar una liga en la pestaña Ligas (ligas.habilitada = false) la saca AL INSTANTE de En vivo, Radar,
// widget, Alertas, Candidatos y Rendimiento. No se borra nada: el filtro se aplica al leer, así que si
// la liga se vuelve a activar todo reaparece. La foto del radar es JSON guardado por el escáner, por eso
// se filtra aquí y no espera al próximo barrido. Los partidos solo de Flashscore (lg = 0) se reconocen
// por nombre de liga + país.
async function ligasExcluidas() {
  const filas = await sql`select id, lower(nombre) as n, lower(coalesce(pais, '')) as p from futbol.ligas where habilitada = false`;
  const ids = new Set(filas.map((f: any) => Number(f.id)));
  const nombres = new Set(filas.map((f: any) => `${f.n}|${f.p}`));
  return (j: any) => ids.has(Number(j?.lg)) || nombres.has(`${String(j?.liga ?? "").toLowerCase()}|${String(j?.pais ?? "").toLowerCase()}`);
}
// Quita de una foto del radar los partidos de ligas excluidas y descuenta los que estaban en juego
async function fotoSinExcluidas(u: any) {
  if (!u?.radar) return u;
  const excluida = await ligasExcluidas();
  const quitados = u.radar.filter(excluida);
  if (!quitados.length) return u;
  const enJuego = quitados.filter((j: any) => j.e === "1H" || j.e === "2H" || j.e === "HT").length;
  return { ...u, radar: u.radar.filter((j: any) => !excluida(j)),
           partidos_vivos: u.partidos_vivos == null ? null : Math.max(0, u.partidos_vivos - enJuego) };
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
    where coalesce(l.habilitada, true)
      and (p.seguimiento
       or exists (select 1 from futbol.alertas a where a.fixture_id = p.fixture_id and a.resultado = 'pendiente'))
    order by p.minuto desc nulls last`;
  const [ultimo] = await sql`select ts, motivo, partidos_vivos, candidatos, llamadas, alertas, resueltas, detalle
                             from futbol.escaneos where motivo not in ('seguimiento', 'previa') order by ts desc limit 1`;
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

// Widget de Android y resumen compacto: lo mínimo para pintar "N en vivo · M candidatos" y la lista.
// Lee la última foto del radar (no gasta consultas de API-Football) y marca como candidato lo que
// el escáner tiene en seguimiento o con alerta pendiente. Respuesta chica (~100 bytes por partido).
// ---------- En vivo = solo ligas habilitadas (16 nov, Fredy) ----------
// La sección "En vivo" de Ahora y el widget de Android muestran SOLO partidos de ligas con
// habilitada = true: las apagadas y las que ni están en futbol.ligas (ej. femenina argentina) se ocultan.
// Es filtro de lectura: el escáner sigue guardando la foto completa de Flashscore (todas las ligas)
// y la pestaña Radar sigue mostrando las no registradas para la revisión semanal de ligas.
// Los partidos solo de Flashscore (lg = 0, "sin cruce") se reconocen por nombre + país, contra el nombre
// de la liga y contra los nombres que Flashscore ya usó para esa liga (futbol.fs_partidos: "SPAIN: LaLiga2"
// → liga 141). Cero consultas a API-Football.
const claveFS = (liga: string) => {
  const [pais, resto] = liga.includes(": ") ? liga.split(/: (.*)/s) : ["", liga];
  return `${(resto ?? liga).replace(/ - .*$/, "").toLowerCase()}|${pais.toLowerCase()}`;
};
async function ligasHabilitadas() {
  const filas = await sql`select id, lower(nombre) as n, lower(coalesce(pais, '')) as p from futbol.ligas where habilitada`;
  const ids = new Set(filas.map((f: any) => Number(f.id)));
  const nombres = new Set(filas.map((f: any) => `${f.n}|${f.p}`));
  const alias = await sql`select distinct f.liga from futbol.fs_partidos f join futbol.partidos p using (fixture_id)
                          join futbol.ligas l on l.id = p.liga_id where l.habilitada and f.liga is not null`;
  for (const a of alias) nombres.add(claveFS(a.liga));
  return (j: any) => Number(j?.lg) > 0
    ? ids.has(Number(j.lg))
    : nombres.has(`${String(j?.liga ?? "").toLowerCase()}|${String(j?.pais ?? "").toLowerCase()}`);
}

async function widget() {
  const [u0] = await sql`select ts, partidos_vivos, candidatos, radar from futbol.escaneos
                         where radar is not null order by ts desc limit 1`;
  if (!u0) return { ts: null, vivos: 0, candidatos: 0, partidos: [] };
  const habilitada = await ligasHabilitadas();
  const u = { ...u0, radar: (u0.radar ?? []).filter(habilitada) };
  const segs = new Set((await sql`
    select fixture_id from futbol.partidos where seguimiento
    union select fixture_id from futbol.alertas where resultado = 'pendiente'`).map((r: any) => String(r.fixture_id)));
  const partidos = (u.radar ?? []).map((p: any) => ({
    id: p.id, e: p.e, m: p.m, l: p.l, v: p.v, gl: p.gl, gv: p.gv, fav: p.fav, liga: p.liga, c: segs.has(String(p.id)),
  })).sort((a: any, b: any) => Number(b.c) - Number(a.c) || (b.m ?? -1) - (a.m ?? -1));
  // vivos se cuenta sobre la lista ya filtrada (el conteo guardado incluye todas las ligas)
  const vivos = partidos.filter((p: any) => ["1H", "HT", "2H", "ET", "BT", "P", "LIVE"].includes(p.e)).length;
  return { ts: u.ts, vivos, candidatos: partidos.filter((p: any) => p.c).length, partidos };
}

// Pestaña Radar. No llama a API-Football: lee la foto que el escáner guardó en su último barrido.
async function radar() {
  const [ultimo0] = await sql`select ts, motivo, partidos_vivos, llamadas, radar
                              from futbol.escaneos where radar is not null order by ts desc limit 1`;
  const ultimo = await fotoSinExcluidas(ultimo0);
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
    from x where not exists (select 1 from futbol.ligas l where l.id = (x.j->>'lg')::int and l.habilitada = false)
    group by 1 order by partidos desc, liga`;
  const cfg = await leerConfig();
  return { ultimo: ultimo ?? null, historial, ligas, horas_activas_utc: cfg.horas_activas_utc,
           minuto_min: cfg.minuto_min, minuto_max: cfg.minuto_max, cuota_fav_max: cfg.cuota_fav_max,
           diferencia_min: cfg.diferencia_min, goles_fav_max: cfg.goles_fav_max };
}

// Con sesión, cada alerta trae lo que marcó esa persona (mi_decision, mi_monto, mi_cuota) y,
// para el admin, cuántos amigos entraron. cuota_actual = la última cuota vista después de la alerta.
async function alertas(yo: Sesion | null) {
  const uid = yo?.usuario_id ?? -1;
  return await sql`
    select a.*, p.local, p.visitante, p.favorito, p.goles_local_90, p.goles_visitante_90, l.nombre as liga, l.pais,
           p.estado, p.minuto as minuto_actual, p.goles_local, p.goles_visitante,
           e.decision as mi_decision, e.monto as mi_monto, e.cuota as mi_cuota,
           (e.ts > coalesce(a.gol_avisado, a.cerrada_ts, 'infinity'::timestamptz)) as mi_tardia,
           (select count(*)::int from futbol.entradas x where x.alerta_id = a.id and x.decision = 'entre') as entraron,
           (select s.cuota_over from futbol.snapshots s where s.fixture_id = a.fixture_id and s.ts > a.ts and s.cuota_over is not null
             order by s.ts desc limit 1) as cuota_actual,
           a.minuto between coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'minuto_min'), 0)
                        and coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'minuto_max'), 200) as en_ventana
    from futbol.alertas a join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
    left join futbol.entradas e on e.alerta_id = a.id and e.usuario_id = ${uid}
    where coalesce(l.habilitada, true)
    order by a.ts desc limit 200`;
}

// ---------- Acceso de amigos ----------
// Métricas del radar "entrando en todas" (stake 1) desde una fecha. Igual que v_rendimiento: solo
// ligas activas y alertas dentro de la ventana de minutos (DECISIONES 34).
async function metricasRadar(desde: string | null) {
  const [r] = await sql`
    select count(*) filter (where a.resultado in ('acierto','fallo'))::int as cerradas,
           count(*) filter (where a.resultado = 'acierto')::int as aciertos,
           coalesce(sum(case when a.resultado = 'acierto' then a.cuota - 1 when a.resultado = 'fallo' then -1 end), 0)::float8 as ganancia_u
    from futbol.alertas a join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
    where coalesce(l.habilitada, true) and a.ts >= coalesce(${desde}::timestamptz, '-infinity'::timestamptz)
      and a.minuto between coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'minuto_min'), 0)
                       and coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'minuto_max'), 200)`;
  return { ...r, yield_pct: r.cerradas ? Math.round(1000 * r.ganancia_u / r.cerradas) / 10 : null };
}

async function miBanca(yo: Sesion) {
  const movimientos = await sql`
    select e.alerta_id, e.decision, e.monto, coalesce(e.cuota, a.cuota) as cuota, e.ts, a.resultado, a.minuto, a.minuto_gol,
           a.marcador, p.local, p.visitante,
           case when e.decision <> 'entre' then null
                when a.resultado = 'acierto' then coalesce(e.monto, 1) * (coalesce(e.cuota, a.cuota) - 1)
                when a.resultado = 'fallo' then -coalesce(e.monto, 1) end::float8 as ganancia
    from futbol.entradas e join futbol.alertas a on a.id = e.alerta_id join futbol.partidos p using (fixture_id)
    where e.usuario_id = ${yo.usuario_id} order by e.ts desc limit 200`;
  const entre = movimientos.filter((m: any) => m.decision === "entre");
  const cerr = entre.filter((m: any) => m.resultado === "acierto" || m.resultado === "fallo");
  const invertido = cerr.reduce((t: number, m: any) => t + Number(m.monto ?? 1), 0);
  const ganancia = cerr.reduce((t: number, m: any) => t + Number(m.ganancia), 0);
  // Plata real: solo las entradas con monto (sin monto cuentan para el yield, no para la banca)
  const conMonto = cerr.filter((m: any) => m.monto != null);
  const montos = entre.filter((m: any) => m.monto != null).map((m: any) => Number(m.monto));
  const [ex] = await sql`select ganancia_pct, futbol.banca_actual(${yo.usuario_id}::int) as banca_actual,
                                (select (valor #>> '{}')::numeric from futbol.config where clave = 'monto_max_pct') as monto_max_pct
                         from futbol.usuarios where id = ${yo.usuario_id}`;
  return {
    banca_inicial: yo.banca_inicial,
    ganancia_pct: ex?.ganancia_pct == null ? null : Number(ex.ganancia_pct),
    banca_actual: ex?.banca_actual == null ? null : Number(ex.banca_actual),
    monto_max_pct: Number(ex?.monto_max_pct ?? 10),
    yo: {
      entradas: entre.length, cerradas: cerr.length, aciertos: cerr.filter((m: any) => m.resultado === "acierto").length,
      invertido, ganancia, yield_pct: invertido ? Math.round(1000 * ganancia / invertido) / 10 : null,
      ganancia_pesos: conMonto.reduce((t: number, m: any) => t + Number(m.ganancia), 0),
      invertido_pesos: conMonto.reduce((t: number, m: any) => t + Number(m.monto), 0),
    },
    radar: await metricasRadar(yo.creado),
    radar_total: await metricasRadar(null),
    desde: yo.creado,
    stake_ref: montos.length ? Math.round(montos.reduce((a: number, b: number) => a + b, 0) / montos.length) : null,
    movimientos,
  };
}

async function marcarEntrada(yo: Sesion, b: any) {
  const alertaId = Number(b?.alerta_id);
  const decision = String(b?.decision ?? "");
  if (!Number.isInteger(alertaId) || !["entre", "no_entro", "borrar"].includes(decision)) return { error: "datos inválidos" };
  const [a] = await sql`select resultado, gol_avisado from futbol.alertas where id = ${alertaId}`;
  if (!a) return { error: "esa alerta no existe" };
  // Fredy (14 nov): también se puede marcar después (si entró y no alcanzó a tocar el botón). Queda a la
  // vista: una entrada marcada después del gol o del final sale como "marcada después" (mi_tardia y, para
  // el admin, la columna tardias en Amigos). Las anuladas no cuentan, así que no se marcan.
  if (a.resultado === "anulada") return { error: "Esta alerta se anuló (el partido no se jugó completo)." };
  if (decision === "borrar") {
    await sql`delete from futbol.entradas where usuario_id = ${yo.usuario_id} and alerta_id = ${alertaId}`;
    return { ok: true };
  }
  const monto = b?.monto == null || b.monto === "" ? null : Math.round(Number(b.monto));
  const cuota = b?.cuota == null || b.cuota === "" ? null : Number(b.cuota);
  if (monto !== null && !(monto > 0 && monto < 1e12)) return { error: "monto inválido" };
  if (cuota !== null && !(cuota > 1 && cuota < 100)) return { error: "cuota inválida" };
  const origen = b?.origen === "notificacion" ? "notificacion" : "app";
  // Desde la notificación no llega monto: se conserva el que ya hubiera escrito en la app
  const conservar = origen === "notificacion";
  const m = decision === "entre" ? monto : null, c = decision === "entre" ? cuota : null;
  await sql`
    insert into futbol.entradas (usuario_id, alerta_id, decision, monto, cuota, origen)
    values (${yo.usuario_id}, ${alertaId}, ${decision}, ${m}, ${c}, ${origen})
    on conflict (usuario_id, alerta_id) do update set
      decision = excluded.decision, ts = now(), origen = excluded.origen,
      monto = case when excluded.decision <> 'entre' then null when ${conservar} then coalesce(excluded.monto, futbol.entradas.monto) else excluded.monto end,
      cuota = case when excluded.decision <> 'entre' then null when ${conservar} then coalesce(excluded.cuota, futbol.entradas.cuota) else excluded.cuota end`;
  return { ok: true };
}

async function listarUsuarios() {
  return await sql`
    select u.id, u.nombre, u.telefono, u.rol, u.activo, u.creado, u.ultimo_acceso,
           (select count(*)::int from futbol.sesiones s where s.usuario_id = u.id and s.revocada is null) as sesiones,
           (select max(i.vence) from futbol.invitaciones i where i.usuario_id = u.id and i.usada is null and i.vence > now()) as enlace_vence,
           (select count(*)::int from futbol.push_suscripciones p where p.usuario_id = u.id and p.activa) as avisos,
           y.cerradas, y.aciertos, y.yield_pct,
           (select count(*)::int from futbol.entradas e where e.usuario_id = u.id and e.decision = 'entre') as entradas,
           (select count(*)::int from futbol.entradas e join futbol.alertas a on a.id = e.alerta_id
             where e.usuario_id = u.id and e.decision = 'entre'
               and e.ts > coalesce(a.gol_avisado, a.cerrada_ts, 'infinity'::timestamptz)) as tardias
    from futbol.usuarios u left join futbol.v_yield_usuario y on y.usuario_id = u.id
    order by u.activo desc, u.rol, u.nombre`;
}

async function adminUsuarios(b: any, yo: Sesion | null) {
  const accion = String(b?.accion ?? "listar");
  if (accion === "listar") return { usuarios: await listarUsuarios(), modo_acceso: await modoAcceso() };
  if (accion === "crear") {
    const nombre = String(b?.nombre ?? "").trim().slice(0, 60);
    if (!nombre) return { error: "Escribe el nombre" };
    const tel = b?.telefono ? normalizarTelefono(b.telefono) : null;
    if (b?.telefono && !tel) return { error: "Número de WhatsApp inválido (ej. 3001234567)" };
    if (tel && (await sql`select 1 from futbol.usuarios where telefono = ${tel}`).length) return { error: "Ese número ya tiene acceso" };
    const rol = b?.rol === "admin" ? "admin" : "visor";
    const [u] = await sql`insert into futbol.usuarios (nombre, telefono, rol) values (${nombre}, ${tel}, ${rol}) returning id, nombre, telefono`;
    return { ok: true, usuario: u, ...(await enlaceNuevo(Number(u.id))) };
  }
  const id = Number(b?.id);
  const [u] = await sql`select id, nombre, telefono, rol, activo from futbol.usuarios where id = ${Number.isInteger(id) ? id : -1}`;
  if (!u) return { error: "No existe esa persona" };
  if (accion === "enlace") return { ok: true, usuario: u, ...(await enlaceNuevo(Number(u.id))) };
  if (accion === "activo") {
    const activo = !!b?.activo;
    if (!activo && u.rol === "admin") {
      if (yo && yo.usuario_id === Number(u.id)) return { error: "No puedes apagar tu propio acceso" };
      const [{ n }] = await sql`select count(*)::int as n from futbol.usuarios where rol = 'admin' and activo`;
      if (n <= 1) return { error: "Debe quedar al menos un administrador activo" };
    }
    await sql`update futbol.usuarios set activo = ${activo} where id = ${u.id}`;
    return { ok: true };
  }
  if (accion === "editar") {
    const nombre = b?.nombre == null ? u.nombre : String(b.nombre).trim().slice(0, 60);
    const tel = b?.telefono === undefined ? u.telefono : b.telefono ? normalizarTelefono(b.telefono) : null;
    if (!nombre) return { error: "Escribe el nombre" };
    if (b?.telefono && !tel) return { error: "Número de WhatsApp inválido" };
    if (tel && (await sql`select 1 from futbol.usuarios where telefono = ${tel} and id <> ${u.id}`).length) return { error: "Ese número ya tiene acceso" };
    await sql`update futbol.usuarios set nombre = ${nombre}, telefono = ${tel} where id = ${u.id}`;
    return { ok: true };
  }
  return { error: "acción desconocida" };
}

async function rendimiento() {
  const filas = await sql`select * from futbol.v_rendimiento order by regla_version, liga, franja_minuto`;
  // v_rendimiento ya ignora las ligas excluidas (migración 20261114210000); el conteo hace lo mismo
  // y dice cuántas alertas quedaron fuera, para que se vea que no se borraron.
  const [conteo] = await sql`select count(*) filter (where resultado='pendiente' and incluida)::int as pendientes,
                                    count(*) filter (where resultado='anulada' and incluida)::int as anuladas,
                                    count(*) filter (where incluida)::int as total,
                                    count(*) filter (where not incluida)::int as excluidas,
                                    count(*) filter (where incluida and not en_ventana)::int as fuera_ventana
                             from (select a.resultado, coalesce(l.habilitada, true) as incluida,
                                          a.minuto between coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'minuto_min'), 0)
                                                       and coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'minuto_max'), 200) as en_ventana
                                   from futbol.alertas a join futbol.partidos p using (fixture_id)
                                   left join futbol.ligas l on l.id = p.liga_id) x`;
  // DECISIONES 34: v_rendimiento y v_ligas_historial solo cuentan alertas dentro de minuto_min–minuto_max.
  const [datos] = await sql`select (select count(*)::int from futbol.snapshots) as snapshots,
                                   (select count(distinct fixture_id)::int from futbol.snapshots) as partidos_seguidos`;
  // Historial acumulado por liga (vista v_ligas_historial); la PWA lo agrupa por país.
  const historial = await sql`select * from futbol.v_ligas_historial
                              where precandidatos > 0 and coalesce(habilitada, true) order by candidatos desc, precandidatos desc, vistos desc`;
  // Favorito local vs visitante (Fredy, 14 nov): candidatos y alertas según dónde juega el favorito.
  // Alertas con el mismo filtro que v_rendimiento (ligas activas, dentro de la ventana de minutos).
  const ladoAlertas = await sql`
    select p.favorito as lado,
           count(*) filter (where a.resultado in ('acierto','fallo'))::int as resueltas,
           count(*) filter (where a.resultado = 'acierto')::int as aciertos,
           round(sum(case when a.resultado = 'acierto' then a.cuota - 1 when a.resultado = 'fallo' then -1 end), 2) as ganancia_u
    from futbol.alertas a join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
    where coalesce(l.habilitada, true) and p.favorito in ('home', 'away')
      and a.minuto between coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'minuto_min'), 0)
                       and coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'minuto_max'), 200)
    group by 1`;
  const ladoCand = await sql`
    select c.favorito as lado, count(*)::int as candidatos,
           count(*) filter (where c.resultado = 'gol')::int as con_gol,
           count(*) filter (where c.resultado = 'sin_gol')::int as sin_gol
    from futbol.v_candidatos c join futbol.partidos p using (fixture_id) left join futbol.ligas l on l.id = p.liga_id
    where coalesce(l.habilitada, true) and c.favorito in ('home', 'away') group by 1`;
  const lado = ["home", "away"].map((k) => ({
    lado: k, ...(ladoCand.find((x: any) => x.lado === k) ?? { candidatos: 0, con_gol: 0, sin_gol: 0 }),
    ...(ladoAlertas.find((x: any) => x.lado === k) ?? { resueltas: 0, aciertos: 0, ganancia_u: 0 }),
  }));
  return { filas, conteo, datos, historial, lado };
}

// Pestaña Candidatos (DECISIONES 32): partidos que pasaron el filtro, con su desenlace (¿hubo un gol
// más después de entrar?, ¿en qué minuto?, ¿de quién?) y la serie de cada snapshot. Sirve para ver
// qué se le escapa a la regla (falsos negativos) y calibrar la v5. No gasta cuota: solo lee la base.
async function candidatos(dias: number) {
  const filas = await sql`select c.* from futbol.v_candidatos c join futbol.partidos p using (fixture_id)
                          left join futbol.ligas l on l.id = p.liga_id
                          where coalesce(l.habilitada, true)
                            and c.ts_entrada > now() - make_interval(days => ${dias}) order by c.ts_entrada desc limit 300`;
  const ids = filas.map((f: any) => f.fixture_id);
  // Serie compacta: IP, dominancia, momentum, cuota, córners y ataques peligrosos de cada snapshot.
  // Los ataques peligrosos solo existen si Flashscore los publica para esa liga (raw.fixture.__extra).
  const serie = ids.length ? await sql`
    select fixture_id, minuto as m, goles_local as gl, goles_visitante as gv, ip_local as ipl, ip_visitante as ipv,
           dominancia as d, momentum as mo, cuota_over as c,
           (stats_local->>'corners')::int as col, (stats_visitante->>'corners')::int as cov,
           nullif(regexp_replace(coalesce(raw->'fixture'->'__extra'->'Dangerous attacks'->>0, ''), '[^0-9.]', '', 'g'), '')::numeric as apl,
           nullif(regexp_replace(coalesce(raw->'fixture'->'__extra'->'Dangerous attacks'->>1, ''), '[^0-9.]', '', 'g'), '')::numeric as apv,
           evaluacion->'dominancia' as okd, evaluacion->'momentum' as okm, evaluacion->'cuota' as okc
    from futbol.snapshots where stats_local is not null and fixture_id = any(${ids}::int[]) order by fixture_id, ts` : [];
  const porId = new Map<number, any[]>();
  for (const s of serie) { const id = s.fixture_id; delete s.fixture_id; (porId.get(id) ?? porId.set(id, []).get(id)!).push(s); }
  const goles = ids.length ? await sql`select fixture_id, minuto, minuto_antes, gl_antes, gv_antes, gl, gv, fuente
                                       from futbol.cambios_marcador where fixture_id = any(${ids}::int[]) order by ts` : [];
  const golesPor = new Map<number, any[]>();
  for (const g of goles) (golesPor.get(g.fixture_id) ?? golesPor.set(g.fixture_id, []).get(g.fixture_id)!).push(g);
  const cfg = await leerConfig();
  return {
    dias, dominancia_min: cfg.dominancia_min, cuota_objetivo: cfg.cuota_objetivo, minuto_max: cfg.minuto_max,
    candidatos: filas.map((f: any) => ({ ...f, serie: porId.get(f.fixture_id) ?? [], goles: golesPor.get(f.fixture_id) ?? [] })),
  };
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

// ---------- Córners (lab, DECISIONES 37): solo administradores, por POST /admin/corners ----------
// Acierto por mercado y versión. La implícita se promedia SOLO sobre las que tuvieron cuota; el % de las
// que no la tuvieron mide el patrón, no la rentabilidad.
async function cornersLab() {
  const params = Object.fromEntries((await sql`select clave, valor from futbol.config where clave like 'corners%'`)
    .map((r: any) => [r.clave, r.valor]));
  const alertas = await sql`
    select id, mercado, version, fixture_id, liga, local, visitante, favorito, ts, minuto, goles_local, goles_visitante,
           corners_local, corners_visitante, linea, objetivo, api_consultada, hay_mercado, cuota, mercado_nombre,
           motivo_sin_cuota, mercados_vistos, resultado, corners_final, minuto_cierre, cerrada_ts, nota
    from futbol.alertas_corners order by ts desc limit 200`;
  const resumen = await sql`
    select mercado, version,
           count(*)::int as avisos,
           count(*) filter (where resultado = 'acierto')::int as aciertos,
           count(*) filter (where resultado = 'fallo')::int as fallos,
           count(*) filter (where resultado = 'pendiente')::int as pendientes,
           count(*) filter (where cuota is not null)::int as con_cuota,
           count(*) filter (where cuota is not null and resultado = 'acierto')::int as aciertos_con_cuota,
           count(*) filter (where cuota is not null and resultado in ('acierto', 'fallo'))::int as resueltas_con_cuota,
           round(avg(100 / cuota) filter (where cuota is not null and resultado in ('acierto', 'fallo')), 1) as implicita_pct,
           round(sum(case when resultado = 'acierto' then cuota - 1 when resultado = 'fallo' then -1 end)
                 filter (where cuota is not null), 2) as ganancia_u,
           count(*) filter (where api_consultada and hay_mercado is false)::int as sin_mercado
    from futbol.alertas_corners group by 1, 2 order by 2 desc, 1`;
  const base = await sql`
    select mercado, count(*)::int as revisados, count(*) filter (where alerto)::int as avisaron,
           count(*) filter (where motivo = 'sin_stats' or motivo = 'sin_fila_corners')::int as sin_datos
    from futbol.corners_chequeos group by 1`;
  const [hoy] = await sql`select count(*) filter (where api_consultada)::int as consultas_hoy from futbol.alertas_corners
                          where ts >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;
  return { params, alertas, resumen, base, consultas_hoy: hoy.consultas_hoy };
}

// ---------- Laboratorio de goles y córners (DECISIONES 40): solo administradores ----------
// Umbral de entrada calculado desde la base (lab_umbrales, uno por día), oportunidades con la serie de la
// mejor cuota tras el gol, resumen de acierto y ganancia de las que superaron el umbral, y salud de Flashscore.
async function laboratorio() {
  const params = Object.fromEntries((await sql`select clave, valor from futbol.config
    where clave like 'lab\_%' or clave like 'fs\_vivo%' or clave like 'fs\_salud%' or clave = 'fs_fallos_aviso'`)
    .map((r: any) => [r.clave, r.valor]));
  const umbrales = await sql`select fecha, estrategia, n, aciertos, p, ic_bajo, cuota_justa, umbral, actualizado
                             from futbol.lab_umbrales where fecha > now() - interval '400 days' order by fecha, estrategia`;
  const oportunidades = await sql`
    select id, estrategia, fixture_id, liga, local, visitante, ts_inicio, minuto_gatillo, linea, vence_minuto, vigilando,
           n_hist, p_hist, umbral, mejor_cuota, mejor_casa, minuto_mejor, serie, alertada, ts_alerta, minuto_alerta,
           cuota_alerta, casa_alerta, resultado, goles_final
    from futbol.lab_oportunidades order by ts_inicio desc limit 150`;
  const resumen = await sql`
    select estrategia, count(*)::int as casos,
           count(*) filter (where resultado = 'acierto')::int as aciertos,
           count(*) filter (where resultado = 'fallo')::int as fallos,
           count(*) filter (where mejor_cuota is not null)::int as con_cuota,
           round(avg(mejor_cuota), 3) as cuota_media,
           count(*) filter (where alertada)::int as alertadas,
           count(*) filter (where alertada and resultado = 'acierto')::int as alertadas_acierto,
           count(*) filter (where alertada and resultado = 'fallo')::int as alertadas_fallo,
           round(sum(case when resultado = 'acierto' then cuota_alerta - 1 when resultado = 'fallo' then -1 end)
                 filter (where alertada), 2) as ganancia_u
    from futbol.lab_oportunidades group by 1 order by 1`;
  const [hoy] = await sql`select count(*)::int as filas, count(distinct (fixture_id, date_trunc('minute', ts)))::int as fotos,
                                 count(distinct fixture_id)::int as partidos
                          from futbol.cuotas_vivo where ts >= now() - interval '24 hours'`;
  return { params, umbrales, oportunidades, resumen, ultimas_24h: hoy };
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
    // Córners (lab): versión propia, separada de la del radar de goles
    let versionCorners: string | null = null;
    if (aplicar.some(([k]) => CORNERS_REGLA.includes(k))) {
      const n = parseInt(String((mapa.get("corners_version") as any)?.valor ?? "c1").replace(/^c/, ""), 10) || 1;
      versionCorners = `c${n + 1}`;
      await tx`update futbol.config set valor = ${tx.json(versionCorners)}, actualizado = now() where clave = 'corners_version'`;
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
    return { ok: true, cambiados: aplicar.map(([k]) => k), nueva_version: version, version_corners: versionCorners };
  });
}

// ---------- Ficha del partido (pestaña Ahora) ----------
// Nombres de Flashscore (en) → nombre simple en español, en el orden en que se muestran. Lo que no está
// aquí no se muestra (poka-yoke: la ficha es para gente común; nada de jerga ni filas raras).
const STATS_ES: [string, string][] = [
  ["ball possession", "Posesión"],
  ["expected goals (xg)", "Goles esperados (xG)"],
  ["big chances", "Ocasiones claras"],
  ["total shots", "Remates"],
  ["shots on target", "Remates al arco"],
  ["shots off target", "Remates afuera"],
  ["blocked shots", "Remates bloqueados"],
  ["shots inside the box", "Remates dentro del área"],
  ["hit the woodwork", "Remates al palo"],
  ["dangerous attacks", "Ataques peligrosos"],
  ["attacks", "Ataques"],
  ["corner kicks", "Córners"],
  ["goalkeeper saves", "Atajadas del arquero"],
  ["offsides", "Fueras de lugar"],
  ["fouls", "Faltas"],
  ["free kicks", "Tiros libres"],
  ["yellow cards", "Tarjetas amarillas"],
  ["red cards", "Tarjetas rojas"],
];
const numStat = (v: string) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
function statsEnEspañol(filas: [string, string, string][]) {
  const porNombre = new Map(filas.map(([n, l, v]) => [n.toLowerCase(), [l, v]]));
  const out: { nombre: string; local: string; visitante: string; nl: number | null; nv: number | null }[] = [];
  for (const [k, es] of STATS_ES) {
    const x = porNombre.get(k);
    if (!x || (x[0] === "" && x[1] === "")) continue;
    out.push({ nombre: es, local: x[0], visitante: x[1], nl: numStat(x[0]), nv: numStat(x[1]) });
  }
  return out;
}

// Caché corta por instancia: varios amigos abriendo el mismo partido no multiplican las lecturas a Flashscore.
const cacheFicha = new Map<string, { t: number; d: any }>();

async function fichaPartido(idPedido: string, conCrudo: boolean) {
  let fsId: string | null = null, fixtureId: number | null = null;
  if (idPedido.startsWith("fs:")) fsId = idPedido.slice(3).replace(/[^A-Za-z0-9]/g, "") || null;
  else if (/^\d+$/.test(idPedido)) fixtureId = Number(idPedido);
  if (!fsId && !fixtureId) return { error: "partido no válido" };

  const [fsRow] = fixtureId
    ? await sql`select fs_id, local, visitante, liga from futbol.fs_partidos where fixture_id = ${fixtureId} order by creado desc limit 1`
    : await sql`select fs_id, fixture_id, local, visitante, liga from futbol.fs_partidos where fs_id = ${fsId}`;
  fsId = fsId ?? fsRow?.fs_id ?? null;
  fixtureId = fixtureId ?? fsRow?.fixture_id ?? null;
  const [p] = fixtureId ? await sql`
    select p.local, p.visitante, p.estado, p.minuto, p.goles_local, p.goles_visitante, p.favorito, l.nombre as liga, l.pais
    from futbol.partidos p left join futbol.ligas l on l.id = p.liga_id where p.fixture_id = ${fixtureId}` : [];

  const clave = `${fsId ?? ""}|${fixtureId ?? ""}`;
  const c = cacheFicha.get(clave);
  if (c && Date.now() - c.t < 45000 && !conCrudo) return c.d;

  let stats: ReturnType<typeof statsEnEspañol> = [];
  let incid: FS.IncidenciaFS[] = [];
  let crudo: string | null = null;
  let fuente = "flashscore";
  const errores: string[] = [];
  if (fsId) {
    const [st, inc] = await Promise.allSettled([FS.estadisticasTodas(fsId), FS.incidencias(fsId)]);
    if (st.status === "fulfilled") stats = statsEnEspañol(st.value); else errores.push(String(st.reason?.message ?? st.reason));
    if (inc.status === "fulfilled") { incid = inc.value.lista; crudo = inc.value.crudo; } else errores.push(String(inc.reason?.message ?? inc.reason));
  }
  // Respaldo sin Flashscore: lo último guardado por el escáner (solo partidos en seguimiento)
  if (!stats.length && fixtureId) {
    const [s] = await sql`select raw->'fixture'->'__extra' as extra from futbol.snapshots
                          where fixture_id = ${fixtureId} and raw->'fixture'->'__extra' is not null order by ts desc limit 1`;
    if (s?.extra) { stats = statsEnEspañol(Object.entries(s.extra as Record<string, [string, string]>).map(([n, [l, v]]) => [n, l, v])); fuente = "guardado"; }
  }
  // Goles con minuto desde los cambios de marcador si Flashscore no dio incidencias legibles
  let goles = incid.filter((i) => i.tipo === "gol" || i.tipo === "autogol" || i.tipo === "penal");
  if (!goles.length && fixtureId) {
    const cm = await sql`select minuto, gl_antes, gv_antes, gl, gv from futbol.cambios_marcador
                         where fixture_id = ${fixtureId} order by ts`;
    for (const r of cm) {
      const dl = (r.gl ?? 0) - (r.gl_antes ?? 0), dv = (r.gv ?? 0) - (r.gv_antes ?? 0);
      for (let k = 0; k < dl; k++) incid.push({ minuto: r.minuto != null ? `${r.minuto}'` : "", lado: "local", tipo: "gol", jugador: null, detalle: null, texto: "cambio de marcador" });
      for (let k = 0; k < dv; k++) incid.push({ minuto: r.minuto != null ? `${r.minuto}'` : "", lado: "visitante", tipo: "gol", jugador: null, detalle: null, texto: "cambio de marcador" });
    }
  }
  const visibles = new Set(["gol", "autogol", "penal", "penal_fallado", "amarilla", "roja", "segunda_amarilla"]);
  const d: any = {
    fixture_id: fixtureId, fs_id: fsId,
    local: p?.local ?? fsRow?.local ?? null, visitante: p?.visitante ?? fsRow?.visitante ?? null,
    liga: p?.liga ?? fsRow?.liga?.replace(/ - .*$/, "") ?? null, pais: p?.pais ?? null,
    estado: p?.estado ?? null, minuto: p?.minuto ?? null, goles_local: p?.goles_local ?? null, goles_visitante: p?.goles_visitante ?? null,
    favorito: p?.favorito ?? null,
    incidencias: incid.filter((i) => visibles.has(i.tipo)).map(({ texto: _t, ...i }) => i),
    estadisticas: stats, fuente: stats.length ? fuente : null, ts: new Date().toISOString(),
  };
  if (errores.length) d.errores = errores;
  if (conCrudo) { d.crudo_incidencias = crudo; d.incidencias_todas = incid; }
  cacheFicha.set(clave, { t: Date.now(), d });
  if (cacheFicha.size > 200) cacheFicha.delete(cacheFicha.keys().next().value!);
  return d;
}

// Rutas que funcionan siempre sin sesión
const PUBLICAS_GET = new Set(["/vapid", "/widget", "/yo"]);
// Lo técnico: con modo cerrado, solo administradores
const SOLO_ADMIN_GET = new Set(["/radar", "/rendimiento", "/ligas", "/candidatos", "/config", "/snapshots"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const ruta = url.pathname.replace(/^.*\/api/, "") || "/";
  try {
    const leida = await leerSesion(req);
    const yo = leida === "invalida" ? null : leida;
    const abierto = (await modoAcceso()) === "abierto";
    const sinSesion = () => json({ error: leida === "invalida" ? "Tu acceso ya no es válido. Pídele a Fredy un enlace nuevo." : "Entra con tu enlace personal.", codigo: leida === "invalida" ? "sesion_invalida" : "sin_sesion" }, 401);

    if (req.method === "GET") {
      if (!PUBLICAS_GET.has(ruta)) {
        if (!abierto && !yo) return sinSesion();
        if (!abierto && SOLO_ADMIN_GET.has(ruta) && yo!.rol !== "admin") return json({ error: "Solo para administradores" }, 403);
      }
      if (ruta === "/yo") {
        return json({ modo_acceso: abierto ? "abierto" : "cerrado", sesion_invalida: leida === "invalida",
                      usuario: yo ? { id: yo.usuario_id, nombre: yo.nombre, rol: yo.rol, banca_inicial: yo.banca_inicial } : null });
      }
      if (ruta === "/mi-banca") return yo ? json(await miBanca(yo)) : sinSesion();
      if (ruta === "/resumen") return json(await resumen());
      if (ruta === "/alertas") return json(await alertas(yo));
      if (ruta === "/radar") return json(await radar());
      if (ruta === "/partido") {
        // ?crudo=1 (solo admin): texto crudo de Flashscore para revisar el formato de las incidencias
        const crudo = url.searchParams.get("crudo") === "1" && (abierto || yo?.rol === "admin");
        return json(await fichaPartido(String(url.searchParams.get("id") ?? ""), crudo));
      }
      if (ruta === "/widget") return json(await widget());
      if (ruta === "/rendimiento") return json(await rendimiento());
      if (ruta === "/ligas") return json(await ligas());
      if (ruta === "/candidatos") return json(await candidatos(Math.min(Math.max(Number(url.searchParams.get("dias")) || 14, 1), 90)));
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

    // El enlace de WhatsApp: público por definición (el token es la credencial)
    if (ruta === "/acceso/canjear") {
      const r = await canjear(body?.token, req.headers.get("user-agent"));
      return json(r, (r as any).error ? 400 : 200);
    }
    if (ruta === "/entradas") {
      if (!yo) return sinSesion();
      const r = await marcarEntrada(yo, body);
      return json(r, (r as any).error ? 400 : 200);
    }
    if (ruta === "/mi-banca") {
      if (!yo) return sinSesion();
      // Monto sugerido (DECISIONES 41): % de la banca que quiere ganar por entrada (vacío = sin sugerencia)
      if (body && "ganancia_pct" in body) {
        const g = body.ganancia_pct;
        const pct = g == null || g === "" ? null : Math.round(Number(String(g).replace(",", ".")) * 100) / 100;
        if (pct !== null && !(pct > 0 && pct <= 20)) return json({ error: "El % debe estar entre 0,1 y 20" }, 400);
        await sql`update futbol.usuarios set ganancia_pct = ${pct} where id = ${yo.usuario_id}`;
        if (!("banca_inicial" in body)) return json({ ok: true });
      }
      const v = body?.banca_inicial;
      const banca = v == null || v === "" ? null : Math.round(Number(v));
      if (banca !== null && !(banca >= 0 && banca < 1e12)) return json({ error: "valor inválido" }, 400);
      await sql`update futbol.usuarios set banca_inicial = ${banca} where id = ${yo.usuario_id}`;
      return json({ ok: true });
    }

    if (ruta === "/suscribir") {
      if (!abierto && !yo) return sinSesion();
      const { endpoint, keys } = body ?? {};
      if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || !keys?.p256dh || !keys?.auth) {
        return json({ error: "suscripción inválida" }, 400);
      }
      // La suscripción queda ligada a la persona (recordatorios, apagar acceso, avisos solo admin)
      const uid = yo?.usuario_id ?? null;
      await sql`insert into futbol.push_suscripciones (endpoint, p256dh, auth, usuario_id)
                values (${endpoint}, ${keys.p256dh}, ${keys.auth}, ${uid})
                on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, activa = true, fallos = 0,
                  usuario_id = coalesce(excluded.usuario_id, futbol.push_suscripciones.usuario_id)`;
      return json({ ok: true });
    }
    if (ruta === "/desuscribir") {
      await sql`update futbol.push_suscripciones set activa = false where endpoint = ${String(body?.endpoint ?? "")}`;
      return json({ ok: true });
    }

    if (ruta.startsWith("/admin/")) {
      // Administrador: sesión admin, o el PIN como respaldo mientras Fredy confirma su enlace
      if (yo?.rol !== "admin") {
        const v = await verificarPin(body?.pin);
        if (!v.ok) return json({ error: v.error }, 401);
      }
      if (ruta === "/admin/verificar") return json({ ok: true });
      // El administrador que ya tiene el PIN en su celular no necesita enlace: el PIN liga ese celular a su
      // usuario admin (para Mi banca, sus entradas y sus avisos). No revoca sus otras sesiones.
      if (ruta === "/admin/vincular") {
        const [u] = await sql`select id, nombre, rol, banca_inicial from futbol.usuarios where rol = 'admin' and activo order by id limit 1`;
        if (!u) return json({ error: "No hay un administrador activo" }, 400);
        const sesion = tokenNuevo();
        await sql`insert into futbol.sesiones (usuario_id, token_hash, dispositivo)
                  values (${u.id}, ${await sha256(sesion)}, ${req.headers.get("user-agent")?.slice(0, 300) ?? null})`;
        await sql`update futbol.usuarios set ultimo_acceso = now() where id = ${u.id}`;
        return json({ ok: true, sesion, usuario: { id: Number(u.id), nombre: u.nombre, rol: u.rol, banca_inicial: u.banca_inicial == null ? null : Number(u.banca_inicial) } });
      }
      if (ruta === "/admin/config") {
        const r = await cambiarConfig(body.cambios, body.nota);
        return json(r, (r as any).error ? 400 : 200);
      }
      if (ruta === "/admin/liga") {
        await sql`update futbol.ligas set habilitada = ${!!body.habilitada} where id = ${Number(body.id)}`;
        // Excluir surte efecto ya: sus partidos salen del seguimiento sin esperar el próximo ciclo del escáner
        if (!body.habilitada) await sql`update futbol.partidos set seguimiento = false where seguimiento and liga_id = ${Number(body.id)}`;
        return json({ ok: true });
      }
      if (ruta === "/admin/corners") return json(await cornersLab());
      if (ruta === "/admin/laboratorio") return json(await laboratorio());
      if (ruta === "/admin/push-prueba") {
        const n = await notificar({ titulo: "🔔 Prueba de ADN Soccer", cuerpo: "Si ves esto, las notificaciones funcionan.", url: "./#ajustes", tag: "prueba" },
                                  { soloAdmin: true });
        return json({ ok: true, enviados: n });
      }
      if (ruta === "/admin/pin") {
        if (typeof body.nuevo !== "string" || !/^\d{6,12}$/.test(body.nuevo)) return json({ error: "El PIN nuevo debe tener 6 a 12 dígitos" }, 400);
        await sql`update futbol.admin set pin_hash = extensions.crypt(${body.nuevo}, extensions.gen_salt('bf', 10)), actualizado = now() where id = 1`;
        return json({ ok: true });
      }
      if (ruta === "/admin/usuarios") {
        const r = await adminUsuarios(body, yo);
        return json(r, (r as any).error ? 400 : 200);
      }
      if (ruta === "/admin/acceso") {
        const modo = body?.modo === "cerrado" ? "cerrado" : body?.modo === "abierto" ? "abierto" : null;
        if (!modo) return json({ error: "modo inválido" }, 400);
        // Poka-yoke: no se puede cerrar la app si nadie con rol admin tiene una sesión activa (Fredy quedaría por fuera)
        if (modo === "cerrado") {
          const [{ n }] = await sql`select count(*)::int as n from futbol.sesiones s join futbol.usuarios u on u.id = s.usuario_id
                                    where s.revocada is null and u.activo and u.rol = 'admin'`;
          if (!n) return json({ error: "Primero abre tu enlace de administrador en tu celular; si no, quedarías por fuera." }, 400);
        }
        await sql`update futbol.config set valor = ${sql.json(modo)}, actualizado = now() where clave = 'modo_acceso'`;
        return json({ ok: true, modo_acceso: modo });
      }
    }
    return json({ error: "ruta no encontrada" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
