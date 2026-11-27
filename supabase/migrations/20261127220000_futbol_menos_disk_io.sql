-- =====================================================================
-- DECISIONES 79 (27 nov 2026, correo de Supabase "running out of Disk IO budget"): menos lectura y
-- escritura a disco sin cambiar qué se lee de BetPlay/Rushbet ni cada cuánto.
--
--   1. Respuestas de Kambi en net._http_response: pg_net las guarda 6 h (pg_net.ttl, solo lo cambia un
--      superusuario). El escáner solo usa las de los últimos 10 min (kambi_eventos) y 3 min (kambi_listas).
--      Eran ~10.000 filas, 433 MB de JSON sin comprimir (76 MB en disco) que autovacuum recorría ~35 veces
--      al día. kambi_encolar ahora borra las respuestas de SUS pedidos con más de kambi_respuestas_min
--      (15 min). Las respuestas de otros pedidos de pg_net (otros esquemas) no se tocan.
--   2. Índices que faltaban (cada consulta recorría la tabla entera):
--      · cuotas_casa (casa, evento_id, ts): la comprobación de "cuota vieja" del escáner (DECISIONES 76)
--        hacía un seq scan de cuotas_casa por cada respuesta: ~16.000 recorridos, 1.250 millones de filas.
--      · kambi_pedidos (casa, evento_id, ts): el "no pedir de nuevo" de kambi_encolar y el update de
--        procesado: ~95.000 recorridos, 1.650 millones de filas.
--   3. cron.job_run_details: una fila por corrida (kambi cada 30 s + escáner cada minuto ≈ 4.300 al día).
--      La limpieza diaria ahora también borra las de los jobs futbol-* con más de 3 días.
--
-- Solo aditiva: dos índices, una fila de config, la función reemplazada (misma lógica + el borrado) y el
-- comando del job de limpieza. Volver atrás el punto 1:
--   update futbol.config set valor = '0' where clave = 'kambi_respuestas_min';   -- 0 = no borrar
-- =====================================================================

create index if not exists cuotas_casa_casa_evento_ts on futbol.cuotas_casa (casa, evento_id, ts);
create index if not exists kambi_pedidos_casa_evento_ts on futbol.kambi_pedidos (casa, evento_id, ts);

insert into futbol.config (clave, valor, descripcion)
values ('kambi_respuestas_min', '15',
        'Minutos que se guardan las respuestas crudas de BetPlay/Rushbet en net._http_response (0 = no borrar; pg_net igual las borra a las 6 h)')
on conflict (clave) do nothing;

create or replace function futbol.kambi_encolar()
returns integer
language plpgsql security definer
set search_path to 'public', 'net'
as $function$
declare
  cfg_activo boolean; casas jsonb; servidor text; params text := 'lang=en_GB&market=CO&client_id=2&channel_id=1';
  hdr jsonb := '{"User-Agent":"Mozilla/5.0 (compatible; ADN-Soccer/1.0)","Accept":"application/json"}'::jsonb;
  c record; q record; rid bigint; n int := 0; intervalo int; urgente_seg int; guardar_min int;
begin
  -- DECISIONES 79: borrar respuestas crudas viejas de nuestros pedidos (va antes de los return tempranos,
  -- así también limpia de noche). Solo ids que están en kambi_pedidos.
  select coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'kambi_respuestas_min'), 15) into guardar_min;
  if guardar_min > 0 then
    delete from net._http_response r
     where r.created < now() - make_interval(mins => greatest(guardar_min, 11))
       and r.id in (select p.id from futbol.kambi_pedidos p where p.ts < now() - make_interval(mins => greatest(guardar_min, 11)));
  end if;

  select coalesce((select valor from futbol.config where clave = 'kambi_activo')::text <> 'false', true) into cfg_activo;
  if not cfg_activo then return 0; end if;
  if not exists (select 1 from futbol.escaneos where ts > now() - interval '10 minutes' and motivo not in ('previa')) then return 0; end if;
  select coalesce((select valor from futbol.config where clave = 'kambi_casas'), '{"betplay":"betplay","rushbet":"rsico"}'::jsonb) into casas;
  select coalesce((select valor #>> '{}' from futbol.config where clave = 'kambi_servidor'), 'us.offering-api.kambicdn.com') into servidor;
  select coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'kambi_intervalo_min'), 2) into intervalo;
  select coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'kambi_urgente_seg'), 30) into urgente_seg;
  if servidor !~ '^[a-z0-9.-]+\.kambicdn\.com$' then raise exception 'servidor no permitido: %', servidor; end if;
  for c in select key as casa, value #>> '{}' as codigo from jsonb_each(casas) where key in ('betplay', 'rushbet') loop
    -- Lista en vivo: 1 por minuto y casa (el cron corre cada 30 s)
    if not exists (select 1 from futbol.kambi_pedidos p where p.casa = c.casa and p.tipo = 'lista' and p.ts > now() - interval '50 seconds') then
      rid := net.http_get(format('https://%s/offering/v2018/%s/listView/football/all/all/all/in-play.json?%s&useCombined=true', servidor, c.codigo, params),
                          headers => hdr, timeout_milliseconds => 10000);
      insert into futbol.kambi_pedidos (id, casa, tipo) values (rid, c.casa, 'lista');
      n := n + 1;
    end if;
    -- Cuotas de cada partido: urgentes cada kambi_urgente_seg, el resto cada kambi_intervalo_min
    for q in select * from futbol.kambi_quiero k where k.casa = c.casa and k.hasta > now()
               and not exists (select 1 from futbol.kambi_pedidos p where p.casa = k.casa and p.evento_id = k.evento_id
                               and p.ts > now() - make_interval(secs => case when k.urgente then greatest(urgente_seg, 20) - 5
                                                                             else greatest(intervalo, 1) * 60 - 20 end)) loop
      rid := net.http_get(format('https://%s/offering/v2018/%s/betoffer/event/%s.json?%s&includeParticipants=true', servidor, c.codigo, q.evento_id, params),
                          headers => hdr, timeout_milliseconds => 10000);
      insert into futbol.kambi_pedidos (id, casa, tipo, evento_id, fs_id, fixture_id) values (rid, c.casa, 'evento', q.evento_id, q.fs_id, q.fixture_id);
      n := n + 1;
    end loop;
  end loop;
  delete from futbol.kambi_quiero where hasta < now() - interval '1 hour';
  delete from futbol.kambi_pedidos where ts < now() - interval '1 day';
  return n;
end $function$;
revoke all on function futbol.kambi_encolar() from public, anon, authenticated;

-- Limpieza diaria: escaneos de más de 30 días (como antes) + historial de cron de los jobs futbol-* de más de 3 días
select cron.alter_job((select jobid from cron.job where jobname = 'futbol-limpieza'),
  command := $cmd$delete from futbol.escaneos where ts < now() - interval '30 days';
delete from cron.job_run_details where end_time < now() - interval '3 days' and jobid in (select jobid from cron.job where jobname like 'futbol-%');$cmd$);
