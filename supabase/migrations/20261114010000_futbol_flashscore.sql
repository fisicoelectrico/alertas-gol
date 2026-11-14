-- Modo Flashscore (14 nov 2026, regla v4 al activarlo). Ver DECISIONES 28. Solo aditivo.
create table if not exists futbol.fs_partidos (
  fs_id        text primary key,          -- id de Flashscore (AA)
  fixture_id   int,                       -- fixture de API-Football emparejado (null = sin pareja)
  puntaje      numeric(4,2),              -- parecido de nombres del emparejamiento (0-1)
  liga         text,
  local        text,
  visitante    text,
  inicio       timestamptz,
  id_local     text,                      -- participante Flashscore (para leer cuotas)
  id_visitante text,
  cuotas       jsonb,                     -- apertura/actual 1X2 y Over/Under de casas colombianas
  creado       timestamptz not null default now()
);
create index if not exists fs_partidos_fixture_idx on futbol.fs_partidos (fixture_id);
alter table futbol.fs_partidos enable row level security;

insert into futbol.config (clave, valor, descripcion, es_regla) values
 ('fuente_datos', '"api"'::jsonb, 'De dónde salen lista, favorito y estadísticas: api (API-Football) o flashscore', true)
on conflict (clave) do nothing;
insert into futbol.config (clave, valor, descripcion) values
 ('intervalo_fs_min', '5'::jsonb, 'Minutos entre ciclos en modo Flashscore'),
 ('fs_cuotas_por_ciclo', '8'::jsonb, 'Máximo de lecturas de cuotas de Flashscore por ciclo')
on conflict (clave) do nothing;
