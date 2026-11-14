-- DECISIONES 34.
-- 1) Parámetro de regla excluir_reempate (v6). Nace en false: se enciende (y abre v6) cuando el
--    escáner v18 esté desplegado, para que ninguna versión diga algo que el escáner no hace.
insert into futbol.config (clave, valor, descripcion, es_regla)
values ('excluir_reempate', 'false'::jsonb,
        'Fuera del radar si el favorito empató viniendo de atrás y le volvieron a marcar', true)
on conflict (clave) do nothing;

-- 2) Las métricas solo cuentan alertas dentro de la ventana de minutos vigente (minuto_min–minuto_max).
--    Es un filtro: si se amplía la ventana, las alertas vuelven a contar. Snapshots y alertas no se tocan.
create or replace view futbol.v_rendimiento as
with ventana as (
  select (select (valor #>> '{}')::int from futbol.config where clave = 'minuto_min') as mmin,
         (select (valor #>> '{}')::int from futbol.config where clave = 'minuto_max') as mmax
), base as (
  select a.id, a.fixture_id, a.snapshot_id, a.ts, a.minuto, a.marcador, a.goles_al_alertar, a.linea_over,
         a.cuota, a.dominancia, a.momentum, a.regla_version, a.resultado, a.minuto_gol, a.lado_gol,
         a.push_enviados, a.cerrada_ts, p.liga_id, l.nombre as liga,
         case when a.minuto < 60 then '46-59' when a.minuto < 70 then '60-69'
              when a.minuto < 80 then '70-79' else '80+' end as franja_minuto
  from futbol.alertas a
  join futbol.partidos p using (fixture_id)
  left join futbol.ligas l on l.id = p.liga_id
  cross join ventana v
  where a.resultado in ('acierto', 'fallo')
    and coalesce(l.habilitada, true)                                       -- DECISIONES 33
    and a.minuto between coalesce(v.mmin, 0) and coalesce(v.mmax, 200)     -- DECISIONES 34
)
select regla_version,
       coalesce(liga, '(todas)') as liga,
       coalesce(franja_minuto, '(todas)') as franja_minuto,
       count(*) as alertas,
       count(*) filter (where resultado = 'acierto') as aciertos,
       round(avg((resultado = 'acierto')::int) * 100, 1) as acierto_pct,
       round(avg(cuota), 2) as cuota_media,
       round(avg(1 / cuota) * 100, 1) as prob_implicita_pct,
       round(sum(case when resultado = 'acierto' then cuota - 1 else -1 end), 2) as ganancia_u,
       round(sum(case when resultado = 'acierto' then cuota - 1 else -1 end) / count(*) * 100, 1) as roi_pct
from base
group by grouping sets ((regla_version), (regla_version, liga), (regla_version, franja_minuto));

-- Historial por liga: mismo criterio de ventana para alertas/aciertos/fallos.
create or replace view futbol.v_ligas_historial as
with snap as (
  select fixture_id, bool_or(stats_local is not null) as con_stats, bool_or(cuota_over is not null) as con_cuota_vivo
  from futbol.snapshots group by fixture_id
), ventana as (
  select (select (valor #>> '{}')::int from futbol.config where clave = 'minuto_min') as mmin,
         (select (valor #>> '{}')::int from futbol.config where clave = 'minuto_max') as mmax
), al as (
  select a.fixture_id,
         count(*) as alertas,
         count(*) filter (where a.resultado = 'acierto') as aciertos,
         count(*) filter (where a.resultado = 'fallo') as fallos,
         count(*) filter (where a.resultado = 'pendiente') as pendientes,
         sum(1 / a.cuota) filter (where a.resultado in ('acierto', 'fallo')) as suma_implicita,
         sum(case when a.resultado = 'acierto' then a.cuota - 1 when a.resultado = 'fallo' then -1 end) as ganancia_u
  from futbol.alertas a cross join ventana v
  where a.minuto between coalesce(v.mmin, 0) and coalesce(v.mmax, 200)
  group by a.fixture_id
)
select l.id as liga_id, l.nombre as liga, coalesce(l.pais, '(sin país)') as pais, l.habilitada,
       count(p.fixture_id)::int as vistos,
       (count(p.fixture_id) filter (where p.cuota_pre_consultada))::int as precandidatos,
       (count(p.fixture_id) filter (where p.favorito is not null))::int as con_favorito,
       (count(p.fixture_id) filter (where s.fixture_id is not null or p.sin_stats > 0))::int as candidatos,
       (count(s.fixture_id) filter (where s.con_stats))::int as con_stats,
       (count(s.fixture_id) filter (where s.con_cuota_vivo))::int as con_cuota_vivo,
       coalesce(sum(a.alertas), 0)::int as alertas,
       coalesce(sum(a.aciertos), 0)::int as aciertos,
       coalesce(sum(a.fallos), 0)::int as fallos,
       coalesce(sum(a.pendientes), 0)::int as pendientes,
       round(sum(a.aciertos) * 100 / nullif(sum(a.aciertos + a.fallos), 0), 1) as acierto_pct,
       round(sum(a.suma_implicita) * 100 / nullif(sum(a.aciertos + a.fallos), 0), 1) as prob_implicita_pct,
       round(coalesce(sum(a.ganancia_u), 0), 2) as ganancia_u,
       min(p.kickoff) as desde
from futbol.ligas l
left join futbol.partidos p on p.liga_id = l.id
left join snap s on s.fixture_id = p.fixture_id
left join al a on a.fixture_id = p.fixture_id
group by l.id;
