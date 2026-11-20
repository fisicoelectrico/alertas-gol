-- =====================================================================
-- Kambi desde la base (DECISIONES 55, Fredy 20 nov). Solo aditiva.
-- Kambi le responde 410 a las Edge Functions, pero el mismo pedido hecho con pg_net desde la base
-- responde 200. El escáner pide por aquí: kambi_get encola los GET y kambi_respuestas los lee.
-- Solo acepta direcciones de *.kambicdn.com (no es un proxy general).
-- =====================================================================
create or replace function futbol.kambi_get(urls text[])
returns bigint[] language plpgsql security definer set search_path = public, net as $$
declare u text; ids bigint[] := '{}';
begin
  foreach u in array urls loop
    if u !~ '^https://[a-z0-9.-]+\.kambicdn\.com/' then raise exception 'url no permitida: %', u; end if;
    ids := ids || net.http_get(u, headers => '{"User-Agent":"Mozilla/5.0 (compatible; ADN-Soccer/1.0)","Accept":"application/json"}'::jsonb,
                               timeout_milliseconds => 10000);
  end loop;
  return ids;
end $$;

create or replace function futbol.kambi_respuestas(ids bigint[])
returns table (id bigint, status_code int, content text, error_msg text)
language sql security definer set search_path = public, net as $$
  select r.id, r.status_code, r.content, r.error_msg from net._http_response r where r.id = any(ids)
$$;

revoke all on function futbol.kambi_get(text[]) from public, anon, authenticated;
revoke all on function futbol.kambi_respuestas(bigint[]) from public, anon, authenticated;

insert into futbol.config (clave, valor, descripcion) values
  ('kambi_via', '"db"', 'Por dónde se pide a Kambi: db (pg_net desde la base) o fetch (desde la función)')
on conflict (clave) do nothing;
