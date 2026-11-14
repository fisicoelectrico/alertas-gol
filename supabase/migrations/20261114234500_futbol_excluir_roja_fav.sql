-- Regla v7 (propuesta de Fredy, 14 nov): un favorito con tarjeta roja no alerta aunque cumpla todo.
-- Nace apagada; al encenderla en Ajustes se abre una versión nueva de la regla.
insert into futbol.config (clave, valor, es_regla, descripcion) values
  ('excluir_roja_fav', 'false', true, 'Si el favorito tiene una tarjeta roja (juega con uno menos), no alerta aunque cumpla todo')
on conflict (clave) do nothing;
