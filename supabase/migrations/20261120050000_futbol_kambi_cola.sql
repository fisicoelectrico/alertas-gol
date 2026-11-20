-- =====================================================================
-- Kambi por una cola de la base cada minuto (DECISIONES 56, 20 nov). Solo aditiva.
-- El escáner lo dispara pg_net (cron futbol-escaner). pg_net atiende los pedidos por tandas y no empieza
-- la siguiente hasta terminar la anterior: un GET a Kambi encolado DENTRO del escáner esperaba a que el
-- escáner terminara (tiempo agotado). Ahora un cron propio encola los pedidos y el escáner lee lo que llegó.
--   kambi_quiero    partidos que el escáner quiere con cuotas (candidatos, gol temprano, franjas de córners), con vencimiento
--   kambi_pedidos   cada GET encolado: id de pg_net, casa, lista o evento (para encontrar su respuesta)
--   kambi_encolar() cada minuto: lista en vivo de cada casa + cuotas de los partidos de kambi_quiero vigentes.
--                   Solo corre si el escáner hizo un ciclo en los últimos 10 min (horario del radar).
-- =====================================================================
create table if not exists futbol.kambi_quiero (
  casa       text not null,
  evento_id  bigint not null,
  fs_id      text,
  fixture_id int,
  hasta      timestamptz not null,
  primary key (casa, evento_id)
);
alter table futbol.kambi_quiero enable row level security;

create table if not exists futbol.kambi_pedidos (
  id         bigint primary key,           -- id de net.http_get
  ts         timestamptz not null default now(),
  casa       text not null,
  tipo       text not null check (tipo in ('lista', 'evento')),
  evento_id  bigint,
  fs_id      text,
  fixture_id int,
  procesado  boolean not null default false
);
create index if not exists kambi_pedidos_ts on futbol.kambi_pedidos (tipo, ts desc);
alter table futbol.kambi_pedidos enable row level security;

create or replace function futbol.kambi_encolar()
returns int language plpgsql security definer set search_path = public, net as $$
declare
  cfg_activo boolean; casas jsonb; servidor text; params text := 'lang=en_GB&market=CO&client_id=2&channel_id=1';
  hdr jsonb := '{"User-Agent":"Mozilla/5.0 (compatible; ADN-Soccer/1.0)","Accept":"application/json"}'::jsonb;
  c record; q record; rid bigint; n int := 0; intervalo int;
begin
  select coalesce((select valor from futbol.config where clave = 'kambi_activo')::text <> 'false', true) into cfg_activo;
  if not cfg_activo then return 0; end if;
  if not exists (select 1 from futbol.escaneos where ts > now() - interval '10 minutes' and motivo not in ('previa')) then return 0; end if;
  select coalesce((select valor from futbol.config where clave = 'kambi_casas'), '{"betplay":"betplay","rushbet":"rsico"}'::jsonb) into casas;
  select coalesce((select valor #>> '{}' from futbol.config where clave = 'kambi_servidor'), 'us.offering-api.kambicdn.com') into servidor;
  select coalesce((select (valor #>> '{}')::int from futbol.config where clave = 'kambi_intervalo_min'), 2) into intervalo;
  if servidor !~ '^[a-z0-9.-]+\.kambicdn\.com$' then raise exception 'servidor no permitido: %', servidor; end if;
  for c in select key as casa, value #>> '{}' as codigo from jsonb_each(casas) where key in ('betplay', 'rushbet') loop
    rid := net.http_get(format('https://%s/offering/v2018/%s/listView/football/all/all/all/in-play.json?%s&useCombined=true', servidor, c.codigo, params),
                        headers => hdr, timeout_milliseconds => 10000);
    insert into futbol.kambi_pedidos (id, casa, tipo) values (rid, c.casa, 'lista');
    n := n + 1;
    -- Cuotas de cada partido cada kambi_intervalo_min (la lista sí va cada minuto: es 1 pedido por casa)
    for q in select * from futbol.kambi_quiero k where k.casa = c.casa and k.hasta > now()
               and not exists (select 1 from futbol.kambi_pedidos p where p.casa = k.casa and p.evento_id = k.evento_id
                               and p.ts > now() - make_interval(secs => greatest(intervalo, 1) * 60 - 20)) loop
      rid := net.http_get(format('https://%s/offering/v2018/%s/betoffer/event/%s.json?%s&includeParticipants=true', servidor, c.codigo, q.evento_id, params),
                          headers => hdr, timeout_milliseconds => 10000);
      insert into futbol.kambi_pedidos (id, casa, tipo, evento_id, fs_id, fixture_id) values (rid, c.casa, 'evento', q.evento_id, q.fs_id, q.fixture_id);
      n := n + 1;
    end loop;
  end loop;
  delete from futbol.kambi_quiero where hasta < now() - interval '1 hour';
  delete from futbol.kambi_pedidos where ts < now() - interval '1 day';
  return n;
end $$;
revoke all on function futbol.kambi_encolar() from public, anon, authenticated;

-- Respuestas de los pedidos (para el escáner)
create or replace function futbol.kambi_listas(max_min int)
returns table (casa text, ts timestamptz, status_code int, content text)
language sql security definer set search_path = public, net as $$
  select distinct on (p.casa) p.casa, p.ts, r.status_code, r.content
  from futbol.kambi_pedidos p join net._http_response r on r.id = p.id
  where p.tipo = 'lista' and p.ts > now() - make_interval(mins => max_min)
  order by p.casa, p.ts desc
$$;
create or replace function futbol.kambi_eventos()
returns table (id bigint, ts timestamptz, casa text, evento_id bigint, fs_id text, fixture_id int, status_code int, content text)
language sql security definer set search_path = public, net as $$
  -- La respuesta más nueva de cada casa y partido que todavía no se procesó (las más viejas se descartan)
  select distinct on (p.casa, p.evento_id) p.id, p.ts, p.casa, p.evento_id, p.fs_id, p.fixture_id, r.status_code, r.content
  from futbol.kambi_pedidos p join net._http_response r on r.id = p.id
  where p.tipo = 'evento' and not p.procesado and p.ts > now() - interval '10 minutes'
  order by p.casa, p.evento_id, p.ts desc
$$;
revoke all on function futbol.kambi_listas(int) from public, anon, authenticated;
revoke all on function futbol.kambi_eventos() from public, anon, authenticated;

update futbol.config set valor = '2', descripcion = 'Minutos entre dos pedidos de cuotas del mismo partido y casa (cron futbol-kambi)'
  where clave = 'kambi_intervalo_min';
update futbol.config set valor = '"cola"' where clave = 'kambi_via';
select cron.schedule('futbol-kambi', '* * * * *', 'select futbol.kambi_encolar()');
