-- =====================================================================
-- Cuotas de BetPlay y Rushbet leídas por el ESCÁNER (DECISIONES 54, Fredy 20 nov). Solo aditiva.
-- La sonda del 20 nov mostró que el servidor de Kambi para América (us.offering-api.kambicdn.com) sí le
-- responde a Supabase; el 429 de la primera prueba era del servidor de Europa. Así el script del PC ya no
-- hace falta y API-Football deja de gastarse en córners (corners_api_fotos = false).
--   cuotas_casa        una fila por casa, partido y lectura: minuto, marcador, córners (los da Kambi) y las
--                      escaleras de Over de goles y córners (partido y 1T) como {"1.5": 1.42, "2.5": 2.1}
--   alertas            + cuota_casas / motivo_sin_push: lo que ofrecían BetPlay y Rushbet al alertar
--   lab_oportunidades  + cuota_casas / motivo_sin_push: lo mismo para el gol temprano
-- Regla de Fredy: si BetPlay y Rushbet no ofrecen el mercado, NO hay push (la alerta igual se guarda).
-- La regla de disparo no cambia (sigue la cuota de Flashscore), por eso no hay versión nueva.
-- =====================================================================
create table if not exists futbol.cuotas_casa (
  id                bigint generated always as identity primary key,
  ts                timestamptz not null default now(),
  casa              text not null check (casa in ('betplay', 'rushbet')),
  evento_id         bigint not null,       -- id del partido en Kambi
  fs_id             text,                  -- partido de Flashscore (emparejado por nombres y hora)
  fixture_id        int,                   -- futbol.partidos (negativo = nacido en Flashscore)
  liga              text,
  local             text,
  visitante         text,
  periodo           text,                  -- 1st half, 2nd half… (Kambi)
  minuto            int,
  goles_local       int,
  goles_visitante   int,
  corners_local     int,                   -- córners del partido en ese momento (estadística de Kambi)
  corners_visitante int,
  goles             jsonb,                 -- "Total Goals": {"2.5": 1.85, …} solo el Over, líneas abiertas
  goles_1t          jsonb,                 -- "Total Goals - 1st Half"
  corners           jsonb,                 -- "Total Corners"
  corners_1t        jsonb,                 -- "Total Corners - 1st Half"
  mercados          jsonb not null         -- todos los mercados de goles y córners: [{nombre, lineas: [{lado, linea, cuota}]}]
);
create index if not exists cuotas_casa_fs on futbol.cuotas_casa (fs_id, ts desc);
create index if not exists cuotas_casa_fx on futbol.cuotas_casa (fixture_id, ts desc);
create index if not exists cuotas_casa_ts on futbol.cuotas_casa (ts);
alter table futbol.cuotas_casa enable row level security;

alter table futbol.alertas
  add column if not exists cuota_casas jsonb,        -- {"BetPlay": 1.85, "Rushbet": 1.85}; {} = no ofrecían la línea
  add column if not exists motivo_sin_push text;
alter table futbol.lab_oportunidades
  add column if not exists cuota_casas jsonb,
  add column if not exists motivo_sin_push text;
alter table futbol.alertas_corners
  add column if not exists cuota_casas jsonb;

insert into futbol.config (clave, valor, descripcion) values
  ('kambi_activo', 'true', 'Leer cuotas de BetPlay y Rushbet (Kambi) desde el escáner'),
  ('kambi_casas', '{"betplay": "betplay", "rushbet": "rsico"}', 'Casas de Kambi a leer: nombre → código'),
  ('kambi_servidor', '"us.offering-api.kambicdn.com"', 'Servidor de Kambi (el de Europa responde 429)'),
  ('kambi_intervalo_min', '3', 'Minutos mínimos entre dos lecturas de cuotas del mismo partido y casa'),
  ('kambi_max_eventos', '15', 'Máximo de partidos con cuotas completas por casa en cada ciclo'),
  ('kambi_vigencia_min', '5', 'Una lectura de BetPlay/Rushbet sirve para una push hasta estos minutos'),
  ('kambi_exigir', 'true', 'Sin el mercado en BetPlay ni Rushbet no hay push (goles, gol temprano y córners)'),
  ('kambi_caido_avisa', 'true', 'Si Kambi no responde en ese ciclo, las push de goles salen igual (con aviso)')
on conflict (clave) do nothing;
