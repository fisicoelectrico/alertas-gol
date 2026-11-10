-- Agenda del escáner.
-- pg_cron dispara cada 5 min; la Edge Function decide sola si le toca (horario, intervalo
-- efectivo y presupuesto), así que la frecuencia real se controla desde futbol.config
-- sin volver a tocar el cron. Con el plan Pro basta bajar intervalo_radar_min.
select cron.schedule('futbol-escaner', '*/5 * * * *',
  $$select net.http_get(url := 'https://zdhkhsrwvvripuczhvam.supabase.co/functions/v1/escaner', timeout_milliseconds := 120000)$$);

-- Limpieza diaria de la bitácora de escaneos (los snapshots y alertas NO se borran nunca)
select cron.schedule('futbol-limpieza', '17 6 * * *',
  $$delete from futbol.escaneos where ts < now() - interval '30 days'$$);

-- Parámetros operativos añadidos tras la primera prueba.
-- token_forzar se genera aparte (no va en el repositorio):
--   insert into futbol.config (clave, valor, descripcion)
--   values ('token_forzar', to_jsonb(encode(extensions.gen_random_bytes(16), 'hex')), 'Token para ?forzar=1');
insert into futbol.config (clave, valor, descripcion) values
 ('cuotas_siempre', 'true', 'Modo calibración: pedir cuota en vivo en cada snapshot aunque la presión no cumpla (gasta 1 consulta más por snapshot)')
on conflict (clave) do nothing;
update futbol.config set valor = '3' where clave = 'max_detalle_escaneo';
