# Decisiones tomadas durante la construcción
*10 nov 2026. Fredy pidió decidir lo que faltara y dejarlo anotado. Cada decisión trae su porqué y cómo revertirla.*

## Arquitectura
**1. La PWA habla solo con la Edge Function `api`, no con las tablas.**
La especificación decía Supabase JS + publishable key. Para eso habría que "exponer" el esquema `futbol` en la API REST del proyecto, que es un ajuste global de `central-ingenieria` (afecta a los demás esquemas). Con una función propia no se toca nada global, cada pantalla hace una sola petición y las escrituras pasan por una lista blanca. La RLS se dejó igual que en la especificación como segunda barrera.

**2. Las funciones se conectan a Postgres directo (`SUPABASE_DB_URL`).**
Misma razón: supabase-js pasa por la API REST, que no ve `futbol`.

**3. PIN de administrador para cambiar umbrales y ligas.**
La app es pública (cualquiera con la URL la abre). Sin PIN cualquiera podría mover los umbrales o apagar el escáner. El PIN se guarda como hash bcrypt en `futbol.admin`; 5 intentos fallidos bloquean 15 minutos. Se cambia desde Ajustes.

**4. Web Push implementado a mano con WebCrypto.**
Las librerías de web-push dependen de módulos de Node que en Edge Functions dan problemas. Son ~120 líneas (`_shared/webpush.ts`) y están verificadas contra la librería de referencia `http_ece` (descifra lo que ciframos) y con la verificación de la firma VAPID.

**5. Repo público en GitHub Pages.**
Pages gratis exige repo público. No hay secretos en el repo.

## Presupuesto de API (100/día)
**6. El cron corre cada 5 min pero la función se autorregula.**
Así el intervalo se cambia desde `futbol.config` sin tocar el cron. La función sale sin gastar nada si está fuera de horario, si no ha pasado el intervalo o si no hay presupuesto.

**7. Horario activo 12:00 a 02:59 UTC (7 a. m. a 9:59 p. m. Colombia).**
Cubre Europa por la mañana y América por la tarde y noche. Fuera de ese horario solo se escanea si hay un candidato o una alerta pendiente.

**8. Reparto: mitad radares, mitad detalle; reserva de 6.**
`intervalo = max(15, minutos_activos_restantes / (disponibles × 0.5))`. Con 94 disponibles da un radar cada ~20 min. Con candidatos en seguimiento baja a 10 min. Máximo 3 partidos con detalle por escaneo, priorizando los de minuto más avanzado.

**9. La cuota prepartido solo se pide para "pre-candidatos"** (entretiempo o 2T con alguien perdiendo) y una sola vez por partido. Pedirla para todos los partidos en vivo agotaría la cuota en un radar.

**10. Si la API dice que quedan menos consultas que nuestra cuenta, manda la API.** Protege contra usos de la key por fuera de la app.

## Algoritmo v1
**11. Favorito = menor cuota promedio 1X2 entre todas las casas**, y solo cuenta si es ≤ 2,00.

**12. Sin xG en ambos equipos, el término xG vale 0 para los dos.** Si solo uno lo trajera, la razón quedaría sesgada.

**13. Momentum exige un snapshot previo con al menos 8 min de separación.** Sin historia no hay alerta: preferimos perder una alerta a disparar una sin evidencia de presión reciente. Costo real en plan Free: la alerta no puede salir antes del segundo radar del partido.

**14. Cuota suspendida no dispara alerta.** Un mercado suspendido no se puede apostar.

**15. Resolución con el marcador a los 90' reglamentarios.**

**16. Cada cambio de parámetro de regla crea `v2`, `v3`… automáticamente** y pide una nota. Una alerta por partido y versión (restricción única en la tabla).

## Pestaña Radar (10 nov 2026, a pedido de Fredy)
**17. El conteo de partidos en vivo sale del mismo radar, sin consultas nuevas.**
Cada barrido ya trae `/fixtures?live=all` completo. Ahora el escáner guarda una foto compacta de esa lista en `futbol.escaneos.radar` (una fila por partido: liga, equipos, minuto, marcador y motivo). La PWA la lee por `GET /api/radar`. Costo en cuota: cero. Costo en BD: ~150 bytes por partido; la foto se borra (se pone en null) a los 7 días y el conteo `partidos_vivos` queda para siempre.

