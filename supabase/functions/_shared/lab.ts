// =====================================================================
// Laboratorio de goles con umbral automático (DECISIONES 40).
//
// Gol temprano: si el primer gol cae hasta el minuto lab_gt_minuto (15), se abre una oportunidad por
// estrategia (gt_o15 = Más de 1,5; gt_o25 = Más de 2,5) y se vigila la cuota en vivo de Flashscore
// cada lab_intervalo_min (2) durante lab_gt_ventana_min (15) minutos, mientras el marcador no cambie.
// Si alguna casa paga ≥ umbral, se avisa al administrador (solo las estrategias de lab_push_estrategias).
//
// El umbral NO es fijo: lo calcula la base (futbol.lab_calcular) con las ligas habilitadas.
//   p        = aciertos / casos
//   ic_bajo  = límite bajo de Wilson al 95 % (prudente con pocos casos)
//   umbral   = 1 / ic_bajo   → entrar solo si la casa paga eso o más
// Se recalcula cada hora y queda un registro por día en futbol.lab_umbrales para graficarlo.
//
// Honestidad: la estadística vale justo después del gol. Si pasan los minutos sin otro gol la
// probabilidad real baja; por eso la ventana es corta y la serie de cuotas queda guardada para medirlo.
// =====================================================================
import { sql, Config } from "./db.ts";
import { notificar, textoMonto } from "./notificar.ts";

type Log = (s: string) => void;
export const NOMBRE_LAB: Record<string, { titulo: string; linea: number; texto: string }> = {
  gt_o15: { titulo: "Gol temprano · Más de 1,5", linea: 1.5, texto: "terminaron con 2 goles o más" },
  gt_o25: { titulo: "Gol temprano · Más de 2,5", linea: 2.5, texto: "terminaron con 3 goles o más" },
};
const coma = (v: number, d = 2) => v.toFixed(d).replace(".", ",");

/** Ids de los partidos que el laboratorio está vigilando (se fotografían cada lab_intervalo_min). */
export async function vigilados(): Promise<Set<number>> {
  return new Set((await sql`select distinct fixture_id from futbol.lab_oportunidades where vigilando`).map((r: any) => r.fixture_id));
}

/** Umbrales de hoy; si tienen más de una hora (o no hay), se recalculan desde la base. */
export async function umbrales(log: Log): Promise<Map<string, any>> {
  let filas = await sql`select * from futbol.lab_umbrales
                        where fecha = (now() at time zone 'America/Bogota')::date and actualizado > now() - interval '1 hour'`;
  if (!filas.length) {
    filas = await sql`select * from futbol.lab_calcular()`;
    log(`lab: umbrales recalculados (${filas.map((u: any) => `${u.estrategia} ${u.aciertos}/${u.n} → ${u.umbral ?? "–"}`).join(", ")})`);
  }
  return new Map(filas.map((u: any) => [u.estrategia, u]));
}

/**
 * Un ciclo del laboratorio. `vivos` = partidos en forma API-Football con `__fs` (ya fotografiados en
 * este ciclo por cicloCuotasVivo). `habilitada(id)` dice si la liga está encendida.
 */
