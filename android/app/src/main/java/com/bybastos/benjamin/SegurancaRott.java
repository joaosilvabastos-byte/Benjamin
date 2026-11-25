package com.bybastos.benjamin;

import android.os.SystemClock;

import com.getcapacitor.JSObject;

/**
 * ROTT + verificação de 45 em 45 minutos, tudo com SystemClock.elapsedRealtime()
 * (não depende do JavaScript nem do relógio do telemóvel; sobrevive a ecrã apagado).
 *
 * O JavaScript só SINCRONIZA os tempos restantes que já mostra no ecrã (sincronizar()).
 * O serviço em primeiro plano chama tick() a cada poucos segundos.
 */
final class SegurancaRott {

    private static final long CHECK_MS = 45L * 60 * 1000;
    private static final long ALARME_RAPIDO_MS = 15_000L;   // sem resposta à 1.ª pergunta + em movimento: sinais agudos
    private static final long ALARME_APOS_MS = 40_000L;     // parado quando perguntou: 2.ª pergunta e, se entretanto arrancar, alarme
    private static final long ADIA_MS = 5L * 60 * 1000;     // pergunta sem resposta mas parado: volta a perguntar após mais 5 min EM MOVIMENTO
    private static final float VEL_MOVIMENTO_KMH = 5f;
    private static final long VEL_VALIDADE_MS = 90_000L;    // leitura de velocidade mais velha que isto = sem prova de movimento
    private static final long TICK_MAX_MS = 20_000L;        // um intervalo entre ticks maior que isto (suspensão) não conta como condução
    private static final long GUARDA_ECO_MS = 5_000L;       // "estou bem" dito nos primeiros 5 s da pergunta não vale (eco da própria fala)
    private static final int[] AVISOS_MIN = {30, 15, 5, 0};

    private enum Fase { LIVRE, PERGUNTOU, REPETIU, ALARME }

    private String estado = "parado";            // parado | em_marcha | pausa
    private long fimContinua = -1;
    private long fimDiaria = -1;
    private final boolean[] dadoCont = new boolean[4];
    private final boolean[] dadoDia = new boolean[4];
    private long checkRestanteMs = CHECK_MS;     // tempo de CONDUÇÃO REAL que falta até à próxima pergunta (só desce em movimento)
    private long ultimoTick;
    private Fase fase = Fase.LIVRE;
    private long inicioPergunta;
    private long ultimaPergunta;                 // início da última vez que o Benjamin falou a pergunta
    private boolean testeForcado;                // teste manual: alarma mesmo com o camião parado

    synchronized boolean emMarcha() { return "em_marcha".equals(estado); }
    synchronized boolean aguardaResposta() { return fase == Fase.PERGUNTOU || fase == Fase.REPETIU; }
    synchronized boolean alarmeAtivo() { return fase == Fase.ALARME; }

    /** novoEstado: parado | em_marcha | pausa. Segundos restantes < 0 = desconhecido. */
    synchronized void sincronizar(String novoEstado, long contSeg, long diarioSeg) {
        long agora = SystemClock.elapsedRealtime();
        fimContinua = contSeg >= 0 ? agora + contSeg * 1000 : -1;
        fimDiaria = diarioSeg >= 0 ? agora + diarioSeg * 1000 : -1;
        marcar(dadoCont, contSeg);
        marcar(dadoDia, diarioSeg);

        if (!novoEstado.equals(estado)) {
            String antigo = estado;
            estado = novoEstado;
            if ("em_marcha".equals(novoEstado)) {
                ultimoTick = agora;
                fase = Fase.LIVRE;
            } else {
                if ("parado".equals(novoEstado)) checkRestanteMs = CHECK_MS;
                terminarVerificacao();
            }
        }
        com.bybastos.benjamin.VoiceForegroundService.atualizar();
    }

    /** Evita repetir um aviso por causa de pequenas diferenças entre o relógio do JS e este. */
    private void marcar(boolean[] dado, long seg) {
        if (seg < 0) return;
        for (int i = 0; i < AVISOS_MIN.length; i++) {
            long limite = AVISOS_MIN[i] * 60L;
            if (seg <= limite) dado[i] = true;
            else if (seg > limite + 120) dado[i] = false;
        }
    }

    synchronized void tick() {
        if (!"em_marcha".equals(estado)) return;
        long agora = SystemClock.elapsedRealtime();
        long dt = Math.min(Math.max(agora - ultimoTick, 0L), TICK_MAX_MS);
        ultimoTick = agora;
        avisos(agora, fimContinua, dadoCont, true);
        avisos(agora, fimDiaria, dadoDia, false);
        verificacao(agora, dt);
    }

    private void avisos(long agora, long fim, boolean[] dado, boolean continua) {
        if (fim < 0) return;
        long restanteSeg = Math.max(0, (fim - agora) / 1000);
        for (int i = 0; i < AVISOS_MIN.length; i++) {
            if (dado[i]) continue;
            if (restanteSeg <= AVISOS_MIN[i] * 60L) {
                // marca este e os mais distantes, para não falar três avisos de seguida
                for (int j = 0; j <= i; j++) dado[j] = true;
                int min = AVISOS_MIN[i];
                SegurancaCore.dizer(continua ? FrasesSeguranca.continua(min) : FrasesSeguranca.diaria(min), false);
                JSObject o = new JSObject();
                o.put("tipo", continua ? "continua" : "diaria");
                o.put("minutos", min);
                SegurancaCore.emitir("rott", o);
                break;
            }
        }
    }

