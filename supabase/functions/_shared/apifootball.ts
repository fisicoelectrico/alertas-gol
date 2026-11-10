// =====================================================================
// Cliente de API-Football con contabilidad y freno de presupuesto.
// Regla de oro: NINGUNA llamada sale sin pasar por el presupuesto,
// y TODA llamada (exitosa o no) queda registrada en futbol.api_uso.
// =====================================================================
import { sql, Config } from "./db.ts";

const BASE = "https://v3.football.api-sports.io";

export class SinPresupuesto extends Error {}

export interface EstadoPresupuesto {
  usadas_hoy: number;
  restantes_api: number | null; // lo que dice la propia API en su último header
  disponibles: number;          // lo que todavía podemos gastar respetando la reserva
}

export async function estadoPresupuesto(cfg: Config): Promise<EstadoPresupuesto> {
  const [r] = await sql`
    select coalesce(sum(llamadas),0)::int as usadas, min(restantes) as restantes
    from futbol.api_uso where fecha = (now() at time zone 'utc')::date`;
  const presupuesto = Number(cfg.presupuesto_diario ?? 100);
  const reserva = Number(cfg.reserva_api ?? 6);
  let disponibles = presupuesto - reserva - r.usadas;
  // Si la API reporta menos de lo que creemos (p. ej. alguien usó la key en otro lado), manda la API.
  if (r.restantes !== null && r.restantes !== undefined) disponibles = Math.min(disponibles, r.restantes - reserva);
  return { usadas_hoy: r.usadas, restantes_api: r.restantes ?? null, disponibles: Math.max(0, disponibles) };
}

export class ApiFootball {
  llamadas = 0;
  private disponibles: number;
  constructor(private key: string, estado: EstadoPresupuesto) {
    this.disponibles = estado.disponibles;
  }

  quedan() { return this.disponibles; }

  async get(endpoint: string, params: Record<string, string | number>): Promise<any> {
    if (this.disponibles <= 0) throw new SinPresupuesto(`sin presupuesto para ${endpoint}`);
    this.disponibles--;
    this.llamadas++;
    const url = new URL(BASE + endpoint);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let restantes: number | null = null;
    try {
      const res = await fetch(url, { headers: { "x-apisports-key": this.key } });
      const h = res.headers.get("x-ratelimit-requests-remaining");
      restantes = h !== null && h !== "" && Number.isFinite(parseInt(h)) ? parseInt(h) : null;
      const cuerpo = await res.json();
      // API-Football responde 200 aunque haya error; los errores vienen en `errors`.
      const errores = cuerpo?.errors;
      const hayError = Array.isArray(errores) ? errores.length > 0 : errores && Object.keys(errores).length > 0;
      if (!res.ok || hayError) throw new Error(`API ${endpoint} ${res.status}: ${JSON.stringify(errores ?? cuerpo).slice(0, 300)}`);
      return cuerpo;
    } finally {
      await sql`
        insert into futbol.api_uso (fecha, endpoint, llamadas, restantes)
        values ((now() at time zone 'utc')::date, ${endpoint}, 1, ${restantes})
        on conflict (fecha, endpoint) do update
          set llamadas = futbol.api_uso.llamadas + 1,
              restantes = coalesce(excluded.restantes, futbol.api_uso.restantes)`;
      if (restantes !== null) {
        // mantener todas las filas del día con el último "restantes" visto
        await sql`update futbol.api_uso set restantes = ${restantes} where fecha = (now() at time zone 'utc')::date`;
      }
    }
  }
}
