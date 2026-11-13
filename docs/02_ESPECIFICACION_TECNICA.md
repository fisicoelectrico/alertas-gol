# Especificación técnica — Alertas de Gol en Vivo
*Versión 1.2 · 10 nov 2026 · Estado: construida y en operación; aprobada por Fredy el 10 nov 2026*

> Los cambios respecto a la 1.0 están listados en la sección 9. El resto del texto se conserva tal cual.

## 1. Hipótesis de negocio
Cuando un **favorito** (según la cuota prepartido) va **perdiendo por ≥1 gol en el segundo tiempo** y **domina claramente** el partido, la probabilidad de que haya **al menos un gol más** antes del final es mayor que la que implica la cuota en vivo del mercado Over (goles actuales + 0.5).

- Ejemplo: favorito local pierde 0-1 al minuto 65, el Over 1.5 paga 1.30. A medida que pasan los minutos sin gol, la cuota sube. Cuando llega a **1.40** y el favorito sigue presionando (≥30% más que el rival) → **alerta**.
- **Métrica de éxito:** tasa de acierto real > probabilidad implícita (1/cuota). Con 1.40 → hay que acertar más del **71,4%**. Se mide también el ROI simulado con stake fijo.

## 2. Decisiones tomadas
| Tema | Decisión | Motivo |
|---|---|---|
| Datos | **API-Football** (api-sports.io, `v3.football.api-sports.io`) | Es la única gratuita que incluye partidos en vivo, estadísticas y cuotas en vivo. Plan Free: 100 consultas/día, todos los endpoints, sin tarjeta. Pro: 19 USD/mes, 7.500/día. |
| Descartados | SofaScore, Scorebing (sin API pública, bloquean CORS, problemas de términos de uso); The Odds API, odds-api.io, KickoffAPI (sin estadísticas, o sin cuotas en vivo gratis, o sin llaves nuevas) | — |
| Backend | **Supabase** `central-ingenieria` (ref `zdhkhsrwvvripuczhvam`, us-east-2), esquema **`futbol`** | El plan gratuito permite 2 proyectos activos y ambos ya existen. `organizado` no se toca. |
| Escaneo | Edge Function `escaner`, disparada por **pg_cron + pg_net** | Funciona 24/7 sin necesidad de tener la app abierta. |
| Notificaciones | **Web Push** (VAPID) desde la Edge Function | Llegan aunque el celular esté bloqueado, una vez instalada la PWA. |
| Frontend | PWA estática (HTML/JS + service worker + manifest) | Se instala como app desde el navegador. |
| Hosting | GitHub Pages o Cloudflare Pages + subdominio **`goles.fredyquiroga.com`** (CNAME) | Gratis, con HTTPS (requisito para la PWA). Dominio alterno: fisicoeléctrico.com. |
| Plan de pago | Se queda en Free hasta que los datos demuestren ganancia; el diseño escala a Pro cambiando solo `config.presupuesto_diario` | Decisión de Fredy. |

## 3. Limitación clave: 100 consultas/día
- `GET /fixtures?live=all` → **1 consulta** devuelve todos los partidos en vivo (marcador, minuto, liga). Este es el "radar".
- `GET /fixtures/statistics?fixture={id}` → 1 consulta por partido.
- `GET /odds/live?fixture={id}` → 1 consulta por partido (también existe `/odds/live` sin filtro, que trae todos; hay que evaluar el tamaño y la paginación).
- `GET /odds?fixture={id}&bet=1` → cuota prepartido 1X2 para definir quién es el favorito (**1 sola vez por partido**, queda en caché en `partidos`).

**Estrategia v1 (Free):** radar cada ~15 min en franjas de alta actividad (configurable); solo los candidatos (2T, favorito perdiendo) gastan consultas de estadísticas y cuotas. Contabilidad estimada: ~40 radares + ~60 consultas de detalle por día. No es minuto a minuto: con Pro el mismo código baja el intervalo a 1–2 min.
**Siempre:** leer los headers `x-ratelimit-requests-remaining` y guardar el consumo en `api_uso`; si queda menos del margen de reserva, se pausa el escaneo.

