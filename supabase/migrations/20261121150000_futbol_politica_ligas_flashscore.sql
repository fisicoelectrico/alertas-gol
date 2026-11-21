-- Política de ligas (solo 1.ª y 2.ª nacionales): patrones que faltaban para nombres de Flashscore.
-- Causa (21 nov): las ligas creadas desde Flashscore se crean encendidas si ningún patrón las excluye.
-- "National 1" y "Ligue 3" (3.ª de Francia, nombre nuevo) no casaban con ^national$, y entraban
-- al gol temprano, córners y demás. Se agregan patrones y se apagan las que ya estaban encendidas.

insert into futbol.liga_patrones_excluir (motivo, regex, pais, nota) values
  ('tercera_o_inferior', '^(national( [1-3])?|ligue [3-9]|championnat national.*)$', 'France',
   'National 1 / Ligue 3 es la 3.ª en Francia (Flashscore usa ambos nombres)'),
  ('tercera_o_inferior', '\mligue [3-9]\M', null, 'Ligue 3, Ligue 4… en cualquier país'),
  ('tercera_o_inferior', '^esiliiga b', 'Estonia', 'Esiliiga B es 3.ª en Estonia'),
  ('tercera_o_inferior', '^liga nusantara', 'Indonesia', 'Liga Nusantara es 3.ª en Indonesia'),
  ('copa', '\m(knockout|knock-out|playoff cup|league cup|8 cup)\M', null, 'Torneos de eliminación directa (p. ej. Carling Knockout)');

update futbol.ligas l
   set habilitada = false,
       notas = 'Apagada 2026-11-21 por política de ligas (' || r.motivo || '), a pedido de Fredy'
  from futbol.revisar_ligas() r
 where r.liga_id = l.id;