    /**
     * Em movimento REAL: leitura de velocidade recente (<= 90 s) e >= 5 km/h.
     * Sem leitura recente (GPS sem sinal, app em segundo plano) NÃO há prova de movimento: não conta e não alarma.
     */
    private boolean emMovimento(long agora) {
        return SegurancaCore.velEm != 0 && (agora - SegurancaCore.velEm) <= VEL_VALIDADE_MS
                && SegurancaCore.velKmh >= VEL_MOVIMENTO_KMH;
    }

    private boolean devoAlarmar(long agora) {
        return testeForcado || emMovimento(agora);
    }

    private void verificacao(long agora, long dt) {
        switch (fase) {
            case LIVRE:
                if (testeForcado || emMovimento(agora)) checkRestanteMs -= dt;     // parado = o contador não anda
                if (checkRestanteMs <= 0) {
                    fase = Fase.PERGUNTOU;
                    inicioPergunta = agora;
                    ultimaPergunta = agora;
                    SegurancaCore.dizer(FrasesSeguranca.VERIF_PERGUNTA, false);
                    SegurancaCore.notificarAlerta(FrasesSeguranca.NOTIF_VERIF_TITULO, FrasesSeguranca.NOTIF_VERIF_TEXTO,
                            VoiceForegroundService.ACAO_CONFIRMAR, "ESTOU BEM");
                    emitirVerificacao("pergunta");
                    VoiceForegroundService.atualizar();
                }
                break;
            case PERGUNTOU:
                if (agora - inicioPergunta >= ALARME_RAPIDO_MS) {
                    if (devoAlarmar(agora)) {
                        dispararAlarme();                // sem resposta: sinais agudos, sem esperar mais fala
                    } else {
                        fase = Fase.REPETIU;
                        ultimaPergunta = agora;
                        SegurancaCore.dizer(FrasesSeguranca.VERIF_REPETE, false);
                        emitirVerificacao("repete");
                    }
                }
                break;
            case REPETIU:
                if (agora - inicioPergunta >= ALARME_APOS_MS) {
                    if (devoAlarmar(agora)) {
                        dispararAlarme();
                    } else {
                        fase = Fase.LIVRE;               // parou entretanto: sem alarme; volta a perguntar após mais 5 min a andar
                        checkRestanteMs = ADIA_MS;
                        SegurancaCore.limparAlerta();
                        emitirVerificacao("adiada");
                    }
                    VoiceForegroundService.atualizar();
                }
                break;
            case ALARME:
            default:
                break;
        }
    }

    private void dispararAlarme() {
        fase = Fase.ALARME;
        SegurancaCore.alarme.iniciar(SegurancaCore.app);
        SegurancaCore.notificarAlerta(FrasesSeguranca.NOTIF_ALARME_TITULO, FrasesSeguranca.NOTIF_ALARME_TEXTO,
                VoiceForegroundService.ACAO_PARAR_ALARME, "PARAR ALARME");
        emitirVerificacao("alarme");
        VoiceForegroundService.atualizar();
    }

    private void emitirVerificacao(String f) {
        JSObject o = new JSObject();
        o.put("fase", f);
        SegurancaCore.emitir("verificacao", o);
    }

    /**
     * Confirma presença. origem: "voz" só vale enquanto o Benjamin pergunta;
     * "ecra" (botão no ecrã ou na notificação) vale também para desligar o alarme.
     */
    synchronized void confirmar(String origem) {
        if (fase == Fase.ALARME) {
            if (!"ecra".equals(origem)) return;     // o alarme só se desliga no ecrã
        } else if (fase != Fase.PERGUNTOU && fase != Fase.REPETIU) {
            return;
        } else if (!"ecra".equals(origem) && SystemClock.elapsedRealtime() - ultimaPergunta < GUARDA_ECO_MS) {
            return;      // o microfone apanhou a própria pergunta ("diz estou bem"): não conta como resposta
        }
        boolean eraAlarme = fase == Fase.ALARME;
        terminarVerificacao();
        checkRestanteMs = CHECK_MS;
        if (!eraAlarme) SegurancaCore.dizer(FrasesSeguranca.VERIF_OK, false);
        emitirVerificacao("ok");
        VoiceForegroundService.atualizar();
    }

    /** Teste manual (Opções): pergunta já e alarma se não responderes, mesmo parado (única exceção à regra do movimento). Só com a viagem em marcha. */
    synchronized boolean testar() {
        if (!"em_marcha".equals(estado)) return false;
        terminarVerificacao();      // limpa qualquer verificação anterior
        testeForcado = true;        // (depois da limpeza, para não a perder)
        checkRestanteMs = 0;        // pergunta já no próximo tick
        return true;
    }

    private void terminarVerificacao() {
        testeForcado = false;
        fase = Fase.LIVRE;
        if (SegurancaCore.alarme != null) SegurancaCore.alarme.parar(SegurancaCore.app);
        SegurancaCore.limparAlerta();
    }

    synchronized void aoTerminarServico() {
        estado = "parado";
        checkRestanteMs = CHECK_MS;
        terminarVerificacao();
    }
}
