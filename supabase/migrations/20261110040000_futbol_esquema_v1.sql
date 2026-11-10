-- =====================================================================
-- Alertas de Gol en Vivo · Migración 1 · esquema `futbol`
-- Proyecto: central-ingenieria (zdhkhsrwvvripuczhvam)
-- Toda la app vive en este esquema; no toca ningún otro.
-- =====================================================================

create schema if not exists futbol;
comment on schema futbol is 'Alertas de Gol en Vivo: radar de partidos, snapshots, alertas y rendimiento';

-- ---------------------------------------------------------------------
-- Catálogos
-- ---------------------------------------------------------------------
create table futbol.ligas (
  id          int primary key,                 -- league.id de API-Football
  nombre      text not null,
  pais        text,
  habilitada  boolean not null default true,   -- false = se ignora como candidata
  notas       text,
  creado      timestamptz not null default now()
);

create table futbol.partidos (
  fixture_id            int primary key,      -- fixture.id de API-Football
  liga_id               int references futbol.ligas(id),
  temporada             int,
  local                 text not null,
  visitante             text not null,
  kickoff               timestamptz,
  favorito              text check (favorito in ('home','away')),
  cuota_pre_local       numeric(6,2),
  cuota_pre_empate      numeric(6,2),
  cuota_pre_visitante   numeric(6,2),
  cuota_pre_consultada  boolean not null default false,  -- caché: no volver a gastar la consulta
  estado                text,                  -- status.short (1H, HT, 2H, FT…)
  minuto                int,
  goles_local           int,
  goles_visitante       int,
  goles_local_90        int,                   -- marcador al final del tiempo reglamentario
  goles_visitante_90    int,
  seguimiento           boolean not null default false,  -- candidato vivo: se le toman snapshots
  creado                timestamptz not null default now(),
  actualizado           timestamptz not null default now()
);
create index partidos_seguimiento_idx on futbol.partidos (seguimiento) where seguimiento;
create index partidos_estado_idx on futbol.partidos (estado, actualizado desc);
create index partidos_liga_idx on futbol.partidos (liga_id);

-- ---------------------------------------------------------------------
-- Serie de tiempo por candidato (dataset del futuro modelo de IA)
-- ---------------------------------------------------------------------
create table futbol.snapshots (
  id               bigserial primary key,
  fixture_id       int not null references futbol.partidos(fixture_id) on delete cascade,
  ts               timestamptz not null default now(),
  minuto           int,
  goles_local      int,
  goles_visitante  int,
  stats_local      jsonb,           -- estadísticas normalizadas (claves en español)
  stats_visitante  jsonb,
  ip_local         numeric(8,2),    -- índice de presión acumulado
  ip_visitante     numeric(8,2),
  dominancia       numeric(8,3),    -- P_fav / max(P_rival,1)
  momentum         numeric(8,3),    -- misma razón pero con el delta entre snapshots
  linea_over       numeric(4,1),    -- goles actuales + 0.5
  cuota_over       numeric(6,2),
  regla_version    text,
  evaluacion       jsonb,           -- qué condiciones se cumplieron y cuáles no
  raw              jsonb            -- respuestas crudas de la API (stats + odds)
);
create index snapshots_fixture_ts_idx on futbol.snapshots (fixture_id, ts desc);

-- ---------------------------------------------------------------------
-- Alertas
-- ---------------------------------------------------------------------
create table futbol.alertas (
  id             bigserial primary key,
  fixture_id     int not null references futbol.partidos(fixture_id) on delete cascade,
  snapshot_id    bigint references futbol.snapshots(id),
  ts             timestamptz not null default now(),
  minuto         int,
  marcador       text,             -- '0-1' local-visitante al momento de la alerta
  goles_al_alertar int,            -- total de goles al alertar (base para resolver)
  linea_over     numeric(4,1),
  cuota          numeric(6,2),
  dominancia     numeric(8,3),
  momentum       numeric(8,3),
  regla_version  text not null,
  resultado      text not null default 'pendiente'
                 check (resultado in ('pendiente','acierto','fallo','anulada')),
  minuto_gol     int,              -- primer gol después de la alerta
  lado_gol       text check (lado_gol in ('favorito','rival')),
  push_enviados  int not null default 0,
  cerrada_ts     timestamptz,
  unique (fixture_id, regla_version)   -- máximo una alerta por partido y versión
);
create index alertas_resultado_idx on futbol.alertas (resultado);
create index alertas_ts_idx on futbol.alertas (ts desc);

