-- pg_net (HTTP desde Postgres) y pg_cron (agenda) para disparar el escáner sin tener la app abierta
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Freno a la fuerza bruta del PIN de administrador: 5 fallos → bloqueo de 15 min
alter table futbol.admin add column if not exists fallos int not null default 0,
                         add column if not exists bloqueado_hasta timestamptz;

-- El PIN NO va en este archivo. Se carga aparte con:
--   insert into futbol.admin (id, pin_hash) values (1, extensions.crypt('<PIN>', extensions.gen_salt('bf', 10)))
--   on conflict (id) do update set pin_hash = excluded.pin_hash;
