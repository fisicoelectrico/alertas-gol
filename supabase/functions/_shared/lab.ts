// =====================================================================
// Laboratorio de goles con umbral automático (DECISIONES 40).
//
// Gol temprano: si el primer gol cae hasta el minuto lab_gt_minuto (15), se abre una oportunidad por
// estrategia (gt_o15 = Más de 1,5; gt_o25 = Más de 2,5) y se vigila la cuota en vivo de Flashscore
// cada lab_intervalo_min (2) los primeros 15 min y luego cada 5, hasta el 2.º gol o el final (lab_gt_ventana_min 90).
// Más de 1,5 usa un umbral por tramo de minuto (gt_o15_m30, _m45…: seguían 1 gol a ese minuto).
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
import { lineasEntrada, notificar } from "./notificar.ts";

type Log = (s: string) => void;
export const NOMBRE_LAB: Record<string, { titulo: string; linea: number; texto: string }> = {
  gt_o15: { titulo: "Gol temprano · Más de 1,5", linea: 1.5, texto: "terminaron con 2 goles o más" },
  gt_o25: { titulo: "Gol temprano · Más de 2,5", linea: 2.5, texto: "terminaron con 3 goles o más" },
};
const coma = (v: number, d = 2) => v.toFixed(d).replace(".", ",");

/**
 * Partidos que el laboratorio está vigilando → cada cuántos segundos fotografiarlos: lab_intervalo_min (2)
 * los primeros 15 min desde que se abrió el caso y lab_intervalo_largo_min (5) después (ahorra consultas).
 */
export async function vigilados(cfg: Config): Promise<Map<number, number>> {
  const corto = Number(cfg.lab_intervalo_min ?? 2) * 60, largo = Number(cfg.lab_intervalo_largo_min ?? 5) * 60;
  const m = new Map<number, number>();
  for (const r of await sql`select fixture_id, bool_or(ts_inicio > now() - interval '15 minutes') as reciente
                            from futbol.lab_oportunidades where vigilando group by 1`) m.set(r.fixture_id, r.reciente ? corto : largo);
  return m;
}

/** Umbral que aplica a un caso en este minuto: Más de 1,5 usa el tramo condicionado (seguía 1 gol al 30', 45'…). */
function umbralDe(U: Map<string, any>, estrategia: string, min: number | null) {
  if (estrategia === "gt_o15" && min != null) {
    for (const t of [75, 60, 45, 30]) if (min >= t && U.get(`gt_o15_m${t}`)) return { u: U.get(`gt_o15_m${t}`), tramo: t };
  }
  return { u: U.get(estrategia), tramo: null as number | null };
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
  // 90 = hasta el 2.º gol o el final (Fredy, 18 nov). Más de 2,5 no tiene tasa por minuto: se vigila 15 min.
  const ventana = Number(cfg.lab_gt_ventana_min ?? 90);
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
                              ${c.minuto}, 1, ${NOMBRE_LAB[est].linea}, ${Number(c.minuto) + (est === "gt_o15" ? ventana : 15)},
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
    const sigue = f && ["1H", "HT", "2H"].includes(f.fixture.status.short) && total(f) === o.goles_gatillo && (min ?? 999) <= o.vence_minuto;
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
    // El umbral vigente (de hoy, del tramo de minuto) manda; si no hay, el que tenía al abrirse.
    // lab_n_min se exige a la estrategia completa; el tramo ya castiga su muestra chica con Wilson.
    const { u, tramo } = umbralDe(U, o.estrategia, min);
    const umbral = Number(u?.umbral ?? o.umbral);
    if (o.alertada || !Number.isFinite(umbral) || mejor.c < umbral) continue;
    // Confirmación en dos fotos seguidas (18 nov): el feed a veces devuelve por un ciclo un tablero viejo
    // (Atenas-Fenix, 21': Más de 1,5 otra vez a 1,53). Solo se avisa si la foto anterior también pasaba el umbral.
    const previa = (o.serie ?? []).slice(-1)[0];
    if (!previa || Number(previa.c) < umbral) { log(`lab: ${o.estrategia} ${o.fixture_id} pasa el umbral con ${mejor.casa} ${mejor.c}; espera confirmación`); continue; }
    const n = Number(u?.n ?? o.n_hist ?? 0);
    const listo = Number(U.get(o.estrategia)?.n ?? o.n_hist ?? 0) >= nMin;
    let push = 0;
    if (listo && cfg.lab_push !== false && avisan.has(o.estrategia)) {
      const L = NOMBRE_LAB[o.estrategia];
      // Monto sugerido con la casa más baja de las que pagan el umbral o más (las demás no tienen valor)
      const validas = casas.filter((x: any) => x.c >= umbral);
      const baja = validas[validas.length - 1];
      // Formato de Fredy (18 nov): país, competencia, partido, mercado, monto y casas; al final, el porqué
      const [paisL, ...resto] = String(o.liga ?? "").split(" · ");
      push = await notificar((d) => ({
        titulo: `🧪 ${L.titulo}`,
        cuerpo: lineasEntrada({
          pais: resto.length ? paisL : null, liga: resto.length ? resto.join(" · ") : (paisL || null),
          partido: `${o.local} ${f.goals.home}–${f.goals.away} ${o.visitante} · min ${min}`,
          mercado: `Más de ${coma(Number(o.linea), 1)} goles (umbral ${coma(umbral)})`,
          d, casas, cuotaMonto: baja.c, casaMonto: baja.casa, maxPct: Number(cfg.monto_max_pct ?? 10),
        }) + `\nEn la base: ${u?.aciertos ?? "?"} de ${n}${tramo ? ` que seguían 1 gol al ${tramo}'` : ""} ${L.texto}.`,
        url: "./#laboratorio", tag: `lab-${o.estrategia}-${o.fixture_id}`,
      }), { soloAdmin: true });
    }
    await sql`update futbol.lab_oportunidades set alertada = true, ts_alerta = now(), minuto_alerta = ${min},
                cuota_alerta = ${mejor.c}, casa_alerta = ${mejor.casa}, push_enviados = ${push}, umbral = ${umbral}
              where id = ${o.id}`;
    log(`lab: ${o.estrategia}${tramo ? `@${tramo}` : ""} ${o.fixture_id} supera umbral ${umbral} con ${mejor.casa} ${mejor.c}${listo ? "" : ` (sin push: ${n} casos < ${nMin})`}, push=${push}`);
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
  // Los aciertos se cierran apenas cae el gol que pasa la línea; al terminar se anota el total final real
  await sql`update futbol.lab_oportunidades o set goles_final = p.goles_local + p.goles_visitante
            from futbol.partidos p
            where p.fixture_id = o.fixture_id and o.resultado = 'acierto' and p.estado in ('FT', 'AET', 'PEN')
              and o.goles_final is distinct from p.goles_local + p.goles_visitante and o.ts_inicio > now() - interval '1 day'`;
}

function ligaDe(f: any) {
  const pais = String(f.league?.country ?? "").replace(/-/g, " ").trim();
  const liga = String(f.league?.name ?? "").trim();
  return !pais || pais.toLowerCase() === "world" ? liga || null : liga ? `${pais} · ${liga}` : pais;
}
