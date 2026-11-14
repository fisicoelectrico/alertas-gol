package com.fredyquiroga.goles;

import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.time.Duration;
import java.time.OffsetDateTime;

/**
 * Widget "N en vivo · M candidatos" con la lista de partidos.
 *
 * Cómo funciona:
 *  1. Android llama onUpdate() al poner el widget (y cada 30 min como respaldo, ver goles_widget.xml).
 *  2. Se programa una tarea periódica de 15 min (Refresco, con JobScheduler) y se pide el dato ya.
 *  3. refrescar() hace GET a /api/widget de Supabase: la última foto del radar, que el escáner
 *     guarda cada 5 min. No gasta consultas de API-Football.
 *  4. Con el JSON se arma un RemoteViews (la vista que el launcher pinta por nosotros) y se entrega.
 */
public class GolesWidget extends AppWidgetProvider {
    static final String API = "https://zdhkhsrwvvripuczhvam.supabase.co/functions/v1/api/widget";
    static final String PWA = "https://goles.fredyquiroga.com/";
    static final String ACTUALIZAR = "com.fredyquiroga.goles.ACTUALIZAR";
    static final int JOB_ID = 4501;

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        programar(ctx);
        refrescarEnSegundoPlano(ctx);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        if (ACTUALIZAR.equals(intent.getAction())) refrescarEnSegundoPlano(ctx);
    }

    @Override
    public void onDisabled(Context ctx) {
        // Se quitó el último widget: no tiene sentido seguir consultando.
        ctx.getSystemService(JobScheduler.class).cancel(JOB_ID);
    }

    static void programar(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        if (js.getPendingJob(JOB_ID) != null) return;
        js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(ctx, Refresco.class))
                .setPeriodic(15 * 60 * 1000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(false)
                .build());
    }

    /** onUpdate/onReceive corren en el hilo principal: la red va en otro hilo (goAsync da ~10 s). */
    private void refrescarEnSegundoPlano(Context ctx) {
        final PendingResult pr = goAsync();
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            try { refrescar(app); } finally { pr.finish(); }
        }).start();
    }

    /** Pide el dato y pinta todos los widgets. Se llama desde un hilo de fondo. */
    static void refrescar(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, GolesWidget.class));
        if (ids.length == 0) return;
        RemoteViews rv;
        try {
            rv = pintar(ctx, new JSONObject(descargar()));
        } catch (Exception e) {
            rv = base(ctx);
            rv.setTextViewText(R.id.hora, "sin conexión · toca ⟳");
        }
        mgr.updateAppWidget(ids, rv);
    }

    static String descargar() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(API).openConnection();
        c.setConnectTimeout(6000);
        c.setReadTimeout(6000);
        c.setRequestProperty("Accept", "application/json");
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
            StringBuilder sb = new StringBuilder();
            String linea;
            while ((linea = r.readLine()) != null) sb.append(linea);
            return sb.toString();
        } finally {
            c.disconnect();
        }
    }

    /** Vista vacía con los toques ya conectados: cabecera abre la PWA, ⟳ refresca. */
    static RemoteViews base(Context ctx) {
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget);
        int mut = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        rv.setOnClickPendingIntent(R.id.cabecera, PendingIntent.getActivity(ctx, 1,
                new Intent(Intent.ACTION_VIEW, Uri.parse(PWA + "#vivo")), mut));
        Intent act = new Intent(ctx, GolesWidget.class).setAction(ACTUALIZAR);
        rv.setOnClickPendingIntent(R.id.actualizar, PendingIntent.getBroadcast(ctx, 2, act, mut));
        return rv;
    }

    static RemoteViews pintar(Context ctx, JSONObject j) throws Exception {
        RemoteViews rv = base(ctx);
        int vivos = j.optInt("vivos"), cand = j.optInt("candidatos");
        rv.setTextViewText(R.id.vivos, String.valueOf(vivos));
        rv.setTextViewText(R.id.candidatos, String.valueOf(cand));
        rv.setTextColor(R.id.candidatos, cand > 0 ? 0xFFFFC247 : 0xFFE8F0EA);
        rv.setTextViewText(R.id.hora, hace(j.optString("ts", null)));

        JSONArray ps = j.optJSONArray("partidos");
        int n = ps == null ? 0 : ps.length();
        rv.setViewVisibility(R.id.vacio, n == 0 ? View.VISIBLE : View.GONE);

        if (Build.VERSION.SDK_INT >= 31) {
            // Android 12+: la lista se entrega completa y el launcher la hace deslizable.
            RemoteViews.RemoteCollectionItems.Builder b = new RemoteViews.RemoteCollectionItems.Builder();
            for (int i = 0; i < n; i++) b.addItem(i, fila(ctx, ps.getJSONObject(i)));
            b.setViewTypeCount(1);
            rv.setRemoteAdapter(R.id.lista, b.build());
            rv.setPendingIntentTemplate(R.id.lista, PendingIntent.getActivity(ctx, 3,
                    new Intent(Intent.ACTION_VIEW, Uri.parse(PWA + "#radar")),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE));
            rv.setViewVisibility(R.id.lista, View.VISIBLE);
            rv.setViewVisibility(R.id.lista_simple, View.GONE);
        } else {
            // Android 8-11: sin listas de este tipo; se muestran los primeros 6 como texto.
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < Math.min(n, 6); i++) sb.append(texto(ps.getJSONObject(i))).append('\n');
            if (n > 6) sb.append("+").append(n - 6).append(" más");
            rv.setTextViewText(R.id.lista_simple, sb.toString().trim());
            rv.setViewVisibility(R.id.lista, View.GONE);
            rv.setViewVisibility(R.id.lista_simple, View.VISIBLE);
        }
        return rv;
    }

    static RemoteViews fila(Context ctx, JSONObject p) {
        RemoteViews f = new RemoteViews(ctx.getPackageName(), R.layout.fila);
        f.setTextViewText(R.id.minuto, minuto(p));
        String fav = p.optString("fav", "");
        f.setTextViewText(R.id.local, p.optString("l") + ("home".equals(fav) ? " ★" : ""));
        f.setTextViewText(R.id.marcador, p.optInt("gl") + "–" + p.optInt("gv"));
        f.setTextViewText(R.id.visitante, ("away".equals(fav) ? "★ " : "") + p.optString("v"));
        boolean c = p.optBoolean("c");
        f.setInt(R.id.fila, "setBackgroundResource", c ? R.drawable.fila_candidato : 0);
        f.setOnClickFillInIntent(R.id.fila, new Intent());
        return f;
    }

    static String texto(JSONObject p) {
        return (p.optBoolean("c") ? "● " : "") + minuto(p) + "  " + p.optString("l") + " " + p.optInt("gl") + "–" + p.optInt("gv") + " " + p.optString("v");
    }

    static String minuto(JSONObject p) {
        String e = p.optString("e", "");
        if ("HT".equals(e)) return "Desc.";
        if (p.isNull("m")) return e;
        return p.optInt("m") + "'";
    }

    static String hace(String ts) {
        if (ts == null || ts.isEmpty() || "null".equals(ts)) return "sin radar aún";
        try {
            long m = Duration.between(OffsetDateTime.parse(ts.replace(' ', 'T')), OffsetDateTime.now()).toMinutes();
            return m < 1 ? "radar: ahora" : m < 60 ? "radar: hace " + m + " min" : "radar: hace " + (m / 60) + " h";
        } catch (Exception e) {
            return "";
        }
    }
}
