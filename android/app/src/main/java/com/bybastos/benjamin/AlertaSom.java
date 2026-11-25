package com.bybastos.benjamin;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.ToneGenerator;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

/**
 * Alarme contínuo e alto (USAGE_ALARM). Não pede foco de áudio: toca POR CIMA do resto,
 * sem cortar chamadas nem a música/navegação de outras apps.
 * Só pára quando o condutor o desliga no ecrã (ou na notificação).
 */
final class AlertaSom {

    private static final String TAG = "BenjaminAlarme";

    private MediaPlayer player;
    private AudioTrack beeps;
    private volatile boolean ativo;
    private int volumeAnterior = -1;

    boolean ativo() { return ativo; }

    synchronized void iniciar(Context ctx) {
        if (ativo) return;
        ativo = true;
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        try {
            if (am != null) {
                volumeAnterior = am.getStreamVolume(AudioManager.STREAM_ALARM);
                am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Não consegui subir o volume do alarme", e);
        }
        // Sinal agudo e intermitente (3 beeps a ~2,9 kHz + pausa), em loop: corta o sono muito melhor que um toque calmo
        try {
            iniciarBeeps();
        } catch (RuntimeException e) {
            Log.e(TAG, "Beeps agudos indisponíveis, a usar o toque de alarme", e);
            libertarBeeps();
            try {
                Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
                if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
                player = new MediaPlayer();
                player.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
                player.setDataSource(ctx, uri);
                player.setLooping(true);
                player.setVolume(1.0f, 1.0f);
                player.prepare();
                player.start();
            } catch (Exception e2) {
                Log.e(TAG, "Alarme sem som (só vibração)", e2);
                libertarPlayer();
            }
        }
        vibrar(ctx, true);
    }

    synchronized void parar(Context ctx) {
        if (!ativo) return;
        ativo = false;
        libertarPlayer();
        libertarBeeps();
        pararVibracao(ctx);
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am != null && volumeAnterior >= 0) am.setStreamVolume(AudioManager.STREAM_ALARM, volumeAnterior, 0);
        } catch (RuntimeException e) {
            Log.w(TAG, "Não consegui repor o volume do alarme", e);
        }
        volumeAnterior = -1;
    }

    private void iniciarBeeps() {
        final int sr = 22050;
        final int beep = sr * 180 / 1000, gap = sr * 90 / 1000, pausa = sr * 500 / 1000;
        short[] pcm = new short[3 * (beep + gap) + pausa];
        int pos = 0;
        for (int b = 0; b < 3; b++) {
            for (int i = 0; i < beep; i++) {
                double fase = 2 * Math.PI * 2900.0 * i / sr;
                double env = Math.min(1.0, Math.min(i, beep - i) / (sr * 0.004));   // rampa de 4 ms: sem estalidos
                pcm[pos++] = (short) ((Math.sin(fase) >= 0 ? 30000 : -30000) * env);  // onda quadrada: soa mais alto e agudo
            }
            pos += gap;
        }
        AudioAttributes aa = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        AudioFormat af = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sr)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build();
        beeps = new AudioTrack(aa, af, pcm.length * 2, AudioTrack.MODE_STATIC, AudioManager.AUDIO_SESSION_ID_GENERATE);
        beeps.write(pcm, 0, pcm.length);
        beeps.setLoopPoints(0, pcm.length, -1);
        beeps.setVolume(1.0f);
        beeps.play();
    }

    private void libertarBeeps() {
        if (beeps != null) {
            try { beeps.stop(); } catch (RuntimeException e) { /* ok */ }
            try { beeps.release(); } catch (RuntimeException e) { /* ok */ }
            beeps = null;
        }
    }

    /** Sinal curto e agudo (sonolência): imediato, por cima de tudo, sem pedir foco de áudio. */
    static void beepCurto() {
        try {
            final ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
            tg.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 600);
            SegurancaCore.main.postDelayed(new Runnable() {
                @Override public void run() { tg.release(); }
            }, 900);
        } catch (RuntimeException e) {
            Log.w(TAG, "beepCurto", e);
        }
    }

    private void libertarPlayer() {
        if (player != null) {
            try { player.stop(); } catch (RuntimeException e) { /* ok */ }
            try { player.release(); } catch (RuntimeException e) { /* ok */ }
            player = null;
        }
    }

    /** Vibração: repetida enquanto o alarme toca, ou um pulso curto (pulso = false com parar). */
    @SuppressWarnings("deprecation")
    static void vibrar(Context ctx, boolean repetir) {
        try {
            Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            long[] padrao = {0, 600, 300, 600, 300};
            if (Build.VERSION.SDK_INT >= 26) {
                v.vibrate(VibrationEffect.createWaveform(padrao, repetir ? 0 : -1));
            } else {
                v.vibrate(padrao, repetir ? 0 : -1);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "vibrar", e);
        }
    }

    @SuppressWarnings("deprecation")
    static void pararVibracao(Context ctx) {
        try {
            Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null) v.cancel();
        } catch (RuntimeException e) { /* ok */ }
    }
}
