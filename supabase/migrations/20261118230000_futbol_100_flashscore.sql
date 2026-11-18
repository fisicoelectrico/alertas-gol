-- =====================================================================
-- 100 % Flashscore (DECISIONES 42, 18 nov 2026). Migración ADITIVA: no borra ni cambia datos viejos.
--
-- Antes, la llave interna de cada partido era el fixture_id de API-Football, y un partido de
-- Flashscore solo se evaluaba si se emparejaba con la agenda de API-Football (los demás quedaban
-- "sin_cruce"). Ahora Flashscore manda:
--   · Partido nuevo de Flashscore → fixture_id propio NEGATIVO (-1, -2, -3…). Así no choca nunca con
--     un id de API-Football (todos positivos) y el resto de tablas (partidos, alertas, snapshots,
--     cuotas_vivo…) siguen funcionando sin tocar sus columnas. Negativo = "nació en Flashscore".
--   · Liga nueva de Flashscore sin equivalente → id de liga propio NEGATIVO, igual idea.
--   · futbol.fs_ligas: nombre de liga de Flashscore ("COLOMBIA: Primera A") → id de futbol.ligas.
--     Se siembra con el historial de partidos emparejados (fs_partidos → agenda/partidos).
--   · La agenda (hoy y mañana) y los favoritos salen de la lista de Flashscore y de las cuotas
--     prepartido (consulta oce), sin gastar API-Football.
-- =====================================================================

create sequence if not exists futbol.fs_fixture_seq as integer increment by -1 minvalue -2147483647 maxvalue -1 start with -1;
create sequence if not exists futbol.fs_liga_seq    as integer increment by -1 minvalue -2147483647 maxvalue -1 start with -1;

create table if not exists futbol.fs_ligas (
  clave    text primary key,                       -- "pais|liga" en minúsculas, sin la fase ("colombia|primera a")
  liga_id  integer not null references futbol.ligas(id),
  origen   text not null,                          -- historial | nombre | nueva
  creado   timestamptz not null default now()
);
comment on table futbol.fs_ligas is 'Nombre de liga de Flashscore → futbol.ligas.id (DECISIONES 42). Ids negativos = ligas que solo existen en Flashscore.';
alter table futbol.fs_ligas enable row level security;

alter table futbol.fs_partidos add column if not exists liga_id integer;
alter table futbol.agenda add column if not exists fs_id text;
alter table futbol.agenda add column if not exists cuota_pre_consultada boolean not null default false;
alter table futbol.agenda add column if not exists casas integer;
create index if not exists agenda_cuotas_pend on futbol.agenda (kickoff) where not cuota_pre_consultada and fs_id is not null;

-- Semilla: cada nombre de liga de Flashscore ya visto, con la liga de API-Football más frecuente.
insert into futbol.fs_ligas (clave, liga_id, origen)
select clave, liga_id, 'historial' from (
  select lower(split_part(f.liga, ': ', 1)) || '|' || lower(regexp_replace(substr(f.liga, strpos(f.liga, ': ') + 2), ' - .*$', '')) as clave,
         coalesce(p.liga_id, a.liga_id) as liga_id, count(*) as n,
         row_number() over (partition by lower(split_part(f.liga, ': ', 1)) || '|' || lower(regexp_replace(substr(f.liga, strpos(f.liga, ': ') + 2), ' - .*$', ''))
                            order by count(*) desc) as rk
  from futbol.fs_partidos f
  left join futbol.partidos p on p.fixture_id = f.fixture_id
  left join futbol.agenda a on a.fixture_id = f.fixture_id
  where f.fixture_id is not null and f.liga like '%: %' and coalesce(p.liga_id, a.liga_id) is not null
  group by 1, 2
) t where rk = 1
on conflict (clave) do nothing;

update futbol.fs_partidos f set liga_id = p.liga_id
from futbol.partidos p where p.fixture_id = f.fixture_id and f.liga_id is null;

insert into futbol.config (clave, valor, descripcion) values
  ('api_football_activa', 'false', 'false = 100 % Flashscore: el escáner no llama a API-Football (agenda, favoritos, cuota en vivo y cierre salen de Flashscore). true = vuelve a usarla como respaldo (DECISIONES 42).'),
  ('fs_agenda_cuotas_por_ciclo', '12', 'Cuotas prepartido (consulta oce de Flashscore) que pide cada ciclo para la agenda de hoy y mañana.'),
  ('fs_agenda_horas', '36', 'Hasta cuántas horas adelante se piden cuotas prepartido de la agenda.'),
  ('fs_agenda_refresco_h', '6', 'Cada cuántas horas se vuelve a leer la lista de mañana de Flashscore.'),
  ('agenda_fs_ts', '"2000-01-01T00:00:00Z"', 'Marca: última lectura de la lista de mañana (la escribe el escáner).')
on conflict (clave) do nothing;

-- Vista para la PWA: favoritos de hoy y mañana (hora Colombia), solo ligas habilitadas.
create or replace view futbol.v_agenda_favoritos as
select a.fixture_id, a.fs_id, a.kickoff, (a.kickoff at time zone 'America/Bogota')::date as dia_co,
       a.local, a.visitante, l.id as liga_id, l.nombre as liga, l.pais,
       a.cuota_pre_local, a.cuota_pre_empate, a.cuota_pre_visitante, a.casas, a.cuota_pre_consultada,
       case when a.cuota_pre_local is null or a.cuota_pre_visitante is null then null
            when a.cuota_pre_local <= a.cuota_pre_visitante then 'home' else 'away' end as favorito,
       least(a.cuota_pre_local, a.cuota_pre_visitante) as cuota_fav
from futbol.agenda a
join futbol.ligas l on l.id = a.liga_id
where coalesce(l.habilitada, true) and a.fs_id is not null
  and a.kickoff > now() - interval '3 hours';
