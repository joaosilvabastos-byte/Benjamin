package com.bybastos.benjamin;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * SOS: 10 s para cancelar -> localização por e-mail ao encarregado (via Worker) -> marcação para a central.
 * Estado e contagem na thread main; o envio de rede numa thread própria.
 */
final class SosFluxo {

    private static final String TAG = "BenjaminSOS";
    private static final int CONTAGEM_S = 10;
    private static final long POSICAO_VALIDADE_MS = 5L * 60 * 1000;

    private volatile boolean contando;
    private int restante;
    private String origem = "botao";
    private final ExecutorService rede = Executors.newSingleThreadExecutor();

    private final Runnable tic = new Runnable() {
        @Override public void run() {
            if (!contando) return;
            restante--;
            if (restante <= 0) {
                enviar();
            } else {
                emitir("contagem", restante);
                SegurancaCore.main.postDelayed(this, 1000);
            }
        }
    };

    boolean contando() { return contando; }

    void iniciar(final String origemPedido) {
        SegurancaCore.main.post(new Runnable() {
            @Override public void run() {
                if (contando) return;
                contando = true;
                restante = CONTAGEM_S;
                origem = origemPedido;
                SegurancaCore.dizer(FrasesSeguranca.SOS_INICIO, true);
                AlertaSom.vibrar(SegurancaCore.app, false);
                SegurancaCore.notificarAlerta(FrasesSeguranca.NOTIF_SOS_TITULO, FrasesSeguranca.NOTIF_SOS_TEXTO,
                        VoiceForegroundService.ACAO_CANCELAR_SOS, "CANCELAR");
                emitir("contagem", restante);
                VoiceForegroundService.atualizar();
                SegurancaCore.main.postDelayed(tic, 1000);
            }
        });
    }

    void cancelar(final String origemPedido) {
        SegurancaCore.main.post(new Runnable() {
            @Override public void run() {
                if (!contando) return;
                contando = false;
                SegurancaCore.main.removeCallbacks(tic);
                SegurancaCore.dizer(FrasesSeguranca.SOS_CANCELADO, false);
                SegurancaCore.limparAlerta();
                emitir("cancelado", 0);
                VoiceForegroundService.atualizar();
            }
        });
    }

    private void emitir(String fase, int segundos) {
        JSObject o = new JSObject();
        o.put("fase", fase);
        o.put("segundos", segundos);
        o.put("origem", origem);
        SegurancaCore.emitir("sosEstado", o);
    }

    // ---- envio ----

    private void enviar() {
        contando = false;
        SegurancaCore.main.removeCallbacks(tic);
        emitir("a-enviar", 0);
        VoiceForegroundService.atualizar();
        final String email = SegurancaCore.email;
        final String telefone = SegurancaCore.telefone;
        ligarCentral(telefone);          // a chamada arranca já, em paralelo com o envio do e-mail
        rede.execute(new Runnable() {
            @Override public void run() {
                final boolean temEmail = email != null && !email.trim().isEmpty();
                boolean ok = temEmail && postarAoWorker(email.trim());
                final boolean enviado = ok;
                SegurancaCore.main.post(new Runnable() {
                    @Override public void run() {
                        SegurancaCore.limparAlerta();
                        if (enviado) {
                            SegurancaCore.dizer(FrasesSeguranca.SOS_ENVIADO, true);
                            emitir("enviado", 0);
                        } else {
                            SegurancaCore.dizer(temEmail ? FrasesSeguranca.SOS_FALHOU : FrasesSeguranca.SOS_SEM_EMAIL, true);
                            emitir("falhou", 0);
                        }
                    }
                });
            }
        });
    }

