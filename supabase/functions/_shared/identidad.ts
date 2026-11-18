// =====================================================================
// Identidad propia de partidos y ligas (100 % Flashscore, DECISIONES 42, 18 nov 2026).
//
// Antes: un partido de Flashscore solo se podía evaluar si se emparejaba con un fixture de
// API-Football (por hora ±20 min y parecido de nombres). Los que no tenían pareja quedaban
// "sin_cruce": se veían en el Radar pero nunca podían alertar.
//
// Ahora cada partido de Flashscore recibe su propio número la primera vez que se ve:
//   · fixture_id NEGATIVO de la secuencia futbol.fs_fixture_seq (-1, -2, -3…).
//     Negativo para que nunca choque con un id de API-Football (siempre positivos) y para que
//     todas las tablas que ya usan fixture_id (partidos, alertas, snapshots, cuotas_vivo…) sigan
//     igual. Los partidos viejos conservan su id de API-Football.
//   · La liga se resuelve con futbol.fs_ligas ("colombia|primera a" → id). Si no existe, se busca
//     por nombre + país en futbol.ligas; si tampoco, se crea con id NEGATIVO.
//
// Poka-yoke de la política de ligas (16 nov): una liga nueva entra ENCENDIDA (Fredy no quiere que
// entren apagadas por defecto), salvo que su nombre caiga en futbol.liga_patrones_excluir
// (femenil, juvenil, reserva, copa, amistoso, 3.ª división…): esas son exactamente las que Fredy
// ya decidió no seguir, así que entran apagadas con la nota del patrón.
// =====================================================================
import { sql } from "./db.ts";
import type { PartidoFS } from "./flashscore.ts";

/** "COLOMBIA: Primera A - Apertura" → { pais: "Colombia", liga: "Primera A", clave: "colombia|primera a" } */
export function partesLiga(ligaFS: string): { pais: string | null; liga: string; clave: string } {
  const i = ligaFS.indexOf(": ");
  const paisCrudo = i > 0 ? ligaFS.slice(0, i) : "";
  const liga = (i > 0 ? ligaFS.slice(i + 2) : ligaFS).replace(/ - .*$/, "").trim();
  const pais = paisCrudo ? paisCrudo.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()) : null;
  return { pais, liga, clave: `${paisCrudo.toLowerCase()}|${liga.toLowerCase()}` };
}

// Caché por ejecución (la función vive pocos segundos). Se precarga una vez con todo fs_ligas y
// futbol.ligas (son unos cientos de filas) para no hacer una consulta por cada liga de la lista.
const cacheLigas = new Map<string, number | null>();
let precargado = 0;   // ms de la última precarga (la instancia puede quedar viva entre ciclos)
const enFsLigas = new Set<string>();
const paises = new Map<string, string>();   // "saudi arabia" → "Saudi-Arabia" (como ya está escrito en futbol.ligas)
async function precargar() {
  if (Date.now() - precargado < 10 * 60000) return;
  cacheLigas.clear(); enFsLigas.clear(); paises.clear();
  for (const r of await sql`select id, nombre, pais from futbol.ligas order by id > 0, id desc`) {
    // por nombre + país; las positivas (API-Football) se cargan al final y ganan si hay dos iguales
    cacheLigas.set(`${String(r.pais ?? "").toLowerCase().replace(/-/g, " ")}|${String(r.nombre).toLowerCase()}`, r.id);
    if (r.pais) paises.set(String(r.pais).toLowerCase().replace(/-/g, " "), r.pais);
  }
  for (const r of await sql`select clave, liga_id from futbol.fs_ligas`) { cacheLigas.set(r.clave, r.liga_id); enFsLigas.add(r.clave); }
  precargado = Date.now();
}

/**
 * Id de futbol.ligas para un nombre de liga de Flashscore.
 * `crear = false` solo busca (para la agenda de mañana: no se crean ligas por partidos que tal vez
 * ni se jueguen; se crean cuando el partido aparece en vivo).
 */
export async function ligaDe(ligaFS: string, crear: boolean): Promise<number | null> {
  const partes = partesLiga(ligaFS);
  const { liga, clave } = partes;
  await precargar();
  // El país se escribe como ya está en futbol.ligas (así la política de ligas por país, p. ej. "USA", aplica igual)
  const pais = partes.pais ? paises.get(partes.pais.toLowerCase()) ?? partes.pais : null;
  const enCache = cacheLigas.get(clave);
  if (enCache) {
    // Puede venir del cruce por nombre + país (la clave es la misma forma): se deja anotado en fs_ligas
    if (!enFsLigas.has(clave)) {
      await sql`insert into futbol.fs_ligas (clave, liga_id, origen) values (${clave}, ${enCache}, 'nombre') on conflict do nothing`;
      enFsLigas.add(clave);
    }
    return enCache;
  }
  if (!crear) return null;
  // Liga nueva, solo de Flashscore: id negativo. Apagada solo si la política de ligas ya la excluye.
  const [patron] = await sql`select motivo from futbol.liga_patrones_excluir
                             where ${liga} ~* regex and (pais is null or pais = ${pais}) order by id limit 1`;
  const [nueva] = await sql`
    insert into futbol.ligas (id, nombre, pais, habilitada, notas)
    values (nextval('futbol.fs_liga_seq'), ${liga}, ${pais}, ${!patron},
            ${patron ? `Creada desde Flashscore y apagada por la política de ligas (${patron.motivo})` : "Creada desde Flashscore (revisar en la revisión semanal)"})
    returning id`;
  await sql`insert into futbol.fs_ligas (clave, liga_id, origen) values (${clave}, ${nueva.id}, 'nueva') on conflict do nothing`;
  const [fin] = await sql`select liga_id from futbol.fs_ligas where clave = ${clave}`;
  cacheLigas.set(clave, fin.liga_id);
  enFsLigas.add(clave);
  return fin.liga_id;
}

/**
 * Da fixture_id propio (negativo) a los partidos de Flashscore que todavía no tienen uno, y guarda
 * su liga. Devuelve la fila de fs_partidos de cada uno (vieja o nueva), por fs_id.
 * `conocidos` trae lo que ya se leyó de fs_partidos para no repetir la consulta.
 */
export async function registrar(partidos: PartidoFS[], conocidos: Map<string, any>, crearLigas: boolean): Promise<number> {
  let nuevos = 0;
  for (const p of partidos) {
    const c = conocidos.get(p.id);
    if (c?.fixture_id && c?.liga_id) continue;
    const ligaId = c?.liga_id ?? await ligaDe(p.liga, crearLigas);
    if (!ligaId) continue;   // agenda de una liga desconocida: se registra cuando aparezca en vivo
    const [fila] = await sql`
      insert into futbol.fs_partidos (fs_id, fixture_id, liga, local, visitante, inicio, id_local, id_visitante, liga_id)
      values (${p.id}, nextval('futbol.fs_fixture_seq'), ${p.liga}, ${p.local}, ${p.visitante},
              ${new Date(p.inicio).toISOString()}, ${p.idLocal}, ${p.idVisitante}, ${ligaId})
      on conflict (fs_id) do update set
        fixture_id = coalesce(futbol.fs_partidos.fixture_id, nextval('futbol.fs_fixture_seq')),
        liga_id = coalesce(futbol.fs_partidos.liga_id, excluded.liga_id)
      returning *`;
    if (!c?.fixture_id) nuevos++;
    conocidos.set(p.id, fila);
  }
  return nuevos;
}
