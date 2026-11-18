// =====================================================================
// Cuotas en vivo de Flashscore (DECISIONES 40). Gratis: no gasta API-Football.
//
// Qué guarda (tabla futbol.cuotas_vivo, una fila por casa y línea):
//   · 'gol'        apenas cambia el marcador (para estudiar "gol temprano → Over")
//   · 'descanso'   una vez al descanso (para "gol en el 2.º tiempo")
//   · 'lab'        cada lab_intervalo_min (2) mientras el laboratorio vigila el partido (lab.ts)
//   · 'candidato'  cada fs_vivo_intervalo_cand_min (2) mientras el partido es candidato (la alerta usa esta)
//   · 'inicio'     la primera vez que se ve el partido
//   · 'ciclo'      cada fs_vivo_intervalo_min (10) en el resto de partidos de ligas habilitadas
// Una casa sin oferta en vivo queda con linea = null (así no se le vuelve a preguntar en cada ciclo).
//
// Poka-yoke contra bloqueos: tope de consultas por ciclo (fs_vivo_max_consultas), pocas casas
// (fs_vivo_casas) y un aviso al administrador si Flashscore deja de responder (salud()).
// =====================================================================
import { sql, Config } from "./db.ts";
import * as FS from "./flashscore.ts";
import * as A from "./algoritmo.ts";
import { notificar } from "./notificar.ts";

type Log = (s: string) => void;
const PRIORIDAD: Record<string, number> = { gol: 0, lab: 1, descanso: 2, candidato: 3, inicio: 4, ciclo: 5 };

export function casasDe(cfg: Config): number[] {
  const c = Array.isArray(cfg.fs_vivo_casas) ? cfg.fs_vivo_casas.map(Number).filter((x: number) => FS.CASAS_CO[x]) : [];
  return c.length ? c : [523, 1097, 1197];
}

/** Pide y guarda la foto de un partido en todas las casas. Devuelve consultas hechas y errores. */
export async function fotografiar(f: any, motivo: string, casas: number[], log: Log) {
  const id = f.fixture.id, fsId = f.__fs?.id;
  let consultas = 0, errores = 0, conOferta = 0;
  if (!fsId) return { consultas, errores, conOferta };
  const filas: any[] = [];
  for (const casa of casas) {
    consultas++;
    try {
      const lineas = await FS.overVivo(fsId, casa);
      if (!lineas || !lineas.length) {
        filas.push({ casa, linea: null, over: null, under: null, activa: false });
        continue;
      }
      conOferta++;
      for (const l of lineas) filas.push({ casa, ...l });
    } catch (e) {
      errores++;
      log(`fs vivo ${fsId}/${casa}: ${(e as Error).message}`);
    }
  }
  const gl = f.goals.home ?? 0, gv = f.goals.away ?? 0;
  for (const r of filas) {
    await sql`insert into futbol.cuotas_vivo (fixture_id, fs_id, minuto, estado, goles_local, goles_visitante, motivo,
                casa_id, casa, linea, cuota_over, cuota_under, activa)
              values (${id}, ${fsId}, ${f.fixture.status.elapsed ?? null}, ${f.fixture.status.short}, ${gl}, ${gv}, ${motivo},
                ${r.casa}, ${FS.CASAS_CO[r.casa] ?? String(r.casa)}, ${r.linea}, ${r.over}, ${r.under}, ${r.activa})`;
  }
  return { consultas, errores, conOferta };
}

/**
 * Un ciclo: decide qué partidos fotografiar, por prioridad, sin pasar el tope de consultas.
 * `enVivo` = partidos en forma API-Football con `__fs`; `habilitada(id)` dice si la liga está encendida.
 */
export async function cicloCuotasVivo(opts: {
  cfg: Config; enVivo: any[]; habilitada: (id: number) => boolean; candidatos: Set<number>; lab?: Map<number, number>; log: Log;
}) {
  const { cfg, enVivo, habilitada, candidatos, log } = opts;
  const lab = opts.lab ?? new Map<number, number>();   // id → segundos entre fotos
  if (cfg.fs_vivo_activo === false) return { consultas: 0, errores: 0, fotos: 0 };
  const casas = casasDe(cfg);
  const tope = Math.max(Number(cfg.fs_vivo_max_consultas ?? 24), casas.length);
  const cada = Number(cfg.fs_vivo_intervalo_min ?? 10) * 60;
  const cadaCand = Number(cfg.fs_vivo_intervalo_cand_min ?? 2) * 60;
  const vivos = enVivo.filter((f) => f.__fs?.id && habilitada(f.fixture.id) && ["1H", "HT", "2H"].includes(f.fixture.status.short));
  if (!vivos.length) return { consultas: 0, errores: 0, fotos: 0 };

  const ultima = new Map<number, any>();
  for (const r of await sql`select distinct on (fixture_id) fixture_id, goles_local + goles_visitante as g, estado,
                              extract(epoch from now() - ts) as edad
                            from futbol.cuotas_vivo where fixture_id = any(${vivos.map((f) => f.fixture.id)}::int[])
                            order by fixture_id, ts desc`) ultima.set(r.fixture_id, r);

  const cola: { f: any; motivo: string; edad: number }[] = [];
  for (const f of vivos) {
    const u = ultima.get(f.fixture.id);
    const g = (f.goals.home ?? 0) + (f.goals.away ?? 0);
    const edad = u ? Number(u.edad) : Infinity;
    let motivo: string | null = null;
    if (!u) motivo = "inicio";
    else if (Number(u.g) !== g) motivo = "gol";
    else if (lab.has(f.fixture.id) && edad >= lab.get(f.fixture.id)! - 20) motivo = "lab";
    else if (f.fixture.status.short === "HT" && u.estado !== "HT") motivo = "descanso";
    else if (candidatos.has(f.fixture.id) && edad >= cadaCand - 20) motivo = "candidato";
    else if (edad >= cada - 20) motivo = "ciclo";
    if (motivo) cola.push({ f, motivo, edad });
  }
  cola.sort((a, b) => PRIORIDAD[a.motivo] - PRIORIDAD[b.motivo] || b.edad - a.edad);

  let consultas = 0, errores = 0, fotos = 0;
  for (const c of cola) {
    if (consultas + casas.length > tope) break;
    const r = await fotografiar(c.f, c.motivo, casas, log);
    consultas += r.consultas; errores += r.errores; fotos++;
  }
  if (cola.length > fotos) log(`fs vivo: ${cola.length - fotos} partido(s) quedan para el próximo ciclo (tope ${tope})`);
  await salud(cfg, "vivo", consultas === 0 || errores < consultas, `${errores} de ${consultas} consultas de cuotas en vivo fallaron`, log);
  return { consultas, errores, fotos };
}

