// Envía notificaciones push y limpia las suscripciones que murieron.
//
// Acceso de amigos (especificación 1.6): cada suscripción sabe de quién es (usuario_id).
//  - Solo reciben las personas activas. Las suscripciones sin dueño (de antes de los enlaces) solo
//    reciben mientras config.modo_acceso = 'abierto'.
//  - soloAdmin: avisos técnicos (candidatos, prueba) solo para administradores.
//  - alertaId + omitirMarcados: los recordatorios no le llegan a quien ya marcó Entré o No entro.
//  - El mensaje puede ser una función: así cada persona recibe su propio texto (por ejemplo
//    "Entraste con $20.000: ganaste $6.600"). Si devuelve null, a esa persona no se le envía.
import { sql } from "./db.ts";
import { enviarPush, Vapid } from "./webpush.ts";

export function vapid(): Vapid | null {
  const publicKey = Deno.env.get("VAPID_PUBLIC")?.trim();
  const privateKey = Deno.env.get("VAPID_PRIVATE")?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: Deno.env.get("VAPID_SUBJECT") ?? "https://goles.fredyquiroga.com" };
}

export type Destinatario = {
  usuario_id: number | null; rol: string | null; nombre: string | null;
  decision: "entre" | "no_entro" | null; monto: number | null; cuota: number | null;
  banca: number | null; ganancia_pct: number | null;   // monto sugerido (DECISIONES 41)
};
type Mensaje = Record<string, unknown>;
export type Opciones = { alertaId?: number; soloAdmin?: boolean; omitirMarcados?: boolean; soloUsuario?: number; forzar?: boolean };

export async function notificar(mensaje: Mensaje | ((d: Destinatario) => Mensaje | null), opc: Opciones = {}): Promise<number> {
  const v = vapid();
  if (!v) return 0;
  // DECISIONES 78 (Fredy, 23 nov): interruptor general. Con silencio_total = true no sale NINGUNA push
  // (alertas, laboratorio, córners, recordatorios, avisos técnicos); todo lo demás se sigue registrando
  // igual. Solo pasan los envíos con forzar (botón de prueba de Ajustes y anuncios).
  if (!opc.forzar) {
    const [sil] = await sql`select valor from futbol.config where clave = 'silencio_total'`;
    if (sil?.valor === true) return 0;
  }
  const [m] = await sql`select valor #>> '{}' as v from futbol.config where clave = 'modo_acceso'`;
  const abierto = m?.v !== "cerrado";
  const alerta = opc.alertaId ?? -1;
  const subs = await sql`
    select s.id, s.endpoint, s.p256dh, s.auth, s.usuario_id, u.rol, u.nombre, e.decision, e.monto, e.cuota,
           u.ganancia_pct, case when u.id is not null and u.ganancia_pct is not null then futbol.banca_actual(u.id::int) end as banca
    from futbol.push_suscripciones s
    left join futbol.usuarios u on u.id = s.usuario_id
    left join futbol.entradas e on e.usuario_id = s.usuario_id and e.alerta_id = ${alerta}
    where s.activa
      and (case when u.id is null then ${abierto} else u.activo end)
      and (${!opc.soloAdmin} or u.rol = 'admin' or (u.id is null and ${abierto}))
      and (${!opc.omitirMarcados} or e.usuario_id is null)
      and (${opc.soloUsuario == null} or s.usuario_id = ${opc.soloUsuario ?? -1})`;
  let ok = 0;
  for (const s of subs) {
    const d: Destinatario = {
      usuario_id: s.usuario_id == null ? null : Number(s.usuario_id), rol: s.rol, nombre: s.nombre, decision: s.decision,
      monto: s.monto == null ? null : Number(s.monto), cuota: s.cuota == null ? null : Number(s.cuota),
      banca: s.banca == null ? null : Number(s.banca), ganancia_pct: s.ganancia_pct == null ? null : Number(s.ganancia_pct),
    };
    const msg = typeof mensaje === "function" ? mensaje(d) : mensaje;
    if (!msg) continue;
    try {
      const r = await enviarPush(s as any, msg, v);
      if (r.ok) { ok++; await sql`update futbol.push_suscripciones set fallos = 0 where id = ${s.id}`; }
      else if (r.expirada) await sql`update futbol.push_suscripciones set activa = false where id = ${s.id}`;
      else await sql`update futbol.push_suscripciones set fallos = fallos + 1, activa = (fallos + 1) < 5 where id = ${s.id}`;
    } catch (_e) {
      await sql`update futbol.push_suscripciones set fallos = fallos + 1 where id = ${s.id}`;
    }
  }
  return ok;
}

// Compatibilidad: a todas las personas activas
export const notificarTodos = (mensaje: Mensaje) => notificar(mensaje);