**18. Cada partido cae en un solo motivo: el primer filtro del embudo que no pasa** (`motivoRadar` en `algoritmo.ts`). Se agrupan en cuatro familias: *cobertura* (la API no trae cuota prepartido, estadísticas o cuota en vivo), *aislada por ti*, *regla* (aún no es 2T, empatado, fuera de la ventana, sin favorito claro…) y *en seguimiento*. La cobertura va primero porque es lo que ningún ajuste de la regla recupera.

**19. La cobertura de una liga solo se descubre cuando uno de sus partidos se vuelve precandidato.** Averiguarla para todos (con `/leagues` o `/odds` por partido) gastaría cuota. Consecuencia: una liga sin cuotas aparece como "empatado" o "aún no es 2T" hasta que alguien pierde en el entretiempo o el 2T. Si más adelante hace falta saberlo antes, la opción barata es una consulta diaria a `/odds?date=` o `/leagues?current=true` que trae la cobertura de todas las ligas de una vez.

**20. El número es una foto, no un contador en tiempo real.** Con el plan Free hay un radar cada 15 a 20 min. Para comparar con otra página hay que mirarla cerca de la hora que muestra la pestaña.

## Límites que hay que tener presentes
- **No es minuto a minuto.** Con un radar cada 10 a 20 min, la cuota puede cruzar 1,40 y un gol caer entre dos radares. La cuota registrada es la del momento del radar, no la del cruce.
- **Cobertura parcial de cuotas en vivo.** API-Football no trae `/odds/live` para todas las ligas; esos partidos nunca alertan (quedan con cuota vacía en el snapshot).
- **El ROI simulado es optimista:** asume que se consigue la cuota de la API. La casa real puede pagar menos.
- **Muestra:** con pocas alertas por día, llegar a 100 alertas resueltas puede tomar semanas. La pantalla Rendimiento muestra el margen de error para no sacar conclusiones antes de tiempo.
- **El parser de `/odds/live` aún no se validó con una respuesta real** (no había partidos en vivo al construir). El modo calibración guarda la respuesta cruda del primer candidato para confirmarlo.

## Seguimiento de candidatos cada 5 minutos (10 nov 2026, a pedido de Fredy)
Caso que lo motivó: Quilmes Reserva 0-2 Independiente Rivadavia Reserva (Reserve League, Argentina, fixture 1612177). Entró como candidato al 59' y nunca tuvo snapshot: API-Football devolvió `/fixtures/statistics` vacío en cada consulta (59', ~69', 74'). Sin estadísticas no hay dominancia y la regla v1 no puede disparar, aunque la casa de apuestas ya pagara el Over 2.5 a 1,47. Ningún intervalo lo habría arreglado: es cobertura de la API, no frecuencia.

**21. Dos relojes en el escáner: radar y seguimiento.** El radar (`/fixtures?live=all`) busca partidos nuevos con el intervalo que sale del reparto del presupuesto. El seguimiento corre cada `intervalo_seguimiento_min` (5) solo si hay candidatos, y no repite el radar. Cada reloj tiene su marca en `futbol.config` (`ultimo_radar`, `ultimo_seguimiento`). Lo que gasta el seguimiento baja los disponibles y el radar se espacia solo: los candidatos tienen prioridad sobre buscar partidos nuevos. Revertir: `intervalo_seguimiento_min` alto (p. ej. 15).

**22. `/fixtures?id=X` en vez de radar + `/fixtures/statistics`.** Una consulta por partido devuelve marcador, minuto, estado, eventos y estadísticas. Un ciclo de seguimiento con 1 candidato cuesta 2 consultas (`/fixtures?id` + `/odds/live`); con 3 candidatos, 6. La variante en lote `?ids=a-b-c` (hasta 20 en una consulta) sería más barata, pero se probó en producción y el plan Free la rechaza ("Free plans do not have access to the Ids parameter"); en Pro se puede activar. Si la respuesta no trae la clave `statistics`, se cae al endpoint dedicado (poka-yoke contra un cambio de formato). La resolución de alertas de partidos que salieron del radar también usaba `?ids=`: se cambió a `?id=` de a uno (máx. 3 por radar).

**23. Corte por falta de cobertura.** Si un partido responde 2 veces seguidas sin estadísticas (`partidos.sin_stats`), sale del seguimiento y deja de gastar. En modo calibración se pide una vez `/odds/live` aunque falten estadísticas (`partidos.cuota_vivo_probada`) para saber si la liga tiene cuota en vivo; queda en `snapshots.raw`.

