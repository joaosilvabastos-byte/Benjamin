package com.bybastos.benjamin;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.audiofx.LoudnessEnhancer;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Voz nativa do Benjamin.
 *
 * ESCUTA  - SpeechRecognizer do sistema, mas o CICLO é todo nativo: cada sessão que termina
 *           (resultado, silêncio, erro) é reaberta aqui, sem passar pelo JavaScript.
 *           Eventos para o JS: "resultado" {texto}  e  "estado" {ouvindo:false, motivo} (só quando desiste).
 * BIP     - o reconhecedor da Google toca um som a cada sessão. Silenciamos brevemente os canais de
 *           áudio à volta de cada arranque (SILENCIAR_BIP). Melhor esforço: depende do telemóvel.
 * FALA    - TextToSpeech nativo com AudioAttributes de navegação + foco de áudio.
 *           O microfone é cancelado (e o som reposto) ANTES de a voz começar.
 *
 * Regras de thread: tudo o que toca no SpeechRecognizer corre na thread principal (main);
 * o TTS e as chamadas de fala correm na thread "exec".
 */
@CapacitorPlugin(
        name = "BenjaminVoice",
        permissions = {
                @Permission(alias = "microfone", strings = { Manifest.permission.RECORD_AUDIO })
        }
)
public class BenjaminVoicePlugin extends Plugin {

    private static final String TAG = "BenjaminNativo";

    /** Silencia os canais de áudio à volta de cada sessão de escuta para tapar o bip do reconhecedor. */
    private static final boolean SILENCIAR_BIP = true;
    private static final int[] STREAMS_BIP = {
            AudioManager.STREAM_MUSIC, AudioManager.STREAM_NOTIFICATION,
            AudioManager.STREAM_SYSTEM, AudioManager.STREAM_ALARM
    };

    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    // ---- Escuta (só na thread main) ----
    private SpeechRecognizer recognizer;
    private Intent recognizerIntent;
    private boolean querOuvir;          // o JS quer o modo mãos-livres ligado
    private boolean sessaoAtiva;        // startListening() feito e ainda sem resultado/erro
    private int falhasSeguidas;
    private final List<Integer> streamsMudos = new ArrayList<>();

    private final Runnable tarefaAbrirSessao = new Runnable() {
        @Override public void run() { abrirSessao(); }
    };
    private final Runnable tarefaLargarBip = new Runnable() {
        @Override public void run() { mudarBip(false); }
    };

    // ---- Voz ----
    private volatile TextToSpeech tts;
    private volatile boolean ttsPronto;
    private volatile String ttsErro;
    private volatile boolean aFalar;
    private final List<PluginCall> esperaTts = new ArrayList<>();           // só em exec
    private final Map<String, PluginCall> falas = new LinkedHashMap<>();    // só em exec
    private int contadorFalas;
    private AudioManager audio;
    private LoudnessEnhancer loudnessEnhancer;
    private int sessaoLoudness = 0;
    private AudioAttributes attrs;
    private AudioFocusRequest foco;

    private boolean servicoAtivo;       // só em exec

    // =====================================================================================
    // Ciclo de vida
    // =====================================================================================

