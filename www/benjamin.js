// benjamin.js — Co-piloto de voz Benjamin
// Fala: SpeechSynthesis | Escuta: SpeechRecognition (instância única, contínua)
import { BENJAMIN_SYSTEM_PROMPT } from './benjaminPrompt.js';

const URL_WORKER = 'https://benjamin.joaosilvabastos.workers.dev';

const ESPERA_REATIVAR_MS = 1000;
const ESPERA_NATIVA_MS = 500;      // idem, com a voz nativa (microfone fechado enquanto fala)
const PENSAR_APOS_MS = 1200;       // se o Gemini demorar mais do que isto, o Benjamin diz algo em vez de ficar calado   // pausa após a fala antes de reabrir o microfone

const QUIZ_VALIDADE_MS = 4 * 60 * 1000; // o quiz fica à espera de resposta até 4 minutos
const HIST_KEY = 'benjamin_historico_v1';
const HIST_MAX = 60;                     // quantas piadas/perguntas/curiosidades se lembra (por tipo)
const TEMAS = {
  piada: ['um camionista distraído', 'animais num escritório', 'os ingleses e a chuva', 'objetos com crises existenciais',
    'um GPS teimoso', 'matemática absurda', 'um pato no supermercado', 'burocracia', 'um fantasma preguiçoso',
    'relógios e o tempo', 'meias e sapatos', 'um pirata reformado', 'um mordomo britânico', 'um frigorífico filósofo',
    'o trânsito', 'um robô sem sentido de humor'],
  quiz: ['geografia estranha', 'leis bizarras pelo mundo', 'história de Portugal', 'natureza e animais', 'cultura pop e cinema',
    'música', 'desporto', 'ciência do dia a dia', 'astronomia', 'gastronomia', 'invenções', 'línguas e palavras',
    'o corpo humano', 'oceanos', 'camiões e transportes', 'monumentos famosos', 'inventores e descobertas', 'recordes do mundo'],
  curiosidade: ['animais invulgares', 'o espaço', 'o corpo humano', 'a história de Portugal', 'estradas e camiões',
    'comida e bebida', 'o mar', 'invenções acidentais', 'línguas e palavras', 'o tempo e o clima', 'países pequenos',
    'plantas e árvores', 'o cérebro e o sono', 'desporto', 'cidades europeias', 'dinheiro e moedas'],
};
const BACKOFF_MIN_MS = 300;
const REINICIO_MS = 400;           // reabre o microfone logo após o fim de uma sessão (300–500 ms)
const VIGIA_MS = 2500;             // vigia: confirma de 2,5 em 2,5 s que a escuta não ficou parada
const ABORT_SEM_FIM_MS = 3000;     // abort() sem onend durante tanto tempo => recria o reconhecimento
const BACKOFF_MAX_MS = 5000;
const FALHA_RAPIDA_MS = 800;       // sessão mais curta do que isto = falha (só então o intervalo de reabertura aumenta)
const TTS_ONSTART_MAX_MS = 3000;   // a voz do WebView tem de arrancar (onstart) neste prazo; senão passa à voz nativa

const RE_FEMININA = /joana|maria|catarina|h[eé]lia|fernanda|francisca|raquel|luciana|\bin[eê]s\b|vit[oó]ria|female|feminina/i;
const RE_MASCULINA = /duarte|cristiano|ricardo|raul|diogo|daniel|jo[aã]o|gon[cç]alo|ant[oó]nio|\bmale\b|masculin/i;

