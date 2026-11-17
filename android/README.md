# App de Android: ADN Soccer (TWA + widget)

Desde noviembre 2026 este APK es **la app ADN Soccer**: el ícono abre la PWA como *Trusted Web Activity* y las
notificaciones push salen a nombre de la app (no de Chrome). Así el teléfono, y apps como Huawei Health, la
tratan como una app propia: se puede elegir que el reloj vibre con ella. Además trae el widget.

## Cómo funciona la TWA

1. **Trusted Web Activity:** el ícono lanza `LauncherActivity` (librería androidbrowserhelper de Google), que
   abre `goles.fredyquiroga.com` en Chrome *en modo app*: mismo motor, mismas cookies, mismo service worker y
   misma suscripción push que ya tenías en Chrome. No es un WebView ni una copia de la web.
2. **Verificación en dos sentidos (Digital Asset Links):** el APK declara el sitio (`asset_statements` en el
   manifiesto) y el sitio declara el APK en `web/.well-known/assetlinks.json` (paquete + huella SHA-256 de la
   llave de firma). Si coinciden, Chrome quita la barra de URL y confía en la app.
3. **Delegación de notificaciones:** con la TWA verificada, cuando el sitio muestra una notificación Chrome
   no la pinta él: se la pasa al `DelegationService` del APK, que la publica con el nombre e ícono de
   ADN Soccer, en su propio canal de notificaciones.

Si cambia el paquete (`com.fredyquiroga.goles.widget`) o la llave, hay que actualizar `assetlinks.json`; si no,
la app abre con barra de URL y las notificaciones vuelven a salir como Chrome.

---

## Widget (historia)

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
lado. Con la TWA ese APK falso además quedaría "verificado" para el dominio (pantalla completa y recibir las
notificaciones del sitio), otra vez solo en un teléfono donde alguien lo instale. Para cerrar eso: llave nueva
como secreto de Actions + huella nueva en `assetlinks.json` (obliga a desinstalar una vez). Si algún día el APK maneja algo privado, se mueve a un secreto de GitHub Actions y se cambia la llave
(eso obliga a desinstalar una vez).
