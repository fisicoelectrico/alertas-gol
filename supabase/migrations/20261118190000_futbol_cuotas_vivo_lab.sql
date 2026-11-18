-- =====================================================================
-- Cuotas en vivo de Flashscore + laboratorio de goles con umbral automático (DECISIONES 40).
-- Aditiva: solo crea tablas, funciones y claves nuevas; abre la regla v8 porque la alerta del radar
-- pasa a leer la cuota del Over en vivo desde Flashscore (API-Football queda de respaldo).
--
--   cuotas_vivo        cada foto de cuotas en vivo, una fila por casa y línea (Over/Under del partido)
--   lab_oportunidades  cada partido que entró a una estrategia de laboratorio (gol temprano → Over 1,5…)
--   lab_umbrales       el umbral de entrada de cada estrategia, un registro por día (para graficar cómo se mueve)
--   lab_base()         cuenta, desde la base, cuántas veces se dio cada estrategia en las ligas habilitadas
--   lab_calcular()     guarda en lab_umbrales: p, límite bajo de Wilson al 95 % y umbral = 1 / límite bajo
-- =====================================================================

create table if not exists futbol.cuotas_vivo (
  id              bigserial primary key,
  fixture_id      int not null,
  fs_id           text not null,
  ts              timestamptz not null default now(),
  minuto          int,
  estado          text,
  goles_local     int,
  goles_visitante int,
  motivo          text,                -- gol, descanso, lab, candidato, inicio, ciclo
  casa_id         int not null,
  casa            text,
  linea           numeric(4,2),        -- null = esa casa no tenía oferta en vivo en ese momento
  cuota_over      numeric(7,3),
  cuota_under     numeric(7,3),
  activa          boolean
);
create index if not exists cuotas_vivo_fixture_ts on futbol.cuotas_vivo (fixture_id, ts desc);
create index if not exists cuotas_vivo_ts on futbol.cuotas_vivo (ts);
alter table futbol.cuotas_vivo enable row level security;

create table if not exists futbol.lab_oportunidades (
  id              bigserial primary key,
  estrategia      text not null,       -- gt_o15, gt_o25
  fixture_id      int not null,
  fs_id           text,
  liga            text,
  local           text,
  visitante       text,
  ts_inicio       timestamptz not null default now(),
  minuto_gatillo  int,                 -- minuto del gol que la abrió
  goles_gatillo   int not null,        -- goles totales al abrirse (si cambian, deja de vigilar)
  linea           numeric(4,2) not null,
  vence_minuto    int not null,        -- hasta qué minuto se vigila la cuota
  vigilando       boolean not null default true,
  n_hist          int,                 -- foto de la estadística con la que se juzgó
  p_hist          numeric(5,4),
  umbral          numeric(6,3),
  mejor_cuota     numeric(7,3),        -- la mejor cuota vista mientras se vigiló
  mejor_casa      text,
  minuto_mejor    int,
  serie           jsonb not null default '[]',  -- [{m, c, casa}] mejor cuota en cada foto
  alertada        boolean not null default false,
  ts_alerta       timestamptz,
  minuto_alerta   int,
  cuota_alerta    numeric(7,3),
  casa_alerta     text,
  push_enviados   int not null default 0,
  resultado       text not null default 'pendiente' check (resultado in ('pendiente', 'acierto', 'fallo', 'anulada')),
  goles_final     int,
  cerrada_ts      timestamptz,
  unique (fixture_id, estrategia)
);
create index if not exists lab_oport_vig on futbol.lab_oportunidades (vigilando) where vigilando;
create index if not exists lab_oport_pend on futbol.lab_oportunidades (resultado) where resultado = 'pendiente';
alter table futbol.lab_oportunidades enable row level security;

create table if not exists futbol.lab_umbrales (
  fecha        date not null,
  estrategia   text not null,
  n            int not null,
  aciertos     int not null,
  p            numeric(5,4),
  ic_bajo      numeric(5,4),
  cuota_justa  numeric(6,3),
  umbral       numeric(6,3),
  actualizado  timestamptz not null default now(),
  primary key (fecha, estrategia)
);
alter table futbol.lab_umbrales enable row level security;

-- Base histórica de cada estrategia, solo ligas habilitadas y partidos terminados.
-- Gol temprano: el PRIMER cambio de marcador debe estar bien seguido (1T, ciclo normal, ≤5 min de hueco,
-- de 0-0 a 1 gol) para confiar en su minuto. El total final sale de partidos (cierre de Flashscore/API).
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
    select c0.fixture_id, min(c0.minuto) filter (where c0.rn = 1) as m1,
           bool_and(c0.rn > 1 or (c0.estado = '1H' and c0.fuente = 'ciclo' and c0.gl_antes + c0.gv_antes = 0
                                   and c0.gl + c0.gv = 1 and c0.minuto - coalesce(c0.minuto_antes, 0) <= 5)) as primero_bien
    from c0 group by 1
  ),
  gt as (select p.total from p join c using (fixture_id), cfg where c.primero_bien and c.m1 <= cfg.m)
  select 'gt_o15', count(*)::int, count(*) filter (where total >= 2)::int from gt
  union all
  select 'gt_o25', count(*)::int, count(*) filter (where total >= 3)::int from gt
  union all
  select a.mercado, count(*)::int, count(*) filter (where a.resultado = 'acierto')::int
  from futbol.alertas_corners a where a.resultado in ('acierto', 'fallo') group by a.mercado
