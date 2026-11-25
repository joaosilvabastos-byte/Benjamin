// Segurança do Benjamin (lado do ecrã): liga o JavaScript ao plugin nativo "BenjaminSeguranca".
// O trabalho a sério (ROTT, verificação de 45 min, alarme, SOS, câmara) corre no Android; aqui só:
//  - se sincroniza o estado da viagem e a posição;
//  - se mostram os ecrãs de SOS / "estás bem?" / alarme / aviso de sonolência;
//  - se tratam os botões das Opções.
// Fora do Android (browser) este módulo fica inerte e a app funciona como antes.

const KEY_CAMERA = 'benjamin_camera_sono';
const KEY_AVISO = 'benjamin_aviso_transicao';
const KEY_CHAVE = 'benjamin_sos_chave';

// ---- Textos novos (para rever/afinar) ----
const T = {
  divulgacao:
    'Câmara de sonolência\n\n' +
    'A câmara frontal vai ser usada, só com a app aberta e a viagem em marcha, para detetar sinais de sonolência (olhos fechados, cabeça a cair).\n\n' +
    'O processamento é feito no telemóvel: nenhuma imagem é gravada nem enviada. Podes desligar quando quiseres nestas Opções.\n\n' +
    'Ativar a câmara?',
  camOn: '📷 Câmara de sonolência: LIGADA',
  camOff: '📷 Câmara de sonolência: DESLIGADA',
  camSemPermissao: 'Sem permissão da câmara. Ativa-a nas definições do Android para usar esta função.',
  camEstado: {
    desligada: 'Desligada.',
    calibrando: 'A calibrar: olha em frente durante uns segundos.',
    ativa: 'Ativa enquanto o ecrã do Benjamin estiver à frente e a viagem em marcha.',
    pausa: 'Em pausa (ecrã fora de vista ou viagem parada). Retoma sozinha.',
    quente: 'Em pausa: o telemóvel está quente.',
  },
  avisoOn: '🔔 Aviso ao mudar de ecrã: LIGADO',
  avisoOff: '🔕 Aviso ao mudar de ecrã: DESLIGADO',
  bateria: '🔋 Bateria: deixar o Benjamin sem restrições',
  testeSemViagem: 'Carrega primeiro em INICIAR (viagem em marcha) e volta a tentar o teste.',
  chaveGuardada: 'Chave do SOS guardada no dispositivo!',
  sosTitulo: '🚨 SOS',
  sosContagem: (s) => `Alerta enviado ao encarregado em ${s} s`,
  sosCancelar: 'CANCELAR SOS',
  sosEnviar: 'A enviar o alerta…',
  sosEnviado: '✅ Alerta enviado',
  sosFalhou: '⚠️ Não foi possível enviar. Liga já para a central.',
  verifTitulo: 'Estás bem?',
  verifBotao: 'ESTOU BEM',
  alarmeTitulo: '⚠️ SEM RESPOSTA',
  alarmeBotao: 'PARAR ALARME',
  sono: ['😴 Sinais de cansaço', '😴 Alerta de sonolência', '🚨 Sonolência! Pára em segurança'],
};

const SERVICO_PERIODO_MS = 60000;
const KEY_NOITE = 'benjamin_noite_perguntada';

// Nascer/pôr do sol calculados no telemóvel (fórmula NOAA simplificada): sem rede, sem serviços pagos
function solEstaNoCeu(lat, lon, quando) {
  const rad = Math.PI / 180;
  const inicio = Date.UTC(quando.getUTCFullYear(), 0, 0);
  const dia = Math.floor((quando.getTime() - inicio) / 86400000);
  const g = (2 * Math.PI / 365) * (dia - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const c = (Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl))) - Math.tan(lat * rad) * Math.tan(decl);
  if (c > 1) return false;     // noite polar
  if (c < -1) return true;     // sol da meia-noite
  const ha = Math.acos(c) / rad;
  const nascer = 720 - 4 * (lon + ha) - eq;     // minutos UTC
  const por = 720 - 4 * (lon - ha) - eq;
  const agora = quando.getUTCHours() * 60 + quando.getUTCMinutes();
  const m = (x) => ((x % 1440) + 1440) % 1440;
  return m(agora - nascer) < m(por - nascer);
}

function plugin() {
  const C = window.Capacitor;
  if (!C) return null;
  try {
    if (C.getPlatform && C.getPlatform() !== 'android') return null;
    return (C.Plugins && C.Plugins.BenjaminSeguranca)
      || (typeof C.registerPlugin === 'function' ? C.registerPlugin('BenjaminSeguranca') : null);
  } catch (e) {
    return null;
  }
}

