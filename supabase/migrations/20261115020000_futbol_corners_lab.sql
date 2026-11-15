-- =====================================================================
-- Mercado experimental de córners, solo para administradores (DECISIONES 37). Aditiva: no toca nada existente.
--   alertas_corners   cada aviso (con su versión c1, c2…, la cuota si la hubo y el desenlace)
--   corners_chequeos  cada partido revisado, avise o no (tasa base: ¿cuántos llegan al 20' sin córners?)
--   config corners_*  parámetros propios; NO son es_regla: cambiarlos no abre una versión del radar de goles,
--                     abre una versión de córners (la api sube corners_version).
-- =====================================================================

create table if not exists futbol.alertas_corners (
  id                bigserial primary key,
  mercado           text not null check (mercado in ('c1t_cero20', 'c2t_fav77')),
  version           text not null,                 -- c1, c2…
  parametros        jsonb,                         -- foto de los parámetros al avisar
  fs_id             text not null,                 -- id de Flashscore
  fixture_id        int,                           -- pareja en API-Football (null = sin pareja, sin cuota)
  liga              text,
  local             text,
  visitante         text,
  favorito          text check (favorito in ('home', 'away')),
  ts                timestamptz not null default now(),
  minuto            int,
  goles_local       int,
  goles_visitante   int,
  corners_local     int,                           -- al avisar (1T: del 1T; 2T: del partido)
  corners_visitante int,
  linea             numeric(4,1) not null,          -- córners al avisar + objetivo − 0,5
  objetivo          int not null default 2,
  api_consultada    boolean not null default false, -- gastó 1 consulta de /odds/live
  hay_mercado       boolean,                        -- null = no se pudo consultar
  cuota             numeric(6,3),
  mercado_nombre    text,
  motivo_sin_cuota  text,                           -- sin_pareja_api, tope_diario, sin_mercado, sin_esa_linea…
  mercados_vistos   jsonb,                          -- todos los mercados de córners de la respuesta
  stats             jsonb,                          -- estadísticas de Flashscore al avisar
  push_enviados     int not null default 0,
  resultado         text not null default 'pendiente' check (resultado in ('pendiente', 'acierto', 'fallo', 'anulada')),
  corners_final     int,
  minuto_cierre     int,
  cerrada_ts        timestamptz,
  nota              text,
  unique (fs_id, mercado)
);
create index if not exists alertas_corners_pend on futbol.alertas_corners (resultado) where resultado = 'pendiente';

create table if not exists futbol.corners_chequeos (
  fs_id             text not null,
  mercado           text not null,
  ts                timestamptz not null default now(),
  minuto            int,
  liga              text,
  local             text,
  visitante         text,
  goles_local       int,
  goles_visitante   int,
  corners_local     int,
  corners_visitante int,
  alerto            boolean not null default false,
  motivo            text,                            -- con_corners, sin_stats, sin_fila_corners (null si avisó)
  primary key (fs_id, mercado)
);

alter table futbol.alertas_corners  enable row level security;
alter table futbol.corners_chequeos enable row level security;

insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('corners_activo',          'true',  'Córners (lab): encendido. Solo avisa a administradores', false),
  ('corners_version',         '"c1"',  'Córners (lab): versión vigente (la sube la api al cambiar un parámetro de córners)', false),
  ('corners_1t_min_desde',    '20',    'Córners 1T: desde qué minuto se revisa si va 0 córners', false),
  ('corners_1t_min_hasta',    '26',    'Córners 1T: hasta qué minuto (ventana para que ningún ciclo la salte)', false),
  ('corners_2t_min_desde',    '77',    'Córners 2T: desde qué minuto se revisa si el favorito pierde', false),
  ('corners_2t_min_hasta',    '80',    'Córners 2T: hasta qué minuto', false),
  ('corners_objetivo',        '2',     'Córners (lab): cuántos córners más se buscan (línea = actuales + objetivo − 0,5)', false),
  ('corners_api_max_dia',     '8',     'Córners (lab): máximo de consultas /odds/live por día para leer la cuota', false),
  ('corners_stats_por_ciclo', '25',    'Córners (lab): máximo de estadísticas de Flashscore por ciclo', false)
on conflict (clave) do nothing;
