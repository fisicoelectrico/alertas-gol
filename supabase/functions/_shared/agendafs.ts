// =====================================================================
// Agenda y favoritos desde Flashscore (DECISIONES 42, 18 nov 2026).
//
// Reemplaza a GET /fixtures?date (API-Football, 1 consulta al día) y a las cuotas prepartido de
// API-Football. Dos pasos, los dos gratis:
//
//   1. LISTA. La lista de hoy ya llega en cada ciclo; la de MAÑANA se lee cada fs_agenda_refresco_h
//      horas (6). Cada partido de una liga conocida y habilitada (y que no sea copa) se registra con
//      su fixture_id propio y entra a futbol.agenda. Las ligas desconocidas no se crean aquí: se
//      crean cuando el partido aparece en vivo (así una liga rara de mañana no ensucia la tabla).
//
//   2. CUOTAS PREPARTIDO. Cada ciclo pide como máximo fs_agenda_cuotas_por_ciclo (12) consultas oce
//      de Flashscore, empezando por los partidos más cercanos (hasta fs_agenda_horas = 36 h). La cuota
//      que manda para elegir favorito es la de APERTURA promedio de las casas colombianas (igual que
//      la regla v4). Cuando el partido arranca, el escáner copia esa cuota a futbol.partidos sin pedir
//      nada más. Así, hoy por la tarde ya se ve quién es favorito mañana.
//
// Volumen: con ~80 ligas habilitadas son ~150-300 partidos por día → 150-300 consultas oce al día,
// repartidas de a 12 cada 5 minutos. Es una consulta por partido UNA vez, no minuto a minuto.
// =====================================================================
import { sql, Config } from "./db.ts";
import * as FS from "./flashscore.ts";
import * as A from "./algoritmo.ts";
import { registrar } from "./identidad.ts";

type Log = (s: string) => void;

/** Registra en la agenda los partidos por jugar de una lista de Flashscore. Devuelve cuántos entraron nuevos. */
async function cargarLista(lista: FS.PartidoFS[], regla: A.Regla): Promise<number> {
  const porJugar = lista.filter((p) => p.estado === 1 && !A.esCopa(p.liga, regla.patrones_copa));
  if (!porJugar.length) return 0;
  const conocidos = new Map<string, any>();
  for (const r of await sql`select * from futbol.fs_partidos where fs_id = any(${porJugar.map((p) => p.id)}::text[])`) conocidos.set(r.fs_id, r);
  await registrar(porJugar, conocidos, false);
  const filas = porJugar.map((p) => ({ p, c: conocidos.get(p.id) })).filter((x) => x.c?.fixture_id && x.c?.liga_id);
  if (!filas.length) return 0;
  // Solo ligas habilitadas (apagar una liga la saca también de la agenda y no gasta cuotas)
  const hab = new Set((await sql`select id from futbol.ligas where id = any(${[...new Set(filas.map((x) => x.c.liga_id))]}::int[])
                                 and coalesce(habilitada, true)`).map((r: any) => r.id));
  const datos = filas.filter((x) => hab.has(x.c.liga_id)).map(({ p, c }) => ({
    fixture_id: c.fixture_id, fecha: new Date(p.inicio).toISOString().slice(0, 10), liga_id: c.liga_id, temporada: null,
    local: p.local, visitante: p.visitante, kickoff: new Date(p.inicio).toISOString(), estado: "NS", fs_id: p.id,
  }));
  let nuevos = 0;
  for (let i = 0; i < datos.length; i += 300) {
    const r = await sql`insert into futbol.agenda ${sql(datos.slice(i, i + 300))}
      on conflict (fixture_id) do update set kickoff = excluded.kickoff, fs_id = excluded.fs_id
        where futbol.agenda.kickoff is distinct from excluded.kickoff or futbol.agenda.fs_id is distinct from excluded.fs_id
      returning (xmax = 0) as nuevo`;
    nuevos += r.filter((x: any) => x.nuevo).length;
  }
  return nuevos;
}