-- ---------------------------------------------------------------------
-- Configuración, versiones de la regla y contabilidad de la API
-- ---------------------------------------------------------------------
create table futbol.config (
  clave        text primary key,
  valor        jsonb not null,
  descripcion  text,
  es_regla     boolean not null default false,  -- true = cambiarlo crea una nueva regla_version
  actualizado  timestamptz not null default now()
);

create table futbol.reglas (
  version     text primary key,     -- v1, v2…
  parametros  jsonb not null,       -- foto congelada de los parámetros es_regla
  creada      timestamptz not null default now(),
  notas       text
);

create table futbol.api_uso (
  fecha      date not null,         -- día UTC (API-Football reinicia la cuota a las 00:00 UTC)
  endpoint   text not null,
  llamadas   int  not null default 0,
  restantes  int,                   -- último x-ratelimit-requests-remaining visto
  primary key (fecha, endpoint)
);

create table futbol.escaneos (
  id             bigserial primary key,
  ts             timestamptz not null default now(),
  motivo         text,              -- 'ok', 'fuera_de_horario', 'intervalo', 'presupuesto'…
  partidos_vivos int,
  candidatos     int,
  llamadas       int,
  alertas        int,
  resueltas      int,
  duracion_ms    int,
  detalle        jsonb
);
create index escaneos_ts_idx on futbol.escaneos (ts desc);

create table futbol.push_suscripciones (
  id        bigserial primary key,
  endpoint  text not null unique,
  p256dh    text not null,
  auth      text not null,
  activa    boolean not null default true,
  fallos    int not null default 0,
  creado    timestamptz not null default now()
);

