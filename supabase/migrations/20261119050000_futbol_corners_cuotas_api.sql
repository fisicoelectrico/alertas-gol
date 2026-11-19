-- =====================================================================
-- Fotos de cuotas de córners desde API-Football (DECISIONES 51, Fredy 19 nov). Solo aditiva.
-- Sonda del 19 nov 18:34Z: UNA consulta /odds/live sin parámetros trae TODOS los partidos en vivo con
-- cuotas (12 de 17 en vivo; 10 con córners; los 5 del 1T con córners del 1T). Cada foto cuesta 1 consulta.
--   corners_cuotas_api   una fila por partido y foto: minuto, marcador, córners (Flashscore) y cuotas de córners
--   api_fs_pareja        fixture de API-Football → partido de Flashscore (para saber de qué partido es cada cuota)
--   alertas_corners      + linea_ofrecida / cuota_ofrecida / foto_id: lo que la casa ofrecía al avisar
-- Regla nueva de Fredy: sin cuota de córners NO hay push (el aviso igual se guarda) y los análisis solo
-- cuentan los avisos que tuvieron cuota (hay_mercado = true).
-- =====================================================================
create table if not exists futbol.corners_cuotas_api (
  id                   bigint generated always as identity primary key,
  ts                   timestamptz not null default now(),   -- hora de la foto (todas las filas de una foto la comparten)
  fixture_api          int not null,
  fs_id                text,
  liga                 text,
  local                text,
  visitante            text,
  periodo              text,          -- First Half, Halftime, Second Half… (lo que dice la API)
  minuto               int,
  goles_local          int,
  goles_visitante      int,
  corners_local        int,           -- córners del partido en la foto (Flashscore); null si no se leyó
  corners_visitante    int,
  corners_1t_local     int,
  corners_1t_visitante int,
  t1_linea             numeric(4,1),  -- "Corners Asian Handicap (1st Half)": línea principal del 1T
  t1_over              numeric(6,3),
  t1_under             numeric(6,3),
  t1_3w_linea          numeric(4,1),  -- "Total Corners (3 way) (1st Half)": "Over 2" = 3 o más
  t1_3w_over           numeric(6,3),
  t1_3w_exacto         numeric(6,3),
  t1_3w_under          numeric(6,3),
  tot_linea            numeric(4,1),  -- "Total Corners": línea principal del partido
  tot_over             numeric(6,3),
  tot_under            numeric(6,3),
  mercados             jsonb not null -- todos los mercados de córners, compactos {"Total Corners": {"Over 9.5": 1.9, …}}
);
create index if not exists corners_cuotas_api_fs on futbol.corners_cuotas_api (fs_id, ts desc);
create index if not exists corners_cuotas_api_ts on futbol.corners_cuotas_api (ts);
alter table futbol.corners_cuotas_api enable row level security;

create table if not exists futbol.api_fs_pareja (
  fixture_api int primary key,
  fs_id       text,                   -- null = se intentó y no se encontró pareja
  puntaje     numeric(4,2),
  liga        text,
  local       text,
  visitante   text,
  inicio      timestamptz,
  creado      timestamptz not null default now()
);
create index if not exists api_fs_pareja_fs on futbol.api_fs_pareja (fs_id);
alter table futbol.api_fs_pareja enable row level security;

alter table futbol.alertas_corners
  add column if not exists linea_ofrecida numeric(4,1),
  add column if not exists cuota_ofrecida numeric(6,3),
  add column if not exists foto_id bigint;

insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('corners_api_fotos', 'true', 'Córners: foto de /odds/live (todos los partidos, 1 consulta) repartida en el horario', false),
  ('corners_api_fotos_max_dia', '85', 'Córners: tope de consultas de API al día para fotos y emparejamiento', false),
  ('corners_api_fotos_min_intervalo', '5', 'Córners: minutos mínimos entre fotos (el reparto puede alargarlo)', false),
  ('corners_api_fotos_vigencia_min', '4', 'Córners: una foto más vieja que esto no sirve para el aviso (se toma otra)', false),
  ('corners_api_stats_max', '20', 'Córners: máximo de partidos por foto a los que se les lee el conteo de córners en Flashscore', false)
