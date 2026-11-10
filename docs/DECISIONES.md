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

## Límites que hay que tener presentes
- **No es minuto a minuto.** Con un radar cada 10 a 20 min, la cuota puede cruzar 1,40 y un gol caer entre dos radares. La cuota registrada es la del momento del radar, no la del cruce.
- **Cobertura parcial de cuotas en vivo.** API-Football no trae `/odds/live` para todas las ligas; esos partidos nunca alertan (quedan con cuota vacía en el snapshot).
- **El ROI simulado es optimista:** asume que se consigue la cuota de la API. La casa real puede pagar menos.
- **Muestra:** con pocas alertas por día, llegar a 100 alertas resueltas puede tomar semanas. La pantalla Rendimiento muestra el margen de error para no sacar conclusiones antes de tiempo.
- **El parser de `/odds/live` aún no se validó con una respuesta real** (no había partidos en vivo al construir). El modo calibración guarda la respuesta cruda del primer candidato para confirmarlo.
