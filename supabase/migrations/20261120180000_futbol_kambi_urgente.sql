-- =====================================================================
-- DECISIONES 62 (20 nov 2026, Dinamo Tbilisi 0-1 Torpedo Kutaisi): menos espera entre la cuota de
-- BetPlay/Rushbet y la alerta.
--   · kambi_quiero.urgente: partidos donde la cuota de goles decide una push (candidatos, alertas abiertas,
--     gol temprano vigilado). A esos se les piden las cuotas cada kambi_urgente_seg (30 s); al resto
--     (franjas de córners, favorito perdiendo antes de la ventana) cada kambi_intervalo_min (2) como antes.
--   · El cron futbol-kambi pasa de cada minuto a cada 30 s. La lista en vivo sigue siendo 1 por minuto.
-- Solo aditiva: una columna con valor por defecto, la función reemplazada y el horario del cron.
-- Volver atrás: select cron.alter_job((select jobid from cron.job where jobname = 'futbol-kambi'), schedule := '* * * * *');
-- =====================================================================
alter table futbol.kambi_quiero add column if not exists urgente boolean not null default false;

insert into futbol.config (clave, valor, descripcion)
values ('kambi_urgente_seg', '30', 'Segundos entre pedidos de cuotas de un partido urgente (candidato, alerta abierta, gol temprano)')
on conflict (clave) do nothing;

create or replace function futbol.kambi_encolar()
returns integer
language plpgsql security definer
set search_path to 'public', 'net'
as $function$
declare
  cfg_activo boolean; casas jsonb; servidor text; params text := 'lang=en_GB&market=CO&client_id=2&channel_id=1';
  hdr jsonb := '{"User-Agent":"Mozilla/5.0 (compatible; ADN-Soccer/1.0)","Accept":"application/json"}'::jsonb;
  c record; q record; rid bigint; n int := 0; intervalo int; urgente_seg int;
begin
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

select cron.alter_job((select jobid from cron.job where jobname = 'futbol-kambi'), schedule := '30 seconds');
