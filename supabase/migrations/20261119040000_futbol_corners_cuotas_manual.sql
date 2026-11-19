-- =====================================================================
-- Cuotas de córners anotadas a mano por Fredy desde la app (DECISIONES 48, 19 nov).
-- Flashscore no trae mercado de córners y API-Football gasta cupo; Fredy ve la cuota en su casa de apuestas
-- y la anota en la tarjeta del aviso (la push abre #corners/<id>). Sirve para armar la curva cuota-minuto
-- y, más adelante, una cuota mínima por minuto como en gol temprano. Solo aditiva.
-- =====================================================================
create table if not exists futbol.corners_cuotas_manual (
  id         bigint generated always as identity primary key,
  alerta_id  bigint not null references futbol.alertas_corners (id) on delete cascade,
  ts         timestamptz not null default now(),
  minuto     int not null check (minuto between 0 and 130),
  corners    int check (corners between 0 and 40),          -- córners del partido (o del 1T) en ese momento
  linea      numeric(4,1) not null check (linea > 0 and linea < 40),
  cuota      numeric(6,2) not null check (cuota > 1 and cuota < 100),
  usuario_id bigint
);
create index if not exists corners_cuotas_manual_alerta on futbol.corners_cuotas_manual (alerta_id, minuto);
alter table futbol.corners_cuotas_manual enable row level security;

-- Las 3 cuotas de Corinthians–Botafogo que Fredy mandó por el chat (aviso 79): 25' 1,30 · 29' 1,66 · 32' 1,89
insert into futbol.corners_cuotas_manual (alerta_id, ts, minuto, corners, linea, cuota)
select 79, a.ts + make_interval(mins => v.m - a.minuto), v.m, 0, 1.5, v.c
from futbol.alertas_corners a, (values (25, 1.30), (29, 1.66), (32, 1.89)) v(m, c)
where a.id = 79 and a.local ilike '%corinthians%'
  and not exists (select 1 from futbol.corners_cuotas_manual where alerta_id = 79);