> ⚠️ Pendiente de verificar con datos reales: (a) API-Football **no entrega "ataques peligrosos"**; sus estadísticas son tiros al arco, tiros totales, tiros dentro del área, córners, posesión, atajadas, pases y `expected_goals` (en algunas ligas). (b) Los nombres e IDs exactos de los mercados en `/odds/live` (Over/Under, línea de goles) hay que confirmarlos con una respuesta real antes de fijar el parser.

## 4. Algoritmo v1 (todos los umbrales viven en `futbol.config`)
**Filtro de candidato:**
1. Estado del partido `2H` y minuto entre `minuto_min` (46) y `minuto_max` (85).
2. Favorito = equipo con la cuota prepartido 1X2 más baja, siempre que sea ≤ `cuota_fav_max` (2.00).
3. El favorito pierde por ≥ `diferencia_min` (1) gol.

**Índice de Presión (IP):** puntaje ponderado por equipo
`P = 3·tiros_al_arco + 2·tiros_dentro_area + 1·tiros_totales + 1.5·córners + 5·xG (si existe) + 0.05·(posesión−50)`
- **Dominancia** `D = P_fav / max(P_rival, 1)` → se exige `D ≥ dominancia_min` (**1.30** = 30% más).
- **Momentum:** el IP del favorito calculado solo con el delta de las estadísticas entre snapshots consecutivos (últimos ~15 min) debe seguir siendo ≥ `dominancia_min`. Esto descarta favoritos que presionaron antes y ya se apagaron.

**Disparo de alerta:** candidato + `D ≥ 1.30` + momentum vigente + cuota Over (goles actuales + 0.5) ≥ `cuota_objetivo` (**1.40**) + sigue perdiendo → crear un registro en `alertas`, enviar push y marcar el partido como "seguimiento intensivo". **Máximo una alerta por partido y versión de regla.**

**Resolución:** al terminar el partido (`FT`), si hubo ≥1 gol después del minuto de la alerta → `acierto`, si no → `fallo`. Se guarda el minuto del gol y quién lo marcó (favorito o rival), para un análisis posterior.

## 5. Esquema de base de datos `futbol`
```
ligas            (id int PK, nombre, pais, habilitada bool default true, notas)
partidos         (fixture_id int PK, liga_id → ligas, temporada, local, visitante,
                  kickoff timestamptz, favorito text check('home','away'),
                  cuota_pre_local, cuota_pre_empate, cuota_pre_visitante,
                  estado, goles_local, goles_visitante, seguimiento bool, creado, actualizado)
snapshots        (id bigserial PK, fixture_id → partidos, ts, minuto, goles_local, goles_visitante,
                  stats_local jsonb, stats_visitante jsonb, ip_local, ip_visitante, dominancia,
                  momentum, linea_over numeric, cuota_over numeric, raw jsonb)
alertas          (id bigserial PK, fixture_id, ts, minuto, marcador text, cuota, dominancia,
                  momentum, regla_version text, resultado text check('pendiente','acierto','fallo','anulada')
                  default 'pendiente', minuto_gol, lado_gol, cerrada_ts)
config           (clave text PK, valor jsonb, descripcion)   -- umbrales + presupuesto
api_uso          (fecha date, endpoint text, llamadas int, restantes int, PK(fecha, endpoint))
push_suscripciones (id, endpoint text unique, p256dh, auth, creado)
```
- **Vista** `v_rendimiento`: acierto %, cuota media, probabilidad implícita media y ROI por `regla_version`, liga y franja de minuto.
- **RLS:** lectura pública (anon) de partidos/snapshots/alertas/v_rendimiento; `push_suscripciones` solo insert anon; escritura del resto solo con service_role (Edge Function).
- `snapshots.raw` guarda la respuesta cruda de la API → es el dataset para el futuro modelo de IA.

