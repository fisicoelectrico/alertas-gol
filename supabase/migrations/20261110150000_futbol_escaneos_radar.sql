-- Pestaña "Radar" de la PWA.
-- Cada barrido guarda la lista compacta de TODOS los partidos en vivo que trajo
-- /fixtures?live=all y el motivo por el que cada uno se descartó (o pasó a seguimiento).
-- No cuesta consultas de API: es la misma respuesta que el escáner ya pedía.
-- El escáner borra esta columna (la pone en null) en filas de más de 7 días para no inflar la BD.
alter table futbol.escaneos add column if not exists radar jsonb;
comment on column futbol.escaneos.radar is
  'Foto del radar: [{id, lg, liga, pais, l, v, e, m, gl, gv, fav, cf, mo, ev?}] (mo = motivo de descarte). Se guarda 7 días.';
