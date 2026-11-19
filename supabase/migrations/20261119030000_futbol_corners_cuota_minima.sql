-- =====================================================================
-- Córners: cuota mínima en la notificación de 0 córners (DECISIONES 47). Pedido de Fredy, 19 nov.
-- Mismo criterio que el laboratorio de goles: la cuota mínima sale de la base y se recalcula cada hora.
-- Va CONDICIONADA a la situación del aviso (0 córners al 15'-35'), no a todos los partidos:
--   c1t_cero20      más de 1,5 en el 1T (avisos resueltos)           → hoy ≈ 27/38, justa 1,41
--   c1t_cero20_o25  más de 2,5 en el 1T (avisos × corners_partido)   → hoy ≈ 6/13,  justa 2,17
-- Las tasas sin condición (1,14 y 1,33) NO sirven aquí: casi todos esos partidos ya llevaban córners.
-- config.corners_cuota_min_tipo: 'justa' (1 / acierto) o 'prudente' (1 / límite bajo de Wilson, como goles).
-- =====================================================================
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
           -- el minuto del 2.º gol solo vale si se vio en un ciclo normal (no anotado al cerrar, en el ~90')
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
  select a.mercado, count(*)::int, count(*) filter (where a.resultado = 'acierto')::int
  from futbol.alertas_corners a where a.resultado in ('acierto', 'fallo') group by a.mercado
  union all
  -- Córners 1T con 0 córners al aviso → ¿llegó a 3 o más en el 1T? (más de 2,5). Los avisos se cierran al
  -- llegar a 2, así que el total del 1T sale de corners_partido (Flashscore, gratis). Solo ligas habilitadas.
  select 'c1t_cero20_o25', count(*)::int,
         count(*) filter (where cp.t1_local + cp.t1_visitante >= 3)::int
  from futbol.corners_chequeos ch
  join futbol.corners_partido cp on cp.fs_id = ch.fs_id and cp.estado = 'ok' and cp.t1_local is not null
  join futbol.ligas l on l.id = cp.liga_id and l.habilitada
  where ch.mercado = 'c1t_cero20' and ch.alerto and ch.corners_local + ch.corners_visitante = 0
$$;
revoke all on function futbol.lab_base() from public, anon, authenticated;

insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('corners_cuota_min_tipo', '"justa"', 'Córners 1T con 0 córners: cuota mínima que muestra la push. justa = 1/acierto; prudente = 1/límite bajo de Wilson (como goles)', false)
on conflict (clave) do nothing;

select futbol.lab_calcular();
