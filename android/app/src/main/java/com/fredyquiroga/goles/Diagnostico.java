package com.fredyquiroga.goles;

import android.content.Context;
import android.util.Log;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Caja negra: guarda el último error (con su traza) para verlo en la pantalla de la app.
 * Sin esto, un cierre en el celular no deja rastro que se pueda leer sin cable USB.
 */
public final class Diagnostico {
    private static final String PREFS = "diagnostico", CLAVE = "ultimo_error";

    static void guardar(Context ctx, String donde, Throwable t) {
        try {
            StringWriter sw = new StringWriter();
            t.printStackTrace(new PrintWriter(sw));
            String hora = new SimpleDateFormat("d MMM HH:mm", new Locale("es")).format(new Date());
            String traza = sw.toString();
            if (traza.length() > 3000) traza = traza.substring(0, 3000);
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(CLAVE, hora + " · " + donde + "\n" + traza).commit();
            Log.e("GolesWidget", donde, t);
        } catch (Throwable ignorado) { }
    }

    static String leer(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(CLAVE, null);
    }

    static void borrar(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(CLAVE).commit();
    }
}
