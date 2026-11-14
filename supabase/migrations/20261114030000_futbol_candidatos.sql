-- =====================================================================
-- Candidatos que no llegaron a alerta (14 nov 2026, DECISIONES 32). Solo aditivo.
--
-- Pregunta que responde: de los partidos que pasaron el filtro (favorito perdiendo en el 2T y
-- con snapshots de estadísticas), ¿cuántos tuvieron un gol más después de entrar, en qué minuto
-- y de qué lado? Así se ven los falsos negativos de la regla y se calibra la v5.
--
-- Tres piezas:
--  1. futbol.cambios_marcador: bitácora de cada cambio de marcador de futbol.partidos, escrita por
--     un trigger. No gasta ninguna consulta: el escáner ya actualiza el marcador de todos los
--     partidos en vivo en cada ciclo (Flashscore, cada 2-5 min). El gol queda entre minuto_antes
--     y minuto (la resolución es la del ciclo).
--  2. futbol.partidos.cierre_fuente: de dónde salió el marcador final (flashscore, api, radar).
--     Antes los partidos sin alerta quedaban congelados en "2H 90'" porque nadie los cerraba.
--  3. futbol.v_candidatos: una fila por partido candidato con su entrada, su resultado y si alertó.
-- =====================================================================

create table if not exists futbol.cambios_marcador (
  id            bigserial primary key,
  fixture_id    int not null,
  ts            timestamptz not null default now(),
  minuto        int,          -- minuto del ciclo que vio el marcador nuevo
  minuto_antes  int,          -- minuto del ciclo anterior (el gol cayó entre los dos)
  estado        text,
  gl_antes      int,
  gv_antes      int,
  gl            int,
  gv            int,
  fuente        text not null default 'ciclo'   -- ciclo | radar (reconstruido de escaneos.radar)
);
create index if not exists cambios_marcador_fixture_idx on futbol.cambios_marcador (fixture_id, ts);
alter table futbol.cambios_marcador enable row level security;

alter table futbol.partidos add column if not exists cierre_fuente text;
alter table futbol.partidos add column if not exists cerrado_ts timestamptz;

create or replace function futbol.registrar_cambio_marcador() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.goles_local is not null and old.goles_visitante is not null
     and (new.goles_local is distinct from old.goles_local or new.goles_visitante is distinct from old.goles_visitante) then
    insert into futbol.cambios_marcador (fixture_id, minuto, minuto_antes, estado, gl_antes, gv_antes, gl, gv)
    values (new.fixture_id, new.minuto, old.minuto, new.estado, old.goles_local, old.goles_visitante,
            new.goles_local, new.goles_visitante);
  end if;
  return new;
end $$;

drop trigger if exists partidos_cambio_marcador on futbol.partidos;
create trigger partidos_cambio_marcador
  after update of goles_local, goles_visitante on futbol.partidos
  for each row execute function futbol.registrar_cambio_marcador();

-- Parámetro: con candidatos u "observados" (ex candidatos aún en vivo) el ciclo FS corre cada
-- intervalo_fs_seg_min, para que el minuto del gol posterior quede con ±2 min y no ±5.
insert into futbol.config (clave, valor, descripcion) values
 ('observar_ex_candidatos', 'true'::jsonb, 'Seguir el marcador de los ex candidatos al ritmo rápido hasta el final (Flashscore, sin cuota)')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------
-- Vista: una fila por partido candidato (= tiene al menos un snapshot con estadísticas)
-- ---------------------------------------------------------------------
create or replace view futbol.v_candidatos with (security_invoker = true) as
with ent as (            -- primer snapshot con estadísticas = entrada como candidato
  select distinct on (fixture_id) fixture_id, ts as ts_entrada, minuto as min_entrada,
         goles_local as gl_entrada, goles_visitante as gv_entrada, regla_version
  from futbol.snapshots where stats_local is not null
  order by fixture_id, ts),
ult as (                 -- último snapshot: qué condición faltaba cuando dejó de evaluarse
  select distinct on (fixture_id) fixture_id, ts as ts_ultimo, minuto as min_ultimo, evaluacion as eval_ultima
  from futbol.snapshots where stats_local is not null
  order by fixture_id, ts desc),
agg as (
  select fixture_id, count(*)::int as snapshots,
         max(dominancia) as dom_max, max(momentum) as mom_max, max(cuota_over) as cuota_max,
         count(*) filter (where (evaluacion->>'dominancia')::boolean)::int as snaps_dom_ok,
         count(*) filter (where (evaluacion->>'momentum')::boolean)::int as snaps_mom_ok,
         count(*) filter (where cuota_over is not null)::int as snaps_con_cuota
  from futbol.snapshots where stats_local is not null group by fixture_id),
gol as (                 -- primer cambio de marcador que SUMA goles después de la entrada
  select distinct on (c.fixture_id) c.fixture_id, c.minuto as min_gol, c.minuto_antes as min_gol_desde,
         case when c.gl > c.gl_antes then 'home' else 'away' end as lado, c.fuente as gol_fuente
  from futbol.cambios_marcador c join ent e using (fixture_id)
  where c.ts > e.ts_entrada and c.gl + c.gv > e.gl_entrada + e.gv_entrada
  order by c.fixture_id, c.ts)
select p.fixture_id, p.local, p.visitante, l.nombre as liga, l.pais, p.kickoff, p.favorito,
       case p.favorito when 'home' then p.cuota_pre_local when 'away' then p.cuota_pre_visitante end as cuota_fav,
       e.regla_version, e.ts_entrada, e.min_entrada, e.gl_entrada, e.gv_entrada,
       e.gl_entrada + e.gv_entrada + 0.5 as linea_entrada,
       u.ts_ultimo, u.min_ultimo, u.eval_ultima,
       a.snapshots, a.dom_max, a.mom_max, a.cuota_max, a.snaps_dom_ok, a.snaps_mom_ok, a.snaps_con_cuota,
       p.estado, p.minuto, p.goles_local, p.goles_visitante, p.cierre_fuente,
       al.id as alerta_id, al.minuto as alerta_minuto, al.cuota as alerta_cuota, al.resultado as alerta_resultado,
       g.min_gol, g.min_gol_desde, g.gol_fuente,
       case when g.lado is null then null when g.lado = p.favorito then 'favorito' else 'rival' end as gol_de,
       case
         when g.fixture_id is not null then 'gol'
         when p.estado in ('PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP') then 'anulado'
         when p.estado in ('FT', 'AET', 'PEN') and p.goles_local + p.goles_visitante > e.gl_entrada + e.gv_entrada then 'gol'
         when p.estado in ('FT', 'AET', 'PEN') then 'sin_gol'
         else 'pendiente'
       end as resultado
from ent e
join futbol.partidos p using (fixture_id)
join ult u using (fixture_id)
join agg a using (fixture_id)
left join futbol.ligas l on l.id = p.liga_id
left join gol g using (fixture_id)
left join lateral (select id, minuto, cuota, resultado from futbol.alertas x
                   where x.fixture_id = p.fixture_id order by ts limit 1) al on true;
