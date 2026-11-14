package com.fredyquiroga.goles;

import android.app.Application;

/** Registra cualquier cierre inesperado en la caja negra antes de que Android cierre la app. */
public class Aplicacion extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        final Thread.UncaughtExceptionHandler previo = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((hilo, t) -> {
            Diagnostico.guardar(this, "cierre en hilo " + hilo.getName(), t);
            if (previo != null) previo.uncaughtException(hilo, t);
        });
    }
}
