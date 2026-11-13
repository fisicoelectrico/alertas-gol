-- Regla v3 (13 nov 2026): copas fuera por nombre. Ver DECISIONES 26.
create table if not exists futbol.respaldo_borrados (
  id bigserial primary key,
  ts timestamptz not null default now(),
  motivo text not null,
  datos jsonb not null
);
alter table futbol.respaldo_borrados enable row level security;

insert into futbol.config (clave, valor, descripcion, es_regla) values
 ('patrones_copa', '["cup","copa","coupe","taça","pokal","coppa","trophy","libertadores","sudamericana","champions league"]'::jsonb,
  'Competiciones que se descartan siempre si su nombre contiene alguno de estos textos (sin mayúsculas ni tildes)', true)
on conflict (clave) do nothing;
insert into futbol.reglas (version, parametros, notas)
select 'v3', jsonb_object_agg(clave, valor), 'Copas fuera por nombre (patrones_copa); resto igual a v2'
from futbol.config where es_regla
on conflict (version) do nothing;
update futbol.config set valor = '"v3"'::jsonb, actualizado = now() where clave = 'regla_version';