**24. Alertas pendientes sin candidatos** se revisan con el mismo `/fixtures?ids=` cada `intervalo_radar_min`, también fuera del horario activo, en vez de correr radares completos de noche.

**Cuenta del presupuesto Free (94 útiles al día):** la cuota prepartido se lleva ~25-30 (17 entre 7 a. m. y 2:30 p. m. del 10 nov). Un candidato típico vive unos 40-45 min reales (de 46' a 85') = ~9 ciclos × 2 = ~18 consultas. Con 1 candidato al día quedan ~48 para radares (uno cada ~19 min en 15 h); con 2, ~30 (uno cada ~30 min); con 3, ~12 (el radar casi desaparece). En Free caben 1 o 2 candidatos al día bien seguidos. En Pro (7.500) el mismo código aguanta seguimiento cada 1-2 min con decenas de candidatos.

**Verificación real (10 nov, 2:40 p. m.):** el ciclo de seguimiento corrió con 2 consultas. `/fixtures?id=1612177` respondió con `statistics: []` y `/odds/live?fixture=1612177` con `response: []`. Conclusión: para la Reserve League de Argentina API-Football no trae ni estadísticas ni cuota en vivo; la casa de apuestas sí la ofrecía (Over 2.5 a 1,47), pero no por esta API.

**25. Historial por país y liga (11 nov).** Fredy pidió acumular los candidatos por país para ir viendo qué ligas son fuertes. No se guarda nada nuevo: `partidos`, `snapshots` y `alertas` ya son permanentes (lo que se borra a los 7 días es solo `escaneos.radar`). La vista `futbol.v_ligas_historial` arma el embudo por liga (vistos, precandidatos, con favorito, candidatos, con stats, con cuota en vivo, alertas, acierto e implícita media) y la PWA lo agrupa por país en Rendimiento. Se suma por país solo para mostrar: la cobertura y el aislamiento son de cada liga, y una liga "fuerte" es la que acierta por encima de la implícita de sus cuotas, no la que da más candidatos. El % de acierto se muestra desde 20 alertas resueltas. Candidato = tiene snapshot o respondió sin estadísticas (`sin_stats > 0`); los que se quedaron sin cupo de API no cuentan.

**26. Copas fuera, siempre (13 nov, regla v3).** Fredy no juega copas (mundiales, nacionales, continentales ni eliminatorias): no tienen el ritmo estable de una liga (rotaciones, partido único, rivales de categorías distintas), y el primer partido que se coló (Túnez 0-2 Libia, eliminatoria de la Copa Africana, alerta 1, fallo) contaminaba el rendimiento. Regla: si el nombre de la competición contiene alguno de `config.patrones_copa` (`cup, copa, coupe, taça, pokal, coppa, trophy, libertadores, sudamericana, champions league`, sin mayúsculas ni tildes, como subcadena), el partido se ve en la foto del radar con el motivo `copa` pero no se guarda en `partidos`, no pide cuota prepartido ni estadísticas y no puede alertar. Es parámetro de regla (`es_regla = true`), por eso abre la v3: el resto de umbrales queda igual que en la v2. Se filtra por nombre y no con la pestaña Ligas porque las copas aparecen con ids nuevos cada temporada y cada país; apagar liga por liga no escala. Fredy empezó con Cup/Copa y el mismo día sumó Coupe, Taça, Pokal, Coppa, Trophy y las continentales que la API nombra sin la palabra (`CONMEBOL Libertadores`, `CONMEBOL Sudamericana`, `UEFA/CAF/AFC Champions League`). Para otra copa basta agregar el patrón en `config.patrones_copa` (abre una versión nueva). El partido borrado quedó copiado en `futbol.respaldo_borrados` por si hay que revertir.

## Exprimir las 100 consultas (13 nov 2026, a pedido de Fredy)
Caso que lo motivó: el viernes 13 el radar se apagó a las 5:25 p. m. de Colombia (22:25 UTC) por cuota agotada, justo antes de la franja de Sudamérica. Desglose del día: 39 `/odds` prepartido (1 por partido), 30 radares, 16 seguimiento, 8 detalle. De 114 cuotas prepartido pedidas en la historia, 29 (25 %) volvieron vacías y solo 3 partidos llegaron a tener snapshot. El gasto grande no estaba en los candidatos sino en buscar favoritos y en radares a horas sin partidos útiles.

