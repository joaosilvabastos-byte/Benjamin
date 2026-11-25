package com.bybastos.benjamin;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;

import java.text.Normalizer;
import java.util.regex.Pattern;

/**
 * Estado partilhado da segurança. Vive no processo (não na Activity): o serviço em primeiro plano
 * continua a avisar mesmo que o ecrã/Activity já tenham sido destruídos.
 */
final class SegurancaCore {

    private static final String TAG = "BenjaminSeg";
    private static final String PREFS = "benjamin_seguranca";
    static final String WORKER_PADRAO = "https://benjamin.joaosilvabastos.workers.dev";

    static final String CANAL_ALERTA = "benjamin_alerta";
    static final int ID_ALERTA = 4712;

    static final Handler main = new Handler(Looper.getMainLooper());

    static Context app;
    static volatile boolean visivel;          // Activity em primeiro plano (onStart..onStop)
    static volatile boolean servicoAtivo;     // VoiceForegroundService a correr

    // Configuração (persistida)
    static volatile String email = "";
    static volatile String telefone = "";
    static volatile String condutor = "";
    static volatile String workerUrl = WORKER_PADRAO;
    static volatile String workerChave = "";
    static volatile boolean cameraAtiva;
    static volatile boolean avisoTransicao = true;

    // Posição / velocidade (vêm do GPS do JavaScript)
    static volatile double lat = Double.NaN;
    static volatile double lon = Double.NaN;
    static volatile double prec;
    static volatile long posEm;               // elapsedRealtime
    static volatile float velKmh;
    static volatile long velEm;               // elapsedRealtime

    // Estado da câmara (para a notificação e para o ecrã)
    static volatile String estadoCamera = "desligada";   // desligada | calibrando | ativa | pausa | quente

    static volatile boolean aguardaNoite;     // a pergunta do anoitecer está à espera de resposta por voz

    static SegurancaRott rott;
    static SosFluxo sos;
    static AlertaSom alarme;

    interface Eventos { void emitir(String nome, JSObject dados); }
    static volatile Eventos eventos;

    private SegurancaCore() { }

    static synchronized void init(Context c) {
        if (app != null) return;
        app = c.getApplicationContext();
        SharedPreferences p = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        email = p.getString("email", "");
        telefone = p.getString("telefone", "");
        condutor = p.getString("condutor", "");
        workerUrl = p.getString("workerUrl", WORKER_PADRAO);
        workerChave = p.getString("workerChave", "");
        cameraAtiva = p.getBoolean("camera", false);
        avisoTransicao = p.getBoolean("avisoTransicao", true);
        alarme = new AlertaSom();
        rott = new SegurancaRott();
        sos = new SosFluxo();
        criarCanalAlerta();
    }

    static void guardar() {
        if (app == null) return;
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("email", email).putString("telefone", telefone).putString("condutor", condutor)
                .putString("workerUrl", workerUrl).putString("workerChave", workerChave)
                .putBoolean("camera", cameraAtiva).putBoolean("avisoTransicao", avisoTransicao)
                .apply();
    }

    static void emitir(String nome, JSObject dados) {
        Eventos e = eventos;
        if (e != null) {
            try { e.emitir(nome, dados == null ? new JSObject() : dados); } catch (RuntimeException ex) { Log.w(TAG, "emitir " + nome, ex); }
        }
    }

    // ---------------------------------------------------------------- voz

