package com.fredyquiroga.goles;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Tarea que JobScheduler despierta cada ~15 min: refresca el widget en un hilo de fondo. */
public class Refresco extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            GolesWidget.refrescar(getApplicationContext());
            jobFinished(params, false);
        }).start();
        return true; // el trabajo sigue en el hilo
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true; // si Android lo corta, que lo reintente
    }
}