on conflict (clave) do nothing;

-- Análisis de córners solo con avisos que tuvieron cuota (hay_mercado = true). Los viejos no cuentan.
create or replace function futbol.lab_base()
returns table (estrategia text, n int, aciertos int)
language sql stable set search_path = futbol, public as $$
  with cfg as (select coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'lab_gt_minuto'), 15) as m),
  p as (
    select p.fixture_id, p.goles_local + p.goles_visitante as total
    from futbol.partidos p join futbol.ligas l on l.id = p.liga_id and l.habilitada
    where p.estado = 'FT'
  ),
  c0 as (select c.*, row_number() over (partition by c.fixture_id order by c.ts, c.id) as rn from futbol.cambios_marcador c),
  c as (
    select c0.fixture_id, min(c0.minuto) filter (where c0.rn = 1) as m1, min(c0.minuto) filter (where c0.rn = 2) as m2,
           bool_and(c0.rn > 1 or (c0.estado = '1H' and c0.fuente = 'ciclo' and c0.gl_antes + c0.gv_antes = 0
                                   and c0.gl + c0.gv = 1 and c0.minuto - coalesce(c0.minuto_antes, 0) <= 5)) as primero_bien,
           bool_and(c0.rn <> 2 or (c0.estado in ('1H', 'HT', '2H') and c0.fuente = 'ciclo'
                                    and c0.minuto - coalesce(c0.minuto_antes, 0) <= 5)) as segundo_bien
    from c0 group by 1
  ),
  gt as (select p.total, c.m2, (c.segundo_bien and (c.m2 is not null or p.total < 2)) as m2_ok
          from p join c using (fixture_id), cfg where c.primero_bien and c.m1 <= cfg.m)
  select 'gt_o15', count(*)::int, count(*) filter (where total >= 2)::int from gt
  union all
  select 'gt_o25', count(*)::int, count(*) filter (where total >= 3)::int from gt
  union all
  select 'gt_o15_m' || t.m, count(gt.total)::int, count(*) filter (where gt.total >= 2)::int
  from (values (30), (45), (60), (75)) t(m) left join gt on gt.m2_ok and (gt.m2 is null or gt.m2 > t.m)
  group by t.m
  union all
  -- Córners: solo avisos con cuota (Fredy, 19 nov: "para los análisis solo cuentan los que tienen cuota")
  -- (siempre una fila por mercado, aunque sea n = 0, para que la cuota mínima vieja no quede pegada)
  select m.mercado, count(a.id)::int, count(a.id) filter (where a.resultado = 'acierto')::int
  from (values ('c1t_cero20'), ('c1t_uno'), ('c2t_fav77')) m(mercado)
  left join futbol.alertas_corners a on a.mercado = m.mercado and a.resultado in ('acierto', 'fallo') and a.hay_mercado is true
  group by m.mercado
  union all
  select 'c1t_cero20_o25', count(*)::int,
         count(*) filter (where cp.t1_local + cp.t1_visitante >= 3)::int
  from futbol.corners_chequeos ch
  join futbol.alertas_corners a on a.fs_id = ch.fs_id and a.mercado = 'c1t_cero20' and a.hay_mercado is true
  join futbol.corners_partido cp on cp.fs_id = ch.fs_id and cp.estado = 'ok' and cp.t1_local is not null
  join futbol.ligas l on l.id = cp.liga_id and l.habilitada
  where ch.mercado = 'c1t_cero20' and ch.alerto and ch.corners_local + ch.corners_visitante = 0
$$;
revoke all on function futbol.lab_base() from public, anon, authenticated;

select futbol.lab_calcular();
