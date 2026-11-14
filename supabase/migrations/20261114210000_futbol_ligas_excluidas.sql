-- DECISIONES 33: excluir una liga (ligas.habilitada = false) la saca de las métricas al instante.
-- Solo cambia la vista: no borra alertas ni partidos. Si la liga se reactiva, sus alertas vuelven a contar.
create or replace view futbol.v_rendimiento as
with base as (
  select a.id, a.fixture_id, a.snapshot_id, a.ts, a.minuto, a.marcador, a.goles_al_alertar, a.linea_over,
         a.cuota, a.dominancia, a.momentum, a.regla_version, a.resultado, a.minuto_gol, a.lado_gol,
         a.push_enviados, a.cerrada_ts, p.liga_id, l.nombre as liga,
         case when a.minuto < 60 then '46-59' when a.minuto < 70 then '60-69'
              when a.minuto < 80 then '70-79' else '80+' end as franja_minuto
  from futbol.alertas a
  join futbol.partidos p using (fixture_id)
  left join futbol.ligas l on l.id = p.liga_id
  where a.resultado in ('acierto', 'fallo')
    and coalesce(l.habilitada, true)          -- ligas excluidas fuera del yield y del acierto
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
