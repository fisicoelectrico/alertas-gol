-- =====================================================================
-- Umbral por liga en el laboratorio de gol temprano (DECISIONES 43). Pedido de Fredy, 18 nov ("Dale").
--
-- futbol.ligas_ref guarda el promedio de goles de temporada de cada liga según una fuente externa
-- (SoccerStats, tabla "Leagues overview" del 18 nov 2026, temporadas completas: cientos de partidos).
-- Con ese promedio λ el escáner estima, por Poisson, la probabilidad de que lleguen los goles que faltan
-- en los minutos que quedan:
--     μ = λ · (lab_liga_min_fin − minuto) / lab_liga_min_fin        (goles esperados en lo que falta)
--     Más de 1,5 con 1 gol:  P = 1 − e^(−μ)           Más de 2,5 con 1 gol:  P = 1 − e^(−μ)(1 + μ)
--     umbral_liga = 1 / P
-- y exige la cuota MAYOR entre el umbral de la base (Wilson) y el de la liga. Así una liga de pocos
-- goles (Argentina Primera Nacional, 1,95) no entra con el umbral pensado para una liga promedio.
-- Validación: con solo λ, Poisson predijo el % de Más de 1,5 de las 157 ligas del PDF con sesgo 0 y
-- error medio de 2,4 puntos.
-- Solo aditiva: tabla nueva, columnas nuevas, claves de config nuevas.
-- =====================================================================
create table if not exists futbol.ligas_ref (
  liga_id        int primary key references futbol.ligas(id),
  fuente         text not null default 'soccerstats',
  nombre_fuente  text,                -- nombre de la liga en la fuente
  fecha          date not null default '2026-11-18',
  gp             int,                 -- partidos jugados en la temporada
  goles_prom     numeric(4,2) not null,
  hg             numeric(4,2),        -- goles por partido del local
  ag             numeric(4,2),        -- goles por partido del visitante
  home_pct       int, draw_pct int, away_pct int,
  o15_pct        int, o25_pct int, o35_pct int, btts_pct int
);
alter table futbol.ligas_ref enable row level security;
revoke all on futbol.ligas_ref from anon, authenticated;

insert into futbol.ligas_ref (liga_id, nombre_fuente, gp, goles_prom, hg, ag, home_pct, draw_pct, away_pct, o15_pct, o25_pct, o35_pct, btts_pct) values
  (129, 'Argentina - Primera National', 648, 1.95, 1.19, 0.76, 47, 32, 22, 59, 33, 13, 40),
  (71, 'Brazil - Serie A', 341, 2.66, 1.53, 1.13, 48, 27, 25, 78, 51, 26, 58),
  (72, 'Brazil - Serie B', 380, 2.35, 1.33, 1.01, 45, 26, 29, 69, 44, 18, 47),
  (173, 'Bulgaria - Vtora Liga', 142, 2.80, 1.61, 1.19, 48, 26, 26, 75, 50, 31, 51),
  (266, 'Chile - Liga de Ascenso', 240, 2.65, 1.54, 1.11, 43, 30, 27, 75, 48, 28, 55),
  (170, 'China - League One', 240, 2.69, 1.44, 1.25, 42, 28, 30, 74, 51, 28, 55),
  (346, 'Czechia - FNL', 112, 3.00, 1.58, 1.42, 38, 31, 31, 80, 62, 42, 65),
  (327, 'Georgia - Erovnuli Liga', 161, 2.66, 1.42, 1.24, 42, 28, 30, 73, 53, 27, 56),
  (339, 'Guatemala - Liga Nacional', 118, 2.64, 1.69, 0.95, 60, 21, 19, 78, 50, 28, 52),
  (99, 'Japan - J2 League', 170, 2.60, 1.42, 1.18, 44, 23, 33, 74, 49, 25, 52),
  (365, 'Latvia - Virsliga', 179, 2.92, 1.64, 1.28, 42, 23, 35, 77, 55, 33, 54),
  (362, 'Lithuania - A Lyga', 144, 2.65, 1.46, 1.19, 41, 28, 31, 75, 53, 28, 52),
  (263, 'Mexico - Liga de Expansion MX', 118, 3.19, 1.90, 1.30, 49, 21, 30, 83, 63, 43, 58),
  (262, 'Mexico - Liga MX', 144, 3.01, 1.56, 1.44, 37, 26, 37, 80, 53, 34, 60),
  (355, 'Montenegro - First League', 74, 2.23, 1.27, 0.96, 38, 32, 30, 59, 39, 22, 38),
  (89, 'Netherlands - Eerste Divisie', 147, 3.56, 1.95, 1.61, 48, 20, 32, 88, 67, 44, 70),
  (408, 'Northern Ireland - NIFL Premiership', 93, 2.78, 1.42, 1.37, 45, 17, 38, 80, 55, 27, 53),
  (104, 'Norway - 1st Division', 240, 3.79, 2.15, 1.63, 51, 17, 32, 89, 72, 51, 65),
  (95, 'Portugal - Liga Portugal 2', 95, 2.48, 1.29, 1.19, 42, 25, 33, 73, 48, 23, 51),
  (180, 'Scotland - Championship', 73, 2.30, 1.32, 0.99, 45, 22, 33, 73, 34, 18, 40),
  (141, 'Spain - LaLiga2', 151, 2.72, 1.56, 1.16, 46, 23, 32, 76, 50, 31, 53),
  (333, 'Ukraine - Premier League', 89, 2.37, 1.36, 1.01, 42, 29, 29, 74, 48, 20, 43),
  (255, 'USA - USL Championship', 375, 2.72, 1.50, 1.22, 44, 28, 28, 71, 50, 31, 54),
  (268, 'Uruguay - Liga AUF Uruguaya', 288, 2.37, 1.30, 1.07, 41, 26, 33, 68, 44, 21, 51),
  (299, 'Venezuela - Liga FUTVE', 227, 2.56, 1.37, 1.18, 39, 29, 31, 72, 45, 26, 54),
  (281, 'Peru - Liga 1', 302, 2.82, 1.72, 1.10, 51, 25, 24, 75, 55, 34, 59)

on conflict (liga_id) do update set nombre_fuente = excluded.nombre_fuente, gp = excluded.gp, goles_prom = excluded.goles_prom,
  hg = excluded.hg, ag = excluded.ag, home_pct = excluded.home_pct, draw_pct = excluded.draw_pct, away_pct = excluded.away_pct,
  o15_pct = excluded.o15_pct, o25_pct = excluded.o25_pct, o35_pct = excluded.o35_pct, btts_pct = excluded.btts_pct,
  fecha = excluded.fecha;

-- Qué umbral se usó en cada caso, para comparar después si el piso por liga ayudó
alter table futbol.lab_oportunidades
  add column if not exists liga_id      int,
  add column if not exists lambda_liga  numeric(4,2),   -- goles por partido de la liga (ligas_ref)
  add column if not exists umbral_base  numeric(6,3),   -- umbral de la base (Wilson) al alertar
  add column if not exists umbral_liga  numeric(6,3);   -- piso por liga al alertar (null = liga sin referencia)

insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('lab_umbral_liga', 'true', 'Laboratorio: exigir también el umbral por liga (Poisson con el promedio de goles de futbol.ligas_ref)', false),
  ('lab_liga_min_fin', '95', 'Laboratorio: minuto final supuesto (90 + añadido) para repartir el promedio de goles de la liga', false)
on conflict (clave) do nothing;
