// Conexión directa a Postgres desde la Edge Function.
// ¿Por qué no supabase-js? supabase-js pasa por la API REST (PostgREST), que solo ve
// los esquemas "expuestos" en la configuración del proyecto. Conectando directo con
// SUPABASE_DB_URL (variable que Supabase inyecta en toda Edge Function) el esquema
// `futbol` funciona sin tocar ninguna configuración global del proyecto.
import postgres from "npm:postgres@3.4.5";

export const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
  prepare: false,   // el pooler de Supabase (modo transacción) no admite sentencias preparadas
  max: 3,
  idle_timeout: 5,
  connect_timeout: 10,
});

export type Config = Record<string, any>;

export async function leerConfig(): Promise<Config> {
  const filas = await sql`select clave, valor from futbol.config`;
  const c: Config = {};
  for (const f of filas) c[f.clave] = f.valor;
  return c;
}
