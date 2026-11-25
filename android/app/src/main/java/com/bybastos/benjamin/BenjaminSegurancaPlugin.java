package com.bybastos.benjamin;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Ponte JavaScript <-> segurança nativa (ROTT, verificação de 45 min, SOS, câmara de sonolência).
 * O trabalho em si vive em SegurancaCore/SegurancaRott/SosFluxo/MonitorSonolencia, que sobrevivem à Activity.
 *
 * Eventos para o JS: "rott", "verificacao", "sosEstado", "sonolencia", "cameraEstado".
 */
@CapacitorPlugin(
        name = "BenjaminSeguranca",
        permissions = {
                @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
                @Permission(alias = "chamada", strings = { Manifest.permission.CALL_PHONE })
        }
)
public class BenjaminSegurancaPlugin extends Plugin {

    private static final String TAG = "BenjaminSegPlugin";

    private MonitorSonolencia monitor;
    private boolean pausadaPorSaida;     // a câmara parou porque o condutor saiu do ecrã (para o aviso de regresso)

    @Override
    public void load() {
        super.load();
        SegurancaCore.init(getContext());
        monitor = new MonitorSonolencia(getContext());
        SegurancaCore.eventos = new SegurancaCore.Eventos() {
            @Override public void emitir(String nome, JSObject dados) { notifyListeners(nome, dados); }
        };
    }

    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        SegurancaCore.visivel = true;
        boolean estavaPausada = pausadaPorSaida;
        avaliarCamera();
        if (estavaPausada && monitor.ligada()) {
            pausadaPorSaida = false;
            if (podeAvisarTransicao()) SegurancaCore.dizer(FrasesSeguranca.TRANSICAO_VOLTAR, false);
        }
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        SegurancaCore.visivel = false;
        if (monitor != null && monitor.ligada()) {
            boolean avisar = podeAvisarTransicao() && ecraLigado();
            monitor.desligar();
            pausadaPorSaida = true;
            SegurancaCore.definirEstadoCamera("pausa");
            if (avisar) SegurancaCore.dizer(FrasesSeguranca.TRANSICAO_SAIR, false);
        }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        SegurancaCore.eventos = null;
        SegurancaCore.visivel = false;
        if (monitor != null) monitor.destruir();
        if (SegurancaCore.cameraAtiva) SegurancaCore.estadoCamera = "pausa";
    }

    // ------------------------------------------------------------------ configuração

    /** configurar({ email, telefone, condutor, workerUrl, workerChave, avisoTransicao }) — só altera o que vier. */
    @PluginMethod
    public void configurar(PluginCall call) {
        if (call.hasOption("email")) SegurancaCore.email = call.getString("email", "").trim();
        if (call.hasOption("telefone")) SegurancaCore.telefone = call.getString("telefone", "").trim();
        if (call.hasOption("condutor")) SegurancaCore.condutor = call.getString("condutor", "").trim();
        if (call.hasOption("workerUrl")) {
            String u = call.getString("workerUrl", "").trim();
            SegurancaCore.workerUrl = u.isEmpty() ? SegurancaCore.WORKER_PADRAO : u;
        }
        if (call.hasOption("workerChave")) SegurancaCore.workerChave = call.getString("workerChave", "").trim();
        if (call.hasOption("avisoTransicao")) SegurancaCore.avisoTransicao = call.getBoolean("avisoTransicao", true);
        SegurancaCore.guardar();
        call.resolve();
    }

    /** cameraLigar({ ativa }) — pede a permissão da câmara se for preciso. */
    @PluginMethod
    public void cameraLigar(PluginCall call) {
        boolean ativa = call.getBoolean("ativa", false);
        if (ativa && !temCamera()) {
            requestPermissionForAlias("camera", call, "aoPermissaoCamera");
            return;
        }
        aplicarCamera(ativa, call);
    }

    @PermissionCallback
    private void aoPermissaoCamera(PluginCall call) {
        if (temCamera()) {
            aplicarCamera(true, call);
        } else {
            SegurancaCore.cameraAtiva = false;
            SegurancaCore.guardar();
            JSObject r = new JSObject();
            r.put("ativa", false);
            r.put("motivo", "permissao");
            call.resolve(r);
        }
    }

    private void aplicarCamera(boolean ativa, PluginCall call) {
        SegurancaCore.cameraAtiva = ativa;
        SegurancaCore.guardar();
        if (!ativa) SegurancaCore.definirEstadoCamera("desligada");
        avaliarCamera();
        JSObject r = new JSObject();
        r.put("ativa", ativa);
        r.put("estado", SegurancaCore.estadoCamera);
        call.resolve(r);
    }

    private boolean temCamera() {
        return getPermissionState("camera") == PermissionState.GRANTED
                || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    /** A câmara só corre com: opção ligada + ecrã visível + viagem em marcha + permissão. */
    private void avaliarCamera() {
        if (monitor == null) return;
        boolean quer = SegurancaCore.cameraAtiva && SegurancaCore.visivel && temCamera()
                && SegurancaCore.rott != null && SegurancaCore.rott.emMarcha() && getActivity() != null;
        if (quer && !monitor.ligada()) {
            monitor.ligar(getActivity());
        } else if (!quer && monitor.ligada()) {
            monitor.desligar();
            SegurancaCore.definirEstadoCamera(SegurancaCore.cameraAtiva ? "pausa" : "desligada");
        } else if (!quer && !SegurancaCore.cameraAtiva && !"desligada".equals(SegurancaCore.estadoCamera)) {
            SegurancaCore.definirEstadoCamera("desligada");
        }
    }

    /** O aviso falado ao mudar de ecrã só sai se a opção estiver ligada e não houver chamada nem áudio a tocar. */
    private boolean podeAvisarTransicao() {
        if (!SegurancaCore.avisoTransicao || !SegurancaCore.cameraAtiva) return false;
        if (SegurancaCore.rott == null || !SegurancaCore.rott.emMarcha()) return false;
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return true;
            return am.getMode() == AudioManager.MODE_NORMAL && !am.isMusicActive();
        } catch (RuntimeException e) {
            return false;
        }
    }

    private boolean ecraLigado() {
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            return pm == null || pm.isInteractive();
        } catch (RuntimeException e) {
            return true;
        }
    }

    // ------------------------------------------------------------------ ROTT / verificação

    /**
     * rott({ estado: 'parado'|'em_marcha'|'pausa', continuaSeg, diarioSeg }).
     * continuaSeg = tempo que falta para a pausa das 4h30 (o que o ecrã mostra), diarioSeg = o que falta para o limite de 9h/10h.
     */
    @PluginMethod
    public void rott(PluginCall call) {
        String estado = call.getString("estado", "parado");
        Integer cont = call.getInt("continuaSeg", -1);
        Integer dia = call.getInt("diarioSeg", -1);
        if (!"em_marcha".equals(estado) && !"pausa".equals(estado)) estado = "parado";
        garantirServico(estado);
        SegurancaCore.rott.sincronizar(estado, cont == null ? -1 : cont, dia == null ? -1 : dia);
        avaliarCamera();
        call.resolve();
    }

    private void garantirServico(String estado) {
        if (!"em_marcha".equals(estado) || SegurancaCore.servicoAtivo) return;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return;
        try {
            Context ctx = getContext();
            ContextCompat.startForegroundService(ctx, new Intent(ctx, VoiceForegroundService.class));
        } catch (RuntimeException e) {
            Log.w(TAG, "Não consegui arrancar o serviço", e);
        }
    }

    /** velocidade({ kmh, lat, lon, prec }) — vem do GPS do JS; é o que confirma que o camião se está a mover. */
    @PluginMethod
    public void posicao(PluginCall call) {
        Float kmh = call.getFloat("kmh", 0f);
        Double lat = call.getDouble("lat", Double.NaN);
        Double lon = call.getDouble("lon", Double.NaN);
        Double prec = call.getDouble("prec", 0.0);
        long agora = SystemClock.elapsedRealtime();
        if (kmh != null && kmh >= 0) { SegurancaCore.velKmh = kmh; SegurancaCore.velEm = agora; }
        if (lat != null && lon != null && !lat.isNaN() && !lon.isNaN()) {
            SegurancaCore.lat = lat;
            SegurancaCore.lon = lon;
            SegurancaCore.prec = prec == null ? 0 : prec;
            SegurancaCore.posEm = agora;
        }
        call.resolve();
    }

    /** Pede a permissão de chamada (SOS liga sozinho à central). Se for recusada, o SOS abre o marcador. */
    @PluginMethod
    public void pedirChamada(PluginCall call) {
        if (getPermissionState("chamada") == PermissionState.GRANTED) {
            JSObject r = new JSObject();
            r.put("concedida", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias("chamada", call, "aoPermissaoChamada");
    }

    @PermissionCallback
    private void aoPermissaoChamada(PluginCall call) {
        JSObject r = new JSObject();
        r.put("concedida", getPermissionState("chamada") == PermissionState.GRANTED);
        call.resolve(r);
    }

    /** Anoitecer: pergunta por voz se liga a câmara de sonolência (a resposta volta no evento "noiteResposta"). */
    @PluginMethod
    public void perguntarNoite(PluginCall call) {
        SegurancaCore.perguntarNoite();
        call.resolve();
    }

    /** Teste: faz já a pergunta "estás bem?" e dispara o alarme se não responderes. Resolve ok=false se a viagem não está em marcha. */
    @PluginMethod
    public void testarVerificacao(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ok", SegurancaCore.rott.testar());
        call.resolve(r);
    }

    @PluginMethod
    public void confirmar(PluginCall call) {
        SegurancaCore.rott.confirmar("ecra");
        call.resolve();
    }

    // ------------------------------------------------------------------ SOS

    @PluginMethod
    public void sosIniciar(PluginCall call) {
        SegurancaCore.sos.iniciar("botao");
        call.resolve();
    }

    @PluginMethod
    public void sosCancelar(PluginCall call) {
        SegurancaCore.sos.cancelar("ecra");
        call.resolve();
    }

    // ------------------------------------------------------------------ estado e definições do sistema

    @PluginMethod
    public void estado(PluginCall call) {
        JSObject r = new JSObject();
        r.put("camera", SegurancaCore.estadoCamera);
        r.put("cameraAtiva", SegurancaCore.cameraAtiva);
        r.put("avisoTransicao", SegurancaCore.avisoTransicao);
        r.put("sosAContar", SegurancaCore.sos != null && SegurancaCore.sos.contando());
        r.put("aguardaResposta", SegurancaCore.rott != null && SegurancaCore.rott.aguardaResposta());
        r.put("alarme", SegurancaCore.alarme != null && SegurancaCore.alarme.ativo());
        r.put("servico", SegurancaCore.servicoAtivo);
        r.put("bateriaIsenta", bateriaIsenta());
        call.resolve(r);
    }

    private boolean bateriaIsenta() {
        if (Build.VERSION.SDK_INT < 23) return true;
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * Abre o ecrã de otimização de bateria do Android para o condutor escolher "Sem restrições" para o Benjamin.
     * NÃO usa REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (política da Google Play).
     */
    @PluginMethod
    public void abrirBateria(PluginCall call) {
        Context ctx = getActivity() != null ? getActivity() : getContext();
        Intent lista = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        Intent detalhes = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        if (!(ctx instanceof android.app.Activity)) {
            lista.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            detalhes.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        }
        try {
            ctx.startActivity(lista);
        } catch (ActivityNotFoundException | SecurityException e) {
            try {
                ctx.startActivity(detalhes);
            } catch (RuntimeException e2) {
                call.reject("Não consegui abrir as definições de bateria", "BATERIA");
                return;
            }
        }
        call.resolve();
    }
}
