-- Seguimiento de candidatos cada 5 minutos (ver DECISIONES.md, puntos 21 a 24)
alter table futbol.partidos
  add column if not exists sin_stats int not null default 0,
  add column if not exists cuota_vivo_probada boolean not null default false;
comment on column futbol.partidos.sin_stats is 'Respuestas seguidas sin estadísticas; con 2 el partido sale del seguimiento (no gasta más consultas)';
comment on column futbol.partidos.cuota_vivo_probada is 'Ya se pidió /odds/live al menos una vez (para conocer la cobertura aunque falten estadísticas)';
insert into futbol.config (clave, valor, descripcion, es_regla) values
  ('ultimo_seguimiento', to_jsonb('2000-01-01T00:00:00Z'::text), 'Marca del último seguimiento de candidatos (la escribe el escáner)', false)
on conflict (clave) do nothing;
update futbol.config set valor = '5'::jsonb where clave = 'intervalo_seguimiento_min';