function lerLS(k, d = '') { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function gravarLS(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ok */ } }

const Seg = {
  _p: null,
  _ultPos: 0,
  _lat: NaN,
  _lon: NaN,
  _timerOverlay: null,

  disponivel() { return !!this._p; },

  iniciar() {
    this._p = plugin();
    if (!this._p) { this._pintarOpcoes({}); return this; }
    const ouvir = (ev, fn) => {
      try { Promise.resolve(this._p.addListener(ev, fn)).catch((e) => console.warn('Benjamin SEG: listener', ev, e)); }
      catch (e) { console.warn('Benjamin SEG: listener', ev, e); }
    };
    ouvir('sosEstado', (d) => this._aoSos(d || {}));
    ouvir('verificacao', (d) => this._aoVerificacao(d || {}));
    ouvir('sonolencia', (d) => this._aoSono(d || {}));
    ouvir('cameraEstado', (d) => this._pintarCameraEstado((d || {}).estado));
    ouvir('noiteResposta', (d) => this._aoRespostaNoite(d || {}));
    ouvir('rott', () => { /* o aviso é falado pelo nativo; nada a fazer no ecrã */ });

    this.configurar();
    this.sincronizar();
    setInterval(() => { this.sincronizar(); this._verificarNoite(); }, SERVICO_PERIODO_MS);   // corrige pequenas derivas do relógio do ecrã
    this._p.estado().then((e) => this._pintarOpcoes(e || {})).catch(() => this._pintarOpcoes({}));
    return this;
  },

  /** Envia ao nativo o que ele precisa para trabalhar sozinho (e-mail, telefone, condutor, chave). */
  configurar() {
    if (!this._p) return;
    let condutor = 'Condutor';
    try { if (typeof window.obterNomeCondutorAtivo === 'function') condutor = window.obterNomeCondutorAtivo(); } catch (e) { /* ok */ }
    this._p.configurar({
      email: lerLS('benjamin_patrao_email', ''),
      telefone: lerLS('benjamin_sos_telefone', ''),
      condutor,
      workerChave: lerLS(KEY_CHAVE, ''),
      avisoTransicao: lerLS(KEY_AVISO, '1') !== '0',
    }).catch((e) => console.warn('Benjamin SEG: configurar', e));
  },

  /** Estado da viagem + tempos que o ecrã já mostra. O nativo conta sozinho a partir daqui. */
  sincronizar() {
    if (!this._p || typeof window.__benjaminEstadoRott !== 'function') return;
    const e = window.__benjaminEstadoRott();
    this._p.rott({ estado: e.estado, continuaSeg: Math.round(e.continuaSeg), diarioSeg: Math.round(e.diarioSeg) })
      .catch((err) => console.warn('Benjamin SEG: rott', err));
  },

  /** Posição do GPS (chamada pelo mapa a cada fix). vel em m/s (pode ser null). */
  posicao(p) {
    if (!this._p || !p) return;
    if (typeof p.lat === 'number' && typeof p.lon === 'number') { this._lat = p.lat; this._lon = p.lon; }
    const agora = Date.now();
    if (agora - this._ultPos < 1000) return;
    this._ultPos = agora;
    // Velocidade: a do GPS; se o GPS não a dá (null), calcula-a pela distância entre posições; senão "desconhecida" (-1)
    let kmh = (typeof p.vel === 'number' && !isNaN(p.vel)) ? Math.max(0, p.vel * 3.6) : -1;
    const ant = this._anterior;
    if (kmh < 0 && ant && typeof p.lat === 'number') {
      const dt = (agora - ant.t) / 1000;
      if (dt >= 1 && dt <= 15) {
        const R = 6371000, rad = Math.PI / 180;
        const a = Math.sin((p.lat - ant.lat) * rad / 2) ** 2 + Math.cos(ant.lat * rad) * Math.cos(p.lat * rad) * Math.sin((p.lon - ant.lon) * rad / 2) ** 2;
        kmh = (2 * R * Math.asin(Math.sqrt(a)) / dt) * 3.6;
      }
    }
    this._anterior = { lat: p.lat, lon: p.lon, t: agora };
    this._p.posicao({ kmh, lat: p.lat, lon: p.lon, prec: p.prec || 0 }).catch(() => {});
  },

  sosIniciar() { if (this._p) this._p.sosIniciar().catch(() => {}); },
  sosCancelar() { if (this._p) this._p.sosCancelar().catch(() => {}); },
  confirmar() { if (this._p) this._p.confirmar().catch(() => {}); },

  // ---------------------------------------------------------------- opções
  // ---------------------------------------------------------------- anoitecer
  _eNoite() {
    const agora = new Date();
    if (!isNaN(this._lat) && !isNaN(this._lon)) return !solEstaNoCeu(this._lat, this._lon, agora);
    const h = agora.getHours();                 // sem GPS ainda: aproximação pela hora local
    return h >= 20 || h < 7;
  },

  /** Uma vez por noite, com a viagem em marcha e a câmara desligada, o Benjamin pergunta se liga a câmara. */
  _verificarNoite() {
    if (!this._p || typeof window.__benjaminEstadoRott !== 'function') return;
    if (window.__benjaminEstadoRott().estado !== 'em_marcha') return;
    if (lerLS(KEY_CAMERA, '0') === '1') return;
    if (!this._eNoite()) return;
    const noiteId = new Date(Date.now() - 12 * 3600 * 1000).toDateString();   // a madrugada conta como a mesma noite
    if (lerLS(KEY_NOITE, '') === noiteId) return;
    gravarLS(KEY_NOITE, noiteId);
    this._p.perguntarNoite().catch(() => {});
  },

  _aoRespostaNoite(d) {
    if (!d.sim) return;
    if (lerLS(KEY_CAMERA, '0') === '1') return;   // já está ligada: não desliga
    this.alternarCamera();                         // exatamente a mesma função do botão das Opções
  },

  async alternarCamera() {
    if (!this._p) return;
    const ligada = lerLS(KEY_CAMERA, '0') === '1';
    if (!ligada) {
      if (!confirm(T.divulgacao)) return;                      // divulgação em destaque antes da permissão
      try {
        const r = await this._p.cameraLigar({ ativa: true });
        if (r && r.ativa) gravarLS(KEY_CAMERA, '1');
        else { gravarLS(KEY_CAMERA, '0'); alert(T.camSemPermissao); }
      } catch (e) { gravarLS(KEY_CAMERA, '0'); alert(T.camSemPermissao); }
    } else {
      try { await this._p.cameraLigar({ ativa: false }); } catch (e) { /* ok */ }
      gravarLS(KEY_CAMERA, '0');
    }
    this._p.estado().then((e) => this._pintarOpcoes(e || {})).catch(() => this._pintarOpcoes({}));
  },

  alternarAviso() {
    const ligado = lerLS(KEY_AVISO, '1') !== '0';
    gravarLS(KEY_AVISO, ligado ? '0' : '1');
    this.configurar();
    this._pintarOpcoes({ cameraAtiva: lerLS(KEY_CAMERA, '0') === '1' });
  },

  guardarChave() {
    const i = document.getElementById('sos-chave-input');
    gravarLS(KEY_CHAVE, i ? i.value.trim() : '');
    this.configurar();
    alert(T.chaveGuardada);
  },

  /** Pede a permissão de chamada (para o SOS ligar sozinho). */
  pedirChamada() { if (this._p) this._p.pedirChamada().catch(() => {}); },

  /** Teste do alarme "estás bem?" (só com a viagem em marcha). */
  async testarVerificacao() {
    if (!this._p) return;
    let ok = false;
    try { const r = await this._p.testarVerificacao(); ok = !!(r && r.ok); } catch (e) { /* ok */ }
    if (!ok) alert(T.testeSemViagem);
  },

  abrirBateria() { if (this._p) this._p.abrirBateria().catch(() => {}); },

  _pintarOpcoes(e) {
    const on = 'flex-1 py-2 rounded-xl text-[11px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500';
    const off = 'flex-1 py-2 rounded-xl text-[11px] font-bold bg-[#1E293B] text-gray-400 border border-gray-700';
    const cam = document.getElementById('btn-camera-sono');
    const av = document.getElementById('btn-aviso-transicao');
    const info = document.getElementById('estado-camera-sono');
    const chave = document.getElementById('sos-chave-input');
    const camOn = e.cameraAtiva !== undefined ? !!e.cameraAtiva : lerLS(KEY_CAMERA, '0') === '1';
    if (e.cameraAtiva !== undefined) gravarLS(KEY_CAMERA, camOn ? '1' : '0');
    if (cam) { cam.className = camOn ? on : off; cam.innerText = camOn ? T.camOn : T.camOff; }
    const avOn = lerLS(KEY_AVISO, '1') !== '0';
    if (av) { av.className = avOn ? on : off; av.innerText = avOn ? T.avisoOn : T.avisoOff; }
    if (chave && !chave.value) chave.value = lerLS(KEY_CHAVE, '');
    this._pintarCameraEstado(camOn ? (e.camera || 'pausa') : 'desligada', info);
  },

  _pintarCameraEstado(estado, el) {
    const info = el || document.getElementById('estado-camera-sono');
    if (info) info.innerText = T.camEstado[estado] || '';
  },

  // ---------------------------------------------------------------- ecrãs de alerta
  _overlay() {
    let o = document.getElementById('benjamin-seg-overlay');
    if (o) return o;
    o = document.createElement('div');
    o.id = 'benjamin-seg-overlay';
    o.style.cssText = 'position:fixed;inset:0;z-index:99999;display:none;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;text-align:center;font-family:inherit;';
    document.body.appendChild(o);
    return o;
  },

  _mostrar({ fundo, titulo, grande, texto, botao, acao }) {
    clearTimeout(this._timerOverlay);
    const o = this._overlay();
    o.style.background = fundo;
    o.innerHTML = '';
    const mk = (tag, css, txt) => { const e = document.createElement(tag); e.style.cssText = css; e.textContent = txt; return e; };
    o.appendChild(mk('div', 'font-size:22px;font-weight:900;color:#fff;letter-spacing:.04em;', titulo));
    if (grande !== undefined && grande !== '') o.appendChild(mk('div', 'font-size:96px;font-weight:900;color:#fff;line-height:1;font-family:monospace;', String(grande)));
    if (texto) o.appendChild(mk('div', 'font-size:15px;font-weight:700;color:#e2e8f0;max-width:320px;', texto));
    if (botao) {
      const b = mk('button', 'width:100%;max-width:340px;padding:22px 12px;border-radius:18px;font-size:22px;font-weight:900;background:#fff;color:#0B132B;border:0;', botao);
      b.addEventListener('click', acao);
      o.appendChild(b);
    }
    o.style.display = 'flex';
  },

  _esconder() {
    clearTimeout(this._timerOverlay);
    const o = document.getElementById('benjamin-seg-overlay');
    if (o) o.style.display = 'none';
  },

  _aoSos(d) {
    if (d.fase === 'contagem') {
      this._mostrar({ fundo: '#991b1b', titulo: T.sosTitulo, grande: d.segundos, texto: T.sosContagem(d.segundos), botao: T.sosCancelar, acao: () => this.sosCancelar() });
    } else if (d.fase === 'a-enviar') {
      this._mostrar({ fundo: '#991b1b', titulo: T.sosTitulo, texto: T.sosEnviar });
    } else if (d.fase === 'enviado') {
      this._mostrar({ fundo: '#065f46', titulo: T.sosEnviado });
      this._timerOverlay = setTimeout(() => this._esconder(), 4000);
    } else if (d.fase === 'falhou') {
      this._mostrar({ fundo: '#991b1b', titulo: T.sosFalhou });
      this._timerOverlay = setTimeout(() => this._esconder(), 8000);
    } else {
      this._esconder();    // cancelado
    }
  },

  _aoVerificacao(d) {
    if (d.fase === 'pergunta' || d.fase === 'repete') {
      this._mostrar({ fundo: '#1e3a8a', titulo: T.verifTitulo, botao: T.verifBotao, acao: () => this.confirmar() });
    } else if (d.fase === 'alarme') {
      this._mostrar({ fundo: '#991b1b', titulo: T.alarmeTitulo, botao: T.alarmeBotao, acao: () => this.confirmar() });
    } else {
      this._esconder();    // ok / adiada
    }
  },

  _aoSono(d) {
    const nivel = Math.min(2, Math.max(0, d.nivel | 0));
    let b = document.getElementById('benjamin-seg-sono');
    if (!b) {
      b = document.createElement('div');
      b.id = 'benjamin-seg-sono';
      b.style.cssText = 'position:fixed;top:12px;left:12px;right:12px;z-index:99998;padding:14px;border-radius:16px;text-align:center;font-weight:900;font-size:16px;color:#fff;display:none;';
      document.body.appendChild(b);
    }
    b.style.background = nivel >= 2 ? '#991b1b' : (nivel === 1 ? '#b45309' : '#1e3a8a');
    b.textContent = T.sono[nivel];
    b.style.display = 'block';
    clearTimeout(this._timerSono);
    this._timerSono = setTimeout(() => { b.style.display = 'none'; }, 6000);
  },
};

export const BenjaminSeguranca = Seg;
