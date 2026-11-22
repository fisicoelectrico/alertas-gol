-- Respaldo por partes (DECISIONES 77): el día completo del sábado pasaba el tope de CPU de la Edge Function.
-- Solo aditiva: futbol.respaldos estaba vacía; se le agrega la parte y el rango de id.
alter table futbol.respaldos add column if not exists parte int not null default 1, add column if not exists min_id bigint not null default 0;
alter table futbol.respaldos drop constraint respaldos_pkey, add primary key (dia, tabla, parte);
insert into futbol.config (clave, valor, descripcion) values
  ('respaldo_filas_por_parte', '3000', 'Filas de cuotas_casa por archivo de respaldo (parte-NNN.jsonl.gz)'),
  ('respaldo_partes_por_llamada', '2', 'Partes que exporta cada llamada de la función respaldo (tope de CPU)')
on conflict (clave) do nothing;
update futbol.config set descripcion = 'Ya no se usa (respaldo por partes)' where clave = 'respaldo_dias_por_corrida';
-- Cada 5 min de 4:00 a 6:55 a. m. Colombia (fuera del horario del radar); reemplaza el horario anterior
select cron.schedule('futbol-respaldo', '*/5 9-11 * * *', $$
  select net.http_get(url := 'https://zdhkhsrwvvripuczhvam.supabase.co/functions/v1/respaldo',
    headers := jsonb_build_object('x-token', (select valor #>> '{}' from futbol.config where clave = 'token_forzar')),
    timeout_milliseconds := 140000)
$$);
