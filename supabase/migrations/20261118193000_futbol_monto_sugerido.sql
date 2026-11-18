-- =====================================================================
-- Monto sugerido en cada aviso (DECISIONES 41). Aditiva.
-- Cada persona escribe en Mi banca qué % de su banca quiere ganar por entrada (ganancia_pct).
-- monto = banca actual × ganancia_pct / 100 / (cuota − 1), con la casa que paga MENOS (lo prudente),
-- y nunca más de monto_max_pct (10 %) de la banca: con cuotas muy bajas el monto se dispara.
-- Banca actual = banca inicial + ganancias en pesos de las entradas cerradas con monto.
-- =====================================================================
alter table futbol.usuarios add column if not exists ganancia_pct numeric(5,2)
  check (ganancia_pct is null or (ganancia_pct > 0 and ganancia_pct <= 20));

create or replace function futbol.banca_actual(p_usuario int)
returns numeric language sql stable set search_path = futbol, public as $$
  select u.banca_inicial + coalesce((
    select sum(case when a.resultado = 'acierto' then e.monto * (coalesce(e.cuota, a.cuota) - 1)
                    when a.resultado = 'fallo' then -e.monto end)
    from futbol.entradas e join futbol.alertas a on a.id = e.alerta_id
    where e.usuario_id = u.id and e.decision = 'entre' and e.monto is not null and a.resultado in ('acierto', 'fallo')), 0)
  from futbol.usuarios u where u.id = p_usuario
$$;
revoke all on function futbol.banca_actual(int) from public, anon, authenticated;

insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('monto_max_pct', '10', 'Monto sugerido: tope en % de la banca por entrada (poka-yoke con cuotas muy bajas)', false)
on conflict (clave) do nothing;
