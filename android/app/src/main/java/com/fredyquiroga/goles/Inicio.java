package com.fredyquiroga.goles;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Pantalla de bienvenida: el APK existe por el widget; la app completa sigue siendo la PWA. */
public class Inicio extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setGravity(Gravity.CENTER);
        l.setPadding(56, 56, 56, 56);
        l.setBackgroundColor(0xFF0D1512);

        TextView t = new TextView(this);
        t.setTextColor(0xFFE8F0EA);
        t.setTextSize(16);
        t.setText("Goles widget\n\nMantén presionado un espacio vacío de la pantalla de inicio → Widgets → "
                + "\"Goles widget\" y arrástralo.\n\nMuestra cuántos partidos hay en vivo, cuántos son candidatos "
                + "y la lista (deslizable). Se actualiza solo cada 15 min; el botón ⟳ lo actualiza al instante.\n\n"
                + "Las alertas siguen llegando por la app web (PWA).");
        l.addView(t);

        Button abrir = new Button(this);
        abrir.setText("Abrir Alertas de Gol");
        abrir.setOnClickListener(v -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(GolesWidget.PWA))));
        l.addView(abrir);
        // Caja negra: si algo falló, se muestra aquí para poder enviar una captura.
        String err = Diagnostico.leer(this);
        if (err != null) {
            TextView e = new TextView(this);
            e.setTextColor(0xFFFF6B5E);
            e.setTextSize(11);
            e.setTextIsSelectable(true);
            e.setPadding(0, 32, 0, 0);
            e.setText("Último error registrado (mándale captura a Claude):\n" + err);
            l.addView(e);
            Button borrar = new Button(this);
            borrar.setText("Borrar error");
            borrar.setOnClickListener(v -> { Diagnostico.borrar(this); recreate(); });
            l.addView(borrar);
        }
        android.widget.ScrollView sv = new android.widget.ScrollView(this);
        sv.setBackgroundColor(0xFF0D1512);
        sv.addView(l);
        setContentView(sv);

        try { GolesWidget.programar(this); } catch (Throwable ex) { Diagnostico.guardar(this, "programar", ex); }
    }
}
