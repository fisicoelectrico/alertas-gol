package com.fredyquiroga.goles;

import android.app.Application;

/** Registra cualquier cierre inesperado en la caja negra antes de que Android cierre la app. */
public class Aplicacion extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        // El canal "Alertas de gol" existe desde que se abre la app, así aparece en Ajustes antes de la primera alerta
        try { AlertasGol.crearCanal(this); } catch (Throwable t) { Diagnostico.guardar(this, "crear canal", t); }
        final Thread.UncaughtExceptionHandler previo = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((hilo, t) -> {
            Diagnostico.guardar(this, "cierre en hilo " + hilo.getName(), t);
            if (previo != null) previo.uncaughtException(hilo, t);
        });
    }
}
