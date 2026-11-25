package com.bybastos.benjamin;

/**
 * TODAS as frases novas de segurança num só sítio, para rever e afinar.
 * Só texto: nenhuma lógica aqui. Os %d são substituídos pelos minutos.
 */
final class FrasesSeguranca {
    private FrasesSeguranca() { }

    // ---- ROTT: pausa obrigatória das 4h30 de condução contínua ----
    static final String CONT_30 = "Atenção, faltam trinta minutos para a pausa obrigatória das quatro horas e meia. Vai pensando onde parar.";
    static final String CONT_15 = "Faltam quinze minutos para a pausa obrigatória. Começa a procurar um sítio seguro.";
    static final String CONT_5  = "Faltam cinco minutos para a pausa obrigatória. Procura já onde parar em segurança.";
    static final String CONT_0  = "Chegaste às quatro horas e meia de condução. Tens de fazer a pausa agora, assim que for seguro.";

    // ---- ROTT: limite diário de condução (9h ou 10h) ----
    static final String DIA_30 = "Atenção, faltam trinta minutos para o limite diário de condução.";
    static final String DIA_15 = "Faltam quinze minutos para o limite diário de condução. Vai pensando onde ficar.";
    static final String DIA_5  = "Faltam cinco minutos para o limite diário de condução. Procura já um sítio para estacionar.";
    static final String DIA_0  = "Chegaste ao limite diário de condução. Tens de parar assim que for seguro.";

    // ---- Verificação de 45 em 45 minutos ----
    static final String VERIF_PERGUNTA = "Estás bem? Diz estou bem, ou toca no ecrã.";
    static final String VERIF_REPETE   = "Preciso que me respondas. Estás acordado?";
    static final String VERIF_OK       = "Boa. Seguimos.";

    // ---- SOS ----
    static final String SOS_INICIO    = "SOS ativado. Envio o alerta em dez segundos. Diz cancelar, ou toca no ecrã, para parar.";
    static final String SOS_CANCELADO = "SOS cancelado.";
    static final String SOS_ENVIADO   = "Alerta enviado ao encarregado com a tua localização.";
    static final String SOS_SEM_EMAIL = "Não tenho o e-mail do encarregado. Configura-o nas opções.";
    static final String SOS_FALHOU    = "Não consegui enviar o alerta. Liga já para a central.";

    // ---- Sonolência (câmara frontal) ----
    static final String SONO_AVISO   = "Vejo sinais de cansaço. Abre a janela e fala comigo.";
    static final String SONO_ALERTA  = "Alerta de sonolência. Pára no próximo sítio seguro.";
    static final String SONO_CRITICO = "Acorda! Sonolência detetada. Pára assim que puderes em segurança.";
    static final String CAMERA_ATIVA = "Câmara de sonolência ativa.";

    // ---- Anoitecer: pergunta se liga a câmara de sonolência ----
    static final String NOITE_PERGUNTA = "Já escureceu. Queres que ligue a câmara de sonolência? Diz sim, liga, ou não.";

    // ---- Mudança de ecrã (aviso curto, configurável nas Opções) ----
    static final String TRANSICAO_SAIR   = "Câmara de sonolência em pausa enquanto estás noutra aplicação.";
    static final String TRANSICAO_VOLTAR = "Câmara de sonolência outra vez ativa.";

    // ---- Textos de notificação / ecrã (não são falados) ----
    static final String NOTIF_ALARME_TITULO = "Benjamin: sem resposta";
    static final String NOTIF_ALARME_TEXTO  = "Alarme ativo. Toca para parar.";
    static final String NOTIF_VERIF_TITULO  = "Benjamin: estás bem?";
    static final String NOTIF_VERIF_TEXTO   = "Toca em ESTOU BEM para confirmar.";
    static final String NOTIF_SOS_TITULO    = "SOS a caminho";
    static final String NOTIF_SOS_TEXTO     = "Toca em CANCELAR para parar o alerta.";
    static final String NOTIF_LIGAR_TITULO  = "SOS enviado";
    static final String NOTIF_LIGAR_TEXTO   = "Toca para ligar à central.";
    static final String ESTADO_CAM_ATIVA    = "Câmara ativa";
    static final String ESTADO_CAM_PAUSA    = "Câmara em pausa";
    static final String ESTADO_CAM_CALIB    = "Câmara a calibrar";
    static final String ESTADO_CAM_QUENTE   = "Câmara em pausa (telemóvel quente)";

    static String continua(int min) {
        switch (min) { case 30: return CONT_30; case 15: return CONT_15; case 5: return CONT_5; default: return CONT_0; }
    }

    static String diaria(int min) {
        switch (min) { case 30: return DIA_30; case 15: return DIA_15; case 5: return DIA_5; default: return DIA_0; }
    }
}