**27. Agenda diaria, cobertura por liga y cuotas en bloque.** Ninguno de estos cambios toca la regla (qué dispara una alerta); solo cambian en qué se gasta. Por eso no abren versión nueva.
- **Cobertura (`/leagues?current=true`, 1 consulta por semana).** La API publica por liga si trae cuotas (`coverage.odds`) y estadísticas de partido (`coverage.fixtures.statistics_fixtures`). Se guarda en `ligas.cob_odds` / `ligas.cob_stats`. Una liga sin cuotas nunca define favorito; una sin estadísticas nunca tiene dominancia: ninguna de las dos puede alertar, así que no se les pide nada. `null` = sin dato = se trata como "sí" (poka-yoke: la falta de dato nunca apaga una liga). Además, la vista `v_cobertura_liga` aprende de nuestra propia historia (2+ cuotas vacías y ninguna llena, o 2+ partidos sin stats y ninguno con ellas).
- **Agenda (`/fixtures?date=HOY`, 1 consulta por día UTC).** Trae todos los partidos del día con su hora. La "zona útil" de un partido va del descanso (pitazo + 45 min de reloj) hasta ~el minuto 77 de juego (pitazo + 105 min). Si ningún partido de liga útil está en zona, el radar no corre (motivo `sin_partidos_en_zona`): no tiene nada que encontrar. Y el intervalo del radar reparte lo que queda solo entre los minutos de zona de lo que resta del día, no entre todas las horas activas. Un día con poco fútbol por la mañana ya no se come la cuota de la noche.
- **Cuotas en bloque (`/odds?league&season&date&bet=1`, 10 partidos por consulta).** Para ligas con `cuotas_bloque_min_partidos` (3) o más partidos útiles que empiezan en las próximas 3 h, una consulta trae los favoritos de toda la jornada y quedan en `agenda`. Cuando el partido llega al descanso con alguien ganando, el favorito sale de ahí sin gastar. Si el bloque falla o quedó incompleto, se vuelve a la consulta de a uno (nunca se da un partido por "sin cuotas" por un error). Tope diario `cuotas_bloque_max_dia` (20).
- **"Tarde" (cero consultas).** El momentum exige un snapshot con estadísticas tomado 8+ minutos antes (`momentum_gap_min`). Un partido sin snapshot que ya pasó el minuto `minuto_max − momentum_gap_min` (77') no puede alertar antes del 85': no se le pide favorito ni detalle. Motivo de radar `tarde`.
- **Tope por ejecución:** los pasos previos gastan como máximo 2 consultas por corrida (el plan Free limita además a 10 por minuto). Lo que no alcanza se hace en la corrida siguiente (5 min después).
- Revertir: `config.usar_agenda = false` vuelve al comportamiento anterior completo.

**Lo que se verificó y lo que no.** La documentación de la API no se pudo abrir desde el entorno de desarrollo (el proxy la bloquea), así que los parámetros `date` de `/fixtures`, `league+season+date` de `/odds` y `current` de `/leagues` se tomaron de la documentación v3 conocida y quedan por confirmar con la primera respuesta real. Cada paso queda en la bitácora (`escaneos.detalle.eventos`) con lo que trajo; si uno falla, el escáner sigue como antes.

**Otras fuentes evaluadas (13 nov).** Ninguna gratuita reemplaza a API-Football con estadísticas + cuota en vivo para todas las ligas. Flashscore tiene todo (stats, xG, Over/Under en vivo) por un feed interno sin bloqueo a servidores, pero sus términos prohíben el acceso automatizado y el uso comercial, el formato es propietario y se rompe sin aviso, y las cuotas dependen de la región del servidor. Sofascore bloquea IPs de datacenter; FotMob prohíbe explícitamente la extracción; ESPN (API oculta) es estable y sin llave pero solo trae stats y cuotas de ligas grandes. The Odds API (500 créditos al mes) se agota en ~2 días a esta cadencia. Abrir varias cuentas Free de API-Football para sumar cuota viola las condiciones de uso y la API agrupa el consumo por IP. Conclusión: exprimir el Free y, cuando la app sea funcional, pasar a Pro.
