-- ADN Soccer: aviso de gol al instante y tope de minuto para recordatorios (aditivo)
alter table futbol.alertas add column if not exists gol_avisado timestamptz;
insert into futbol.config (clave, valor, es_regla, descripcion) values
  ('recordatorio_minuto_tope', '85', false, 'después de este minuto ya no se envían recordatorios de una alerta abierta')
on conflict (clave) do nothing;
