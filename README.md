# Alertas de Gol en Vivo

Detecta partidos donde el **favorito va perdiendo en el segundo tiempo y presiona**, y avisa por
notificación push cuando la cuota de "un gol más" (Over goles actuales + 0.5) llega al umbral.
Todo queda guardado para medir si el acierto real supera la probabilidad implícita de la cuota.

## Cómo fluye la información

```
pg_cron (cada 5 min)
   └─ pg_net ──► Edge Function `escaner` ──► API-Football (máx. 100 consultas/día)
                     │  radar → favoritos → estadísticas + cuotas → regla
                     ▼
              Postgres, esquema `futbol`  (partidos, snapshots, alertas, api_uso…)
                     │                         │
                     ▼                         ▼
              Web Push (VAPID)          Edge Function `api`  ◄── PWA (GitHub Pages)
              al celular                (lecturas + cambios con PIN)
```

| Carpeta | Qué hay |
|---|---|
| `supabase/migrations/` | SQL del esquema `futbol`, RLS, vista de rendimiento y cron |
| `supabase/functions/escaner/` | El escáner (orquestación) |
| `supabase/functions/api/` | La API que consume la PWA |
| `supabase/functions/_shared/` | `algoritmo.ts` (regla, funciones puras), `apifootball.ts` (cliente con presupuesto), `webpush.ts` (cifrado push), `db.ts` |
| `web/` | La PWA (HTML/CSS/JS sin frameworks, service worker, manifest) |
| `docs/` | Especificación, decisiones tomadas y guía de puesta en marcha |

## Documentos
- [`docs/02_ESPECIFICACION_TECNICA.md`](docs/02_ESPECIFICACION_TECNICA.md): especificación, versión 1.1 propuesta (la 1.0 original sigue en los archivos del proyecto).
- [`docs/DECISIONES.md`](docs/DECISIONES.md): decisiones tomadas durante la construcción y su porqué.
- [`docs/PUESTA_EN_MARCHA.md`](docs/PUESTA_EN_MARCHA.md): DNS, instalar la PWA, activar notificaciones, operación diaria.

## Secretos
Ninguno vive en este repositorio. `APIFOOTBALL_KEY`, `VAPID_PUBLIC` y `VAPID_PRIVATE` están en
Supabase → Edge Functions → Secrets. El PIN de administrador se guarda como hash bcrypt en `futbol.admin`.
