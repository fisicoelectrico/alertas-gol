-- =====================================================================
-- ADN Soccer · Acceso para amigos por enlace personal (aplicada 2026-11-14 con aprobación de Fredy)
-- Solo esquema `futbol`. No toca Supabase Auth ni otros esquemas.
-- Aplicada como migración `futbol_acceso_amigos`.
-- Todo es aditivo: no borra ni cambia columnas existentes.
-- =====================================================================

-- 1) Personas con acceso. El teléfono lo escribe Fredy al invitar
--    (la web no puede leer el número del celular).
create table futbol.usuarios (
  id             bigint generated always as identity primary key,
  nombre         text not null,
  telefono       text,                                   -- WhatsApp, formato +57...
  rol            text not null default 'visor' check (rol in ('admin','visor')),
  activo         boolean not null default true,          -- apagar = sin acceso al instante
  banca_inicial  numeric(14,0),                          -- opcional, pesos colombianos
  creado         timestamptz not null default now(),
  ultimo_acceso  timestamptz
);
create unique index usuarios_telefono_uk on futbol.usuarios (telefono) where telefono is not null;

-- 2) Enlaces de un solo uso. Se guarda solo el hash del token (si alguien
--    lee la tabla no puede armar enlaces válidos).
create table futbol.invitaciones (
  id          bigint generated always as identity primary key,
  usuario_id  bigint not null references futbol.usuarios(id) on delete cascade,
  token_hash  text not null unique,                      -- sha256 del token del enlace
  creada      timestamptz not null default now(),
  vence       timestamptz not null default now() + interval '7 days',
  usada       timestamptz,                               -- null = sin usar
  usada_ua    text                                       -- navegador que la canjeó
);

-- 3) Sesiones: un celular registrado = una sesión. Crear un enlace nuevo
--    para la misma persona revoca sus sesiones anteriores.
create table futbol.sesiones (
  id          bigint generated always as identity primary key,
  usuario_id  bigint not null references futbol.usuarios(id) on delete cascade,
  token_hash  text not null unique,
  dispositivo text,
  creada      timestamptz not null default now(),
  ultimo_uso  timestamptz not null default now(),
  revocada    timestamptz
);
create index sesiones_usuario_idx on futbol.sesiones (usuario_id) where revocada is null;

-- 4) Entré / No entro por persona y alerta. Una fila por (persona, alerta):
--    los recordatorios no crean filas.
create table futbol.entradas (
  usuario_id  bigint not null references futbol.usuarios(id) on delete cascade,
  alerta_id   bigint not null references futbol.alertas(id) on delete cascade,
  decision    text not null check (decision in ('entre','no_entro')),
  monto       numeric(14,0) check (monto is null or monto > 0),   -- opcional
  cuota       numeric(6,2)  check (cuota is null or cuota > 1),   -- la que tomó; null = la de la alerta
  origen      text not null default 'app' check (origen in ('app','notificacion')),
  ts          timestamptz not null default now(),
  primary key (usuario_id, alerta_id)
);

-- 5) Cada suscripción push queda ligada a su dueño (para no mandar
--    recordatorios a quien ya marcó y para apagar a quien se excluya).
alter table futbol.push_suscripciones add column usuario_id bigint references futbol.usuarios(id) on delete set null;

-- 6) Recordatorios: cuántos se mandaron por alerta (informativo).
alter table futbol.alertas add column recordatorios int not null default 0;

-- 7) Parámetros nuevos (no son de regla: no abren versión).
insert into futbol.config (clave, valor, es_regla, descripcion) values
  ('modo_acceso',            '"abierto"', false, 'abierto = la app funciona sin sesión (transición); cerrado = exige enlace'),
  ('recordatorio_cada_min',  '5',         false, 'minutos entre recordatorios de una alerta abierta'),
  ('recordatorios_max',      '4',         false, 'tope de recordatorios por alerta'),
  ('invitacion_dias',        '7',         false, 'días de vigencia de un enlace sin usar')
on conflict (clave) do nothing;

-- 8) Seguridad: como el resto de `futbol`, solo la función `api` (conexión
--    directa) lee y escribe. RLS activo y sin políticas = nadie por REST.
alter table futbol.usuarios     enable row level security;
alter table futbol.invitaciones enable row level security;
alter table futbol.sesiones     enable row level security;
alter table futbol.entradas     enable row level security;
revoke all on futbol.usuarios, futbol.invitaciones, futbol.sesiones, futbol.entradas from anon, authenticated;

-- 9) Fredy como administrador (su enlace se genera después desde la función).
insert into futbol.usuarios (nombre, rol) values ('Fredy', 'admin');

-- 10) Yield por persona (todas sus "entré"; sin monto se asume stake 1).
create view futbol.v_yield_usuario with (security_invoker = true) as
select e.usuario_id,
       count(*) filter (where a.resultado in ('acierto','fallo'))                        as cerradas,
       count(*) filter (where a.resultado = 'acierto')                                   as aciertos,
       sum(coalesce(e.monto,1)) filter (where a.resultado in ('acierto','fallo'))        as invertido,
       sum(case when a.resultado = 'acierto' then coalesce(e.monto,1)*(coalesce(e.cuota,a.cuota)-1)
                when a.resultado = 'fallo'   then -coalesce(e.monto,1) end)              as ganancia,
       round(100.0 * sum(case when a.resultado = 'acierto' then coalesce(e.monto,1)*(coalesce(e.cuota,a.cuota)-1)
                              when a.resultado = 'fallo'   then -coalesce(e.monto,1) end)
             / nullif(sum(coalesce(e.monto,1)) filter (where a.resultado in ('acierto','fallo')),0), 1) as yield_pct
from futbol.entradas e
join futbol.alertas a on a.id = e.alerta_id
where e.decision = 'entre'
group by e.usuario_id;
revoke all on futbol.v_yield_usuario from anon, authenticated;
