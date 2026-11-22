-- =====================================================================
-- Respaldo del detalle de mercados de BetPlay/Rushbet en Storage (DECISIONES 77, Fredy 22 nov 2026).
-- Fredy aprobó crear el espacio privado de Storage (queda fuera del esquema futbol, es el único cambio fuera).
-- La Edge Function `respaldo` exporta cada día viejo a futbol-respaldo/cuotas_casa/AAAA/MM/AAAA-MM-DD.jsonl.gz,
-- verifica el conteo y solo entonces vacía cuotas_casa.mercados de esas filas.
-- =====================================================================
insert into storage.buckets (id, name, public) values ('futbol-respaldo', 'futbol-respaldo', false)
on conflict (id) do nothing;

create table if not exists futbol.respaldos (
  dia      date not null,
  tabla    text not null,
  ruta     text not null,
  filas    int not null,
  bytes    bigint not null,
  max_id   bigint not null,
  vaciadas int not null default 0,
  ts       timestamptz not null default now(),
  primary key (dia, tabla)
);
alter table futbol.respaldos enable row level security;

insert into futbol.config (clave, valor, descripcion) values
  ('respaldo_activo', 'true', 'Exportar cada día el detalle de mercados de BetPlay/Rushbet a Storage y vaciarlo de la base'),
  ('respaldo_dias_base', '3', 'Días completos (además de hoy) que el detalle de mercados se queda en la base antes de pasar a Storage'),
  ('respaldo_dias_por_corrida', '2', 'Máximo de días que exporta cada corrida de la función respaldo')
on conflict (clave) do nothing;

-- 4:20 a. m. Colombia (fuera del horario del radar)
select cron.schedule('futbol-respaldo', '20 9 * * *', $$
  select net.http_get(url := 'https://zdhkhsrwvvripuczhvam.supabase.co/functions/v1/respaldo',
    headers := jsonb_build_object('x-token', (select valor #>> '{}' from futbol.config where clave = 'token_forzar')),
    timeout_milliseconds := 140000)
$$);
