-- Historial acumulado por liga (con su país) para identificar ligas fuertes.
-- Solo lee tablas que no se borran (partidos, snapshots, alertas): no guarda nada nuevo
-- y se puede eliminar con `drop view futbol.v_ligas_historial` sin perder datos.
--
-- Embudo por liga:
--   vistos         partidos en vivo que el radar guardó alguna vez
--   precandidatos  alguien perdía en el entretiempo o 2.º tiempo y se pidió la cuota prepartido
--   con_favorito   la cuota prepartido dejó un favorito claro
--   candidatos     el escáner pidió su detalle: tiene snapshot o respondió sin estadísticas
--                  (sin_stats > 0). Los que se quedaron sin cupo de API no cuentan.
--   con_stats      algún snapshot trajo estadísticas
--   con_cuota_vivo algún snapshot trajo la cuota del Over en vivo
--   alertas / aciertos / fallos / pendientes, acierto % y probabilidad implícita media (1/cuota)
create or replace view futbol.v_ligas_historial with (security_invoker = true) as
with snap as (
  select fixture_id,
         bool_or(stats_local is not null) as con_stats,
         bool_or(cuota_over is not null)  as con_cuota_vivo
  from futbol.snapshots group by fixture_id
), al as (
  select fixture_id,
         count(*)                                         as alertas,
         count(*) filter (where resultado = 'acierto')    as aciertos,
         count(*) filter (where resultado = 'fallo')      as fallos,
         count(*) filter (where resultado = 'pendiente')  as pendientes,
         sum(1 / cuota) filter (where resultado in ('acierto','fallo')) as suma_implicita,
         sum(case when resultado = 'acierto' then cuota - 1 when resultado = 'fallo' then -1 end) as ganancia_u
  from futbol.alertas group by fixture_id
)
select l.id                                                    as liga_id,
       l.nombre                                                as liga,
       coalesce(l.pais, '(sin país)')                          as pais,
       l.habilitada,
       count(p.fixture_id)::int                                as vistos,
       count(p.fixture_id) filter (where p.cuota_pre_consultada)::int as precandidatos,
       count(p.fixture_id) filter (where p.favorito is not null)::int as con_favorito,
       count(p.fixture_id) filter (where s.fixture_id is not null or p.sin_stats > 0)::int as candidatos,
       count(s.fixture_id) filter (where s.con_stats)::int     as con_stats,
       count(s.fixture_id) filter (where s.con_cuota_vivo)::int as con_cuota_vivo,
       coalesce(sum(a.alertas), 0)::int                        as alertas,
       coalesce(sum(a.aciertos), 0)::int                       as aciertos,
       coalesce(sum(a.fallos), 0)::int                         as fallos,
       coalesce(sum(a.pendientes), 0)::int                     as pendientes,
       round(sum(a.aciertos)::numeric * 100 / nullif(sum(a.aciertos + a.fallos), 0), 1) as acierto_pct,
       round(sum(a.suma_implicita) * 100 / nullif(sum(a.aciertos + a.fallos), 0), 1)    as prob_implicita_pct,
       round(coalesce(sum(a.ganancia_u), 0), 2)                as ganancia_u,
       min(p.kickoff)                                          as desde
from futbol.ligas l
left join futbol.partidos p on p.liga_id = l.id
left join snap s on s.fixture_id = p.fixture_id
left join al a on a.fixture_id = p.fixture_id
group by l.id;

grant select on futbol.v_ligas_historial to anon, authenticated;
