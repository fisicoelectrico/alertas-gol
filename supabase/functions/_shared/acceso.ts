// =====================================================================
// Acceso de amigos por enlace personal (ADN Soccer, especificación 1.6).
//
// Sin Supabase Auth: todo vive en el esquema `futbol` (usuarios, invitaciones, sesiones).
//  - Fredy crea a la persona (nombre + WhatsApp) y la app genera un enlace de UN solo uso.
//  - Al abrirlo, ese celular recibe un token de sesión propio y el enlace muere.
//  - En la base solo se guarda el sha256 de cada token: leer las tablas no permite fabricar accesos.
//  - Apagar a alguien (usuarios.activo = false) corta todas sus sesiones al instante, porque cada
//    petición vuelve a mirar `activo`.
// =====================================================================
import { sql } from "./db.ts";

export async function sha256(texto: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 24 bytes aleatorios en base64url = 32 caracteres (192 bits: imposible de adivinar)
export function tokenNuevo(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type Sesion = {
  sesion_id: number; usuario_id: number; nombre: string; rol: "admin" | "visor";
  banca_inicial: number | null; creado: string;
};

// Lee el header x-sesion. Devuelve la sesión, null si no vino, o "invalida" si vino pero no sirve
// (revocada, persona apagada o token desconocido): la app entonces pide un enlace nuevo.
export async function leerSesion(req: Request): Promise<Sesion | null | "invalida"> {
  const t = req.headers.get("x-sesion")?.trim();
  if (!t) return null;
  if (t.length < 20 || t.length > 100) return "invalida";
  const [s] = await sql`
    select s.id as sesion_id, s.ultimo_uso, u.id as usuario_id, u.nombre, u.rol, u.banca_inicial, u.creado
    from futbol.sesiones s join futbol.usuarios u on u.id = s.usuario_id
    where s.token_hash = ${await sha256(t)} and s.revocada is null and u.activo`;
  if (!s) return "invalida";
  // "Último acceso" con resolución de 5 min: no se escribe en la base en cada petición
  if (Date.now() - new Date(s.ultimo_uso).getTime() > 5 * 60e3) {
    await sql`update futbol.sesiones set ultimo_uso = now() where id = ${s.sesion_id}`;
    await sql`update futbol.usuarios set ultimo_acceso = now() where id = ${s.usuario_id}`;
  }
  return {
    sesion_id: Number(s.sesion_id), usuario_id: Number(s.usuario_id), nombre: s.nombre, rol: s.rol,
    banca_inicial: s.banca_inicial == null ? null : Number(s.banca_inicial), creado: s.creado,
  };
}

export async function modoAcceso(): Promise<"abierto" | "cerrado"> {
  const [c] = await sql`select valor #>> '{}' as v from futbol.config where clave = 'modo_acceso'`;
  return c?.v === "cerrado" ? "cerrado" : "abierto";
}

// Canje del enlace: marca la invitación como usada y crea la sesión del celular, en una transacción
// (si dos celulares abren el mismo enlace a la vez, solo uno gana).
export async function canjear(token: unknown, ua: string | null) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return { error: "Enlace inválido" };
  const h = await sha256(token);
  return await sql.begin(async (tx: any) => {
    const [inv] = await tx`
      update futbol.invitaciones i set usada = now(), usada_ua = ${ua?.slice(0, 300) ?? null}
      from futbol.usuarios u
      where i.token_hash = ${h} and i.usada is null and i.vence > now() and u.id = i.usuario_id and u.activo
      returning i.usuario_id, u.nombre, u.rol`;
    if (!inv) {
      const [vieja] = await tx`select usada from futbol.invitaciones where token_hash = ${h}`;
      return {
        error: !vieja ? "Este enlace no existe. Pídele a Fredy uno nuevo."
          : vieja.usada ? "Este enlace ya se usó. Si no fuiste tú, avísale a Fredy para que te mande otro."
          : "Este enlace venció o tu acceso está apagado. Pídele a Fredy uno nuevo.",
      };
    }
    const sesion = tokenNuevo();
    await tx`insert into futbol.sesiones (usuario_id, token_hash, dispositivo)
             values (${inv.usuario_id}, ${await sha256(sesion)}, ${ua?.slice(0, 300) ?? null})`;
    await tx`update futbol.usuarios set ultimo_acceso = now() where id = ${inv.usuario_id}`;
    return { ok: true, sesion, usuario: { id: Number(inv.usuario_id), nombre: inv.nombre, rol: inv.rol } };
  });
}

// Enlace nuevo para una persona: revoca sus sesiones y enlaces anteriores (cambio de celular o
// un enlace que usó otra persona). Devuelve el token en claro UNA vez; la base solo guarda el hash.
export async function enlaceNuevo(usuarioId: number) {
  const token = tokenNuevo();
  const [cfg] = await sql`select (valor #>> '{}')::int as dias from futbol.config where clave = 'invitacion_dias'`;
  const dias = Math.min(Math.max(Number(cfg?.dias ?? 7) || 7, 1), 30);
  const hash = await sha256(token);
  await sql.begin(async (tx: any) => {
    await tx`update futbol.sesiones set revocada = now() where usuario_id = ${usuarioId} and revocada is null`;
    await tx`update futbol.invitaciones set vence = now() where usuario_id = ${usuarioId} and usada is null and vence > now()`;
    await tx`insert into futbol.invitaciones (usuario_id, token_hash, vence)
             values (${usuarioId}, ${hash}, now() + make_interval(days => ${dias}))`;
  });
  return { token, dias };
}

// WhatsApp en formato +57…: 10 dígitos que empiezan por 3 son celular colombiano.
export function normalizarTelefono(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const d = t.replace(/[^\d+]/g, "");
  if (!d) return null;
  if (/^3\d{9}$/.test(d)) return `+57${d}`;
  if (/^57\d{10}$/.test(d)) return `+${d}`;
  if (/^\+\d{8,15}$/.test(d)) return d;
  return null;
}
