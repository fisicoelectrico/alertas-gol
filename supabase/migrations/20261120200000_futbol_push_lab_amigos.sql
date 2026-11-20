-- =====================================================================
-- DECISIONES 68 (20 nov 2026, Fredy): las push de córners y de gol temprano también les llegan a los amigos
-- (rol visor), con formato claro ("Más de 9,5 tiros de esquina · 1,72 · BetPlay"), y durante el fin de semana
-- todas exigen una cuota mínima FIJA de 1,40 en BetPlay o Rushbet. El lunes 23 se revisa.
--   lab_push_amigos        true = la push de gol temprano sale a todos (false = solo admin)
--   corners_push_amigos    true = la push de córners sale a todos (false = solo admin)
--   lab_umbral_fijo        > 1 reemplaza el umbral automático (lab_umbrales) de gol temprano; 0 = automático
--   corners_cuota_min_fija > 1 cuota mínima de los tres mercados de córners; 0 = la calculada / sin mínimo
-- Solo aditiva. Volver atrás: poner las dos *_amigos en false y los dos umbrales en 0 (desde Ajustes).
-- =====================================================================
insert into futbol.config (clave, valor, descripcion) values
  ('lab_push_amigos', 'true', 'Push de gol temprano también para los amigos (false = solo admin)'),
  ('corners_push_amigos', 'true', 'Push de córners también para los amigos (false = solo admin)'),
  ('lab_umbral_fijo', '1.40', 'Cuota mínima fija de gol temprano en BetPlay/Rushbet; 0 = umbral automático de la base'),
  ('corners_cuota_min_fija', '1.40', 'Cuota mínima fija de córners en BetPlay/Rushbet; 0 = calculada o sin mínimo')
on conflict (clave) do nothing;
