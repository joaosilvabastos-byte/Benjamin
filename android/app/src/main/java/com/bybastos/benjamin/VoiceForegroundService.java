package com.bybastos.benjamin;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Serviço em primeiro plano (tipo "microphone"). Sem ele, o Android corta o acesso ao microfone
 * e suspende a app quando o ecrã se apaga ou a app vai para segundo plano.
 *
 * Além de manter o processo vivo:
 *  - wake lock parcial COM prazo, renovado a cada batimento (se o serviço morrer, o CPU é libertado sozinho);
 *  - batimento de 5 s que faz avançar o ROTT / verificação de 45 min (SegurancaRott);
 *  - a notificação mostra o estado da câmara de sonolência.
 * Continua START_NOT_STICKY: o Android não o reinicia sozinho (arrancar do ecrã é obrigatório no Android 14).
 */
public class VoiceForegroundService extends Service {

    public static final String ACAO_CONFIRMAR = "com.bybastos.benjamin.CONFIRMAR";
    public static final String ACAO_PARAR_ALARME = "com.bybastos.benjamin.PARAR_ALARME";
    public static final String ACAO_CANCELAR_SOS = "com.bybastos.benjamin.CANCELAR_SOS";

    private static final String TAG = "BenjaminServico";
    private static final String CANAL = "benjamin_voz";
    private static final int ID_NOTIFICACAO = 4711;
    private static final long BATIMENTO_MS = 5_000L;
    private static final long WAKELOCK_MS = 2L * 60 * 1000;   // renovado a cada batimento

    private static volatile VoiceForegroundService instancia;

    private final Handler main = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;
    private String ultimoEstado = "";
    private boolean emPrimeiroPlano;

    private final Runnable batimento = new Runnable() {
        @Override
        public void run() {
            renovarWakeLock();
            try {
                if (SegurancaCore.rott != null) SegurancaCore.rott.tick();
            } catch (RuntimeException e) {
                Log.w(TAG, "tick", e);
            }
            refrescar();
            main.postDelayed(this, BATIMENTO_MS);
        }
    };

    /** Pede à notificação permanente que se refaça (estado da câmara, alarme, SOS...). */
    public static void atualizar() {
        final VoiceForegroundService s = instancia;
        if (s != null) {
            s.main.post(new Runnable() {
                @Override public void run() { s.refrescar(); }
            });
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SegurancaCore.init(getApplicationContext());
        criarCanal();
        tratarAcao(intent);

        try {
            Notification n = montarNotificacao();
            if (Build.VERSION.SDK_INT >= 30) {
                startForeground(ID_NOTIFICACAO, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(ID_NOTIFICACAO, n);
            }
        } catch (RuntimeException e) {
            // Android 14: não deixa arrancar o microfone em segundo plano (ex.: ação de notificação sem a app aberta)
            Log.w(TAG, "startForeground recusado", e);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!emPrimeiroPlano) {
            emPrimeiroPlano = true;
            instancia = this;
            SegurancaCore.servicoAtivo = true;
            renovarWakeLock();
            main.removeCallbacks(batimento);
            main.postDelayed(batimento, BATIMENTO_MS);
        }
        return START_NOT_STICKY;
    }

    private void tratarAcao(Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String a = intent.getAction();
        if (ACAO_CONFIRMAR.equals(a) || ACAO_PARAR_ALARME.equals(a)) {
            if (SegurancaCore.rott != null) SegurancaCore.rott.confirmar("ecra");
        } else if (ACAO_CANCELAR_SOS.equals(a)) {
            if (SegurancaCore.sos != null) SegurancaCore.sos.cancelar("ecra");
        }
    }

    private void renovarWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                if (pm == null) return;
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Benjamin:voz");
                wakeLock.setReferenceCounted(false);
            }
            wakeLock.acquire(WAKELOCK_MS);   // com prazo: nunca fica preso se o serviço morrer
        } catch (RuntimeException e) {
            Log.w(TAG, "wakeLock", e);
        }
    }

    private void refrescar() {
        if (!emPrimeiroPlano) return;
        String estado = SegurancaCore.textoEstado();
        if (estado.equals(ultimoEstado)) return;
        ultimoEstado = estado;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(ID_NOTIFICACAO, montarNotificacao());
        } catch (RuntimeException e) {
            Log.w(TAG, "notify", e);
        }
    }

    private Notification montarNotificacao() {
        Intent abrir = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(this, 0, abrir, fl);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CANAL)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("Benjamin ativo")
                .setContentText("À escuta, mãos-livres")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW);
        String estado = SegurancaCore.textoEstado();
        if (!estado.isEmpty()) b.setSubText(estado);
        return b.build();
    }

    @Override
    public void onDestroy() {
        main.removeCallbacks(batimento);
        instancia = null;
        SegurancaCore.servicoAtivo = false;
        try {
            if (SegurancaCore.rott != null) SegurancaCore.rott.aoTerminarServico();
        } catch (RuntimeException e) {
            Log.w(TAG, "aoTerminarServico", e);
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void criarCanal() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel c = new NotificationChannel(CANAL, "Benjamin (voz)", NotificationManager.IMPORTANCE_LOW);
        c.setShowBadge(false);
        nm.createNotificationChannel(c);
    }
}
