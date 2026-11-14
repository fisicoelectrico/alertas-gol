-- Ahorro de consultas (13 nov 2026). Ver DECISIONES 27.
-- Todo es aditivo: una tabla nueva, columnas nuevas, una vista y claves de config. No borra nada.

-- 1) Cobertura por liga según la propia API (/leagues?current=true, 1 consulta por semana).
--    null = no se sabe todavía (se trata como "sí": nunca se descarta por falta de dato).
alter table futbol.ligas add column if not exists cob_odds boolean;
alter table futbol.ligas add column if not exists cob_stats boolean;
alter table futbol.ligas add column if not exists cob_actualizada timestamptz;

-- 2) Agenda del día (/fixtures?date=YYYY-MM-DD, 1 consulta por día UTC).
--    Sirve para dos cosas: saber CUÁNDO hay partidos en la zona útil (descanso → minuto 77)
--    y traer las cuotas prepartido EN BLOQUE por liga (/odds?league&season&date, 10 partidos por consulta).
create table if not exists futbol.agenda (
  fixture_id           int primary key,
  fecha                date not null,           -- día UTC de la consulta que lo trajo
  liga_id              int not null,
  temporada            int,
  local                text,
  visitante            text,
  kickoff              timestamptz not null,
  estado               text,
  cuota_pre_local      numeric(6,2),
  cuota_pre_empate     numeric(6,2),
  cuota_pre_visitante  numeric(6,2),
  cuota_pre_ts         timestamptz,             -- cuándo llegó la cuota en bloque (null = no vino)
  creado               timestamptz not null default now()
);
create index if not exists agenda_kickoff_idx on futbol.agenda (kickoff);
create index if not exists agenda_liga_fecha_idx on futbol.agenda (liga_id, fecha);
alter table futbol.agenda enable row level security;

-- Ligas a las que ya se les pidió el bloque de cuotas hoy (para no repetir ni reintentar en bucle)
create table if not exists futbol.cuotas_bloque (
  fecha     date not null,
  liga_id   int not null,
  temporada int,
  paginas   int not null default 0,
  partidos  int not null default 0,             -- cuántos partidos trajo con cuota
  error     text,
  ts        timestamptz not null default now(),
  primary key (fecha, liga_id)
);
alter table futbol.cuotas_bloque enable row level security;

-- 3) Cobertura aprendida de nuestra propia historia (cero consultas): una liga donde ya se pidió
--    la cuota 2+ veces y nunca vino, o donde 2+ partidos salieron sin estadísticas y ninguno con
--    ellas, se trata como "sin cobertura" aunque la API diga otra cosa.
create or replace view futbol.v_cobertura_liga as
select p.liga_id,
       count(*) filter (where p.cuota_pre_consultada)               as consultadas,
       count(*) filter (where p.favorito is not null)                as con_cuota,
       count(*) filter (where p.sin_stats >= 2)                      as sin_stats,
       count(*) filter (where exists (select 1 from futbol.snapshots s
                                      where s.fixture_id = p.fixture_id and s.stats_local is not null)) as con_stats,
       (count(*) filter (where p.cuota_pre_consultada) >= 2 and count(*) filter (where p.favorito is not null) = 0) as sin_cuota_aprendida,
       (count(*) filter (where p.sin_stats >= 2) >= 2 and count(*) filter (where exists (select 1 from futbol.snapshots s
                                      where s.fixture_id = p.fixture_id and s.stats_local is not null)) = 0) as sin_stats_aprendida
from futbol.partidos p
group by p.liga_id;

-- 4) Configuración (no son de regla: no cambian qué alerta, solo en qué se gasta)
insert into futbol.config (clave, valor, descripcion) values
 ('usar_agenda', 'true'::jsonb, 'Radar solo cuando hay partidos de ligas útiles entre el descanso y el minuto 77 (agenda diaria, 1 consulta)'),
 ('cuotas_bloque_min_partidos', '3'::jsonb, 'Una liga con al menos N partidos hoy recibe sus cuotas prepartido en bloque (1 consulta por cada 10)'),
 ('cuotas_bloque_max_dia', '20'::jsonb, 'Tope de consultas diarias para cuotas en bloque'),
 ('agenda_fecha', '"2000-01-01"'::jsonb, 'Día UTC de la última agenda cargada (la escribe el escáner)'),
 ('cobertura_ts', '"2000-01-01T00:00:00Z"'::jsonb, 'Última lectura de cobertura de ligas (la escribe el escáner)')
on conflict (clave) do nothing;
