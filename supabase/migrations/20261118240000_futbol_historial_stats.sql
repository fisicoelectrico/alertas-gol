-- DECISIONES 44 (18 nov 2026, a pedido de Fredy): fotos de estadísticas desde que el favorito recibe el gol,
-- aunque sea en el 1T. Solo sirven de historial para el momentum al arrancar el 2T: no cuentan como
-- candidato (por eso van en tabla aparte y no en futbol.snapshots, que define la entrada de v_candidatos).
-- Solo aditiva.
create table if not exists futbol.historial_stats (
  id bigint generated always as identity primary key,
  fixture_id int not null,
  ts timestamptz not null default now(),
  estado text not null,
  minuto int not null,
  goles_local int not null,
  goles_visitante int not null,
  stats_local jsonb not null,
  stats_visitante jsonb not null,
  ip_local numeric,
  ip_visitante numeric
);
create index if not exists historial_stats_fixture_ts on futbol.historial_stats (fixture_id, ts);
alter table futbol.historial_stats enable row level security;

insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('historial_desde_gol', 'true', 'Fotos de estadísticas desde que el favorito va perdiendo (1T incluido), para tener momentum desde el 46''', true),
  ('historial_intervalo_min', '4', 'Minutos entre fotos de historial por partido (antes de ser candidato)', false),
  ('historial_max_ciclo', '6', 'Tope de fotos de historial por ciclo (pedidos a Flashscore)', false)
on conflict (clave) do nothing;
