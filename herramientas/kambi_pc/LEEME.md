# Cuotas de córners de BetPlay y Rushbet desde tu PC

BetPlay y Rushbet funcionan sobre la plataforma **Kambi**. Kambi publica las cuotas en un feed JSON que el navegador lee sin iniciar sesión. Ese feed le responde "No access" a los servidores (Supabase), pero sí responde a una IP colombiana normal como la de tu casa. Por eso este script corre en tu PC: lee los mercados de **córners** de los partidos en vivo y los sube a la base de la app. No usa tus cuentas ni tu sesión.

## Qué necesitas
- **Python 3.10 o más nuevo.** En Windows se instala desde python.org; en el instalador marca "Add python.exe to PATH". No hace falta instalar paquetes.
- **Tu PIN de administrador de ADN Soccer.** El script lo pide al arrancar y no lo guarda en ningún archivo.

## Paso 1: probar (no sube nada)
Abre una terminal en esta carpeta y ejecuta:
```
python kambi_corners.py --probar
```
Esto da una vuelta y muestra, para cada casa, cuántos partidos hay en vivo y los primeros mercados de córners que encontró. Mándame lo que salga: con eso confirmo los nombres de los mercados y ajusto lo que haga falta.

Si una casa dice "Kambi respondió 404" o algo parecido, el código de esa casa no es el correcto. Para encontrarlo:
1. Abre la página de en vivo de la casa en Chrome y pulsa F12 → pestaña **Network**.
2. Escribe `offering` en el filtro.
3. Verás direcciones como `.../offering/v2018/XXXX/...`. La parte `XXXX` es el código.
4. Pruébalo así: `python kambi_corners.py --probar --betplay XXXX` (o `--rushbet XXXX`).

## Paso 2: dejarlo corriendo
```
python kambi_corners.py
```
El script pide el PIN y da una vuelta cada 3 minutos (se cambia con `--cada 5`), hasta que cierres la ventana o pulses Ctrl+C. En cada vuelta escribe una línea por casa con cuántos partidos subió.

Para cuidar la carga sobre las casas:
- Solo pide cuotas de los partidos que están en la franja útil: el 1T desde el minuto 10 y el 2T desde el 60.
- Pide máximo 25 partidos por casa en cada vuelta (`--max`).
- Hace un pedido a la vez, con una pausa corta entre uno y otro.

## Dónde queda la información
En la tabla `futbol.corners_cuotas_casa`: una fila por casa, partido y vuelta. Cada fila guarda el minuto, el marcador, los córners que llevaba el partido (los lee el servidor en Flashscore) y las cuotas del 1T más de 0,5, 1,5, 2,5 y 3,5. También guarda todos los mercados de córners en `mercados`.

## Límites y riesgos
- Solo junta datos mientras el PC esté prendido y el script abierto.
- Leer el feed de forma automática va en contra de los términos de las casas (igual que Flashscore). Fredy lo autorizó para uso personal el 19 nov. Si alguna casa empieza a bloquear, se cierra el script y no pasa nada más.
- Si Kambi cambia el formato, el script avisa con un error por línea y sigue con la otra casa.
