-- Cuota congelada tras un gol (DECISIONES 40, 18 nov): el feed de Flashscore repite unos minutos el tablero de
-- antes del gol. Se marcan esas filas (congelada = true, activa = false) para que no cuenten.
alter table futbol.cuotas_vivo add column if not exists congelada boolean not null default false;

-- Corrige Atenas 1-0 Fenix (Uruguay 2.ª): las fotos de 13' a 17' repetían el tablero de antes del gol y
-- dispararon un aviso con Más de 1,5 a 1,53 cuando las casas ya pagaban ~1,10.
update futbol.cuotas_vivo c set congelada = true, activa = false
from futbol.partidos p
where p.fixture_id = c.fixture_id and p.local ilike 'Atenas%' and c.goles_local + c.goles_visitante = 1
  and c.minuto between 13 and 17 and c.linea is not null and c.ts::date = '2026-11-18';
update futbol.lab_oportunidades o set alertada = false, ts_alerta = null, minuto_alerta = null, cuota_alerta = null,
  casa_alerta = null, push_enviados = 0, mejor_cuota = null, mejor_casa = null, minuto_mejor = null,
  serie = (select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(o.serie) e where (e->>'m')::int > 17)
from futbol.partidos p
where p.fixture_id = o.fixture_id and p.local ilike 'Atenas%' and o.ts_inicio::date = '2026-11-18';
