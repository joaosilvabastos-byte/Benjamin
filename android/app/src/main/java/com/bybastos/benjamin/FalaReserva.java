package com.bybastos.benjamin;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.audiofx.LoudnessEnhancer;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Voz de reserva para os avisos de segurança quando o BenjaminVoicePlugin já não existe
 * (a Activity foi destruída mas o serviço em primeiro plano continua vivo).
 * Usa EXATAMENTE a mesma afinação do plugin: pitch 0.35, rate 1.3, voz pt-PT offline, +9 dB.
 */
final class FalaReserva {

    private static final String TAG = "BenjaminReserva";

    private static TextToSpeech tts;
    private static boolean pronto;
    private static boolean aIniciar;
    private static final List<Object[]> fila = new ArrayList<>();   // {texto, critico}
    private static LoudnessEnhancer loudness;
    private static int sessao;
    private static AudioFocusRequest foco;
    private static int pendentes;

    private FalaReserva() { }

    static synchronized void falar(final Context ctx, String texto, boolean critico) {
        if (pronto && tts != null) {
            dizer(ctx, texto, critico);
            return;
        }
        fila.add(new Object[]{texto, critico});
        if (aIniciar) return;
        aIniciar = true;
        final Context app = ctx.getApplicationContext();
        tts = new TextToSpeech(app, new TextToSpeech.OnInitListener() {
            @Override public void onInit(int status) { aoIniciar(app, status); }
        }, "com.google.android.tts");
    }

    private static synchronized void aoIniciar(Context app, int status) {
        aIniciar = false;
        if (status != TextToSpeech.SUCCESS || tts == null) {
            Log.w(TAG, "TTS de reserva não arrancou (" + status + ")");
            fila.clear();
            try { if (tts != null) tts.shutdown(); } catch (RuntimeException e) { /* ok */ }
            tts = null;
            return;
        }
        int r = tts.setLanguage(Locale.forLanguageTag("pt-PT"));
        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
            r = tts.setLanguage(Locale.forLanguageTag("pt-BR"));
        }
        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
            fila.clear();
            return;
        }
        tts.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onDone(String id) { fim(app); }
            @Override public void onError(String id) { fim(app); }
            @Override public void onStop(String id, boolean interrompido) { fim(app); }
        });
        pronto = true;
        List<Object[]> espera = new ArrayList<>(fila);
        fila.clear();
        for (Object[] e : espera) dizer(app, (String) e[0], (Boolean) e[1]);
    }

    private static synchronized void fim(Context app) {
        if (pendentes > 0) pendentes--;
        if (pendentes == 0) largarFoco(app);
    }

    private static void dizer(Context ctx, String texto, boolean critico) {
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        int ganho = critico ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE : AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK;
        if (am != null && !pedirFoco(am, ganho)) return;   // sem foco (chamada): não fala

        // Mesma afinação do BenjaminVoicePlugin
        tts.setPitch(0.35f);
        escolherVoz();
        tts.setSpeechRate(1.3f);

        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
        params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
        try {
            if (loudness == null && am != null) {
                sessao = am.generateAudioSessionId();
                loudness = new LoudnessEnhancer(sessao);
                loudness.setTargetGain(900);
                loudness.setEnabled(true);
            }
            if (loudness != null) params.putInt(TextToSpeech.Engine.KEY_PARAM_SESSION_ID, sessao);
        } catch (RuntimeException e) {
            Log.w(TAG, "LoudnessEnhancer indisponivel", e);
            loudness = null;
        }
        pendentes++;
        int mod = critico ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
        int r = tts.speak(texto, mod, params, "r" + System.nanoTime());
        if (r != TextToSpeech.SUCCESS) {
            pendentes = Math.max(0, pendentes - 1);
            if (pendentes == 0) largarFoco(ctx);
        }
    }

    private static void escolherVoz() {
        try {
            Set<Voice> todas = tts.getVoices();
            if (todas == null) return;
            Voice escolhida = null;
            for (Voice v : todas) {
                Locale l = v.getLocale();
                boolean ptpt = l != null && "pt".equalsIgnoreCase(l.getLanguage()) && "PT".equalsIgnoreCase(l.getCountry());
                if (!ptpt || v.isNetworkConnectionRequired()) continue;
                if (escolhida == null || v.getName().compareTo(escolhida.getName()) < 0) escolhida = v;
            }
            if (escolhida != null) tts.setVoice(escolhida);
        } catch (RuntimeException e) {
            Log.w(TAG, "voz", e);
        }
    }

    private static boolean pedirFoco(AudioManager am, int ganho) {
        try {
            int r;
            if (Build.VERSION.SDK_INT >= 26) {
                foco = new AudioFocusRequest.Builder(ganho)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build())
                        .build();
                r = am.requestAudioFocus(foco);
            } else {
                r = am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, ganho);
            }
            return r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } catch (RuntimeException e) {
            Log.w(TAG, "foco", e);
            return true;
        }
    }

    private static void largarFoco(Context ctx) {
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            if (Build.VERSION.SDK_INT >= 26) {
                if (foco != null) am.abandonAudioFocusRequest(foco);
            } else {
                am.abandonAudioFocus(null);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "largarFoco", e);
        }
    }
}
