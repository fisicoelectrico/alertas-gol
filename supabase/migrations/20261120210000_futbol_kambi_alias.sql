-- =====================================================================
-- DECISIONES 69 (20 nov 2026, Fredy): botón "Confirmar" / "No es" en la etiqueta ámbar "Revisar: en BetPlay sería …".
-- Fredy confirma a mano que un partido de Flashscore es el mismo de BetPlay/Rushbet cuando solo un equipo encaja
-- (Oss–Roda = "TOP Oss - Roda JC Kerkrade"). Se guarda por EQUIPO para que la próxima vez empareje solo.
--   decision 'si'  fs = nombre del equipo en Flashscore, kambi = nombre del equipo en Kambi (alias)
--   decision 'no'  fs = "Local|Visitante" de Flashscore, kambi = "Local - Visitante" de Kambi (esa pareja NO es)
-- Solo aditiva. Volver atrás: delete from futbol.kambi_alias where id = …
-- =====================================================================
create table if not exists futbol.kambi_alias (
  id bigint generated always as identity primary key,
  fs text not null,
  kambi text not null,
  decision text not null check (decision in ('si', 'no')),
  creado timestamptz not null default now(),
  unique (fs, kambi)
);
alter table futbol.kambi_alias enable row level security;
comment on table futbol.kambi_alias is 'Emparejamientos Flashscore↔BetPlay/Rushbet confirmados (si) o rechazados (no) por el admin (DECISIONES 69)';