    /** Chamada de voz normal do telemóvel (ou a tocar): o Benjamin não fala. */
    static boolean emChamada() {
        try {
            AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return false;
            int m = am.getMode();
            return m == AudioManager.MODE_IN_CALL || m == AudioManager.MODE_RINGTONE;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** Fala um aviso interno. critico = foco EXCLUSIVE (SOS, sonolência); senão MAY_DUCK. */
    static boolean dizer(String texto, boolean critico) {
        if (app == null || emChamada()) return false;
        BenjaminVoicePlugin p = BenjaminVoicePlugin.instancia;
        if (p != null && p.falarInterno(texto, critico ? 1 : 0)) return true;
        FalaReserva.falar(app, texto, critico);
        return true;
    }

    // ---------------------------------------------------------------- voz: palavras-chave

    private static final Pattern P_SOS = Pattern.compile(
            "\\b(sos|socorro|emergencia|chama (o )?(112|inem)|liga (ao|para o) 112|chamar (o )?(112|inem))\\b");
    private static final Pattern P_CANCELAR = Pattern.compile(
            "\\b(cancela|cancelar|cancelado|engano|foi sem querer|esta tudo bem|esta bem|esta controlado)\\b");
    private static final Pattern P_PRESENTE = Pattern.compile(
            "\\b(estou bem|estou acordad[oa]|tudo bem|estou aqui|estou presente|presente|estou atent[oa]|estou ok|sim estou|estou a postos)\\b");

    private static final Pattern P_NOITE_NAO = Pattern.compile("\\b(nao|deixa|dispensa|agora nao)\\b");
    private static final Pattern P_NOITE_SIM = Pattern.compile("\\b(sim|liga|ligar|pode ligar|claro|quero)\\b");

    /** Anoitecer: o Benjamin pergunta e fica 40 s à espera do "sim, liga" / "não". */
    static void perguntarNoite() {
        main.post(new Runnable() {
            @Override public void run() {
                if (aguardaNoite || app == null) return;
                if (!dizer(FrasesSeguranca.NOITE_PERGUNTA, false)) return;   // chamada em curso: não pergunta
                aguardaNoite = true;
                main.postDelayed(new Runnable() {
                    @Override public void run() { aguardaNoite = false; }
                }, 40_000L);
            }
        });
    }

    private static String normalizar(String t) {
        String s = Normalizer.normalize(t == null ? "" : t, Normalizer.Form.NFD).replaceAll("\\p{M}+", "");
        return s.toLowerCase(java.util.Locale.ROOT).trim();
    }

    /**
     * Chamado pelo BenjaminVoicePlugin.onResults ANTES de enviar a frase ao JavaScript.
     * Devolve true se a frase foi consumida (SOS, cancelar SOS, "estou bem" numa verificação).
     */
    static boolean tratarVoz(String texto) {
        if (app == null || sos == null || rott == null) return false;
        String t = normalizar(texto);
        if (t.isEmpty()) return false;
        if (sos.contando() && P_CANCELAR.matcher(t).find()) {
            sos.cancelar("voz");
            return true;
        }
        if (!sos.contando() && P_SOS.matcher(t).find()) {
            sos.iniciar("voz");
            return true;
        }
        if (rott.aguardaResposta() && P_PRESENTE.matcher(t).find()) {
            rott.confirmar("voz");
            return true;
        }
        if (aguardaNoite) {
            boolean nao = P_NOITE_NAO.matcher(t).find();
            boolean sim = !nao && P_NOITE_SIM.matcher(t).find();
            if (nao || sim) {
                aguardaNoite = false;
                JSObject o = new JSObject();
                o.put("sim", sim);
                emitir("noiteResposta", o);   // o ecrã liga a câmara com a mesma função do botão das Opções
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- notificações de alerta

    private static void criarCanalAlerta() {
        if (Build.VERSION.SDK_INT < 26 || app == null) return;
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel c = new NotificationChannel(CANAL_ALERTA, "Benjamin (alertas)", NotificationManager.IMPORTANCE_HIGH);
        c.setShowBadge(false);
        c.enableVibration(false);
        c.setSound(null, null);
        nm.createNotificationChannel(c);
    }

    private static PendingIntent acaoServico(String acao, int codigo) {
        Intent i = new Intent(app, VoiceForegroundService.class).setAction(acao);
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getService(app, codigo, i, fl);
    }

    private static PendingIntent abrirApp() {
        Intent i = new Intent(app, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(app, 10, i, fl);
    }

    /** acao: VoiceForegroundService.ACAO_* ou null. rotulo: texto do botão. */
    static void notificarAlerta(String titulo, String texto, String acao, String rotulo) {
        if (app == null) return;
        try {
            NotificationCompat.Builder b = new NotificationCompat.Builder(app, CANAL_ALERTA)
                    .setSmallIcon(android.R.drawable.ic_dialog_alert)
                    .setContentTitle(titulo)
                    .setContentText(texto)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setContentIntent(abrirApp());
            if (acao != null) b.addAction(0, rotulo, acaoServico(acao, 20));
            NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(ID_ALERTA, b.build());
        } catch (RuntimeException e) {
            Log.w(TAG, "notificarAlerta", e);   // sem permissão de notificações: ignora
        }
    }

    /** Notificação simples com toque que abre uma Intent (ex.: marcador de chamada). */
    static void notificarComIntent(String titulo, String texto, Intent intent) {
        if (app == null) return;
        try {
            int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent pi = PendingIntent.getActivity(app, 30, intent, fl);
            Notification n = new NotificationCompat.Builder(app, CANAL_ALERTA)
                    .setSmallIcon(android.R.drawable.ic_dialog_alert)
                    .setContentTitle(titulo)
                    .setContentText(texto)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .build();
            NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(ID_ALERTA, n);
        } catch (RuntimeException e) {
            Log.w(TAG, "notificarComIntent", e);
        }
    }

    static void limparAlerta() {
        if (app == null) return;
        try {
            NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(ID_ALERTA);
        } catch (RuntimeException e) { /* ok */ }
    }

    /** Texto curto de estado para a notificação permanente (vazio se não houver nada a dizer). */
    static String textoEstado() {
        String s = null;
        if (alarme != null && alarme.ativo()) s = "ALARME ATIVO";
        else if (sos != null && sos.contando()) s = "SOS em contagem";
        else if (rott != null && rott.aguardaResposta()) s = "A verificar se estás bem";
        else if ("ativa".equals(estadoCamera)) s = FrasesSeguranca.ESTADO_CAM_ATIVA;
        else if ("calibrando".equals(estadoCamera)) s = FrasesSeguranca.ESTADO_CAM_CALIB;
        else if ("pausa".equals(estadoCamera)) s = FrasesSeguranca.ESTADO_CAM_PAUSA;
        else if ("quente".equals(estadoCamera)) s = FrasesSeguranca.ESTADO_CAM_QUENTE;
        return s == null ? "" : s;
    }

    static void definirEstadoCamera(String estado) {
        estadoCamera = estado;
        JSObject o = new JSObject();
        o.put("estado", estado);
        emitir("cameraEstado", o);
        VoiceForegroundService.atualizar();
    }
}
