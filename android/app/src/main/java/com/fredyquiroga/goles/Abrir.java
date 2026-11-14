package com.fredyquiroga.goles;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/** Trampolín sin pantalla: los toques del widget llegan aquí (intent explícito) y se abre la PWA. */
public class Abrir extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(GolesWidget.PWA + "#radar"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Throwable t) {
            Diagnostico.guardar(this, "abrir", t);
        }
        finish();
    }
}