-- Credencial del modo administrador de la PWA (hash bcrypt, nunca el PIN plano)
create table futbol.admin (
  id        int primary key default 1 check (id = 1),
  pin_hash  text not null,
  actualizado timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Vista de rendimiento: lo que decide si la estrategia gana dinero
--   acierto real vs probabilidad implícita (1/cuota) y ROI con stake 1
-- ---------------------------------------------------------------------
create view futbol.v_rendimiento with (security_invoker = true) as
with base as (
  select a.*,
         p.liga_id,
         l.nombre as liga,
         case when a.minuto < 60 then '46-59'
              when a.minuto < 70 then '60-69'
              when a.minuto < 80 then '70-79'
              else '80+' end as franja_minuto
  from futbol.alertas a
  join futbol.partidos p using (fixture_id)
  left join futbol.ligas l on l.id = p.liga_id
  where a.resultado in ('acierto','fallo')
)
select regla_version,
       coalesce(liga, '(todas)')          as liga,
       coalesce(franja_minuto, '(todas)') as franja_minuto,
       count(*)                                             as alertas,
       count(*) filter (where resultado = 'acierto')        as aciertos,
       round(avg((resultado = 'acierto')::int) * 100, 1)    as acierto_pct,
       round(avg(cuota), 2)                                 as cuota_media,
       round(avg(1 / cuota) * 100, 1)                       as prob_implicita_pct,
       round(sum(case when resultado = 'acierto' then cuota - 1 else -1 end), 2) as ganancia_u,
       round(sum(case when resultado = 'acierto' then cuota - 1 else -1 end) / count(*) * 100, 1) as roi_pct
from base
group by grouping sets ((regla_version), (regla_version, liga), (regla_version, franja_minuto));

-- ---------------------------------------------------------------------
-- RLS: lectura pública de lo que muestra la PWA; escritura solo service_role
-- (las Edge Functions se conectan como postgres/service_role y no pasan por RLS)
-- ---------------------------------------------------------------------
alter table futbol.ligas              enable row level security;
alter table futbol.partidos           enable row level security;
alter table futbol.snapshots          enable row level security;
alter table futbol.alertas            enable row level security;
alter table futbol.config             enable row level security;
alter table futbol.reglas             enable row level security;
alter table futbol.api_uso            enable row level security;
alter table futbol.escaneos           enable row level security;
alter table futbol.push_suscripciones enable row level security;
alter table futbol.admin              enable row level security;

grant usage on schema futbol to anon, authenticated, service_role;
grant select on futbol.ligas, futbol.partidos, futbol.snapshots, futbol.alertas,
                futbol.v_rendimiento to anon, authenticated;
grant insert on futbol.push_suscripciones to anon, authenticated;
grant usage on sequence futbol.push_suscripciones_id_seq to anon, authenticated;
grant all on all tables in schema futbol to service_role;
grant all on all sequences in schema futbol to service_role;

create policy lectura_publica on futbol.ligas     for select to anon, authenticated using (true);
create policy lectura_publica on futbol.partidos  for select to anon, authenticated using (true);
create policy lectura_publica on futbol.snapshots for select to anon, authenticated using (true);
create policy lectura_publica on futbol.alertas   for select to anon, authenticated using (true);
create policy solo_insertar   on futbol.push_suscripciones for insert to anon, authenticated with check (true);
-- config, reglas, api_uso, escaneos y admin: sin políticas = sin acceso anon.

-- ---------------------------------------------------------------------
-- Valores v1 (sección 4 de la especificación)
-- ---------------------------------------------------------------------
insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('regla_version',        '"v1"',  'Versión vigente del algoritmo', false),
  ('minuto_min',           '46',    'Minuto mínimo del 2T para ser candidato', true),
  ('minuto_max',           '85',    'Minuto máximo para ser candidato', true),
  ('cuota_fav_max',        '2.00',  'Cuota prepartido máxima para considerar favorito', true),
  ('diferencia_min',       '1',     'Goles mínimos por los que debe ir perdiendo el favorito', true),
  ('dominancia_min',       '1.30',  'IP_fav / IP_rival mínimo (acumulado y momentum)', true),
  ('cuota_objetivo',       '1.40',  'Cuota mínima del Over (goles+0.5) para alertar', true),
  ('momentum_ventana_min', '15',    'Ventana objetivo (min) para el delta del momentum', true),
  ('momentum_gap_min',     '8',     'Separación mínima (min) entre snapshots para calcular momentum', true),
  ('pesos_ip',             '{"tiros_al_arco":3,"tiros_dentro_area":2,"tiros_totales":1,"corners":1.5,"xg":5,"posesion":0.05}',
                                    'Pesos del Índice de Presión', true),
  ('escaneo_activo',       'true',  'Interruptor general del escáner', false),
  ('presupuesto_diario',   '100',   'Consultas/día del plan (Free=100, Pro=7500)', false),
  ('reserva_api',          '6',     'Consultas que nunca se gastan (margen de seguridad)', false),
  ('intervalo_radar_min',  '15',    'Minutos entre radares sin candidatos en seguimiento', false),
  ('intervalo_seguimiento_min', '10', 'Minutos entre radares cuando hay candidatos en seguimiento', false),
  ('horas_activas_utc',    '[12,13,14,15,16,17,18,19,20,21,22,23,0,1,2]',
                                    'Horas UTC en que corre el radar (fuera de ellas solo si hay seguimiento)', false),
  ('fraccion_radar',       '0.5',   'Fracción del presupuesto restante reservada a radares (el resto, a stats/cuotas)', false),
  ('max_detalle_escaneo',  '4',     'Máximo de partidos a los que se piden stats+cuotas por escaneo', false),
  ('stake',                '1',     'Stake fijo para el ROI simulado', false);

insert into futbol.reglas (version, parametros, notas)
select 'v1', jsonb_object_agg(clave, valor), 'Algoritmo inicial de la especificación 1.0'
from futbol.config where es_regla;