export async function cicloAgendaFS(opts: { cfg: Config; hoyLista: FS.PartidoFS[]; regla: A.Regla; log: Log }) {
  const { cfg, hoyLista, regla, log } = opts;
  // 1a. Hoy: la lista ya llegó en este ciclo (cuesta cero)
  const nHoy = await cargarLista(hoyLista, regla);
  if (nHoy) log(`agenda fs hoy: ${nHoy} partidos nuevos`);
  // 1b. Mañana: una lectura cada N horas (reserva atómica de la marca)
  const horas = Number(cfg.fs_agenda_refresco_h ?? 6);
  const toma = await sql`update futbol.config set valor = to_jsonb(now()::text), actualizado = now()
                         where clave = 'agenda_fs_ts' and (valor #>> '{}')::timestamptz < now() - make_interval(hours => ${horas})
                         returning 1`;
  if (toma.length) {
    try {
      const manana = await FS.listaDia(1);
      const n = await cargarLista(manana, regla);
      log(`agenda fs mañana: ${manana.length} partidos en Flashscore, ${n} nuevos en ligas habilitadas`);
    } catch (e) { log(`agenda fs mañana: ${(e as Error).message}`); }
    await sql`delete from futbol.agenda where fecha < (now() at time zone 'utc')::date - 3`;
  }

  // 2. Cuotas prepartido de los más cercanos
  const cupo = Number(cfg.fs_agenda_cuotas_por_ciclo ?? 12);
  if (cupo <= 0) return;
  const pend = await sql`
    select a.fixture_id, a.fs_id, f.id_local, f.id_visitante
    from futbol.agenda a join futbol.fs_partidos f on f.fs_id = a.fs_id
    left join futbol.ligas l on l.id = a.liga_id
    where not a.cuota_pre_consultada and a.fs_id is not null and coalesce(l.habilitada, true)
      and a.kickoff between now() - interval '30 minutes' and now() + make_interval(hours => ${Number(cfg.fs_agenda_horas ?? 36)})
    order by a.kickoff limit ${cupo}`;
  let con = 0, sin = 0, err = 0;
  for (const r of pend) {
    let c: FS.CuotasFS;
    try { c = await FS.cuotas(r.fs_id, r.id_local, r.id_visitante); }
    catch (e) { err++; if (err >= 3) { log(`agenda fs cuotas: ${(e as Error).message} (se corta el ciclo)`); break; } continue; }
    const ap = c.apertura ?? c.actual;
    await sql`update futbol.agenda set cuota_pre_consultada = true,
                cuota_pre_local = ${ap ? ap.local.toFixed(2) : null},
                cuota_pre_empate = ${ap && Number.isFinite(ap.empate) ? ap.empate.toFixed(2) : null},
                cuota_pre_visitante = ${ap ? ap.visitante.toFixed(2) : null},
                casas = ${ap?.casas ?? 0}, cuota_pre_ts = now()
              where fixture_id = ${r.fixture_id}`;
    await sql`update futbol.fs_partidos set cuotas = ${sql.json(c as any)} where fs_id = ${r.fs_id}`;
    if (ap) con++; else sin++;
  }
  if (pend.length) log(`agenda fs cuotas: ${con} con favorito, ${sin} sin cuotas${err ? `, ${err} errores` : ""}`);
}

/**
 * Copia a futbol.partidos el favorito que la agenda ya tiene (cero consultas). Devuelve los ids copiados.
 * Se usa antes de pedir la cuota oce en vivo: si la agenda la trae, no se pide.
 */
export async function favoritosDesdeAgenda(ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const r = await sql`
    update futbol.partidos p set cuota_pre_consultada = true,
      cuota_pre_local = a.cuota_pre_local, cuota_pre_empate = a.cuota_pre_empate, cuota_pre_visitante = a.cuota_pre_visitante,
      favorito = case when a.cuota_pre_local is null or a.cuota_pre_visitante is null then null
                      when a.cuota_pre_local <= a.cuota_pre_visitante then 'home' else 'away' end
    from futbol.agenda a
    where a.fixture_id = p.fixture_id and a.cuota_pre_consultada and not p.cuota_pre_consultada
      and p.fixture_id = any(${ids}::int[])
    returning p.fixture_id`;
  return r.map((x: any) => x.fixture_id);
}
