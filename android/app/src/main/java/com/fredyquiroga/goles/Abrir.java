package com.fredyquiroga.goles;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/** Trampolín sin pantalla: los toques del widget llegan aquí (intent explícito) y se abre la app (TWA). */
public class Abrir extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        try {
            startActivity(abrirApp(this, GolesWidget.PWA + "#radar"));
        } catch (Throwable t) {
            Diagnostico.guardar(this, "abrir", t);
        }
        finish();
    }

    /** Intent explícito a la actividad de la TWA: abre la PWA en modo app (sin pasar por el selector de apps). */
    static Intent abrirApp(android.content.Context c, String url) {
        return new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .setClassName(c, "com.google.androidbrowserhelper.trusted.LauncherActivity")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }
}