export const Benjamin = {
  prompt: BENJAMIN_SYSTEM_PROMPT,

  // ---- Estado ----
  escutaDesejada: false,     // o modo mãos-livres está ligado
  aFalar: false,             // barreira anti-eco: true => microfone desligado e resultados ignorados
  modoEmEspera: false,       // "cala-te" por voz: só reage a "Benjamin, acorda"
  aoMudarEstadoEscuta: null, // callback da UI: 'ouvir' | 'calado' | 'inativo'

  _iniciado: false,
  _aOuvir: false,
  _rec: null,                // instância única de SpeechRecognition
  _paragemIntencional: false,
  _timerReativar: null,
  _reativacaoAte: 0,         // instante previsto da próxima reabertura (para a vigia saber se há uma agendada)
  _timerVigia: null,
  _aIniciar: false,          // _iniciarMicrofone() em curso (ex.: à espera da permissão)
  _abortEm: 0,
  _inicioSessao: 0,
  _falhasRapidas: 0,
  _ignorarAte: 0,
  _fila: [],
  _aProcessarFila: false,
  _voz: null,
  _vozConfirmada: false,
  _permissaoConcedida: false,
  _aPensar: false,
  _ultimaResposta: {},
  _webTtsMudo: false,        // o WebView não fala: usar sempre a voz nativa
  _tn: null,                 // plugin nativo de voz (cache)
  _tnMau: false,             // o plugin nativo respondeu "not implemented": não insistir
  _vozNativaIdx: undefined,
  _avisouSemTts: false,
  _vp: undefined,            // plugin próprio BenjaminVoice (Vosk + TTS nativo); null = não existe
  _vpOuvir: true,            // a escuta nativa está operacional (falso se o modelo não carregar)
  _vpFala: true,             // a fala nativa está operacional (falso se o Android não tiver voz PT)
  _vpLigado: false,

  // ================= Arranque =================
  init() {
    if (this._iniciado) return;
    this._iniciado = true;
    this._diagnosticoTts();
    this._ligarNativo();
    if ('speechSynthesis' in window) {
      this._escolherVoz()
        .then(() => console.log('Benjamin TTS: vozes do WebView =', window.speechSynthesis.getVoices().length))
        .catch(() => {});
    }
    // Se o separador voltar a ficar visível e a escuta devia estar ativa, retoma
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.escutaDesejada && !this.aFalar && !this._aOuvir) {
        this._agendarReativacao(BACKOFF_MIN_MS);
      }
    });
  },

  // ================= Voz e escuta NATIVAS (plugin BenjaminVoice, só no APK) =================
  /** O plugin Java próprio (Vosk offline + TextToSpeech + foco de áudio). null no browser. */
  _nativo() {
    if (this._vp !== undefined) return this._vp;
    let p = null;
    try {
      const C = window.Capacitor;
      const nativo = C && typeof C.isNativePlatform === 'function' && C.isNativePlatform();
      if (nativo && (typeof C.isPluginAvailable !== 'function' || C.isPluginAvailable('BenjaminVoice'))) {
        p = (C.Plugins && C.Plugins.BenjaminVoice)
          || (typeof C.registerPlugin === 'function' ? C.registerPlugin('BenjaminVoice') : null);
      }
    } catch (e) { p = null; }
    this._vp = p || null;
    return this._vp;
  },

  _sttNativo() { return this._vpOuvir ? this._nativo() : null; },
  _ttsVp() { return this._vpFala ? this._nativo() : null; },

  _ligarNativo() {
    const nv = this._nativo();
    if (!nv || this._vpLigado) return;
    this._vpLigado = true;
    const ouvir = (evento, fn) => {
      try { Promise.resolve(nv.addListener(evento, fn)).catch((e) => console.warn('Benjamin NATIVO: listener', evento, e)); }
      catch (e) { console.warn('Benjamin NATIVO: listener', evento, e); }
    };

    ouvir('resultado', (d) => {
      if (this.aFalar || Date.now() < this._ignorarAte) return; // anti-eco
      const texto = String((d && d.texto) || '').trim();
      if (!texto) return;
      this._t0 = Date.now();
      console.log('Condutor disse (nativo):', texto);
      if (this._capturar) { this._capturar(texto); return; }   // ditado: não é um comando
      this._mostrarTranscricao(texto);
      this.aoOuvir(texto.toLowerCase());
    });

    // a escuta nativa caiu sozinha (erro do microfone): reabre
    ouvir('ttsInicio', () => {
      if (this._t0) {
        console.log(`Benjamin LATÊNCIA: a voz arrancou ${Date.now() - this._t0} ms depois de ouvir a frase`);
        this._t0 = 0;
      }
    });

    // O plugin só emite "estado" com ouvindo:false quando DESISTE (permissão, idioma, erro).
    // (Antes, qualquer "estado" — incluindo "pronto a ouvir" — cancelava a sessão ao fim de 1 s.)
    ouvir('estado', (d) => {
      if (!d || d.ouvindo !== false) return;
      console.warn('Benjamin NATIVO: escuta parou:', d.motivo);
      this._aOuvir = false;
      if (d.motivo === 'permissao' || d.motivo === 'indisponivel') {
        this.escutaDesejada = false;
        this._emitirEstado('calado');
        this._atualizarUI('alert', d.motivo === 'permissao'
          ? 'Permissão de microfone necessária nas definições.'
          : 'Reconhecimento de voz em português indisponível neste telemóvel.');
        return;
      }
      if (this.escutaDesejada && !this.aFalar) this._agendarReativacao(2000);
    });

    // o modelo Vosk acabou de ser preparado (ou falhou)
    ouvir('modelo', (d) => {
      if (d && d.pronto) {
        console.log('Benjamin NATIVO: modelo de voz pronto.');
      } else {
        console.warn('Benjamin NATIVO: modelo Vosk indisponível (' + (d && d.erro) + '). A usar o reconhecimento do WebView.');
        this._vpOuvir = false;
      }
      if (this.escutaDesejada && !this.aFalar) this._agendarReativacao(0);
    });

    Promise.resolve(nv.preparar())
      .then((r) => console.log('Benjamin NATIVO: preparar() =', JSON.stringify(r)))
      .catch((e) => console.warn('Benjamin NATIVO: preparar() falhou:', e && (e.message || e)));
  },

  _servicoNativo(ativar) {
    const nv = this._nativo();
    if (!nv) return;
    Promise.resolve(ativar ? nv.ativarServico() : nv.terminar())
      .catch((e) => console.warn('Benjamin NATIVO: serviço:', e && (e.message || e)));
  },

  /** Fala com o TTS nativo. true = tratado; false = TTS nativo indisponível (usar o resto). */
  async _dizerVp(vp, texto) {
    let voz = '';
    try { voz = localStorage.getItem('benjamin_voz_vp') || ''; } catch (e) { /* ok */ }
    try {
      await Promise.race([
        vp.falar({ texto, pitch: 0.85, rate: 1.1, voz }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000 + texto.length * 110)),
      ]);
      return true;
    } catch (e) {
      const msg = String((e && (e.message || e)) || e);
      console.warn('Benjamin TTS nativo (BenjaminVoice): ERRO', msg, e && e.code ? '[' + e.code + ']' : '');
      if ((e && e.code === 'TTS_INDISPONIVEL') || /not implemented/i.test(msg)) {
        this._vpFala = false;
        return false;
      }
      try { await vp.cortarFala(); } catch (_) { /* ok */ }
      return true;
    }
  },

  /** Comando de voz "muda de voz": roda pelas vozes pt-PT instaladas (o Android não diz o género). */
  async _mudarVoz() {
    const vp = this._ttsVp();
    if (!vp) return 'Neste momento só consigo usar a voz que o sistema me dá.';
    let lista = [];
    try { lista = (await vp.listarVozes()).vozes || []; } catch (e) { /* ok */ }
    if (!lista.length) return 'Não encontrei outras vozes portuguesas instaladas neste telemóvel.';
    let atual = '';
    try { atual = localStorage.getItem('benjamin_voz_vp') || ''; } catch (e) { /* ok */ }
    const i = (lista.indexOf(atual) + 1) % lista.length;
    try { localStorage.setItem('benjamin_voz_vp', lista[i]); } catch (e) { /* ok */ }
    console.log('Benjamin TTS: voz nativa =', lista[i], '| instaladas:', lista.join(', '));
    return `Esta é a voz ${i + 1} de ${lista.length}. Gostas desta, ou queres que mude outra vez?`;
  },

  _emitirEstado(estado) {
    try { if (typeof this.aoMudarEstadoEscuta === 'function') this.aoMudarEstadoEscuta(estado); } catch (e) { /* UI opcional */ }
  },

  _atualizarUI(estado, mensagem) {
    const el = document.getElementById('status');
    if (el && mensagem) el.innerText = mensagem;
  },

  _mostrarTranscricao(texto) {
    const el = document.getElementById('transcricao');
    if (el) el.innerText = `"${texto}"`;
  },

  // ================= Eventos da viagem (chamados pelo index.html) =================
  aoIniciar() {
    this.init();
    this.modoEmEspera = false;
    this._servicoNativo(true); // serviço em primeiro plano (microfone) — pede a permissão na 1.ª vez
    const [m1, m2] = this._boasVindas();
    this.falar(m1);          // 1.ª mensagem de boas-vindas
    this.falar(m2);          // 2.ª mensagem de boas-vindas
    this.ouvirContinuo();    // fica sempre à escuta (o microfone só abre quando acabar de falar)
  },

  aoRetomar() {
    this.falar(this._variar('retomar', [
      'Vamos a isso. Boa estrada!',
      'Pausa terminada. Segue com calma, que eu fico atento.',
    ]));
    this.ouvirContinuo();
  },

  aoPausar() {
    this.falar('Condução em pausa. Descansa um pouco. Se beberes um litro de café, talvez ajude.');
    // o microfone mantém-se ativo
  },

  aoParar() {
    this.escutaDesejada = false;
    this._pararVigia();
    this.modoEmEspera = false;
    clearTimeout(this._timerReativar);
    this._pararMicrofone();
    this._emitirEstado('inativo');
    this.falar('Contagem encerrada. Bom descanso!').then(() => this._servicoNativo(false));
    this._atualizarUI('idle', 'Benjamin parado.');
  },

  aoGuiaRegistada(guia) {
    if (guia && guia.morada) this.falar(`Guia registada. Destino: ${guia.morada}.`);
    else this.falar('Guia registada. Ainda não tenho a morada. Toca em Ditar no cartão da guia.');
  },

  _saudacao() {
    const h = new Date().getHours();
    return h < 6 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 20 ? 'Boa tarde' : 'Boa noite';
  },

  _boasVindas() {
    const nome = this._nomeCondutor();
    const guias = (typeof window.getGuias === 'function' ? window.getGuias() : []) || [];
    const m1 = `${this._saudacao()}${nome ? ', ' + nome : ''}! Aqui é o Benjamin, o teu co-piloto. Viagem iniciada, boa estrada!`;

    let parteGuias;
    if (guias.length) {
      const comMorada = guias.find((g) => g.morada);
      parteGuias = `Tens ${guias.length} ${guias.length === 1 ? 'guia de remessa registada' : 'guias de remessa registadas'}` +
        `${comMorada ? ', e o primeiro destino é ' + comMorada.morada : ''}. ` +
        'Confere se está tudo na carga, para não vires a ter desgostos.';
    } else {
      parteGuias = 'Ainda não tenho nenhuma guia de remessa registada. Confere a carga antes de arrancares, para não vires a ter desgostos.';
    }
    const m2 = `Fico sempre à escuta: é só falares comigo, sem tocar em nada. ${parteGuias}`;
    return [m1, m2];
  },

  // ================= Fala =================
  _obterVozes() {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      const ja = synth.getVoices();
      if (ja.length) return resolve(ja);
      const t = setTimeout(() => resolve(synth.getVoices()), 1500);
      synth.addEventListener('voiceschanged', () => {
        clearTimeout(t);
        resolve(synth.getVoices());
      }, { once: true });
    });
  },

  async _escolherVoz() {
    if (this._voz) return this._voz;
    const vozes = await this._obterVozes();
    const lang = (v) => (v.lang || '').replace('_', '-').toLowerCase();
    const ptPT = vozes.filter((v) => lang(v) === 'pt-pt');
    const ptOutras = vozes.filter((v) => lang(v).startsWith('pt') && lang(v) !== 'pt-pt');
    const naoFem = (l) => l.filter((v) => !RE_FEMININA.test(v.name || ''));
    const masc = (l) => naoFem(l).find((v) => RE_MASCULINA.test(v.name || ''));

    // 1) pt-PT masculina  2) pt-PT não feminina  3) pt-BR masculina  4) pt-BR não feminina
    let voz = masc(ptPT);
    let confirmada = Boolean(voz);
    if (!voz) voz = naoFem(ptPT)[0];
    if (!voz) { voz = masc(ptOutras); confirmada = Boolean(voz); }
    if (!voz) voz = naoFem(ptOutras)[0];

    if (vozes.length) { // só guarda em cache quando a lista de vozes já carregou
      this._voz = voz || null;
      this._vozConfirmada = confirmada;
      console.log('Benjamin: voz =', voz ? `${voz.name} (${voz.lang})` : '(padrão do sistema)',
        confirmada ? '[masculina]' : '[género não confirmado: tom grave]');
    }
    return voz || null;
  },

  _dividirTexto(t, max = 180) {
    const frases = t.split(/(?<=[.!?…])\s+/).filter(Boolean);
    const out = [];
    let atual = '';
    for (const f of frases) {
      if (atual && (atual + ' ' + f).length > max) { out.push(atual); atual = f; }
      else atual = (atual ? atual + ' ' : '') + f;
    }
    if (atual) out.push(atual);
    return out.length ? out : [t];
  },

  /** Fala o texto. Devolve Promise resolvida quando termina. { interromper:true } corta a fala atual. */
  falar(texto, { interromper = false } = {}) {
    if (!texto) return Promise.resolve();
    if (!('speechSynthesis' in window) && !this._ttsNativo() && !this._ttsVp()) {
      if (!this._avisouSemTts) {
        this._avisouSemTts = true;
        console.warn('Benjamin TTS: sem síntese de voz (nem speechSynthesis nem plugin nativo). ' +
          'Instala @capacitor-community/text-to-speech e corre: npx cap sync android');
      }
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      if (interromper) {
        this._fila.splice(0).forEach((i) => i.resolve && i.resolve());
        this._cortarFala();
      }
      const pedacos = this._dividirTexto(this.ajustarFonetica(texto), this._ttsVp() ? 500 : 180);
      pedacos.forEach((p, i) => {
        this._fila.push({ texto: p, resolve: i === pedacos.length - 1 ? resolve : null });
      });

      // Barreira: microfone desligado ANTES de qualquer som
      this.aFalar = true;
      clearTimeout(this._timerReativar);
      this._pararMicrofone();
      this._processarFila();
    });
  },

  async _processarFila() {
    if (this._aProcessarFila) return;
    this._aProcessarFila = true;
    this._atualizarUI('speaking', 'Benjamin a falar...');

    // Espera que o microfone liberte o áudio antes de falar (evita "audio-busy" / voz muda)
    for (let i = 0; i < 12 && this._aOuvir; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, this._ttsVp() ? 30 : 150));

    while (this._fila.length) {
      const item = this._fila.shift();
      await this._dizer(item.texto);
      if (item.resolve) item.resolve();
    }

    // Fila vazia: só agora se levanta a barreira (nunca entre duas frases seguidas)
    this._aProcessarFila = false;
    this.aFalar = false;
    this._falhasRapidas = 0;
    // com a voz nativa o microfone esteve fechado durante a fala: o eco residual é curto
    const espera = this._ttsVp() ? ESPERA_NATIVA_MS : ESPERA_REATIVAR_MS;
    this._ignorarAte = Date.now() + espera; // ignora o eco residual
    if (this.escutaDesejada) this._agendarReativacao(espera);
    else this._atualizarUI('idle', 'Benjamin pronto.');
  },

  async _dizer(texto, tentativa = 1) {
    // 1.ª escolha no APK: voz nativa do plugin BenjaminVoice (canal de áudio próprio + foco de áudio)
    const vp = this._ttsVp();
    if (vp && (await this._dizerVp(vp, texto))) return;

    // Sem speechSynthesis (ou já provado mudo neste WebView): voz nativa do Android
    if (!('speechSynthesis' in window) || this._webTtsMudo) return this._dizerNativo(texto);

    const voz = await this._escolherVoz();
    const erro = await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(texto);
      u.lang = voz ? voz.lang : 'pt-PT';
      u.rate = 1.0;
      u.volume = 1;
      u.pitch = this._vozConfirmada ? 0.95 : 0.8;
      if (voz) u.voice = voz;

      let terminado = false;
      const fim = (e) => {
        if (terminado) return;
        terminado = true;
        clearTimeout(watchdog);
        clearTimeout(vigiaStart);
        resolve(e || null);
      };
      const watchdog = setTimeout(() => {
        console.warn('Benjamin TTS: onend nunca chegou (watchdog) →', texto.slice(0, 40));
        fim();
      }, 4000 + texto.length * 90);

      // Se a voz nunca arranca (onstart ausente), não esperar em silêncio: avisar e deixar passar ao plano B
      let iniciou = false;
      const vigiaStart = setTimeout(() => {
        if (iniciou || terminado) return;
        const s = window.speechSynthesis;
        console.warn(`Benjamin TTS: sem onstart em ${TTS_ONSTART_MAX_MS} ms (speaking=${s.speaking}, pending=${s.pending}): motor de voz do WebView mudo?`);
        fim('sem-onstart');
      }, TTS_ONSTART_MAX_MS);

      u.onstart = () => {
        iniciou = true;
        clearTimeout(vigiaStart);
        console.log('Benjamin TTS: a falar →', texto.slice(0, 50));
      };
      u.onend = () => fim();
      u.onerror = (ev) => {
        console.warn('Benjamin TTS: ERRO =', ev.error);
        fim(ev.error || 'erro');
      };
      try {
        const synth = window.speechSynthesis;
        synth.cancel();                // limpa áudio / estado preso no buffer (Android)
        if (synth.paused) synth.resume();
        setTimeout(() => {             // pequena folga: speak() colado ao cancel() pode ser ignorado
          try {
            synth.speak(u);
            if (synth.paused) synth.resume();
          } catch (e) {
            console.warn('Benjamin TTS: exceção ao falar:', e);
            fim('excecao');
          }
        }, 60);
      } catch (e) {
        console.warn('Benjamin TTS: exceção ao falar:', e);
        fim('excecao');
      }
    });

    if (erro === 'sem-onstart') {
      try { window.speechSynthesis.cancel(); } catch (e) { /* ok */ }
      if (this._ttsNativo()) {
        this._webTtsMudo = true;
        console.warn('Benjamin TTS: voz do WebView sem resposta; a passar para a voz nativa.');
        return this._dizerNativo(texto);
      }
    }

    // Falhou por motivo que não foi um corte intencional: tenta mais uma vez
    if (erro && erro !== 'interrupted' && erro !== 'canceled' && tentativa < 2) {
      await new Promise((r) => setTimeout(r, 500));
      return this._dizer(texto, tentativa + 1);
    }
  },

  // ================= Voz nativa (plano B no Android) =================
  /** Regista na consola o que o WebView oferece, para sabermos porque é que a voz falha. */
  _diagnosticoTts() {
    let plugins = '';
    try {
      const C = window.Capacitor;
      if (C && C.Plugins) plugins = ', plugins=[' + Object.keys(C.Plugins).join(',') + ']';
    } catch (e) { /* proxy sem chaves */ }
    console.log('Benjamin NATIVO: plugin BenjaminVoice=' + (this._nativo() ? 'SIM (Vosk + TTS nativo)' : 'não (a usar o browser)'));
    console.log('Benjamin TTS: speechSynthesis=' + ('speechSynthesis' in window ? 'sim' : 'NÃO') +
      ', Capacitor=' + (window.Capacitor ? 'sim' : 'não') + plugins +
      ', TTS nativo=' + (this._ttsNativo() ? 'sim' : 'não'));
  },

  /** Plugin @capacitor-community/text-to-speech, se estiver instalado na app Android. */
  _ttsNativo() {
    if (this._tnMau) return null;
    if (this._tn) return this._tn;
    let p = null;
    try {
      const C = window.Capacitor;
      const nativo = C && (typeof C.isNativePlatform === 'function' ? C.isNativePlatform() : true);
      if (nativo) {
        const verificavel = typeof C.isPluginAvailable === 'function';
        if (!verificavel || C.isPluginAvailable('TextToSpeech')) {
          p = (C.Plugins && C.Plugins.TextToSpeech)
            || (typeof C.registerPlugin === 'function' ? C.registerPlugin('TextToSpeech') : null);
        }
      }
    } catch (e) { p = null; }
    this._tn = p || null;
    return this._tn;
  },

  /** Corta a fala em curso, seja a do WebView seja a nativa. */
  _cortarFala() {
    try {
      const vp = this._nativo();
      if (vp) Promise.resolve(vp.cortarFala()).catch(() => {});
    } catch (e) { /* ok */ }
    try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) { /* ok */ }
    try {
      const n = this._ttsNativo();
      if (n) Promise.resolve(n.stop()).catch(() => {});
    } catch (e) { /* ok */ }
  },

  /** Índice (na lista do plugin) de uma voz pt-PT não feminina. Os nomes das vozes do Android raramente
   *  indicam o género: a lista fica na consola e podes fixar uma com localStorage 'benjamin_voz_nativa'. */
  async _escolherVozNativa(tts) {
    if (this._vozNativaIdx !== undefined) return this._vozNativaIdx;
    let idx = null;
    try {
      const { voices } = await tts.getSupportedVoices();
      const pt = (voices || []).map((v, i) => ({ v, i })).filter(({ v }) => /^pt[-_]pt/i.test(v.lang || ''));
      console.log('Benjamin TTS nativo: vozes pt-PT =', pt.map(({ v, i }) => `${i}=${v.name}`).join(' | ') || '(nenhuma)');
      let pref = '';
      try { pref = (localStorage.getItem('benjamin_voz_nativa') || '').toLowerCase(); } catch (e) { /* ok */ }
      const nome = (x) => (x.v.name || '');
      const esc = (pref && pt.find((x) => nome(x).toLowerCase() === pref))
        || pt.find((x) => RE_MASCULINA.test(nome(x)) && !RE_FEMININA.test(nome(x)))
        || pt.find((x) => !RE_FEMININA.test(nome(x)));
      if (esc) {
        idx = esc.i;
        console.log('Benjamin TTS nativo: voz escolhida =', nome(esc));
      }
    } catch (e) {
      console.warn('Benjamin TTS nativo: getSupportedVoices falhou:', e && (e.message || e));
    }
    this._vozNativaIdx = idx;
    return idx;
  },

  async _dizerNativo(texto) {
    const tts = this._ttsNativo();
    if (!tts) {
      if (!this._avisouSemTts) {
        this._avisouSemTts = true;
        console.warn('Benjamin TTS: sem voz disponível. Instala @capacitor-community/text-to-speech e corre: npx cap sync android');
      }
      return;
    }
    const idx = await this._escolherVozNativa(tts);
    const opcoes = { text: texto, lang: 'pt-PT', rate: 1.0, pitch: 0.85, volume: 1.0, queueStrategy: 1 };
    if (idx !== null) opcoes.voice = idx;

    const t0 = Date.now();
    const estimado = Math.max(800, texto.length * 65); // ~15 caracteres por segundo
    console.log('Benjamin TTS nativo: a falar →', texto.slice(0, 50));
    try {
      await Promise.race([
        tts.speak(opcoes),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), estimado * 3 + 8000)),
      ]);
      const gasto = Date.now() - t0;
      console.log(`Benjamin TTS nativo: speak() devolveu em ${gasto} ms (estimado ${estimado} ms)`);
      // Se devolveu logo no início (sem esperar pelo fim da fala), espera o resto: não reabrir o microfone a meio
      if (gasto < estimado * 0.5) await new Promise((r) => setTimeout(r, estimado - gasto));
    } catch (e) {
      const msg = String((e && (e.message || e)) || e);
      console.warn('Benjamin TTS nativo: ERRO', msg);
      try { await tts.stop(); } catch (_) { /* ok */ }
      if (/not implemented|unavailable|not available/i.test(msg)) {
        this._tnMau = true;       // o plugin não está realmente instalado
        this._tn = null;
        this._webTtsMudo = false; // volta a tentar a voz do WebView
      }
    }
  },

  // ================= Escuta =================
  async _garantirPermissoes() {
    if (this._permissaoConcedida) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      this._permissaoConcedida = true;
      return true;
    } catch (err) {
      console.error('Benjamin: permissão de microfone negada:', err);
      this._atualizarUI('alert', 'Permissão de microfone necessária nas definições.');
      return false;
    }
  },

  _criarReconhecimento() {
    if (this._rec) return this._rec;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.warn('Benjamin: este browser não suporta reconhecimento de voz.');
      this._atualizarUI('alert', 'Reconhecimento de voz não suportado neste dispositivo.');
      return null;
    }

    const rec = new SR();
    rec.lang = 'pt-PT';
    rec.continuous = true;      // uma sessão longa em vez de abrir/fechar a cada frase
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this._aOuvir = true;
      this._inicioSessao = Date.now();
      this._atualizarUI('listening', 'A escutar na cabine...');
    };

    rec.onresult = (event) => {
      if (this.aFalar || Date.now() < this._ignorarAte) return; // anti-eco
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (!event.results[i].isFinal) continue;
        const texto = event.results[i][0].transcript.trim();
        if (!texto) continue;
        console.log('Condutor disse:', texto);
        if (this._capturar) { this._capturar(texto); continue; }  // ditado: não é um comando
        this._mostrarTranscricao(texto);
        this.aoOuvir(texto.toLowerCase());
      }
    };

    rec.onerror = (e) => {
      switch (e.error) {
        case 'aborted':   // abort() nosso ou do sistema
        case 'no-speech': // silêncio: normal, nunca pára o fluxo
          // garante a reabertura mesmo que o onend tarde; o onend seguinte substitui este agendamento
          if (this.escutaDesejada && !this.aFalar) this._agendarReativacao(REINICIO_MS);
          break;
        case 'not-allowed':
        case 'service-not-allowed':
          console.error('Benjamin: microfone/serviço de voz não permitido.');
          this._permissaoConcedida = false;
          this.escutaDesejada = false;
          this._emitirEstado('calado');
          this._atualizarUI('alert', 'Permissão de microfone necessária nas definições.');
          break;
        default:
          console.warn('Benjamin: erro de reconhecimento:', e.error);
      }
    };

    rec.onend = () => {
      this._aOuvir = false;
      console.log(`Benjamin MIC: sessão terminou após ${Date.now() - this._inicioSessao} ms`,
        this._paragemIntencional ? '(abort nosso)' : '(terminada pelo browser)');
      if (this._paragemIntencional) {
        this._paragemIntencional = false; // abort() nosso: não conta como falha
        this._abortEm = 0;
      } else {
        const duracao = Date.now() - this._inicioSessao;
        this._falhasRapidas = duracao < FALHA_RAPIDA_MS ? this._falhasRapidas + 1 : 0;
      }
      if (this.escutaDesejada && !this.aFalar) {
        // Fim normal (silêncio / fim de frase): reabre em REINICIO_MS.
        // Só alarga o intervalo se a escuta falhar em ciclos muito curtos (evita loop apertado).
        const atraso = this._falhasRapidas
          ? Math.min(REINICIO_MS * 2 ** this._falhasRapidas, BACKOFF_MAX_MS)
          : REINICIO_MS;
        this._agendarReativacao(atraso);
      }
    };

    this._rec = rec;
    return rec;
  },

  // ---- Ditado: a PRÓXIMA frase ouvida vai para cb(texto) em vez de ser tratada como comando ----
  _capturar: null,
  _capturaTimer: null,

  /** cb(texto) com a frase seguinte, ou cb(null) se nada for dito em `ms`. Liga a escuta se estiver desligada. */
  capturarProximaFrase(cb, ms = 15000) {
    this.cancelarCaptura();
    const jaOuvia = this.escutaDesejada;
    const fim = (t) => {
      clearTimeout(this._capturaTimer);
      this._capturar = null;
      if (!jaOuvia) this.pararEscuta('inativo');   // não deixar o microfone aberto se estava desligado
      cb(t);
    };
    this._capturaTimer = setTimeout(() => fim(null), ms);
    this._capturar = fim;
    if (!jaOuvia) this.ouvirContinuo();
  },

  cancelarCaptura() {
    clearTimeout(this._capturaTimer);
    this._capturar = null;
  },

  /** Liga o modo mãos-livres. */
  ouvirContinuo() {
    this.init();
    this.escutaDesejada = true;
    this._iniciarVigia();
    this.modoEmEspera = false;
    this._emitirEstado('ouvir');
    if (!this.aFalar) this._agendarReativacao(0);
  },

  /** Desliga a escuta. estado: 'calado' (botão cala-te) ou 'inativo' (fim de viagem). */
  pararEscuta(estado = 'calado') {
    this.escutaDesejada = false;
    this._pararVigia();
    clearTimeout(this._timerReativar);
    this._pararMicrofone();
    this._emitirEstado(estado);
    if (!this.aFalar) this._atualizarUI('idle', 'Benjamin em repouso.');
  },

  /** Botão CALA-TE: corta a fala e desliga o microfone de imediato. */
  silenciar() {
    this._fila.splice(0).forEach((i) => i.resolve && i.resolve());
    this._cortarFala();
    this.pararEscuta('calado');
  },

  _pararMicrofone() {
    const nv = this._sttNativo();
    if (nv) {
      this._aOuvir = false;
      try { Promise.resolve(nv.pararEscuta()).catch(() => {}); } catch (e) { /* ok */ }
      return;
    }
    if (this._rec && this._aOuvir) {
      this._paragemIntencional = true;
      this._abortEm = Date.now();
      try { this._rec.abort(); } catch (e) { this._paragemIntencional = false; this._abortEm = 0; }
    }
  },

  _agendarReativacao(atraso) {
    clearTimeout(this._timerReativar);
    this._reativacaoAte = Date.now() + atraso;
    this._timerReativar = setTimeout(() => this._iniciarMicrofone(), atraso);
  },

  /** Larga o reconhecimento atual (ex.: abort() sem onend) para que o próximo ciclo crie um novo. */
  _largarReconhecimento() {
    const r = this._rec;
    this._rec = null;
    this._aOuvir = false;
    this._paragemIntencional = false;
    this._abortEm = 0;
    if (r) {
      r.onstart = r.onresult = r.onerror = r.onend = null;
      try { r.abort(); } catch (e) { /* já parado */ }
    }
  },

  /** Vigia: se a escuta devia estar ativa e ficou parada sem nada agendado, reabre-a. */
  _iniciarVigia() {
    if (this._timerVigia) return;
    this._timerVigia = setInterval(() => {
      if (!this.escutaDesejada || this.aFalar) return;
      if (this._aOuvir && this._paragemIntencional && Date.now() - this._abortEm > ABORT_SEM_FIM_MS) {
        console.warn('Benjamin MIC: abort sem onend, a recriar o reconhecimento');
        this._largarReconhecimento();
      }
      if (!this._aOuvir && !this._aIniciar && Date.now() > this._reativacaoAte + 200) {
        console.log('Benjamin MIC: vigia a reabrir a escuta');
        this._agendarReativacao(REINICIO_MS);
      }
    }, VIGIA_MS);
  },

  _pararVigia() {
    clearInterval(this._timerVigia);
    this._timerVigia = null;
  },

  async _iniciarMicrofone() {
    if (!this.escutaDesejada || this.aFalar || this._aIniciar) return;
    this._aIniciar = true;
    try {
      // Escuta nativa (Vosk): contínua, offline, sem bip. A permissão é pedida pelo próprio plugin.
      const nv = this._sttNativo();
      if (nv) {
        try {
          const r = await nv.iniciarEscuta();
          if (!this.escutaDesejada || this.aFalar) { try { await nv.pararEscuta(); } catch (_) { /* ok */ } return; }
          if (r && r.ouvindo) {
            this._aOuvir = true;
            this._falhasRapidas = 0;
            this._atualizarUI('listening', 'A escutar na cabine...');
          } else if (r && r.motivo === 'modelo') {
            console.log('Benjamin NATIVO: a aguardar o modelo de voz (1.ª vez demora uns segundos)...');
          } else {
            console.warn('Benjamin NATIVO: escuta não abriu:', r && r.motivo);
            this._agendarReativacao(2000);
          }
        } catch (e) {
          console.warn('Benjamin NATIVO: iniciarEscuta falhou:', e && (e.message || e), e && e.code);
          if (e && e.code === 'PERMISSAO') {
            this.escutaDesejada = false;
            this._emitirEstado('calado');
            this._atualizarUI('alert', 'Permissão de microfone necessária nas definições.');
          } else {
            this._agendarReativacao(2000);
          }
        }
        return;
      }

      if (!(await this._garantirPermissoes())) {
        this.escutaDesejada = false;
        this._emitirEstado('calado');
        return;
      }
      if (!this.escutaDesejada || this.aFalar) return;

      const rec = this._criarReconhecimento();
      if (!rec) return;
      if (this._aOuvir) {
        // Já a ouvir: o onend trata do ciclo seguinte. Só espera de novo se estivermos a fechar por abort().
        if (this._paragemIntencional) this._agendarReativacao(BACKOFF_MIN_MS);
        return;
      }
      try {
        rec.start();
      } catch (e) {
        this._agendarReativacao(BACKOFF_MIN_MS * 2); // InvalidStateError: tenta mais tarde
      }
    } finally {
      this._aIniciar = false;
    }
  },

  // ================= Interpretação de comandos =================
  _norm(t) {
    return t.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  },

  // Palavras inteiras; "cansad*" = prefixo
  _tem(t, lista) {
    return lista.some((k) => {
      const prefixo = k.endsWith('*');
      const base = prefixo ? k.slice(0, -1) : k;
      return new RegExp('\\b' + base + (prefixo ? '' : '\\b')).test(t);
    });
  },

  _variar(chave, opcoes) {
    let i;
    do { i = Math.floor(Math.random() * opcoes.length); }
    while (opcoes.length > 1 && i === this._ultimaResposta[chave]);
    this._ultimaResposta[chave] = i;
    return opcoes[i];
  },

  _nomeCondutor() {
    try {
      const ativo = localStorage.getItem('benjamin_motorista_ativo') || '1';
      const n = localStorage.getItem(ativo === '2' ? 'benjamin_condutor2_nome' : 'benjamin_condutor1_nome');
      return n && n.trim() ? n.trim().split(/\s+/)[0] : '';
    } catch { return ''; }
  },

  _lerTempo(id) {
    const el = document.getElementById(id);
    if (el && el.textContent) {
      const m = el.textContent.match(/(\d+):(\d+):(\d+)/);
      if (m) return { h: +m[1], m: +m[2] };
    }
    const seg = id === 'driving-timer'
      ? (typeof drivingSeconds === 'number' ? drivingSeconds : null)
      : (typeof pauseSeconds === 'number' ? pauseSeconds : null);
    return seg === null ? null : { h: Math.floor(seg / 3600), m: Math.floor((seg % 3600) / 60) };
  },

  _duracaoFalada({ h, m }) {
    const p = [];
    if (h) p.push(`${h} ${h === 1 ? 'hora' : 'horas'}`);
    if (m) p.push(`${m} ${m === 1 ? 'minuto' : 'minutos'}`);
    return p.length ? p.join(' e ') : 'menos de um minuto';
  },

  async _fetchJSON(url, opcoes, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...opcoes, signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  },

  // ================= Conteúdo: piadas, quizzes e curiosidades (SEM repetições) =================
  _histMem: { piada: [], quiz: [], curiosidade: [] },
  _ultimosTemas: { piada: [], quiz: [], curiosidade: [] },
  _quiz: null,        // { pergunta, letra, opcoes, t } enquanto há um quiz à espera de resposta
  _quizAtivo: false,

  _lerHist() {
    try {
      const h = JSON.parse(localStorage.getItem(HIST_KEY) || 'null');
      if (h && typeof h === 'object') return { piada: h.piada || [], quiz: h.quiz || [], curiosidade: h.curiosidade || [] };
    } catch (e) { /* usa a memória */ }
    return this._histMem;
  },

  _hist(tipo) { return this._lerHist()[tipo] || []; },

  _guardarHist(tipo, texto) {
    const h = this._lerHist();
    h[tipo] = (h[tipo] || []).concat(String(texto).replace(/\s+/g, ' ').trim().slice(0, 160)).slice(-HIST_MAX);
    this._histMem = h;
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch (e) { /* só em memória */ }
  },

  _tokens(s) {
    return new Set(this._norm(s).split(' ').filter((w) => w.length > 3));
  },

  /** Já foi dito algo parecido? (mesmo início, ou muitas palavras em comum) */
  _repetido(tipo, texto) {
    const n = this._norm(texto).slice(0, 60);
    const tk = this._tokens(texto.slice(0, 160));
    return this._hist(tipo).some((h) => {
      if (this._norm(h).slice(0, 60) === n) return true;
      const th = this._tokens(h);
      if (!tk.size || !th.size) return false;
      let comum = 0;
      tk.forEach((w) => { if (th.has(w)) comum++; });
      return comum / (tk.size + th.size - comum) >= 0.6;
    });
  },

  _escolherTema(tipo, evitar = []) {
    const lista = TEMAS[tipo];
    const recentes = this._ultimosTemas[tipo].concat(evitar);
    const livres = lista.filter((x) => !recentes.includes(x));
    const t = (livres.length ? livres : lista)[Math.floor(Math.random() * (livres.length || lista.length))];
    this._ultimosTemas[tipo] = this._ultimosTemas[tipo].concat(t).slice(-5);
    return t;
  },

  _pedido(tipo, tema) {
    const antigos = this._hist(tipo).slice(-10).map((h) => '"' + h.slice(0, 70) + '"').join('; ');
    const regra = antigos
      ? ` REGRA ABSOLUTA: não repitas nem reciclas nenhum destes conteúdos já ditos ao condutor (muda de assunto e de estrutura): ${antigos}.`
      : '';
    const sorte = ' [variação ' + Math.random().toString(36).slice(2, 7) + ']';
    if (tipo === 'piada') {
      return `Conta UMA anedota curta (no máximo 3 frases), de humor seco, absurdo (non-sense) ou humor inglês, própria para ser dita em voz alta: sem palavrões, sem ofender ninguém. Tema desta vez: ${tema}. Responde só com a anedota, sem introdução nem comentários.${regra}${sorte}`;
    }
    if (tipo === 'quiz') {
      const letra = 'ABC'[Math.floor(Math.random() * 3)];
      return `Gera UMA pergunta de escolha múltipla com 3 opções (A, B e C), sobre o tema: ${tema}. Escreve apenas a pergunta e as opções, sem introdução, sem comentários e sem nunca usar a expressão "sabias que". A pergunta termina com "?". Desta vez a resposta certa é a opção ${letra}. Na última linha, depois das opções, escreve exatamente [[RESPOSTA: ${letra}]].${regra}${sorte}`;
    }
    return `Conta UMA curiosidade rápida e surpreendente (no máximo 2 frases) sobre o tema: ${tema}. Começa por "Sabias que". Responde só com a curiosidade.${regra}${sorte}`;
  },

  /** Pede um conteúdo novo ao Gemini; se vier repetido tenta uma vez com outro tema. null = falhou. */
  async _novoConteudo(tipo) {
    let tema = this._escolherTema(tipo);
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const bruto = await this.perguntarAoGemini(this._pedido(tipo, tema), { semOffline: true, ms: 15000 });
      if (!bruto) return null;
      let texto = bruto.trim();
      let letra = null;
      if (tipo === 'quiz') {
        const m = texto.match(/\[{0,2}\s*resposta(?:\s+certa)?\s*:?\s*\(?([abc])\)?\s*\]{0,2}\s*\.?\s*$/i);
        if (m) { letra = m[1].toUpperCase(); texto = texto.slice(0, m.index).trim(); }
      }
      if (!texto) return null;
      // no quiz compara-se só o enunciado (as opções "A) B) C)" não contam)
      const chave = tipo === 'quiz' ? texto.split(/\s\(?A[\)\.:]/)[0] : texto;
      if (!this._repetido(tipo, chave)) {
        this._guardarHist(tipo, chave);
        return { texto, letra };
      }
      console.warn(`Benjamin: ${tipo} repetido, a pedir outro (tema: ${tema})`);
      tema = this._escolherTema(tipo, [tema]);
    }
    return null;
  },

  // ---- Quiz: resposta do condutor ----
  _quizAberto() {
    if (this._quizAtivo && this._quiz && Date.now() - this._quiz.t < QUIZ_VALIDADE_MS) return true;
    this._quizAtivo = false;
    this._quiz = null;
    return false;
  },

  /** "a", "letra b", "é a segunda", "bê"... -> 'A' | 'B' | 'C' | null  (t já normalizado) */
  _letraResposta(t) {
    let m = t.match(/\b(?:letra|opcao|alinea|resposta)\s+([abc])\b/);
    if (m) return m[1].toUpperCase();
    if (/\bprimeira\b/.test(t)) return 'A';
    if (/\bsegunda\b/.test(t)) return 'B';
    if (/\bterceira\b/.test(t)) return 'C';
    const p = t.split(' ');
    if (p.length > 4) return null;
    const mapa = { a: 'A', ah: 'A', b: 'B', be: 'B', c: 'C', ce: 'C' };
    const letras = p.filter((w) => mapa[w]);
    return letras.length ? mapa[letras[letras.length - 1]] : null; // "é a b" -> B
  },

  _opcoesQuiz(pergunta) {
    const o = {};
    const re = /(?:^|\s)\(?([ABC])[\)\.:\-]\s*(.+?)(?=\s+\(?[ABC][\)\.:\-]\s|\s*$)/gis;
    let m;
    while ((m = re.exec(pergunta))) o[m[1].toUpperCase()] = m[2].trim().replace(/[\s.;,]+$/, '');
    return o;
  },

  async _validarQuiz(t, texto, tr) {
    const q = this._quiz;
    const palavras = t.split(' ').length;
    const letra = this._letraResposta(t);
    const certa = q.letra && q.opcoes[q.letra] ? `${q.letra}: ${q.opcoes[q.letra]}` : q.letra;

    if (/\b(desisto|nao sei|nao faco ideia|passo|salta|outra pergunta)\b/.test(t) && q.letra) {
      this._fechaQuiz();
      return `Sem problema, ${tr}. A resposta certa era a ${certa}.`;
    }
    if (/\b(para|acaba|sair|chega|cancela)\b.*\bquiz/.test(t) || /\bquiz\b.*\b(acabou|chega|cancela)/.test(t)) {
      this._fechaQuiz();
      return 'Está bem, fica o quiz por aqui. Quando quiseres outro, é só pedir.';
    }
    // Frase comprida que não tem nada a ver com a pergunta: larga o quiz e segue o fluxo normal
    if (!letra && palavras > 8) { this._fechaQuiz(); return undefined; }

    // Resposta certa conhecida + letra percebida: valida já, sem ir à rede (instantâneo)
    if (letra && q.letra) {
      this._fechaQuiz();
      if (letra === q.letra) {
        return this._variar('quizCerto', [
          `Certo, ${tr}! A ${q.letra} é a resposta. Afinal ainda há esperança para ti.`,
          'Acertaste! Até um relógio parado acerta duas vezes por dia, mas aqui foi mérito teu.',
          `Boa, ${tr}! É isso mesmo. Estou comovido.`,
          'Correto! Já podes pôr isso no currículo.',
        ]);
      }
      return this._variar('quizErrado', [
        `Falhaste! Era a ${certa}. Não faz mal, também já fui humano.`,
        `Ora bolas, ${tr}. A resposta certa era a ${certa}.`,
        `Não foi desta. Era a ${certa}. Atenção à estrada, que o quiz não paga multas.`,
      ]);
    }

    // Sem resposta conhecida (o Gemini não mandou a letra) ou resposta por extenso: o Gemini corrige
    const pergunta = q.pergunta;
    this._fechaQuiz();
    const r = await this._comPensar(() => this.perguntarAoGemini(
      `A pergunta de escolha múltipla era: "${pergunta}". O condutor respondeu: "${texto}". Diz em uma ou duas frases curtas, com humor seco, se acertou ou falhou, revelando a resposta certa. Sem markdown.`,
      { semOffline: true, ms: 15000 }));
    return r || `Respondeste "${texto}". A rede falhou na correção, mas seguimos viagem.`;
  },

  _fechaQuiz() { this._quizAtivo = false; this._quiz = null; },

  /** Corre fn com o guarda _aPensar e, se demorar, um "deixa ver..." para o condutor não ficar no silêncio. */
  async _comPensar(fn) {
    this._aPensar = true;
    const tG = Date.now();
    const aviso = setTimeout(() => {
      this.falar(this._variar('pensar', ['Deixa ver...', 'Já te digo.', 'Hum, deixa-me pensar.']));
    }, PENSAR_APOS_MS);
    try { return await fn(); }
    finally {
      clearTimeout(aviso);
      this._aPensar = false;
      console.log(`Benjamin LATÊNCIA: nuvem respondeu em ${Date.now() - tG} ms`);
    }
  },

  /**
   * Perguntas sobre as guias de remessa. t = frase normalizada (sem acentos).
   * Lê window.getGuias() (ordem de descarga; cada guia tem .morada = morada de descarga).
   * Devolve a resposta falada, ou undefined se a frase não for sobre destinos.
   */
  _respostaDestino(t) {
    const palavras = t.split(' ').length;
    if (palavras > 10) return undefined;
    const guias = (typeof window.getGuias === 'function' ? window.getGuias() : []) || [];

    const quantas = /\bquantas\b.*\b(guias|entregas|descargas|paragens)\b/.test(t) ||
      /\bquantas\b.*\bfaltam\b/.test(t);
    const destino = this._tem(t, ['destino', 'destinos', 'morada', 'proxima entrega', 'proxima descarga', 'proxima paragem',
      'onde descarrego', 'onde entrego', 'onde vou descarregar', 'onde vou entregar', 'para onde vou', 'para onde vamos',
      'onde e a entrega', 'onde e a descarga', 'local de descarga', 'local de entrega']);
    if (!quantas && !destino) return undefined;

    if (!guias.length) return 'Ainda não tenho nenhuma guia de remessa registada. Importa uma no separador das guias.';
    if (quantas) {
      const n = guias.length;
      return `Tens ${n} ${n === 1 ? 'guia registada' : 'guias registadas'}.`;
    }

    // qual delas? primeira por defeito; "segundo destino", "terceira entrega", "último destino"
    const ord = { primeir: 0, segund: 1, terceir: 2, quart: 3, quint: 4 };
    let i = 0;
    const m = t.match(/\b(primeir|segund|terceir|quart|quint)[oa]s?\b/);
    if (m) i = ord[m[1]];
    else if (/\b(ultim[oa]|final)\b/.test(t)) i = guias.length - 1;
    else if (/\b(seguinte|a seguir|depois)\b/.test(t)) i = 1;
    const g = guias[i];
    if (!g) return `Só tenho ${guias.length} ${guias.length === 1 ? 'guia' : 'guias'} registadas.`;

    const qual = i === 0 ? 'O próximo destino' : i === guias.length - 1 && i > 1 ? 'O último destino' : `O ${i + 1}.º destino`;
    if (!g.morada) {
      return `A guia ${g.nome || g.ref || ''} ainda não tem morada. Toca em Editar e depois em Ditar, no cartão da guia.`;
    }
    const aviso = g.moradaAuto ? ' Li-a da guia e ainda não a confirmaste.' : '';
    return `${qual} é: ${g.morada}.${aviso}`;
  },

  /** Navegação por voz. t = frase normalizada. undefined = não é sobre navegação. */
  _respostaNavegacao(t) {
    if (t.split(' ').length > 10) return undefined;
    const nav = typeof window.getNavegacao === 'function' ? window.getNavegacao() : null;

    // ligar / desligar a voz da navegação
    if (/\b(liga|ativa|acende|desliga|desativa|apaga)\b.*\b(navegacao|gps|indicacoes)\b/.test(t) ||
        /\b(navegacao|gps)\b.*\b(por voz|voz)\b/.test(t)) {
      if (typeof window.navegacaoVoz !== 'function') return undefined;
      const on = !/\b(desliga|desativa|apaga)\b/.test(t);
      window.navegacaoVoz(on);
      return on ? 'Está bem, o mapa passa a avisar-me quando recalcular a rota e quando chegares.' : 'Está bem, o mapa fica em silêncio. A rota continua no ecrã.';
    }

    const quando = /\bquanto\b.*\b(falta|tempo|demora)\b/.test(t) || /\ba que horas\b.*\b(chego|chegamos)\b/.test(t) ||
      /\bquantos\b.*\b(quilometros|km)\b/.test(t) ;
    const aoDestino = /\b(chegar|chego|chegamos|destino|quilometros|km|entrega|descarga)\b/.test(t);
    if (!quando || !aoDestino) return undefined;
    if (!nav || !nav.restM) return 'Ainda não tenho a rota calculada. Preciso de GPS e da morada da primeira guia.';
    const km = nav.restM >= 1000 ? `${(nav.restM / 1000).toFixed(1).replace('.', ',')} quilómetros` : `${Math.round(nav.restM / 10) * 10} metros`;
    const min = Math.max(1, Math.round(nav.restS / 60));
    const pl = (n, u) => `${n} ${n === 1 ? u : u + 's'}`;
    const dur = min < 60 ? pl(min, 'minuto') : `${pl(Math.floor(min / 60), 'hora')}${min % 60 ? ' e ' + pl(min % 60, 'minuto') : ''}`;
    const d = new Date(nav.eta);
    const hora = `${d.getHours()} e ${String(d.getMinutes()).padStart(2, '0')}`;
    return `Faltam ${km}, cerca de ${dur}. Chegas por volta das ${hora}.`;
  },

  /**
   * "Benjamin, apresento-te o meu amigo [Nome]" / "...a minha amiga [Nome]" -> saudação com o nome.
   * Recebe o texto ORIGINAL (para manter as maiúsculas do nome). Devolve a frase, ou undefined.
   */
  _respostaApresentacao(texto) {
    // "apresento-te [o|a] [meu|minha <parentesco>] Nome"  —  também "apresentar-te", e sem artigo: "apresento-te Ana"
    const m = String(texto || '').match(
      /\bapresent(?:o|ar)[-\s]*(?:te|lhe)\s+(?:(?:o|a)\s+)?(?:(?:meu|minha)\s+[A-Za-zÀ-ÿ]+\s+)?([A-Za-zÀ-ÿ][^\d,.;:!?]*)/i);
    if (!m) return undefined;
    if (/\b(?:apresent(?:o|ar)[-\s]*(?:te|lhe)\s+(?:os|as|uns|umas)\b)/i.test(texto)) return undefined;   // plural: não é uma pessoa só
    if (/^(?:um|uma|isto|isso|aqui|ali|este|esta|esse|essa|novo|nova|meu|minha|que|se|me|te)\b/i.test(m[1].trim())) return undefined;
    let palavras = m[1].trim().split(/\s+/).filter(Boolean);
    const FIM = /^(?:que|e|para|porque|pois|vai|vem|esta|está|viaja|viajar|hoje|connosco|comigo|agora)$/i;
    const i = palavras.findIndex((p, k) => k > 0 && FIM.test(p));       // corta o resto da frase
    if (i > 0) palavras = palavras.slice(0, i);
    palavras = palavras.slice(0, 3);                                    // nomes até 3 palavras ("Ana Sofia Costa")
    if (!palavras.length) return undefined;
    const ligacao = /^(?:da|de|do|das|dos|e)$/i;
    const nomeProprio = palavras
      .map((p) => (ligacao.test(p) ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1)))
      .join(' ');
    return `Olá ${nomeProprio}, muito gosto em conhecer. Sou o Benjamin, assistente de bordo e terei muito gosto em fazer-te companhia nas tuas viagens.`;
  },

  /** "preciso de abastecer", "onde há gasolina", "área de descanso"… → 'combustivel' | 'descanso' | null. t = frase normalizada. */
  _tipoPontoUtil(t) {
    if (t.split(' ').length > 12) return null;
    const pede = /\b(preciso|precisamos|onde|ha|tem|tens|perto|proximo|proxima|quero|procura|mostra|marca|indica|ajuda)\b/.test(t);
    if (/\b(abastecer|abastecimento|gasolina|gasoleo|diesel|combustivel|gasolineira|bomba de gasolina|bombas de gasolina|posto de combustivel|postos de combustivel)\b/.test(t) ||
        (/\bpostos?\b/.test(t) && pede)) return 'combustivel';
    if (/\b(area|areas) de (descanso|servico)\b/.test(t) ||
        (/\b(parar|descansar|estacionar|dormir)\b/.test(t) && /\b(onde|sitio|local|perto|parque)\b/.test(t)) ||
        /\bparque de camioes\b/.test(t)) return 'descanso';
    return null;
  },

  /** "Como está o trânsito?" / "há trânsito até ao destino?" */
  _pedidoTransito(t) {
    if (t.split(' ').length > 14) return false;
    return /\b(transito|engarrafamento|engarrafamentos|filas?|colunas?|acidentes?|obras)\b/.test(t) &&
      /\b(como|ha|tem|tens|existe|ate|no caminho|na estrada|a frente|destino|rota|percurso|caminho)\b/.test(t);
  },

  /** Trânsito pela rota ativa: manda à rede a posição, o destino e o previsto; o mapa não depende disto. */
  async _respostaTransito() {
    // 1.º dados reais (TomTom) se houver chave; sem chave segue para o Gemini
    if (typeof window.navegacaoTransito === 'function') {
      const real = await this._comPensar(() => window.navegacaoTransito());
      if (real) return real;
    }
    const nav = typeof window.getNavegacao === 'function' ? window.getNavegacao() : null;
    if (!nav || !nav.destino) return 'Ainda não tenho uma rota ativa. Preciso do GPS e da morada da primeira guia para ver o trânsito.';
    const km = nav.restM ? (nav.restM / 1000).toFixed(1).replace('.', ',') : null;
    const min = nav.restS ? Math.max(1, Math.round(nav.restS / 60)) : null;
    const previsto = km ? `${km} quilómetros, cerca de ${min} minutos sem contar com trânsito` : 'distância ainda por calcular';
    const prev = km ? `O percurso previsto é de ${km} quilómetros, cerca de ${min} minutos, sem contar com trânsito.` : '';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return `Estou sem rede para consultar o trânsito, mas o mapa continua a funcionar. ${prev}`.trim();
    }
    const agora = new Date().toLocaleString('pt-PT', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
    const de = nav.posicao ? `latitude ${nav.posicao[0].toFixed(4)}, longitude ${nav.posicao[1].toFixed(4)}` : 'posição desconhecida';
    const pergunta = `Sou condutor de um camião em Portugal e vou em viagem. Agora é ${agora}. Posição atual: ${de}. ` +
      `Destino: ${nav.destino.morada} (latitude ${nav.destino.coord[0].toFixed(4)}, longitude ${nav.destino.coord[1].toFixed(4)}). ` +
      `Faltam ${previsto}. Como está o trânsito neste percurso agora? Responde em duas frases curtas, em português de Portugal: ` +
      `diz se há atrasos, acidentes ou obras conhecidos e se devo contar com mais tempo do que o previsto. ` +
      `Se não tiveres dados em tempo real, di-lo com honestidade em vez de inventar. Sem markdown.`;
    const r = await this._comPensar(() => this.perguntarAoGemini(pergunta, { semOffline: true, ms: 15000 }));
    return r || `Não consegui consultar o trânsito agora, mas o mapa continua a funcionar. ${prev}`.trim();
  },

  async aoOuvir(texto) {
    try {
      const t = this._norm(texto);
      const quiz = this._quizAberto();
      if (t.length < (quiz ? 1 : 2)) return;   // com um quiz aberto, "A" / "B" / "C" são respostas válidas
      const tem = (lista) => this._tem(t, lista);
      const nome = this._nomeCondutor();
      const tr = nome || 'chefe';
      const agora = new Date();
      let resposta;
      let tipoPonto = null;

      if (this.modoEmEspera) {
        if (!tem(['acorda*', 'desperta*'])) return;
        this.modoEmEspera = false;
        this._emitirEstado('ouvir');
        resposta = `Diz lá, ${tr}. Não entres em stress, homem. Não sou surdo. Diz lá.`;

      } else if (tem(['cala', 'cala te', 'calate', 'silencio', 'para de falar', 'chega de conversa'])) {
        this._fila.splice(0).forEach((i) => i.resolve && i.resolve());
        this._cortarFala();
        this._fechaQuiz();
        await this.falar(this._variar('cala', [
          'Safa, que mau feitio. Pronto, fico calado. Diz "Benjamin, acorda" quando tiveres saudades minhas.',
          'Contrariado, mas calo-me. Quando precisares de mim, já sabes: "Benjamin, acorda".',
        ]));
        this.modoEmEspera = true;
        this._emitirEstado('calado');
        console.log('Benjamin: em modo de espera silenciosa.');
        return;

      } else if (this._aPensar) {
        return; // já estou a tratar de uma pergunta

      } else if (quiz && (resposta = await this._validarQuiz(t, texto, tr)) !== undefined) {
        // QUIZ À ESPERA DE RESPOSTA: tem prioridade sobre todos os outros filtros (só "cala-te" passa à frente)

      } else if ((resposta = this._respostaApresentacao(texto)) !== undefined) {
        // "Benjamin, apresento-te o meu amigo Rui" -> cumprimenta a pessoa pelo nome

      } else if ((tipoPonto = this._tipoPontoUtil(t)) && typeof window.navegacaoPontos === 'function') {
        // "preciso de abastecer" / "onde há gasolina" / "área de descanso": confirma já, procura (Overpass) e marca no mapa
        this.falar(tipoPonto === 'combustivel'
          ? this._variar('pontoComb', ['Já vejo os postos de combustível perto de ti.', 'Deixa-me ver onde podes abastecer.'])
          : this._variar('pontoDesc', ['Já vejo as áreas de descanso aqui perto.', 'Deixa-me ver onde podes parar.']));
        resposta = await this._comPensar(() => window.navegacaoPontos(tipoPonto));

      } else if (/\b(mostra|mostrar|liga|ligar|poe|ativa|ve|ver|tira|tirar|desliga|desligar|esconde|retira)\b.*\btransito\b.*\b(mapa|ecra)\b/.test(t) && typeof window.navegacaoTrafego === 'function') {
        // "mostra o trânsito no mapa" / "tira o trânsito do mapa"
        resposta = await window.navegacaoTrafego(!/\b(tira|tirar|desliga|desligar|esconde|retira)\b/.test(t));

      } else if (this._pedidoTransito(t)) {
        resposta = await this._respostaTransito();

      } else if ((resposta = this._respostaNavegacao(t)) !== undefined) {
        // "liga a voz da navegação", "quanto falta para chegar?", "a que horas chego?"

      } else if ((resposta = this._respostaDestino(t)) !== undefined) {
        // "Qual é o destino?" / "onde descarrego?" / "quantas guias tenho?": responde com os dados das guias, sem ir à rede

      } else if (tem(['muda de voz', 'muda a voz', 'troca de voz', 'outra voz'])) {
        resposta = await this._mudarVoz();

      } else if (tem(['que horas', 'horas sao', 'hora certa'])) {
        const h = agora.getHours(), min = agora.getMinutes();
        const parteH = h === 1 ? 'É uma hora' : h === 0 ? 'É meia-noite' : h === 12 ? 'É meio-dia' : `São ${h} horas`;
        resposta = min === 0 ? `${parteH} em ponto.` : `${parteH} e ${min} ${min === 1 ? 'minuto' : 'minutos'}.`;

      } else if (tem(['que dia', 'data de hoje', 'dia de hoje', 'dia da semana'])) {
        const data = agora.toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' });
        resposta = this._variar('data', [`Hoje é ${data}.`, `Estamos a ${data}, ${tr}.`]);

      } else if (tem(['pausa', 'descanso', 'tacografo', 'conducao', 'conduzi*', 'quanto tempo', 'quanto falta'])) {
        const cond = this._lerTempo('driving-timer');
        const pausa = this._lerTempo('pause-timer');
        if (pausa && cond) {
          resposta = (pausa.h === 0 && pausa.m === 0)
            ? `${tr}, está na hora da pausa regulamentar. Procura um sítio seguro para parar, e não me venhas com histórias a dizer que ainda não estás cansado.`
            : `Podes conduzir mais ${this._duracaoFalada(pausa)} até à pausa obrigatória. No total, restam-te ${this._duracaoFalada(cond)} de condução para hoje. Mais que isto, ias ter de tomar um viagra.`;
        } else {
          resposta = this._variar('tacografo', [
            'A tua próxima pausa regulamentar está sob controlo. Segue tranquilo.',
            'O tacógrafo está em dia, mas não facilites na pausa. As multas não são baratas, ou és rico e não me dizias?',
          ]);
        }

      } else if (tem(['cansad*', 'sono', 'sonolent*', 'adormecer', 'fadiga', 'olhos pesados'])) {
        resposta = this._variar('fadiga', [
          `${tr}, não arrisques. Ou encostas na próxima estação de serviço e descansas, ou vou ficar aos gritos em Russo pelo resto da viagem. Tu escolhes.`,
          `Sabes muito bem que o cansaço na estrada não perdoa, ${tr}. Procura já um sítio seguro para parar. Lava a cara com água fria e faz uma cambalhota. Ouvi dizer que ajuda.`,
        ]);

      // ---- 3 intenções separadas: CURIOSIDADE, PIADA, QUIZ (cada uma com o seu gatilho) ----
      } else if (tem(['curiosidade*', 'facto curioso', 'facto interessante', 'algo interessante']) ||
                 (tem(['sabias que', 'sabia que']) && t.split(' ').length <= 6)) {
        const c = await this._comPensar(() => this._novoConteudo('curiosidade'));
        resposta = c ? c.texto : 'Já te contei tudo o que sabia por hoje, ou então a rede não ajudou. Pede-me outra daqui a pouco.';

      } else if (tem(['piada*', 'anedota*', 'faz me rir', 'fazes me rir'])) {
        const c = await this._comPensar(() => this._novoConteudo('piada'));
        resposta = c ? c.texto : 'A piada ficou presa sem rede, e as que me ocorrem já te contei. Pede outra daqui a pouco.';

      } else if (tem(['quiz*', 'quizz*', 'kuiz', 'jogo de perguntas', 'jogo das perguntas', 'faz me perguntas', 'faz me uma pergunta'])) {
        const c = await this._comPensar(() => this._novoConteudo('quiz'));
        if (c) {
          this._quiz = { pergunta: c.texto, letra: c.letra, opcoes: this._opcoesQuiz(c.texto), t: Date.now() };
          this._quizAtivo = true;     // a próxima frase do condutor entra direta na validação
          resposta = c.texto.replace(/(^|\s)\(?([ABC])[\)\.:]\s*/g, '$1Opção $2: ');
        } else {
          resposta = 'Não consegui arranjar uma pergunta nova. Olhos na estrada, tenta daqui a pouco.';
        }

      } else if (tem(['obrigad*', 'valeu', 'agradeco', 'gracas'])) {
        resposta = this._variar('obrigado', [
          `De nada, ${tr}. É para isso que me pagam.`,
          'Dispõe, quando não me mandas calar, é um prazer ir contigo.',
          'Deixa lá estar isso. O próximo café, pagas tu.',
          'Pensei que nem sequer ias agradecer. Boa. Só te fica bem.',
        ]);

      } else if (tem(['teu nome', 'chamas', 'quem es'])) {
        resposta = 'O meu nome é Benjamin, o teu co-piloto de serviço, mas não me confundas com a tua amante, por favor.';

      } else if (tem(['amigo']) && t.split(' ').length <= 6) {
        resposta = this._variar('amigo', [
          `Claro que sim, ${tr}. Estamos juntos.`,
          'Sou o teu melhor amigo dentro desta cabine. Podes contar comigo.',
        ]);

      } else if (t.split(' ').length <= 4 &&
                 tem(['tas ai', 'estas ai', 'estais ai', 'benjamin', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'oi', 'ei'])) {
        resposta = this._variar('saudacao', [
          `Estou aqui, ${tr}. Diz lá.`,
          `${this._saudacao()}, ${tr}! Sempre atento.`,
          'Cá estou eu, a partilhar a estrada contigo. Tiveste medo que me fosse embora?',
        ]);

      } else {
        // o reconhecedor apanha ruído da cabine: uma palavra solta que não é comando não vai ao Gemini
        if (this._sttNativo() && t.split(' ').length < 2) return;
        resposta = await this._comPensar(() => this.perguntarAoGemini(texto));
      }

      console.log('Benjamin responde:', resposta);
      if (this._t0) console.log(`Benjamin LATÊNCIA: resposta pronta ${Date.now() - this._t0} ms depois de ouvir a frase`);
      this.falar(resposta);
    } catch (e) {
      console.error('Benjamin: erro ao tratar comando:', e);
    }
  },

  /** semOffline: devolve null (em vez de uma frase de "perdi o sinal") quando o Worker falha. */
  async perguntarAoGemini(textoUsuario, { semOffline = false, ms = 12000 } = {}) {
    try {
      const data = await this._fetchJSON(URL_WORKER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ textoUsuario }),
      }, ms);
      if (!data.erro && data.resposta) return String(data.resposta).replace(/[*_#`]/g, '');
    } catch (e) {
      console.warn('Benjamin: Worker indisponível:', e.message);
    }
    if (semOffline) return null;
    return this._variar('offline', [
      'Perdi o sinal por um momento. Antes isso do que perder dinheiro, mas continuo atento à estrada.',
      'A ligação está fraca. Porcaria de aparelhos chineses. Mas estou contigo.',
      'Não consegui ouvir bem. Vou ver se marco uma consulta para os ouvidos. Repete lá, se faz favor.',
    ]);
  },

  ajustarFonetica(texto) {
    if (!texto) return '';
    return texto
      .replace(/\bvocê\b/gi, 'tu')
      .replace(/\bônibus\b/gi, 'autocarro')
      .replace(/\bcaminhão\b/gi, 'camião')
      .replace(/\bxícara\b/gi, 'chávena')
      .replace(/\btrem\b/gi, 'comboio')
      .replace(/\blegal\b/gi, 'fixe')
      .replace(/\b(\d)(\d)(\d)(\d)\s?-\s?(\d)(\d)(\d)\b/g, '$1 $2 $3 $4, $5 $6 $7')   // código postal: dígito a dígito
      .replace(/\s[—–]\s/g, ', ')
      .replace(/\?/g, '?... ')
      .replace(/!/g, '!... ')
      .replace(/,/g, ', ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  },
};

Benjamin.init();
window.Benjamin = Benjamin;
