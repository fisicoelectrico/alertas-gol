package com.fredyquiroga.goles;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.Context;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

import com.google.androidbrowserhelper.trusted.DelegationService;

/**
 * Servicio de delegación con sonido propio para las alertas.
 *
 * Cómo llega una push al teléfono con la TWA verificada:
 *   servidor → Chrome (recibe la push y corre sw.js) → showNotification() → Chrome NO la pinta: llama a este
 *   servicio con la notificación ya armada (título, texto, botones) y el nombre de un canal.
 *
 * En Android 8+ el sonido y la vibración no son de la notificación sino del CANAL donde se publica. La web no
 * puede escoger canal; nosotros sí, porque aquí la notificación ya está en manos de la app. Entonces:
 *   - Alertas (traen los botones Entré / No entro), avisos de "¡Gooool!" y la prueba de Ajustes
 *     → canal "Alertas de gol" con el sonido res/raw/gol.ogg y vibración larga propia.
 *   - Avisos de córners del laboratorio (el texto empieza por "Córners 1T/2T")
 *     → canal "Alertas de córners", con el tono de notificación del teléfono para que Fredy le escoja
 *       otro (p. ej. un pito) en Ajustes → ADN Soccer → Categorías de notificación (Fredy, 19 nov).
 *   - Todo lo demás (resultados, avisos técnicos, confirmaciones silenciosas) → igual que antes (canal de Chrome).
 *
 * Poka-yoke: Android no deja cambiar el sonido de un canal ya creado. Si cambias gol.ogg, sube el número de
 * CANAL (alertas_gol_v2…) o el teléfono seguirá sonando con el viejo.
 */
public class AlertasGol extends DelegationService {
    static final String CANAL = "alertas_gol_v1";
    static final String CANAL_CORNERS = "alertas_corners_v1";
    // espera, vibra, pausa, vibra, pausa, vibración larga: se reconoce en el bolsillo y en el reloj
    static final long[] VIBRACION = {0, 250, 120, 250, 120, 700};

    @Override
    public boolean onNotifyNotificationWithChannel(String platformTag, int platformId,
                                                   Notification notification, String channelName) {
        String canal = Build.VERSION.SDK_INT < 26 ? null
                : esDeCorners(notification) ? CANAL_CORNERS
                : esDeGol(notification) ? CANAL : null;
        if (canal == null) {
            return super.onNotifyNotificationWithChannel(platformTag, platformId, notification, channelName);
        }
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm == null || !nm.areNotificationsEnabled()) return false;
            crearCanal(this);
            NotificationChannel c = nm.getNotificationChannel(canal);
            if (c != null && c.getImportance() == NotificationManager.IMPORTANCE_NONE) return false; // canal apagado por el usuario
            // Misma técnica que usa la librería de Google: reconstruir la notificación y moverla de canal.
            // Se conservan título, texto, ícono, botones, acción al tocar y el tag (para reemplazar recordatorios).
            Notification n = Notification.Builder.recoverBuilder(this, notification).setChannelId(canal).build();
            nm.notify(platformTag, platformId, n);
            return true;
        } catch (Throwable t) {
            // Poka-yoke: si algo falla con el canal propio, la alerta igual llega por el canal normal
            Diagnostico.guardar(this, "canal " + canal, t);
            return super.onNotifyNotificationWithChannel(platformTag, platformId, notification, channelName);
        }
    }

    /** ¿Es un aviso de entrada de córners? El servidor (_shared/corners.ts) arranca el texto con "Córners 1T:" o
     *  "Córners 2T:"; los resultados empiezan por ✅/❌ y siguen en el canal normal. */
    static boolean esDeCorners(Notification n) {
        if (n.actions != null && n.actions.length > 0) return false;
        CharSequence t = n.extras != null ? n.extras.getCharSequence(Notification.EXTRA_TEXT) : null;
        return t != null && t.toString().toLowerCase().startsWith("córners ");
    }

    /** ¿Es una alerta de trading o un gol? Se decide con lo que ya trae la notificación, sin tocar el servidor. */
    static boolean esDeGol(Notification n) {
        if (n.actions != null && n.actions.length > 0) return true; // alerta y recordatorios: botones Entré / No entro
        CharSequence t = n.extras != null ? n.extras.getCharSequence(Notification.EXTRA_TITLE) : null;
        if (t == null) return false;
        String s = t.toString().toLowerCase();
        return s.startsWith("¡goo") || s.startsWith("¡gol") || s.contains("prueba de adn soccer");
    }

    /** Crea el canal (si ya existe, Android lo deja como esté: respeta lo que el usuario haya cambiado). */
    static void crearCanal(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel c = new NotificationChannel(CANAL, "Alertas de gol", NotificationManager.IMPORTANCE_HIGH);
        c.setDescription("Alertas en vivo y goles de ADN Soccer, con sonido de gol");
        Uri sonido = Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + ctx.getPackageName() + "/" + R.raw.gol);
        c.setSound(sonido, new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        c.enableVibration(true);
        c.setVibrationPattern(VIBRACION);
        c.enableLights(true);
        c.setLightColor(0xFF22C55E);
        c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(c);

        // Córners: sonido = tono de notificación del teléfono, para cambiarlo desde Ajustes sin tocar el de gol.
        NotificationChannel k = new NotificationChannel(CANAL_CORNERS, "Alertas de córners", NotificationManager.IMPORTANCE_HIGH);
        k.setDescription("Avisos de córners del laboratorio. Escoge aquí su sonido (p. ej. un pito)");
        k.setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI, new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        k.enableVibration(true);
        k.setVibrationPattern(new long[]{0, 400, 150, 400}); // dos vibraciones parejas: distinta a la de gol
        k.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(k);
    }
}
