-- DECISIONES 45 (19 nov 2026, a pedido de Fredy): córners del 1T, del 2T y del total de CADA partido
-- terminado de ligas habilitadas, para estudiar córners con una base completa (no solo los partidos
-- que revisa el laboratorio). Gratis: feed de estadísticas de Flashscore (df_st), 1 pedido por partido.
-- Solo aditiva.
create table if not exists futbol.corners_partido (
  fixture_id int primary key,
  fs_id text,
  liga_id int,
  kickoff timestamptz,
  t1_local int, t1_visitante int,
  t2_local int, t2_visitante int,
  total_local int, total_visitante int,
  estado text not null default 'pendiente',   -- ok | sin_datos | pendiente
  intentos int not null default 0,
  ultimo_intento timestamptz,
  leido_ts timestamptz
);
create index if not exists corners_partido_liga on futbol.corners_partido (liga_id, kickoff);
alter table futbol.corners_partido enable row level security;

insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('corners_partido_activo', 'true', 'Guardar córners del 1T, 2T y total de cada partido terminado de ligas habilitadas (Flashscore, gratis)', false),
  ('corners_partido_max_ciclo', '12', 'Tope de partidos terminados a leer por ciclo (pedidos a Flashscore)', false),
  ('corners_partido_dias', '7', 'Hasta cuántos días atrás se buscan partidos terminados sin córners guardados', false)
on conflict (clave) do nothing;
