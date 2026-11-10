# Puesta en marcha

## 1. Abrir la app
- Dirección temporal: `https://fisicoelectrico.github.io/alertas-gol/`
- Dirección final (tras el paso 2): `https://goles.fredyquiroga.com`

## 2. Subdominio `goles.fredyquiroga.com`
1. En el panel DNS del dominio (Cloudflare o donde esté `fredyquiroga.com`) crea un registro:
   - Tipo `CNAME`, nombre `goles`, destino `fisicoelectrico.github.io`
   - En Cloudflare déjalo en **"DNS only" (nube gris)**; con el proxy naranja GitHub no puede emitir el certificado HTTPS.
2. En GitHub: repo `alertas-gol` → Settings → Pages → **Custom domain** → escribe `goles.fredyquiroga.com` → Save.
3. Espera a que diga "DNS check successful" y marca **Enforce HTTPS** (puede tardar unos minutos).

Importante: las notificaciones quedan atadas a la dirección desde la que se activan. Si activas en la dirección temporal y luego cambias al subdominio, hay que volver a instalar y activar. Lo ideal es hacer primero el DNS.

## 3. Instalar la PWA
- **Android (Chrome):** abre la dirección → menú ⋮ → "Instalar app" o "Agregar a pantalla principal".
- **iPhone (Safari, iOS 16.4 o superior):** botón Compartir → "Agregar a inicio". En iPhone las notificaciones solo funcionan abriendo la app desde ese ícono.
- **PC (Chrome/Edge):** ícono de instalar en la barra de direcciones.

## 4. Activar notificaciones
1. Abre la app instalada → pestaña **Ajustes** → **Activar notificaciones** → Permitir.
2. Pulsa **Enviar prueba**. Pide el PIN de administrador (te lo entregué por el chat del proyecto; cámbialo ahí mismo con "Cambiar PIN").
3. Debe llegar "Prueba de Alertas de Gol" en unos segundos.

En Android revisa que el ahorro de batería no restrinja a Chrome o a la app, porque puede retrasar las notificaciones.

## 5. Operación
- **Ajustes → Consumo de API hoy:** consultas gastadas (día UTC; se reinicia a las 7 p. m. de Colombia).
- **Ajustes → Últimos escaneos:** qué hizo cada radar.
- **Punto verde arriba a la izquierda:** el radar corrió en los últimos 90 min. Ámbar: fuera de horario o apagado. Rojo: el último radar falló.
- **Modo calibración:** apágalo cuando ya haya snapshots con cuota; ahorra una consulta por snapshot.
- **Pasar a Pro:** cambia `presupuesto_diario` a 7500 e `intervalo_radar_min` / `intervalo_seguimiento_min` a 1 o 2.

## 6. Si algo falla
- Forzar un radar de prueba (gasta 1 a 7 consultas): desde el editor SQL de Supabase
  ```sql
  select net.http_get(
    url := 'https://zdhkhsrwvvripuczhvam.supabase.co/functions/v1/escaner?forzar=1',
    headers := jsonb_build_object('x-token', (select valor #>> '{}' from futbol.config where clave = 'token_forzar')),
    timeout_milliseconds := 120000);
  select * from futbol.escaneos order by ts desc limit 5;
  ```
- Diagnóstico sin gastar cuota: abre `https://zdhkhsrwvvripuczhvam.supabase.co/functions/v1/escaner?diag=1`
- Apagar todo: Ajustes → "Escáner activo", o `select cron.unschedule('futbol-escaner');`
