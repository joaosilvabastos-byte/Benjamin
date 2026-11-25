package com.bybastos.benjamin;

import android.annotation.SuppressLint;
import android.content.Context;
import android.media.Image;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import android.util.Size;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ExperimentalGetImage;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSObject;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.android.gms.tasks.OnCompleteListener;
import com.google.android.gms.tasks.OnSuccessListener;
import com.google.android.gms.tasks.Task;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;

import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sonolência pela câmara frontal. Sem pré-visualização, ~3 fotogramas/s, 320x240, tudo no telemóvel
 * (ML Kit Face Detection com modelo incluído na app: funciona offline). Nada é gravado nem enviado.
 *
 * Só liga enquanto o ecrã da app está visível (a câmara está ligada ao ciclo de vida da Activity).
 * Sinais: olhos fechados seguidos, percentagem de olhos fechados no último minuto, cabeça a cair
 * em relação à posição calibrada. NÃO deteta bocejos (o ML Kit não os classifica).
 */
final class MonitorSonolencia {

    private static final String TAG = "BenjaminSono";

    // ---- Afinação (mexe aqui depois de testar no camião) ----
    private static final long INTERVALO_NORMAL_MS = 300;        // ~3 fps
    private static final long INTERVALO_QUENTE_MS = 700;        // telemóvel a aquecer: ~1,4 fps
    private static final float OLHO_FECHADO_PROB = 0.35f;       // média dos dois olhos abaixo disto = fechados
    private static final long OLHOS_AVISO_MS = 2000;            // olhos fechados 2 s (tempo real) -> alerta
    private static final long OLHOS_ALERTA_MS = 3500;           // fechados seguidos -> alerta forte
    private static final long TOLERANCIA_ABRIR_MS = 450;        // olhos abertos menos tempo que isto não "reiniciam" a contagem (ruído da deteção)
    private static final float CABECA_CAI_GRAUS = 15f;          // inclinação da cabeça (cima/baixo) face à calibração
    private static final float CABECA_LADO_GRAUS = 20f;         // inclinação de lado face à calibração
    private static final long CABECA_CAI_MS = 2000;             // cabeça inclinada seguida durante este tempo -> alerta
    private static final long JANELA_PERCLOS_MS = 60_000;
    private static final float PERCLOS_LIMITE = 0.25f;          // >25% do último minuto com olhos fechados
    private static final long REPETIR_ALERTA_MS = 15_000;       // pausa mínima entre alertas
    private static final long REPETIR_CANSACO_MS = 120_000;     // pausa mínima entre avisos de cansaço
    private static final int CALIBRACAO_FRAMES = 12;            // ~4 s a olhar em frente

    private final Context ctx;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private ProcessCameraProvider provider;
    private ImageAnalysis analise;
    private FaceDetector detetor;
    private volatile boolean ligada;
    private volatile boolean pausadaQuente;
    private volatile long intervaloMs = INTERVALO_NORMAL_MS;
    private PowerManager.OnThermalStatusChangedListener termico;

    // estado da análise (só na thread principal: callbacks do ML Kit)
    private long ultimoFrame;
    private int calibrados;
    private final float[] amostrasX = new float[CALIBRACAO_FRAMES];
    private final float[] amostrasZ = new float[CALIBRACAO_FRAMES];
    private float baseX;
    private float baseZ;
    private long abertosDesde;
    private long direitaDesde;
    private boolean calibrada;
    private long fechadosDesde;
    private long cabecaCaiDesde;
    private long semCaraDesde;
    private long ultimoAlerta;
    private long ultimoCansaco;
    private int alertasRecentes;
    private long primeiroAlertaRecente;
    private final ArrayDeque<Long> fechadosTs = new ArrayDeque<>();
    private final ArrayDeque<Long> todosTs = new ArrayDeque<>();

    MonitorSonolencia(Context c) {
        this.ctx = c.getApplicationContext();
    }

    boolean ligada() { return ligada; }

    /** Liga a câmara ao ciclo de vida da Activity (fecha sozinha quando o ecrã sai de cena). */
    void ligar(final LifecycleOwner dono) {
        if (ligada) return;
        ligada = true;
        reiniciarAnalise();
        registarTermico();
        final ListenableFuture<ProcessCameraProvider> f = ProcessCameraProvider.getInstance(ctx);
        final Executor principal = ContextCompat.getMainExecutor(ctx);
        f.addListener(new Runnable() {
            @Override
            public void run() {
                try {
                    if (!ligada) return;
                    provider = f.get();
                    if (detetor == null) {
                        detetor = FaceDetection.getClient(new FaceDetectorOptions.Builder()
                                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                                .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
                                .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
                                .setContourMode(FaceDetectorOptions.CONTOUR_MODE_NONE)
                                .build());
                    }
                    analise = new ImageAnalysis.Builder()
                            .setTargetResolution(new Size(320, 240))
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build();
                    analise.setAnalyzer(executor, new ImageAnalysis.Analyzer() {
                        @Override public void analyze(@NonNull ImageProxy imagem) { analisar(imagem); }
                    });
                    provider.unbindAll();
                    provider.bindToLifecycle(dono, CameraSelector.DEFAULT_FRONT_CAMERA, analise);
                    SegurancaCore.definirEstadoCamera(calibrada ? "ativa" : "calibrando");
                } catch (ExecutionException | InterruptedException | RuntimeException e) {
                    Log.e(TAG, "Não consegui ligar a câmara", e);
                    ligada = false;
                    SegurancaCore.definirEstadoCamera("pausa");
                }
            }
        }, principal);
    }

