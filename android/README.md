# Widget de Android (APK)

App mínima cuyo único trabajo es el **widget de pantalla de inicio**: "N en vivo · M candidatos" y la lista
deslizable de partidos (candidatos resaltados en ámbar). La app completa y las alertas push siguen siendo la PWA.

## Por qué un APK aparte y no la PWA

Android no deja que una PWA ponga widgets en la pantalla de inicio (Chrome no implementa los widgets del
manifiesto; solo existen en Windows). Un widget es un `AppWidgetProvider` nativo, así que hace falta un APK.
Este APK no reemplaza a la PWA: tocar el widget abre `goles.fredyquiroga.com`, y si la PWA está instalada
Android la abre a ella.

## Cómo funciona

1. `GolesWidget.onUpdate()` se ejecuta al poner el widget; programa `Refresco` (JobScheduler, cada 15 min,
   el mínimo de Android) y pide el dato al instante.
2. El dato sale de `GET /api/widget` (Edge Function `api`): la última foto del radar que el escáner guarda
   cada 5 min. **No gasta consultas de API-Football.**
3. Con el JSON se arma un `RemoteViews` (el launcher pinta la vista por nosotros). En Android 12+ la lista
   va como `RemoteCollectionItems` y se puede deslizar; en Android 8-11 se muestran los primeros 6 como texto.
4. El botón ⟳ manda un broadcast `ACTUALIZAR` al mismo receptor para refrescar sin esperar.

Sin librerías externas: solo el framework de Android (`HttpURLConnection`, `org.json`, `JobScheduler`).

## Compilar y publicar

No hace falta Android Studio: el workflow `.github/workflows/android.yml` compila en GitHub Actions con cada
cambio en `android/` y publica un Release. Enlace fijo al último APK:

https://github.com/fisicoelectrico/alertas-gol/releases/latest/download/alertas-gol-widget.apk

## Firma

`goles-widget.keystore` está en el repo a propósito. Android solo deja **actualizar** un APK si la nueva versión
viene firmada con la misma llave; con una llave aleatoria por compilación habría que desinstalar cada vez.
La llave no protege datos (el APK solo lee un endpoint público), así que el riesgo de que sea pública se
reduce a esto: alguien podría firmar un APK falso con ella, pero solo te afecta si lo instalas tú desde otro
lado. Si algún día el APK maneja algo privado, se mueve a un secreto de GitHub Actions y se cambia la llave
(eso obliga a desinstalar una vez).