$$;

-- Recalcula y guarda el umbral de hoy (Colombia). Wilson 95 %: con pocos casos el límite bajo es prudente,
-- y a medida que llegan partidos se acerca a la tasa real. Umbral = 1 / límite bajo.
create or replace function futbol.lab_calcular()
returns setof futbol.lab_umbrales
language sql volatile set search_path = futbol, public as $$
  insert into futbol.lab_umbrales (fecha, estrategia, n, aciertos, p, ic_bajo, cuota_justa, umbral, actualizado)
  select (now() at time zone 'America/Bogota')::date, b.estrategia, b.n, b.aciertos,
         round(b.aciertos::numeric / nullif(b.n, 0), 4),
         round(w.lo::numeric, 4),
         round(b.n::numeric / nullif(b.aciertos, 0), 3),
         round((1 / nullif(w.lo, 0))::numeric, 3),
         now()
  from futbol.lab_base() b
  cross join lateral (
    select case when b.n = 0 then null else
      ((b.aciertos::float8 / b.n) + 3.8416 / (2 * b.n)
        - 1.96 * sqrt((b.aciertos::float8 / b.n) * (1 - b.aciertos::float8 / b.n) / b.n + 3.8416 / (4.0 * b.n * b.n)))
      / (1 + 3.8416 / b.n) end as lo
  ) w
  on conflict (fecha, estrategia) do update set n = excluded.n, aciertos = excluded.aciertos, p = excluded.p,
    ic_bajo = excluded.ic_bajo, cuota_justa = excluded.cuota_justa, umbral = excluded.umbral, actualizado = now()
  returning *
$$;

revoke all on function futbol.lab_base() from public, anon, authenticated;
revoke all on function futbol.lab_calcular() from public, anon, authenticated;

insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('fs_vivo_activo',            'true',            'Cuotas en vivo de Flashscore: encendido (gratis, no gasta API-Football)', false),
  ('fs_vivo_casas',             '[523,1097,1197]', 'Cuotas en vivo: casas a consultar (523 Wplay, 1097 Betano, 1197 Stake, 598 Bwin, 843 Luckia)', false),
  ('fs_vivo_max_consultas',     '24',              'Cuotas en vivo: máximo de consultas a Flashscore por ciclo (poka-yoke contra bloqueos)', false),
  ('fs_vivo_intervalo_min',     '10',              'Cuotas en vivo: cada cuántos minutos se fotografía un partido sin nada especial', false),
  ('fs_vivo_intervalo_cand_min','2',               'Cuotas en vivo: cada cuántos minutos se fotografía un candidato del radar', false),
  ('fs_fallos_aviso',           '3',               'Ciclos seguidos con falla de Flashscore antes de avisar al administrador', false),
  ('lab_activo',                'true',            'Laboratorio de goles: encendido', false),
  ('lab_push',                  'true',            'Laboratorio de goles: avisar al celular del administrador cuando la cuota supera el umbral', false),
  ('lab_push_estrategias',      '["gt_o15"]',      'Laboratorio: qué estrategias avisan (las demás solo se registran)', false),
  ('lab_gt_minuto',             '15',              'Gol temprano: el primer gol debe caer hasta este minuto', false),
  ('lab_gt_ventana_min',        '15',              'Gol temprano: minutos después del gol durante los que se vigila la cuota', false),
  ('lab_intervalo_min',         '2',               'Laboratorio: cada cuántos minutos se fotografía la cuota de un partido vigilado', false),
  ('lab_n_min',                 '30',              'Laboratorio: casos mínimos en la base para que una estrategia pueda avisar', false),
  ('cuota_vivo_fuente',         '"flashscore"',    'De dónde sale la cuota del Over en vivo de la alerta: flashscore (gratis) o api', true)
on conflict (clave) do nothing;

-- Regla v8: misma regla v7 con la cuota en vivo desde Flashscore
insert into futbol.reglas (version, parametros, notas)
select 'v8', jsonb_object_agg(clave, valor), 'cuota_vivo_fuente = flashscore (cuota del Over en vivo gratis; API-Football de respaldo)'
from futbol.config where es_regla
on conflict do nothing;
update futbol.config set valor = '"v8"', actualizado = now() where clave = 'regla_version';

select futbol.lab_calcular();
