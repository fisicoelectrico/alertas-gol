// =====================================================================
// Web Push sin librerías, solo con WebCrypto (funciona igual en Deno y Node 20+).
//
// Una notificación push tiene dos capas de criptografía:
//  1) VAPID (RFC 8292): firmamos un JWT con nuestra llave privada P-256 para que
//     el servicio push (Google, Mozilla, Apple) sepa que el mensaje viene de
//     nosotros. El navegador se suscribió con nuestra llave PÚBLICA, así que solo
//     quien tenga la privada puede enviarle mensajes.
//  2) Cifrado del contenido (RFC 8291, "aes128gcm"): el servicio push no puede
//     leer el mensaje. Hacemos un ECDH entre una llave efímera nuestra y la llave
//     p256dh del navegador, mezclamos con el secreto `auth` vía HKDF y ciframos con
//     AES-128-GCM. Solo el navegador suscrito puede descifrarlo.
// =====================================================================

export interface Suscripcion {
  endpoint: string;
  p256dh: string; // llave pública del navegador (base64url, 65 bytes sin comprimir)
  auth: string;   // secreto de 16 bytes (base64url)
}

export interface Vapid {
  publicKey: string;  // base64url, 65 bytes (0x04 || X || Y)
  privateKey: string; // base64url, 32 bytes (d)
  subject: string;    // mailto: o https: de contacto
}

const enc = new TextEncoder();

export function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------- VAPID ----------------

async function importarPrivadaVapid(v: Vapid): Promise<CryptoKey> {
  const pub = b64urlDecode(v.publicKey);
  const jwk: JsonWebKey = {
    kty: "EC", crv: "P-256",
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: v.privateKey,
    ext: true,
  };
  return await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function cabeceraVapid(endpoint: string, v: Vapid): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: v.subject,
  })));
  const datos = `${header}.${payload}`;
  const llave = await importarPrivadaVapid(v);
  // WebCrypto devuelve la firma ECDSA ya en formato "raw" (r||s, 64 bytes): justo lo que pide JWS.
  const firma = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, llave, enc.encode(datos));
  return `vapid t=${datos}.${b64urlEncode(firma)}, k=${v.publicKey}`;
}

// ---------------- Cifrado aes128gcm ----------------

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

export async function cifrar(texto: string, sub: Suscripcion): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);

  // Llave efímera del servidor: una nueva por mensaje.
  const efimera = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", efimera.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, efimera.privateKey, 256));

  // RFC 8291 §3.4: IKM = HKDF(auth, ecdh, "WebPush: info\0" || ua_public || as_public)
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // Un solo registro: contenido + delimitador 0x02 (último registro).
  const plano = concat(enc.encode(texto), new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plano));

  // Encabezado: salt(16) | rs(4, big-endian) | idlen(1) | keyid(as_public, 65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cifrado);
}

export interface ResultadoPush { ok: boolean; status: number; expirada: boolean; detalle?: string }

export async function enviarPush(sub: Suscripcion, mensaje: unknown, v: Vapid, ttlSeg = 600): Promise<ResultadoPush> {
  const cuerpo = await cifrar(JSON.stringify(mensaje), sub);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": await cabeceraVapid(sub.endpoint, v),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": String(ttlSeg),   // si el celular está apagado, cuánto tiempo guarda el mensaje el servicio push
      "Urgency": "high",
    },
    body: cuerpo,
  });
  const detalle = res.ok ? undefined : (await res.text()).slice(0, 300);
  // 404/410 = la suscripción ya no existe (app desinstalada o permiso revocado)
  return { ok: res.ok, status: res.status, expirada: res.status === 404 || res.status === 410, detalle };
}
