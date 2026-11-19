-- DECISIONES 46 (19 nov 2026, a pedido de Fredy): mercado de córners c1t_uno. Exactamente 1 córner entre
-- el 28' y el 37' del 1T → "más de 1,5 córners en el 1T" (falta uno). Ventana editable. Solo aditiva.
insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('corners_1t_uno_desde', '28', 'Córners 1T con 1 córner: desde el minuto', false),
  ('corners_1t_uno_hasta', '37', 'Córners 1T con 1 córner: hasta el minuto', false)
on conflict (clave) do nothing;
