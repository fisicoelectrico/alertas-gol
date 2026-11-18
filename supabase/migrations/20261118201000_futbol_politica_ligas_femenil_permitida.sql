-- 2026-11-18: Fredy vuelve a permitir ligas femeninas nacionales de 1.ª y 2.ª división.
-- Siguen fuera copas, internacionales, reservas, juveniles (también femeninas sub-X) y estaduales.
-- revisar_ligas() ignora los patrones con motivo 'femenil' (se conservan por si la política vuelve a cambiar).
create or replace function futbol.revisar_ligas()
returns table (liga_id int, nombre text, pais text, motivo text, patron_id int, nota text)
language sql stable
set search_path = futbol, pg_temp
as $$
  select distinct on (l.id) l.id, l.nombre, l.pais, p.motivo, p.id, p.nota
  from futbol.ligas l
  join futbol.liga_patrones_excluir p
    on l.nombre ~* p.regex
   and (p.pais is null or p.pais = l.pais)
  where coalesce(l.habilitada, true)
    and p.motivo <> 'femenil'
  order by l.id, p.id;
$$;
revoke all on function futbol.revisar_ligas() from public, anon, authenticated;