    @Override
    public void load() {
        super.load();
        Context ctx = getContext();
        audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        attrs = new AudioAttributes.Builder()
                // USAGE_MEDIA = STREAM_MUSIC: sai pela coluna principal e segue o volume de multimédia que o condutor já usa.
                // (USAGE_ASSISTANCE_NAVIGATION_GUIDANCE pode cair num canal de volume mais baixo em alguns Android/ColorOS.)
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();

        recognizerIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "pt-PT");
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "pt-PT");
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        recognizerIntent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
        // pausa de 1,8 s no fim da frase (o valor por defeito corta a meio de frases mais longas)
        recognizerIntent.putExtra("android.speech.extra.SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS", 1800L);
        recognizerIntent.putExtra("android.speech.extra.SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS", 1800L);

        criarTts("com.google.android.tts");
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        main.post(new Runnable() {
            @Override
            public void run() {
                querOuvir = false;
                cancelarSessao();
                destruirRecognizer();
            }
        });
        exec.execute(new Runnable() {
            @Override
            public void run() {
                pararServicoNoExec();
                TextToSpeech t = tts;
                if (t != null) {
                    try { t.stop(); t.shutdown(); } catch (RuntimeException e) { /* ok */ }
                }
                largarFoco();
            }
        });
        exec.shutdown();
    }

    // =====================================================================================
    // Preparação e serviço em primeiro plano
    // =====================================================================================

    @PluginMethod
    public void preparar(PluginCall call) {
        JSObject r = new JSObject();
        r.put("modelo", true);
        r.put("tts", ttsPronto);
        if (ttsErro != null) r.put("ttsErro", ttsErro);
        call.resolve(r);
    }

    /** Chamar quando o condutor carrega em INICIAR (a app está em primeiro plano). */
    @PluginMethod
    public void ativarServico(final PluginCall call) {
        if (!temMicrofone()) {
            requestPermissionForAlias("microfone", call, "aoPermissaoServico");
            return;
        }
        exec.execute(new Runnable() {
            @Override
            public void run() {
                JSObject r = new JSObject();
                r.put("servico", arrancarServicoNoExec());
                call.resolve(r);
            }
        });
    }

    @PermissionCallback
    private void aoPermissaoServico(PluginCall call) {
        if (temMicrofone()) ativarServico(call);
        else call.reject("Permissão de microfone negada", "PERMISSAO");
    }

    @PluginMethod
    public void terminar(final PluginCall call) {
        main.post(new Runnable() {
            @Override
            public void run() {
                querOuvir = false;
                cancelarSessao();
            }
        });
        exec.execute(new Runnable() {
            @Override
            public void run() {
                cortarFalaNoExec();
                pararServicoNoExec();
                call.resolve();
            }
        });
    }

    private boolean arrancarServicoNoExec() {
        if (servicoAtivo) return true;
        try {
            Context ctx = getContext();
            ContextCompat.startForegroundService(ctx, new Intent(ctx, VoiceForegroundService.class));
            servicoAtivo = true;
        } catch (RuntimeException e) {
            Log.w(TAG, "Não consegui arrancar o serviço em primeiro plano", e);
        }
        return servicoAtivo;
    }

    private void pararServicoNoExec() {
        if (!servicoAtivo) return;
        servicoAtivo = false;
        try {
            Context ctx = getContext();
            ctx.stopService(new Intent(ctx, VoiceForegroundService.class));
        } catch (RuntimeException e) {
            Log.w(TAG, "Falha ao parar o serviço", e);
        }
    }

    private boolean temMicrofone() {
        boolean capacitor = getPermissionState("microfone") == PermissionState.GRANTED;
        boolean sistema = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
        return capacitor || sistema;
    }

    // =====================================================================================
    // Escuta
    // =====================================================================================

    /** Liga o modo mãos-livres. Idempotente: se já está a ouvir, não mexe em nada. */
    @PluginMethod
    public void iniciarEscuta(final PluginCall call) {
        if (!temMicrofone()) {
            requestPermissionForAlias("microfone", call, "aoPermissaoEscuta");
            return;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                querOuvir = true;
                JSObject r = new JSObject();
                if (aFalar) {
                    r.put("ouvindo", false);
                    r.put("motivo", "a-falar");
                } else {
                    abrirSessao();
                    r.put("ouvindo", true);
                }
                call.resolve(r);
            }
        });
    }

    @PermissionCallback
    private void aoPermissaoEscuta(PluginCall call) {
        if (temMicrofone()) iniciarEscuta(call);
        else call.reject("Permissão de microfone negada", "PERMISSAO");
    }

    @PluginMethod
    public void pararEscuta(final PluginCall call) {
        main.post(new Runnable() {
            @Override
            public void run() {
                querOuvir = false;
                cancelarSessao();
            }
        });
        call.resolve();
    }

    // ---- Tudo abaixo corre na thread main ----

    private void abrirSessao() {
        main.removeCallbacks(tarefaAbrirSessao);
        if (!querOuvir || aFalar || sessaoAtiva) return;
        if (recognizer == null && !criarRecognizer()) {
            querOuvir = false;
            emitirEstado(false, "indisponivel");
            return;
        }
        try {
            bipMudoPor(900);
            sessaoAtiva = true;
            recognizer.startListening(recognizerIntent);
        } catch (RuntimeException e) {
            Log.e(TAG, "startListening falhou", e);
            sessaoAtiva = false;
            destruirRecognizer();
            agendarSessao(1000);
        }
    }

    private void agendarSessao(long ms) {
        main.removeCallbacks(tarefaAbrirSessao);
        if (querOuvir && !aFalar) main.postDelayed(tarefaAbrirSessao, ms);
    }

    /** Pára a sessão em curso e repõe o som. NÃO altera querOuvir. */
    private void cancelarSessao() {
        main.removeCallbacks(tarefaAbrirSessao);
        sessaoAtiva = false;
        if (recognizer != null) {
            try { recognizer.cancel(); } catch (RuntimeException e) { Log.w(TAG, "cancel()", e); }
        }
        main.removeCallbacks(tarefaLargarBip);
        mudarBip(false);
    }

    private boolean criarRecognizer() {
        destruirRecognizer();
        try {
            Log.i(TAG, "isRecognitionAvailable=" + SpeechRecognizer.isRecognitionAvailable(getContext()));
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            if (recognizer == null) return false;
            recognizer.setRecognitionListener(escuta);
            return true;
        } catch (RuntimeException e) {
            Log.e(TAG, "createSpeechRecognizer falhou", e);
            recognizer = null;
            return false;
        }
    }

    private void destruirRecognizer() {
        if (recognizer != null) {
            try { recognizer.destroy(); } catch (RuntimeException e) { /* ok */ }
            recognizer = null;
        }
        sessaoAtiva = false;
    }

    private void emitirEstado(boolean ouvindo, String motivo) {
        JSObject o = new JSObject();
        o.put("ouvindo", ouvindo);
        if (motivo != null) o.put("motivo", motivo);
        notifyListeners("estado", o);
    }

    private final RecognitionListener escuta = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {
            Log.i(TAG, "À escuta");
            main.removeCallbacks(tarefaLargarBip);
            main.postDelayed(tarefaLargarBip, 400); // o bip de arranque já passou
        }

        @Override public void onBeginningOfSpeech() { }
        @Override public void onRmsChanged(float rmsdB) { }
        @Override public void onBufferReceived(byte[] buffer) { }

        @Override
        public void onEndOfSpeech() {
            bipMudoPor(700); // som de fim de sessão
        }

        @Override
        public void onResults(Bundle results) {
            sessaoAtiva = false;
            falhasSeguidas = 0;
            ArrayList<String> m = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (!aFalar && m != null && !m.isEmpty()) {
                String texto = m.get(0) == null ? "" : m.get(0).trim();
                if (!texto.isEmpty()) {
                    Log.i(TAG, "Ouvi: " + texto);
                    JSObject o = new JSObject();
                    o.put("texto", texto);
                    notifyListeners("resultado", o);
                }
            }
            agendarSessao(300);
        }

        @Override public void onPartialResults(Bundle partialResults) { }
        @Override public void onEvent(int eventType, Bundle params) { }

        @Override
        public void onError(int error) {
            sessaoAtiva = false;
            bipMudoPor(700);
            Log.w(TAG, "SpeechRecognizer onError: " + error);
            switch (error) {
                case SpeechRecognizer.ERROR_NO_MATCH:        // 7: não percebeu
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:  // 6: silêncio — o caso normal
                    falhasSeguidas = 0;
                    agendarSessao(250);
                    break;
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: // 9
                    querOuvir = false;
                    emitirEstado(false, "permissao");
                    break;
                case 12: // ERROR_LANGUAGE_NOT_SUPPORTED (API 31+)
                case 13: // ERROR_LANGUAGE_UNAVAILABLE   (API 31+)
                    querOuvir = false;
                    emitirEstado(false, "indisponivel");
                    break;
                case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: // 8
                case SpeechRecognizer.ERROR_CLIENT:          // 5 (também aparece depois de cancel())
                    destruirRecognizer();
                    agendarSessao(600);
                    break;
                default: // rede, servidor, áudio...: tenta de novo com intervalo crescente
                    falhasSeguidas++;
                    if (falhasSeguidas >= 2) destruirRecognizer();
                    agendarSessao(Math.min(500L << Math.min(falhasSeguidas, 4), 8000L));
            }
        }
    };

    // ---- Bip do reconhecedor ----

    /** Silencia (ou repõe) os canais de áudio. Só repõe os que foi este código a silenciar. */
    private void mudarBip(boolean mudo) {
        if (!SILENCIAR_BIP || audio == null) return;
        if (mudo) {
            for (int s : STREAMS_BIP) {
                if (streamsMudos.contains(s)) continue;
                try {
                    if (Build.VERSION.SDK_INT >= 23 && audio.isStreamMute(s)) continue; // já estava mudo: não tocar
                    audio.adjustStreamVolume(s, AudioManager.ADJUST_MUTE, 0);
                    streamsMudos.add(s);
                } catch (RuntimeException e) {
                    // sem permissão (ex.: Não Incomodar) para este canal: ignora
                }
            }
        } else {
            for (int s : new ArrayList<>(streamsMudos)) {
                try { audio.adjustStreamVolume(s, AudioManager.ADJUST_UNMUTE, 0); } catch (RuntimeException e) { /* ok */ }
            }
            streamsMudos.clear();
        }
    }

    private void bipMudoPor(long ms) {
        if (!SILENCIAR_BIP) return;
        main.removeCallbacks(tarefaLargarBip);
        mudarBip(true);
        main.postDelayed(tarefaLargarBip, ms); // rede de segurança: nunca fica mudo
    }

    // =====================================================================================
    // Fala
    // =====================================================================================

    private void aoIniciarTts(int status) {
        TextToSpeech t = tts;
        if (t == null || status != TextToSpeech.SUCCESS) {
            ttsErro = "o motor de voz do Android não arrancou (status " + status + ")";
        } else {
            int r = t.setLanguage(Locale.forLanguageTag("pt-PT"));
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                Log.w(TAG, "pt-PT indisponível no motor de voz; a tentar pt-BR");
                r = t.setLanguage(Locale.forLanguageTag("pt-BR"));
            }
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                ttsErro = "sem voz portuguesa instalada (Definições > Sistema > Idiomas > Saída de texto para voz)";
            } else {
                t.setAudioAttributes(attrs);
                t.setSpeechRate(0.85f);
                t.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { notifyListeners("ttsInicio", new JSObject()); }
                    @Override public void onDone(String id) { fim(id, null); }
                    @Override public void onError(String id) { fim(id, "erro do motor de voz"); }
                    @Override public void onError(String id, int code) { fim(id, "erro do motor de voz " + code); }
                    @Override public void onStop(String id, boolean interrupted) { fim(id, null); }

                    private void fim(final String id, final String erro) {
                        exec.execute(new Runnable() {
                            @Override public void run() { fimFalaNoExec(id, erro); }
                        });
                    }
                });
                ttsPronto = true;
                Log.i(TAG, "TTS pronto");
            }
        }
        List<PluginCall> espera = new ArrayList<>(esperaTts);
        esperaTts.clear();
        for (PluginCall c : espera) falarNoExec(c);
    }

    private void criarTts(final String motor) {
        final TextToSpeech.OnInitListener l = new TextToSpeech.OnInitListener() {
            @Override
            public void onInit(final int status) {
                if (status != TextToSpeech.SUCCESS && motor != null) {
                    Log.w(TAG, "Motor " + motor + " falhou (" + status + "); a usar o por defeito");
                    exec.execute(new Runnable() {
                        @Override public void run() {
                            TextToSpeech velho = tts;
                            if (velho != null) { try { velho.shutdown(); } catch (RuntimeException e) { /* ok */ } }
                            criarTts(null);
                        }
                    });
                    return;
                }
                exec.execute(new Runnable() {
                    @Override public void run() { aoIniciarTts(status); }
                });
            }
        };
        Context ctx = getContext();
        tts = (motor == null) ? new TextToSpeech(ctx, l) : new TextToSpeech(ctx, l, motor);
    }

    /** falar({ texto, pitch?, rate?, voz? }) — resolve quando a frase TERMINA de ser dita. */
    @PluginMethod
    public void falar(final PluginCall call) {
        final String texto = call.getString("texto", "");
        if (texto == null || texto.trim().isEmpty()) {
            call.resolve();
            return;
        }
        exec.execute(new Runnable() {
            @Override public void run() { falarNoExec(call); }
        });
    }

    private void falarNoExec(PluginCall call) {
        if (ttsErro != null) {
            call.reject(ttsErro, "TTS_INDISPONIVEL");
            return;
        }
        if (!ttsPronto) {
            esperaTts.add(call);
            return;
        }
        TextToSpeech t = tts;
        String texto = call.getString("texto", "");
        Float pitch = call.getFloat("pitch", 0.85f);
        Float rate = call.getFloat("rate", 0.85f);
        String voz = call.getString("voz", "");

        aFalar = true;

        // Antes de qualquer som: cancela o microfone e repõe o volume (espera pela thread main)
        final CountDownLatch pronto = new CountDownLatch(1);
        main.post(new Runnable() {
            @Override
            public void run() {
                try { cancelarSessao(); } finally { pronto.countDown(); }
            }
        });
        try {
            pronto.await(500, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        garantirSaidaAltifalante();
        pedirFoco();
        t.setPitch(0.35f);
        aplicarVoz(t, voz);
        t.setSpeechRate(1.3f);

        String id = "b" + (++contadorFalas);
        falas.put(id, call);
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);                         // volume máximo do TTS (1.0)
        params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);      // coluna principal
        try {
            if (loudnessEnhancer == null && audio != null) {
                sessaoLoudness = audio.generateAudioSessionId();
                loudnessEnhancer = new LoudnessEnhancer(sessaoLoudness);
                loudnessEnhancer.setTargetGain(900);
                loudnessEnhancer.setEnabled(true);
            }
            if (loudnessEnhancer != null) {
                params.putInt(TextToSpeech.Engine.KEY_PARAM_SESSION_ID, sessaoLoudness);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "LoudnessEnhancer indisponivel", e);
            loudnessEnhancer = null;
        }
        int r = t.speak(texto, TextToSpeech.QUEUE_ADD, params, id);
        if (r != TextToSpeech.SUCCESS) {
            falas.remove(id);
            if (falas.isEmpty()) {
                aFalar = false;
                largarFoco();
            }
            call.reject("speak() falhou (" + r + ")", "TTS_ERRO");
        }
    }

    private void fimFalaNoExec(String id, String erro) {
        PluginCall c = falas.remove(id);
        if (c == null) return; // já resolvida por cortarFala()
        if (falas.isEmpty()) {
            aFalar = false;
            largarFoco();
            notifyListeners("ttsFim", new JSObject());
            // Rede de segurança: se o JS quer escuta e ninguém a reabriu, reabre 1 s depois (idempotente)
            main.postDelayed(tarefaAbrirSessao, 1000);
        }
        if (erro == null) c.resolve();
        else c.reject(erro, "TTS_ERRO");
    }

    @PluginMethod
    public void cortarFala(final PluginCall call) {
        exec.execute(new Runnable() {
            @Override
            public void run() {
                cortarFalaNoExec();
                call.resolve();
            }
        });
    }

    private void cortarFalaNoExec() {
        TextToSpeech t = tts;
        if (t != null) {
            try { t.stop(); } catch (RuntimeException e) { /* ok */ }
        }
        for (PluginCall c : new ArrayList<>(falas.values())) c.resolve();
        falas.clear();
        for (PluginCall c : new ArrayList<>(esperaTts)) c.resolve();
        esperaTts.clear();
        aFalar = false;
        largarFoco();
    }

    // ---- Vozes ----

    private static boolean ehPtPT(Voice v) {
        Locale l = v.getLocale();
        return l != null && "pt".equalsIgnoreCase(l.getLanguage()) && "PT".equalsIgnoreCase(l.getCountry());
    }

    private void aplicarVoz(TextToSpeech t, String nome) {
        try {
            Set<Voice> todas = t.getVoices();
            if (todas == null) return;
            Voice escolhida = null;
            for (Voice v : todas) {
                if (nome != null && !nome.isEmpty()) {
                    if (v.getName().equalsIgnoreCase(nome)) { escolhida = v; break; }
                    continue;
                }
                if (!ehPtPT(v) || v.isNetworkConnectionRequired()) continue;
                if (escolhida == null || v.getName().compareTo(escolhida.getName()) < 0) escolhida = v;
            }
            if (escolhida != null) t.setVoice(escolhida);
        } catch (RuntimeException e) {
            Log.w(TAG, "Não consegui escolher a voz", e);
        }
    }

    /** Lista as vozes pt-PT instaladas (o Android não diz se são masculinas ou femininas). */
    @PluginMethod
    public void listarVozes(PluginCall call) {
        JSArray arr = new JSArray();
        TextToSpeech t = tts;
        if (t != null && ttsPronto) {
            try {
                Set<Voice> todas = t.getVoices();
                List<String> nomes = new ArrayList<>();
                if (todas != null) {
                    for (Voice v : todas) if (ehPtPT(v)) nomes.add(v.getName());
                }
                Collections.sort(nomes);
                for (String n : nomes) arr.put(n);
            } catch (RuntimeException e) {
                Log.w(TAG, "getVoices()", e);
            }
        }
        JSObject r = new JSObject();
        r.put("vozes", arr);
        call.resolve(r);
    }

    // ---- Saída de áudio: coluna principal, nunca o auricular ----

    /**
     * Corre antes de CADA fala. Se o reconhecimento de voz (ou outra app) tiver deixado o Android em modo de chamada
     * de voz (MODE_IN_COMMUNICATION / CALL_SCREENING), o som sai pelo auricular, baixinho. Repõe o modo normal e solta
     * qualquer dispositivo de comunicação forçado. Não toca em chamadas reais (MODE_IN_CALL / RINGTONE).
     * Não muda voz, tom nem velocidade e não faz nenhum som.
     */
    private void garantirSaidaAltifalante() {
        if (audio == null) return;
        try {
            int modo = audio.getMode();
            if (modo == AudioManager.MODE_IN_COMMUNICATION || modo == 4 /* MODE_CALL_SCREENING */) {
                Log.w(TAG, "Modo de áudio estava preso em " + modo + " -> a repor MODE_NORMAL (coluna principal)");
                if (Build.VERSION.SDK_INT >= 31) {
                    try { audio.clearCommunicationDevice(); } catch (RuntimeException e) { /* ok */ }
                }
                audio.setMode(AudioManager.MODE_NORMAL);
            }
            if (modo != AudioManager.MODE_IN_CALL && modo != AudioManager.MODE_RINGTONE && audio.isSpeakerphoneOn()) {
                audio.setSpeakerphoneOn(false);   // com MODE_NORMAL o 'speakerphone' ligado só baralha o encaminhamento
            }
            Log.i(TAG, "Áudio ao falar: modo=" + audio.getMode()
                    + " volMusica=" + audio.getStreamVolume(AudioManager.STREAM_MUSIC) + "/" + audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                    + (Build.VERSION.SDK_INT >= 23 ? " mudoMusica=" + audio.isStreamMute(AudioManager.STREAM_MUSIC) : ""));
        } catch (RuntimeException e) {
            Log.w(TAG, "garantirSaidaAltifalante", e);
        }
    }

    // ---- Foco de áudio: baixa as outras apps enquanto o Benjamin fala ----

    private void pedirFoco() {
        if (audio == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                if (foco == null) {
                    foco = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                            .setAudioAttributes(attrs)
                            .build();
                }
                audio.requestAudioFocus(foco);
            } else {
                audio.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "requestAudioFocus", e);
        }
    }

    private void largarFoco() {
        if (audio == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                if (foco != null) audio.abandonAudioFocusRequest(foco);
            } else {
                audio.abandonAudioFocus(null);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "abandonAudioFocus", e);
        }
    }
}