## 6. Frontend PWA
Pantallas: **En vivo** (candidatos con IP, dominancia, cuota y mini-gráfica de presión), **Alertas** (pendientes/resueltas), **Rendimiento** (acierto vs implícita, ROI, por liga), **Ligas** (activar o aislar), **Ajustes** (umbrales, botón para activar notificaciones, consumo de API del día). Supabase JS con la publishable key; refresco en tiempo real con Supabase Realtime o polling liviano.

## 7. Plan de construcción (orden)
1. Migración: esquema `futbol`, tablas, índices, RLS, vista, `config` con valores v1.
2. Llaves VAPID → secretos `VAPID_PUBLIC`, `VAPID_PRIVATE`; verificar `APIFOOTBALL_KEY`.
3. Edge Function `escaner` (radar → candidatos → stats + cuotas → snapshot → regla → alerta/push → resolución de partidos terminados → contabilidad de API).
4. Prueba manual con datos reales (1–3 consultas); ajustar el parser de mercados de cuotas.
5. pg_cron + pg_net cada N min.
6. PWA (manifest, service worker con push, pantallas).
7. Publicación en GitHub Pages / Cloudflare Pages + instrucciones del CNAME `goles` → hosting.
8. Verificación de punta a punta y entrega de los pasos manuales a Fredy.

## 8. Hoja de ruta posterior
- v2 del algoritmo con los datos acumulados (ajuste de pesos del IP, ventanas de minuto, filtrado por liga).
- Aislar ligas rentables y descartar las de bajo rendimiento.
- Pasar a Pro cuando el ROI simulado sea positivo con una muestra suficiente (≥100 alertas).
- Modelo de IA entrenado con `snapshots` + `alertas`.

## 9. Cambios de la versión 1.1 (propuestos tras la construcción)
Cada punto reemplaza o precisa lo dicho arriba. El porqué detallado está en `DECISIONES.md`.

1. **Acceso a datos desde la PWA (sec. 5 y 6):** la PWA no usa Supabase JS ni la publishable key. Lee y escribe a través de la Edge Function `api`. El esquema `futbol` no se expone en la API REST del proyecto. La RLS queda como defensa en profundidad.
2. **Tablas nuevas (sec. 5):** `reglas` (foto de parámetros por versión), `escaneos` (bitácora de cada radar) y `admin` (hash del PIN). `config` gana la columna `es_regla`.
3. **Columnas nuevas (sec. 5):** `partidos.cuota_pre_consultada`, `minuto`, `goles_local_90`, `goles_visitante_90`; `snapshots.regla_version`, `evaluacion`; `alertas.snapshot_id`, `goles_al_alertar`, `linea_over`, `push_enviados`; `push_suscripciones.activa`, `fallos`.
4. **Escritura desde la PWA (sec. 6):** cambiar umbrales o aislar ligas exige un PIN de administrador. Cambiar un parámetro de regla crea automáticamente `v2`, `v3`…
5. **Agenda (sec. 3 y 7.5):** pg_cron dispara cada 5 min y la función decide si le toca. El intervalo real se calcula repartiendo el presupuesto restante entre las horas activas (`horas_activas_utc`, `fraccion_radar`): hoy da un radar cada ~20 min, y 10 min cuando hay candidatos en seguimiento.
6. **Favorito (sec. 4):** la cuota prepartido es el promedio de todas las casas que publica la API, y se consulta solo para partidos donde alguien ya va perdiendo en el entretiempo o el 2T.
7. **Momentum (sec. 4):** se compara contra el snapshot más cercano a 15 min atrás, con separación mínima de 8 min (`momentum_gap_min`). Sin snapshot previo no hay alerta. Consecuencia: la primera alerta posible de un partido llega en el segundo radar que lo ve como candidato.
8. **Resolución (sec. 4):** se liquida con el marcador del tiempo reglamentario (`score.fulltime`), sin prórroga, que es como paga el mercado Over.
9. **Modo calibración:** `cuotas_siempre=true` pide la cuota en vivo en cada snapshot. Gasta más consultas pero permite validar el parser y deja la serie de cuotas para el modelo. Apagarlo cuando el parser esté confirmado.
10. **Hosting (sec. 2 y 7.7):** GitHub Pages desde el repo público `fisicoelectrico/alertas-gol`, carpeta `web/`, publicado por GitHub Actions.
11. **Pendiente (a) de la sec. 3:** se confirma que no hay "ataques peligrosos"; el IP usa solo las estadísticas listadas. **Pendiente (b):** el parser de `/odds/live` acepta "Over/Under Line" y "Match Goals" con la línea en `handicap`; falta confirmarlo con la primera respuesta real (queda guardada en `snapshots.raw`).
12. **Pantalla Radar (sec. 6) y columna `escaneos.radar` (sec. 5):** nueva pestaña con el número de partidos en vivo que entrega API-Football en cada radar, su evolución en 24 h, la lista por liga con el motivo de descarte de cada partido y una tabla de ligas con huecos de cobertura. Se alimenta de la respuesta que el radar ya pide (cero consultas extra). La foto por partido se conserva 7 días.

