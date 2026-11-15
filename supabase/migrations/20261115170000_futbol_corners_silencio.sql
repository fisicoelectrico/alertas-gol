-- Córners (lab): dos llaves nuevas, independientes de corners_activo (DECISIONES 39). Aditiva.
-- Fredy (15 nov): dejarlo juntando datos un buen tiempo, sin push y sin gastar consultas de API.
insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('corners_push',  'false', 'Córners (lab): mandar push al administrador. Apagado = corre en silencio', false),
  ('corners_cuota', 'false', 'Córners (lab): gastar 1 consulta de /odds/live por aviso para leer la cuota. Apagado = 0 consultas', false)
on conflict (clave) do nothing;
