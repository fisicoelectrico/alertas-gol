-- =====================================================================
-- DECISIONES 75 (21 nov 2026, Fredy): interruptor de la push de la alerta principal.
--   alerta_push  false = la alerta se sigue detectando y guardando (con cuota de BetPlay/Rushbet y
--                motivo_sin_push = 'push_apagada'), pero no sale push ni recordatorios. true = como antes.
-- Se crea en false porque Fredy la apagó ese día (solo deja la push de gol temprano Más de 2,5).
-- Solo aditiva. Volver atrás: encenderla en Ajustes → Goles.
-- =====================================================================
insert into futbol.config (clave, valor, descripcion) values
  ('alerta_push', 'false', 'Push de la alerta principal (false = registra en silencio, sin push ni recordatorios)')
on conflict (clave) do nothing;
