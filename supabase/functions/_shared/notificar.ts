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
};
type Mensaje = Record<string, unknown>;
export type Opciones = { alertaId?: number; soloAdmin?: boolean; omitirMarcados?: boolean; soloUsuario?: number };

export async function notificar(mensaje: Mensaje | ((d: Destinatario) => Mensaje | null), opc: Opciones = {}): Promise<number> {
  const v = vapid();
  if (!v) return 0;
  const [m] = await sql`select valor #>> '{}' as v from futbol.config where clave = 'modo_acceso'`;
  const abierto = m?.v !== "cerrado";
  const alerta = opc.alertaId ?? -1;
  const subs = await sql`
    select s.id, s.endpoint, s.p256dh, s.auth, s.usuario_id, u.rol, u.nombre, e.decision, e.monto, e.cuota
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
