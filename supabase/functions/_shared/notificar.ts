// Envía una notificación a todas las suscripciones activas y limpia las que murieron.
import { sql } from "./db.ts";
import { enviarPush, Vapid } from "./webpush.ts";

export function vapid(): Vapid | null {
  const publicKey = Deno.env.get("VAPID_PUBLIC")?.trim();
  const privateKey = Deno.env.get("VAPID_PRIVATE")?.trim();
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: Deno.env.get("VAPID_SUBJECT") ?? "https://goles.freddyquiroga.com" };
}

export async function notificarTodos(mensaje: Record<string, unknown>): Promise<number> {
  const v = vapid();
  if (!v) return 0;
  const subs = await sql`select id, endpoint, p256dh, auth from futbol.push_suscripciones where activa`;
  let ok = 0;
  for (const s of subs) {
    try {
      const r = await enviarPush(s as any, mensaje, v);
      if (r.ok) { ok++; await sql`update futbol.push_suscripciones set fallos = 0 where id = ${s.id}`; }
      else if (r.expirada) await sql`update futbol.push_suscripciones set activa = false where id = ${s.id}`;
      else await sql`update futbol.push_suscripciones set fallos = fallos + 1, activa = (fallos + 1) < 5 where id = ${s.id}`;
    } catch (_e) {
      await sql`update futbol.push_suscripciones set fallos = fallos + 1 where id = ${s.id}`;
    }
  }
  return ok;
}