## 10. Cambios de la versión 1.2 (aprobados por Fredy, 10 nov 2026)
1. **Agenda (sec. 3, reemplaza el punto 5 de la sec. 9):** dos relojes. Radar (`/fixtures?live=all`) con el intervalo del reparto del presupuesto; seguimiento de candidatos cada `intervalo_seguimiento_min` (5 min) con `/fixtures?id=X` (marcador + estadísticas en 1 consulta por partido; el lote `?ids=` no está en el plan Free) + `/odds/live` por candidato. El seguimiento tiene prioridad; el radar se espacia solo cuando el seguimiento consume.
2. **Contabilidad (sec. 3):** un candidato cuesta ~2 consultas cada 5 min (~18 en su vida útil). En Free alcanza para 1 o 2 candidatos al día sin dejar al radar sin cuota.
3. **Cobertura (sec. 3):** un partido con 2 respuestas seguidas sin estadísticas sale del seguimiento (`partidos.sin_stats`). Primer caso real: Reserve League de Argentina, sin estadísticas ni cuota en vivo en API-Football (verificado el 10 nov).
4. **Esquema (sec. 5):** `partidos.sin_stats int`, `partidos.cuota_vivo_probada bool`; `config.ultimo_seguimiento`; `escaneos.motivo` admite `seguimiento`.

## 11. Cambios propuestos para la versión 1.3 (13 nov 2026, pendientes de aprobación de Fredy)
1. **Consumo (sec. 3):** se suman tres consultas "de planeación": `/leagues?current=true` (1 por semana, cobertura de cuotas y estadísticas por liga), `/fixtures?date=HOY` (1 por día, agenda) y `/odds?league&season&date&bet=1` (cuotas prepartido en bloque, 10 partidos por consulta, para ligas con 3+ partidos en el día). La consulta de a uno (`/odds?fixture`) queda solo para ligas chicas o si el bloque falla.
2. **Agenda (reemplaza el punto 1 de la sec. 10):** el radar corre solo si algún partido de liga útil está en su zona útil (descanso → minuto ~77) y su intervalo reparte el presupuesto entre los minutos de zona que quedan en el día. El seguimiento no cambia.
3. **Sin gasto en lo que no puede alertar:** ligas sin cobertura de cuotas o estadísticas (según la API o aprendido de la historia) y partidos vistos por primera vez después del minuto `minuto_max − momentum_gap_min`.
4. **Esquema (sec. 5):** tablas `agenda` y `cuotas_bloque`; columnas `ligas.cob_odds`, `ligas.cob_stats`, `ligas.cob_actualizada`; vista `v_cobertura_liga`; config `usar_agenda`, `cuotas_bloque_min_partidos`, `cuotas_bloque_max_dia`, `agenda_fecha`, `cobertura_ts`; motivos de radar `sin_cobertura` y `tarde`; motivo de escaneo `previa`.
5. **No cambia la regla:** sigue la v3. Ver DECISIONES 27.