    void desligar() {
        ligada = false;
        try {
            if (analise != null) analise.clearAnalyzer();
            if (provider != null) provider.unbindAll();
        } catch (RuntimeException e) {
            Log.w(TAG, "desligar", e);
        }
        analise = null;
        desregistarTermico();
    }

    void destruir() {
        desligar();
        try { if (detetor != null) detetor.close(); } catch (RuntimeException e) { /* ok */ }
        detetor = null;
        executor.shutdown();
    }

    private void reiniciarAnalise() {
        calibrados = 0;
        calibrada = false;
        fechadosDesde = 0;
        abertosDesde = 0;
        cabecaCaiDesde = 0;
        direitaDesde = 0;
        semCaraDesde = 0;
        ultimoFrame = 0;
        fechadosTs.clear();
        todosTs.clear();
    }

    // ---------------------------------------------------------------- calor

    private void registarTermico() {
        if (Build.VERSION.SDK_INT < 29 || termico != null) return;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm == null) return;
        termico = new PowerManager.OnThermalStatusChangedListener() {
            @Override
            public void onThermalStatusChanged(int status) {
                if (status >= PowerManager.THERMAL_STATUS_SEVERE) {
                    pausadaQuente = true;
                    SegurancaCore.definirEstadoCamera("quente");
                } else if (status >= PowerManager.THERMAL_STATUS_MODERATE) {
                    intervaloMs = INTERVALO_QUENTE_MS;       // menos fotogramas, câmara continua
                    if (pausadaQuente) { pausadaQuente = false; SegurancaCore.definirEstadoCamera(calibrada ? "ativa" : "calibrando"); }
                } else {
                    intervaloMs = INTERVALO_NORMAL_MS;
                    if (pausadaQuente) { pausadaQuente = false; SegurancaCore.definirEstadoCamera(calibrada ? "ativa" : "calibrando"); }
                }
            }
        };
        try {
            pm.addThermalStatusListener(termico);
        } catch (RuntimeException e) {
            termico = null;
        }
    }

    private void desregistarTermico() {
        if (Build.VERSION.SDK_INT < 29 || termico == null) return;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm != null) pm.removeThermalStatusListener(termico);
        } catch (RuntimeException e) { /* ok */ }
        termico = null;
        pausadaQuente = false;
        intervaloMs = INTERVALO_NORMAL_MS;
    }

    // ---------------------------------------------------------------- análise

    @OptIn(markerClass = ExperimentalGetImage.class)
    @SuppressLint("UnsafeOptInUsageError")
    private void analisar(@NonNull final ImageProxy imagem) {
        long agora = SystemClock.elapsedRealtime();
        if (!ligada || pausadaQuente || detetor == null || agora - ultimoFrame < intervaloMs) {
            imagem.close();
            return;
        }
        ultimoFrame = agora;
        Image media = imagem.getImage();
        if (media == null) {
            imagem.close();
            return;
        }
        try {
            InputImage in = InputImage.fromMediaImage(media, imagem.getImageInfo().getRotationDegrees());
            Task<List<Face>> t = detetor.process(in);
            t.addOnSuccessListener(new OnSuccessListener<List<Face>>() {
                @Override public void onSuccess(List<Face> caras) { tratar(caras); }
            });
            t.addOnCompleteListener(new OnCompleteListener<List<Face>>() {
                @Override public void onComplete(@NonNull Task<List<Face>> tarefa) { imagem.close(); }
            });
        } catch (RuntimeException e) {
            Log.w(TAG, "analisar", e);
            imagem.close();
        }
    }

    private void tratar(List<Face> caras) {
        long agora = SystemClock.elapsedRealtime();
        if (!ligada) return;
        if (caras == null || caras.isEmpty()) {
            fechadosDesde = 0;
            abertosDesde = 0;
            cabecaCaiDesde = 0;
            direitaDesde = 0;
            if (semCaraDesde == 0) semCaraDesde = agora;
            return;
        }
        semCaraDesde = 0;
        Face cara = caras.get(0);
        for (Face f : caras) {
            if (f.getBoundingBox().width() > cara.getBoundingBox().width()) cara = f;
        }
        Float esq = cara.getLeftEyeOpenProbability();
        Float dir = cara.getRightEyeOpenProbability();
        if (esq == null || dir == null) return;
        float abertura = (esq + dir) / 2f;
        float x = cara.getHeadEulerAngleX();        // cima/baixo (a cabeça a cair faz descer este valor)
        float z = cara.getHeadEulerAngleZ();        // inclinação de lado

        if (!calibrada) {
            if (abertura > 0.6f && calibrados < CALIBRACAO_FRAMES) { amostrasZ[calibrados] = z; amostrasX[calibrados++] = x; }
            if (calibrados >= CALIBRACAO_FRAMES) {
                float[] c = Arrays.copyOf(amostrasX, calibrados);
                Arrays.sort(c);
                baseX = c[c.length / 2];
                float[] cz = Arrays.copyOf(amostrasZ, calibrados);
                Arrays.sort(cz);
                baseZ = cz[cz.length / 2];
                calibrada = true;
                SegurancaCore.definirEstadoCamera("ativa");
                SegurancaCore.dizer(FrasesSeguranca.CAMERA_ATIVA, false);
            }
            return;
        }

        boolean fechados = abertura < OLHO_FECHADO_PROB;
        todosTs.addLast(agora);
        if (fechados) fechadosTs.addLast(agora);
        while (!todosTs.isEmpty() && agora - todosTs.peekFirst() > JANELA_PERCLOS_MS) todosTs.removeFirst();
        while (!fechadosTs.isEmpty() && agora - fechadosTs.peekFirst() > JANELA_PERCLOS_MS) fechadosTs.removeFirst();

        // Tempo real decorrido (não conta fotogramas). Um fotograma "aberto" isolado não reinicia a contagem.
        if (fechados) {
            abertosDesde = 0;
            if (fechadosDesde == 0) fechadosDesde = agora;
        } else if (fechadosDesde != 0) {
            if (abertosDesde == 0) abertosDesde = agora;
            if (agora - abertosDesde >= TOLERANCIA_ABRIR_MS) { fechadosDesde = 0; abertosDesde = 0; }
        }
        boolean cai = Math.abs(x - baseX) > CABECA_CAI_GRAUS || Math.abs(z - baseZ) > CABECA_LADO_GRAUS;
        if (cai) {
            direitaDesde = 0;
            if (cabecaCaiDesde == 0) cabecaCaiDesde = agora;
        } else if (cabecaCaiDesde != 0) {
            if (direitaDesde == 0) direitaDesde = agora;
            if (agora - direitaDesde >= TOLERANCIA_ABRIR_MS) { cabecaCaiDesde = 0; direitaDesde = 0; }
        }

        // Só avalia alertas com a viagem em marcha (parado num semáforo/pausa não alarma)
        if (SegurancaCore.rott == null || !SegurancaCore.rott.emMarcha()) return;

        long fechadosMs = fechadosDesde == 0 ? 0 : agora - fechadosDesde;
        long caiMs = cabecaCaiDesde == 0 ? 0 : agora - cabecaCaiDesde;

        if (fechadosMs >= OLHOS_ALERTA_MS || (caiMs >= CABECA_CAI_MS && fechadosMs >= 1000)) {
            alertar(agora, 2);
        } else if (fechadosMs >= OLHOS_AVISO_MS || caiMs >= CABECA_CAI_MS) {
            alertar(agora, 1);
        } else if (todosTs.size() > 40) {
            float perclos = (float) fechadosTs.size() / (float) todosTs.size();
            if (perclos > PERCLOS_LIMITE && agora - ultimoCansaco > REPETIR_CANSACO_MS) {
                ultimoCansaco = agora;
                emitirSono(0, "perclos");
                SegurancaCore.dizer(FrasesSeguranca.SONO_AVISO, false);
            }
        }
    }

    /** nivel 1 = alerta; nivel 2 = crítico. Alertas repetidos em 2 min sobem sempre para crítico. */
    private void alertar(long agora, int nivel) {
        if (agora - ultimoAlerta < REPETIR_ALERTA_MS) return;
        ultimoAlerta = agora;
        if (agora - primeiroAlertaRecente > 120_000) { alertasRecentes = 0; primeiroAlertaRecente = agora; }
        alertasRecentes++;
        int final_ = (nivel >= 2 || alertasRecentes >= 2) ? 2 : 1;
        AlertaSom.vibrar(ctx, false);
        AlertaSom.beepCurto();                       // sinal imediato: a fala demora mais a começar
        SegurancaCore.dizer(final_ >= 2 ? FrasesSeguranca.SONO_CRITICO : FrasesSeguranca.SONO_ALERTA, true);
        emitirSono(final_, "olhos-ou-cabeca");
    }

    private void emitirSono(int nivel, String motivo) {
        JSObject o = new JSObject();
        o.put("nivel", nivel);
        o.put("motivo", motivo);
        SegurancaCore.emitir("sonolencia", o);
    }
}
