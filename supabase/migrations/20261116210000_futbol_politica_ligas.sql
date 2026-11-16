-- Política de ligas (vigente desde 2026-11-16, decisión de Fredy)
-- Solo quedan habilitadas las primeras y segundas divisiones NACIONALES de hombres.
-- Se apagan: femeniles, reservas, juveniles/sub-X, tercera división o inferior,
-- estaduales/regionales, copas y amistosos.
--
-- Las ligas nuevas siguen entrando ENCENDIDAS (Fredy no quiere apagado por defecto).
-- La revisión semanal usa futbol.revisar_ligas() para encontrar las encendidas que
-- violan la política. No consume la API: solo compara nombres con patrones.

-- 1) Patrones editables. Un patrón es una regex de Postgres (insensible a mayúsculas)
--    que se compara contra "nombre" de la liga; si "pais" no es null, solo aplica a ese país.
create table if not exists futbol.liga_patrones_excluir (
  id      serial primary key,
  motivo  text not null check (motivo in ('femenil','juvenil','reserva','copa','amistoso','tercera_o_inferior','estadual')),
  regex   text not null,
  pais    text,
  nota    text,
  creado  timestamptz not null default now()
);

alter table futbol.liga_patrones_excluir enable row level security;
-- Sin políticas: solo el rol de servicio / SQL Editor la lee y escribe.

-- 2) Marca de "ya revisada por la política" para que cada semana el juicio humano
--    (o de Claude) solo mire las ligas nuevas.
alter table futbol.ligas add column if not exists politica_revisada timestamptz;

insert into futbol.liga_patrones_excluir (motivo, regex, pais, nota) values
  -- femeniles
  ('femenil', '\m(women|womens|woman|femenil|femenina|feminine|feminin|f[ée]minin|frauen\w*|damen|kvinde\w*|damallsvenskan|toppserien|elitettan|wsl|nwsl|we league|wk-league|ladies|girls)\M', null, null),
  ('femenil', 'women''s|w-league|super league women|liga f\M', null, null),
  ('femenil', '^usl super league', 'USA', 'Liga femenina de primera en EE. UU.'),
  -- juveniles
  ('juvenil', '\m(u|sub[- ]?)\d{2}\M', null, 'U19, U20, U23, Sub-20…'),
  ('juvenil', '\m(youth|junior|juniores|júniores|juvenil|primavera|revelação|revelacao|development|academy|diski challenge|next pro)\M', null, null),
  -- reservas
  ('reserva', '\m(reserve|reserves|reserva|reservas)\M', null, null),
  -- copas y amistosos (complementa config.patrones_copa del escáner)
  ('copa', '\m(cup|copa|coupe|taça|taca|pokal|coppa|trophy|beker|libertadores|sudamericana|champions league|supercopa|super cup|shield)\M', null, null),
  ('copa', '.', 'World', 'Competiciones internacionales o de selecciones: no son ligas nacionales'),
  ('amistoso', '\m(friendl\w*|amistos\w*|club friendlies)\M', null, null),
  -- tercera división o inferior (genéricos)
  ('tercera_o_inferior', '\m(third|tercera|terceira|troisième|derde|tweede divisie|regionalliga|oberliga|landesliga|non league|amateur|highland|lowland|gamma ethniki|ettan|druha liga)\M', null, null),
  ('tercera_o_inferior', '(^|\W)[3-9]\.\s*(liga|lig|division|divisie|snl|liga)\M', null, '3. liga, 4. liga, 3. Lig…'),
  ('tercera_o_inferior', '\m(liga iii|iii liga|nb iii|liga 3|national [2-3]|j3 league|primera c|primera b metropolitana|federal a|torneo federal|usl league (one|two)|campeonato de portugal|rfef)\M', null, 'Primera/Segunda/Tercera RFEF son 3.ª a 5.ª en España'),
  -- tercera o inferior que dependen del país (el mismo nombre es 2.ª en otro país)
  ('tercera_o_inferior', '^(league one|league two|national league.*)$', 'England', 'League One/Two y National League son 3.ª a 6.ª en Inglaterra'),
  ('tercera_o_inferior', '^(league one|league two)$', 'Scotland', null),
  ('tercera_o_inferior', '^national$', 'France', 'National es 3.ª en Francia'),
  ('tercera_o_inferior', '^serie [c-d]\M', null, 'Serie C/D (Italia y Brasil)'),
  ('tercera_o_inferior', '^ii liga', 'Poland', 'II Liga es 3.ª en Polonia (Liga II de Rumania sí es 2.ª)'),
  ('tercera_o_inferior', '^2\.\s*lig\M', 'Turkey', '2. Lig es 3.ª en Turquía (1. Lig es la 2.ª)'),
  ('tercera_o_inferior', '^2\.\s*division\M', 'Denmark', '2. Division es 3.ª en Dinamarca'),
  ('tercera_o_inferior', '^second league a', 'Russia', null),
  ('tercera_o_inferior', '^division 2$', 'Saudi-Arabia', null),
  ('tercera_o_inferior', '^1\. liga (classic|promotion)', 'Switzerland', null),
  ('tercera_o_inferior', '^(liga premier|primera premier)', 'Mexico', null),
  ('tercera_o_inferior', '^segunda división$', 'Chile', 'Segunda División es 3.ª en Chile (Primera B es la 2.ª)'),
  -- estaduales de Brasil: son torneos de estado, no nacionales
  ('estadual', '^(paulista|carioca|mineiro|ga[úu]cho|pernambucano|baiano|cearense|paranaense|catarinense|goiano|sergipano|paraense|potiguar|alagoano|paraibano|capixaba|maranhense|piauiense|amazonense|mato-grossense|matogrossense|sul-mato-grossense|brasiliense|tocantinense|acreano|rondoniense|roraimense|amapaense)\M', 'Brazil', 'Estaduales: torneo de estado con fase corta + mata-mata')
on conflict do nothing;

-- 3) La revisión: ligas encendidas que violan algún patrón.
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
  order by l.id, p.id;
$$;

revoke all on function futbol.revisar_ligas() from public, anon, authenticated;

-- 4) Línea base: las 301 ligas existentes quedaron revisadas a mano el 2026-11-16.
update futbol.ligas set politica_revisada = now() where politica_revisada is null;
