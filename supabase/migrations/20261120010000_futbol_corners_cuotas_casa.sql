-- =====================================================================
-- Cuotas de córners de BetPlay y Rushbet leídas desde el PC de Fredy (DECISIONES 53, 19-20 nov). Solo aditiva.
-- El feed público de Kambi (la plataforma de BetPlay y Rushbet) responde 429 "No access" a los servidores
-- (Supabase), pero sí se ve desde una IP colombiana normal. Fredy autorizó leerlo (19 nov, 7:04 p. m.) y eligió
-- un script en su PC (herramientas/kambi_pc) que sube las cuotas por POST /admin/corners-casa (con su PIN).
-- Una fila por casa, partido y lectura. Las líneas del 1T se guardan en columnas para analizar sin abrir el JSON.
-- =====================================================================
create table if not exists futbol.corners_cuotas_casa (
  id                   bigint generated always as identity primary key,
  ts                   timestamptz not null default now(),
  casa                 text not null check (casa in ('betplay', 'rushbet')),
  evento_id            text not null,          -- id del partido en Kambi
  fs_id                text,                   -- partido de Flashscore (emparejado en el servidor), null si no se encontró
  liga                 text,
  local                text,
  visitante            text,
  inicio               timestamptz,
  periodo              text,                   -- lo que dice Kambi: 1st half, 2nd half…
  minuto               int,
  goles_local          int,
  goles_visitante      int,
  corners_local        int,                    -- córners del partido en ese momento (Flashscore), si se leyeron
  corners_visitante    int,
  corners_1t_local     int,
  corners_1t_visitante int,
  t1_o05               numeric(6,3),           -- más de 0,5 / 1,5 / 2,5 / 3,5 córners en el 1T (cuota decimal)
  t1_o15               numeric(6,3),
  t1_o25               numeric(6,3),
  t1_o35               numeric(6,3),
  mercados             jsonb not null          -- todos los mercados de córners: [{nombre, lineas: [{lado, linea, cuota}]}]
);
create index if not exists corners_cuotas_casa_fs on futbol.corners_cuotas_casa (fs_id, ts desc);
create index if not exists corners_cuotas_casa_ts on futbol.corners_cuotas_casa (ts);
alter table futbol.corners_cuotas_casa enable row level security;