/**
 * Cuota Over en vivo para la alerta, desde la última foto (máx. 3 min). Si no hay, toma una ahora.
 * La cuota es el promedio de las casas con la línea activa; `lineas` y `casas` van al snapshot.
 */
export async function cuotaOverFS(f: any, linea: number, cfg: Config, log: Log): Promise<A.CuotaOver & { casas: Record<string, number> }> {
  const vacia = { linea, cuota: null, suspendida: false, mercado: null, lineas: {}, casas: {} };
  if (!f.__fs?.id) return vacia;
  const leer = () => sql`select distinct on (casa_id, linea) casa, linea, cuota_over, activa from futbol.cuotas_vivo
                         where fixture_id = ${f.fixture.id} and ts > now() - interval '3 minutes' and linea is not null
                           and goles_local + goles_visitante = ${(f.goals.home ?? 0) + (f.goals.away ?? 0)}
                         order by casa_id, linea, ts desc`;
  let filas = await leer();
  if (!filas.length) {
    await fotografiar(f, "candidato", casasDe(cfg), log);
    filas = await leer();
  }
  const casas: Record<string, number> = {};
  const porLinea: Record<string, number[]> = {};
  let suspendida = false;
  for (const r of filas) {
    if (!r.activa || r.cuota_over === null) { if (Math.abs(Number(r.linea) - linea) < 1e-6) suspendida = true; continue; }
    (porLinea[String(Number(r.linea))] ??= []).push(Number(r.cuota_over));
    if (Math.abs(Number(r.linea) - linea) < 1e-6) casas[r.casa] = Number(r.cuota_over);
  }
  const prom = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const lineas: Record<string, number> = {};
  for (const [k, v] of Object.entries(porLinea)) lineas[k] = Number(prom(v).toFixed(2));
  const vals = Object.values(casas);
  return {
    linea, cuota: vals.length ? Number(prom(vals).toFixed(2)) : null,
    suspendida: !vals.length && suspendida, mercado: vals.length ? "flashscore vivo" : null, lineas, casas,
  };
}

/**
 * Salud de Flashscore: tras fs_fallos_aviso (3) ciclos seguidos con falla, una push al administrador
 * ("Flashscore no responde"); al volver, otra ("volvió"). Una sola vez por caída.
 */
export async function salud(cfg: Config, parte: "lista" | "vivo", ok: boolean, detalle: string, log: Log) {
  const clave = `fs_salud_${parte}`;
  const [r] = await sql`select valor from futbol.config where clave = ${clave}`;
  const s = (r?.valor ?? { fallos: 0, avisado: false }) as { fallos: number; avisado: boolean };
  const umbral = Math.max(Number(cfg.fs_fallos_aviso ?? 3), 1);
  const que = parte === "lista" ? "la lista de partidos en vivo" : "las cuotas en vivo";
  let nuevo = s;
  if (ok) {
    if (s.avisado) {
      const n = await notificar({ titulo: "Flashscore volvió", cuerpo: `Ya responde de nuevo (${que}).`, url: "./#control", tag: `fs-salud-${parte}` }, { soloAdmin: true });
      log(`fs salud ${parte}: volvió, push=${n}`);
    }
    if (s.fallos === 0 && !s.avisado) return;
    nuevo = { fallos: 0, avisado: false };
  } else {
    nuevo = { fallos: s.fallos + 1, avisado: s.avisado };
    if (nuevo.fallos >= umbral && !s.avisado) {
      const n = await notificar({
        titulo: "⚠️ Flashscore no responde",
        cuerpo: `Fallan ${que} hace ${nuevo.fallos} ciclos seguidos (${detalle}). Puede ser un bloqueo o una caída: el radar queda ciego hasta que vuelva.`,
        url: "./#control", tag: `fs-salud-${parte}`,
      }, { soloAdmin: true });
      nuevo.avisado = true;
      log(`fs salud ${parte}: AVISO enviado, push=${n}`);
    }
  }
  await sql`insert into futbol.config (clave, valor, descripcion) values (${clave}, ${sql.json(nuevo as any)},
              'Salud de Flashscore (la escribe el escáner): fallos seguidos y si ya se avisó')
            on conflict (clave) do update set valor = excluded.valor, actualizado = now()`;
}