// ---------- Textos (formato colombiano) ----------
export const pesos = (v: number) => `$${Math.round(Math.abs(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
export const cuotaTxt = (c: unknown) => Number(c).toFixed(2).replace(".", ",");

// ---------- Monto sugerido (DECISIONES 41) ----------
// Para ganar ganancia_pct % de la banca: monto = banca × pct / (cuota − 1). Cuota 1,50 y 1 % → 2 % de la banca;
// cuota 2,00 → 1 %. Tope maxPct % de la banca (con cuotas muy bajas el monto se dispara). Redondeo a $100.
export function montoSugerido(d: Destinatario, cuota: number | null, maxPct = 10): { monto: number; gana: number; tope: boolean } | null {
  if (!d.banca || d.banca <= 0 || !d.ganancia_pct || !cuota || cuota <= 1) return null;
  const ideal = d.banca * d.ganancia_pct / 100 / (cuota - 1);
  const techo = d.banca * maxPct / 100;
  const monto = Math.max(Math.round(Math.min(ideal, techo) / 100) * 100, 100);
  return { monto, gana: monto * (cuota - 1), tope: ideal > techo };
}
export function textoMonto(d: Destinatario, cuota: number | null, casa: string | null, maxPct = 10): string {
  const m = montoSugerido(d, cuota, maxPct);
  if (!m) return "";
  return `\nSugerido: ${pesos(m.monto)}${casa ? ` en ${casa}` : ""} a ${cuotaTxt(cuota)} → ganas ${pesos(m.gana)}` +
    (m.tope ? ` (tope ${maxPct} % de tu banca)` : ` (${String(d.ganancia_pct).replace(".", ",")} % de tu banca)`);
}

// ---------- Formato de la entrada (Fredy, 18 nov) ----------
// Una línea por dato, en este orden: país, competencia, partido, mercado, monto (si la persona fijó banca y
// meta en Mi banca) y casas con su cuota (de mayor a menor). El título dice qué clase de aviso es.
export function lineasEntrada(o: {
  pais: string | null; liga: string | null; partido: string; mercado: string; contexto?: string | null; etiqueta?: string;
  d: Destinatario; casas: { casa: string; c: number }[]; cuotaMonto: number | null; casaMonto: string | null; maxPct: number;
}): string {
  // Fredy (20 nov, Oss–Roda): la push decía "Entra en Rushbet a 1,56" cuando BetPlay pagaba 1,58. El monto y la
  // casa salen ahora de la casa que MÁS paga (donde conviene entrar); antes salían de la que menos (DECISIONES 70).
  const top = o.casas.filter((x) => x.casa && x.casa !== "Promedio" && x.c > 1).reduce<{ casa: string; c: number } | null>((a, x) => (!a || x.c > a.c ? x : a), null);
  const cuotaM = top?.c ?? o.cuotaMonto, casaM = top?.casa ?? o.casaMonto;
  const m = montoSugerido(o.d, cuotaM, o.maxPct);
  const lineas = [
    o.pais || null,
    o.liga || null,
    o.partido,
    o.contexto || null,
    `${o.etiqueta ?? "Mercado"}: ${o.mercado}`,
    m ? `Entra ${pesos(m.monto)}${casaM ? ` en ${casaM}` : ""} a ${cuotaTxt(cuotaM)} → ganas ${pesos(m.gana)}${m.tope ? ` (tope ${o.maxPct} % de tu banca)` : ""}` : null,
    o.casas.length ? o.casas.map((x) => `${x.casa} ${cuotaTxt(x.c)}`).join(" · ") : null,
  ];
  return lineas.filter(Boolean).join("\n");
}

// ---------- País y liga en cada aviso (Fredy, 15 nov: sin la liga el partido queda "perdido") ----------
// API-Football escribe el país con guiones ("Costa-Rica"); Flashscore en mayúsculas y con la fase pegada
// ("COSTA RICA: Liga de Ascenso - Apertura - Play Offs"). Las dos terminan como "Costa Rica · Liga de Ascenso".
const titulo = (t: string) => t.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
export function ligaTxt(pais: string | null | undefined, liga: string | null | undefined): string {
  const p = (pais ?? "").replace(/-/g, " ").trim();
  const l = (liga ?? "").trim();
  if (!p || p.toLowerCase() === "world") return l || "Fútbol";
  return l ? `${p} · ${l}` : p;
}
export function ligaFS(texto: string | null | undefined): { pais: string | null; liga: string; fase: string | null; txt: string } {
  const t = String(texto ?? "");
  const [pais, resto] = t.includes(": ") ? [t.slice(0, t.indexOf(": ")), t.slice(t.indexOf(": ") + 2)] : [null, t];
  const [liga, ...fase] = resto.split(" - ");
  const p = pais ? titulo(pais) : null;
  return { pais: p, liga: liga.trim(), fase: fase.length ? fase.join(" · ") : null, txt: ligaTxt(p, liga.trim()) };
}