    private boolean postarAoWorker(String email) {
        double lat = SegurancaCore.lat, lon = SegurancaCore.lon;
        double prec = SegurancaCore.prec;
        long idade = SystemClock.elapsedRealtime() - SegurancaCore.posEm;
        if (Double.isNaN(lat) || Double.isNaN(lon) || idade > POSICAO_VALIDADE_MS) {
            Location l = ultimaPosicaoDoSistema();
            if (l != null) { lat = l.getLatitude(); lon = l.getLongitude(); prec = l.getAccuracy(); }
        }
        JSONObject corpo = new JSONObject();
        try {
            corpo.put("para", email);
            corpo.put("condutor", SegurancaCore.condutor);
            corpo.put("origem", origem);
            corpo.put("ts", System.currentTimeMillis());
            if (!Double.isNaN(lat) && !Double.isNaN(lon)) {
                corpo.put("lat", lat);
                corpo.put("lon", lon);
                corpo.put("prec", prec);
            }
        } catch (Exception e) {
            return false;
        }
        long[] esperas = {0, 1500, 4000};
        for (long espera : esperas) {
            if (espera > 0) {
                try { Thread.sleep(espera); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
            }
            if (tentar(corpo.toString())) return true;
        }
        return false;
    }

    private boolean tentar(String json) {
        HttpURLConnection c = null;
        try {
            String base = SegurancaCore.workerUrl == null ? SegurancaCore.WORKER_PADRAO : SegurancaCore.workerUrl;
            while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
            c = (HttpURLConnection) new URL(base + "/sos").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            if (SegurancaCore.workerChave != null && !SegurancaCore.workerChave.isEmpty()) {
                c.setRequestProperty("X-Benjamin-Key", SegurancaCore.workerChave);
            }
            byte[] dados = json.getBytes(StandardCharsets.UTF_8);
            OutputStream os = c.getOutputStream();
            os.write(dados);
            os.close();
            int code = c.getResponseCode();
            Log.i(TAG, "Worker /sos -> HTTP " + code);
            return code >= 200 && code < 300;
        } catch (Exception e) {
            Log.w(TAG, "Falha ao enviar SOS", e);
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private Location ultimaPosicaoDoSistema() {
        Context ctx = SegurancaCore.app;
        try {
            boolean fina = ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            boolean grossa = ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            if (!fina && !grossa) return null;
            LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return null;
            Location melhor = null;
            for (String p : lm.getProviders(true)) {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (melhor == null || l.getTime() > melhor.getTime())) melhor = l;
            }
            return melhor;
        } catch (SecurityException | IllegalArgumentException e) {
            return null;
        }
    }

    // ---- chamada para a central ----

    /**
     * Com a permissão CALL_PHONE: liga logo (ACTION_CALL). Sem ela: abre o marcador com o número (ACTION_DIAL).
     * Em segundo plano o Android não deixa abrir ecrãs a partir do serviço: fica uma notificação com um toque para ligar.
     */
    private void ligarCentral(String telefone) {
        if (telefone == null || telefone.trim().isEmpty()) return;
        Uri numero = Uri.parse("tel:" + Uri.encode(telefone.trim()));
        boolean podeLigar = ContextCompat.checkSelfPermission(SegurancaCore.app, android.Manifest.permission.CALL_PHONE)
                == PackageManager.PERMISSION_GRANTED;
        Intent intent = new Intent(podeLigar ? Intent.ACTION_CALL : Intent.ACTION_DIAL, numero);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (SegurancaCore.visivel) {
            try {
                SegurancaCore.app.startActivity(intent);
                return;
            } catch (RuntimeException e) {
                Log.w(TAG, "ACTION_CALL falhou, a usar o marcador", e);
                if (podeLigar) {
                    try {
                        SegurancaCore.app.startActivity(new Intent(Intent.ACTION_DIAL, numero).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                        return;
                    } catch (RuntimeException e2) {
                        Log.w(TAG, "Não consegui abrir o marcador", e2);
                    }
                }
            }
        }
        SegurancaCore.notificarComIntent(FrasesSeguranca.NOTIF_LIGAR_TITULO, FrasesSeguranca.NOTIF_LIGAR_TEXTO, intent);
    }
}