export async function cicloLab(opts: { cfg: Config; vivos: any[]; habilitada: (id: number) => boolean; log: Log }) {
  const { cfg, vivos, habilitada, log } = opts;
  if (cfg.lab_activo === false) return;
  const U = await umbrales(log);
  const porId = new Map(vivos.map((f) => [f.fixture.id, f]));
  const total = (f: any) => (f.goals.home ?? 0) + (f.goals.away ?? 0);

  // 1. Abrir oportunidades: 1T, un solo gol, y el primer cambio de marcador fue hasta el minuto 15
  const mGt = Number(cfg.lab_gt_minuto ?? 15);
  const ventana = Number(cfg.lab_gt_ventana_min ?? 15);
  const conUnGol = vivos.filter((f) => f.__fs?.id && habilitada(f.fixture.id) && f.fixture.status.short === "1H" && total(f) === 1);
  if (conUnGol.length) {
    const primeros = await sql`select distinct on (fixture_id) fixture_id, minuto, gl_antes + gv_antes as antes
                               from futbol.cambios_marcador where fixture_id = any(${conUnGol.map((f) => f.fixture.id)}::int[])
                               order by fixture_id, ts, id`;
    for (const c of primeros) {
      if (Number(c.antes) !== 0 || c.minuto == null || Number(c.minuto) > mGt) continue;
      const f = porId.get(c.fixture_id)!;
      for (const est of ["gt_o15", "gt_o25"]) {
        const u = U.get(est);
        const r = await sql`insert into futbol.lab_oportunidades (estrategia, fixture_id, fs_id, liga, local, visitante,
                              minuto_gatillo, goles_gatillo, linea, vence_minuto, n_hist, p_hist, umbral)
                            values (${est}, ${f.fixture.id}, ${f.__fs.id}, ${ligaDe(f)}, ${f.teams.home.name}, ${f.teams.away.name},
                              ${c.minuto}, 1, ${NOMBRE_LAB[est].linea}, ${Number(c.minuto) + ventana},
                              ${u?.n ?? null}, ${u?.p ?? null}, ${u?.umbral ?? null})
                            on conflict (fixture_id, estrategia) do nothing returning id`;
        if (r.length) log(`lab: abre ${est} ${f.fixture.id} (gol al ${c.minuto}')`);
      }
    }
  }

  // 2. Vigilar las abiertas con la última foto de cuotas (máx. 4 min, mismo marcador)
  const nMin = Number(cfg.lab_n_min ?? 30);
  const avisan = new Set<string>(Array.isArray(cfg.lab_push_estrategias) ? cfg.lab_push_estrategias : ["gt_o15"]);
  for (const o of await sql`select * from futbol.lab_oportunidades where vigilando order by id`) {
    const f = porId.get(o.fixture_id);
    const min = f?.fixture.status.elapsed ?? null;
    const sigue = f && f.fixture.status.short === "1H" && total(f) === o.goles_gatillo && (min ?? 999) <= o.vence_minuto;
    if (!sigue) {
      await sql`update futbol.lab_oportunidades set vigilando = false where id = ${o.id}`;
      continue;
    }
    const filas = await sql`select distinct on (casa_id) casa, cuota_over from futbol.cuotas_vivo
                            where fixture_id = ${o.fixture_id} and ts > now() - interval '4 minutes'
                              and linea = ${o.linea} and activa and cuota_over is not null
                              and goles_local + goles_visitante = ${o.goles_gatillo}
                            order by casa_id, ts desc`;
    if (!filas.length) continue;
    const casas = filas.map((r: any) => ({ casa: r.casa as string, c: Number(r.cuota_over) })).sort((a: any, b: any) => b.c - a.c);
    const mejor = casas[0];
    const serie = [...(o.serie ?? []), { m: min, c: mejor.c, casa: mejor.casa }];
    const sube = o.mejor_cuota == null || mejor.c > Number(o.mejor_cuota);
    await sql`update futbol.lab_oportunidades set serie = ${sql.json(serie)},
                mejor_cuota = ${sube ? mejor.c : o.mejor_cuota}, mejor_casa = ${sube ? mejor.casa : o.mejor_casa},
                minuto_mejor = ${sube ? min : o.minuto_mejor}
              where id = ${o.id}`;

    // El umbral vigente (de hoy) manda; si no hay, el que tenía al abrirse
    const u = U.get(o.estrategia);
    const umbral = Number(u?.umbral ?? o.umbral);
    if (o.alertada || !Number.isFinite(umbral) || mejor.c < umbral) continue;
    const n = Number(u?.n ?? o.n_hist ?? 0);
    const listo = n >= nMin;
    let push = 0;
    if (listo && cfg.lab_push !== false && avisan.has(o.estrategia)) {
      const L = NOMBRE_LAB[o.estrategia];
      // Monto sugerido con la casa más baja de las que pagan el umbral o más (las demás no tienen valor)
      const validas = casas.filter((x: any) => x.c >= umbral);
      const baja = validas[validas.length - 1];
      push = await notificar((d) => ({
        titulo: `🧪 ${L.titulo}${o.liga ? ` · ${o.liga}` : ""}`,
        cuerpo: `${o.local} ${f.goals.home}–${f.goals.away} ${o.visitante} · min ${min}\n` +
          `${casas.map((x: any) => `${x.casa} ${coma(x.c)}`).join(" · ")} (umbral ${coma(umbral)})` +
          `${textoMonto(d, baja.c, baja.casa, Number(cfg.monto_max_pct ?? 10))}\n` +
          `En la base: ${u?.aciertos ?? "?"} de ${n} con gol antes del ${mGt}' ${L.texto}.`,
        url: "./#laboratorio", tag: `lab-${o.estrategia}-${o.fixture_id}`,
      }), { soloAdmin: true });
    }
    await sql`update futbol.lab_oportunidades set alertada = true, ts_alerta = now(), minuto_alerta = ${min},
                cuota_alerta = ${mejor.c}, casa_alerta = ${mejor.casa}, push_enviados = ${push}, umbral = ${umbral}
              where id = ${o.id}`;
    log(`lab: ${o.estrategia} ${o.fixture_id} supera umbral ${umbral} con ${mejor.casa} ${mejor.c}${listo ? "" : ` (sin push: ${n} casos < ${nMin})`}, push=${push}`);
  }

  // 3. Resolver: acierto apenas el marcador pasa la línea; fallo/acierto definitivo al terminar
  for (const f of vivos) {
    const t = total(f);
    await sql`update futbol.lab_oportunidades set resultado = 'acierto', goles_final = ${t}, cerrada_ts = now(), vigilando = false
              where fixture_id = ${f.fixture.id} and resultado = 'pendiente' and ${t} > linea`;
  }
  await sql`update futbol.lab_oportunidades o set goles_final = p.goles_local + p.goles_visitante, cerrada_ts = now(), vigilando = false,
              resultado = case when p.goles_local + p.goles_visitante > o.linea then 'acierto' else 'fallo' end
            from futbol.partidos p
            where p.fixture_id = o.fixture_id and o.resultado = 'pendiente' and p.estado in ('FT', 'AET', 'PEN')`;
}

function ligaDe(f: any) {
  const pais = String(f.league?.country ?? "").replace(/-/g, " ").trim();
  const liga = String(f.league?.name ?? "").trim();
  return !pais || pais.toLowerCase() === "world" ? liga || null : liga ? `${pais} · ${liga}` : pais;
}
