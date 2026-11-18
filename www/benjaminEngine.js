// benjaminEngine.js — Gestão de guias de remessa (multidrop) do Benjamin
//
// Dados: lista em localStorage (chave GUIAS_KEY). Cada guia:
//   { id, ficheiroGuia, moradaDestino, ordem, ref, nota, nome, docNumero, destinatario, moradaAuto }
//     id            timestamp (único)
//     ficheiroGuia  caminho/URI recebido de fora OU data-URL (foto/PDF importado)
//     moradaDestino A MORADA DE DESCARGA. É a chave que o Benjamin consulta (window.getGuias()[n].morada).
//                   Preenchida sozinha pela leitura do PDF/foto; o motorista só corrige se vir enganos.
//     moradaAuto    true = morada lida automaticamente e ainda não confirmada pelo motorista
//     nome          nome da guia (nome do ficheiro) — aparece no cartão
//     docNumero     nº do documento lido da guia (ex.: "GR 2026/00482")
//     destinatario  nome do cliente que recebe, lido da guia
//     ordem         1 = próxima descarga, 2 = a seguir, ...
// Nada é apagado ao importar: cada importação acrescenta um registo e um cartão.
import { BENJAMIN_SYSTEM_PROMPT } from './benjaminPrompt.js';
import { Benjamin } from './benjamin.js';
import { Leitor, normalizarMorada } from './benjaminLeitor.js';

const GUIAS_KEY = 'benjamin_guias_v2';
const GUIAS_KEY_ANTIGA = 'benjamin_guias';   // formato antigo {uid, ref, morada, nota, foto}: migrado uma vez
const MAX_PDF_BYTES = 1.2 * 1024 * 1024;     // o localStorage tem ~5 MB: PDFs maiores não cabem como data-URL

const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;   // nunca innerHTML com dados do utilizador
  return e;
};

export class BenjaminEngine {
  constructor() {
    this.systemPrompt = BENJAMIN_SYSTEM_PROMPT;
    this.isListening = false;
    this.benjamin = Benjamin;
    this.guias = this._carregar();
    this._ditadoId = null;                      // id da guia que está a ser ditada (só uma de cada vez)
    this._editando = new Set();                 // ids dos cartões em modo de edição
    this._rascunhosNome = new Map();            // id -> nome ainda não gravado
    this._rascunhos = new Map();                // id -> texto ainda não gravado (sobrevive a re-renderizações)
    this._aLer = new Map();                     // id -> texto de estado, enquanto a guia está a ser lida (PDF/OCR)
    this._cancelar = new Map();                 // id -> função que cancela a leitura em curso
    this._leituras = new Map();                 // id -> Promise da leitura (para testes / esperar pelo fim)
    this._avisarReinicioCamara();
    // se a página continua viva ao voltar da câmara, não houve reinício: apaga a marca
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') setTimeout(() => { try { localStorage.removeItem('benjamin_camara_aberta'); } catch (e) { /* ok */ } }, 2500);
    });
    this._vTok = 0;                             // identifica o visualizador aberto (cancela renders antigos)

    // O Benjamin lê as guias por aqui ("Qual é o destino?", boas-vindas): morada = moradaDestino
    window.getGuias = () => this.obterGuias().map((g) => ({ ...g, morada: normalizarMorada(g.moradaDestino) }));

    this._ligarEntradas();
    this._ligarPartilha();
    this.renderizar();
  }

  // ---------- Arranque / paragem do assistente ----------
  async start() {
    if (this.benjamin) { this.benjamin.aoIniciar(); this.isListening = true; }
  }
  stop() {
    if (this.benjamin) { this.benjamin.aoParar(); this.isListening = false; }
  }

  // =====================================================================
  // 1) DADOS (localStorage)
  // =====================================================================
  _carregar() {
    try {
      const raw = localStorage.getItem(GUIAS_KEY);
      if (raw !== null) return this._normalizar(JSON.parse(raw) || []);
    } catch (e) { console.warn('Engine: guias ilegíveis:', e); }
    return this._migrarAntigas();
  }

  /** Converte as guias do formato antigo (uma só vez); se não houver, começa vazio. */
  _migrarAntigas() {
    try {
      const velhas = JSON.parse(localStorage.getItem(GUIAS_KEY_ANTIGA) || '[]') || [];
      const lista = velhas.map((v, i) => ({
        id: Date.now() + i,
        ficheiroGuia: v.foto || '',
        moradaDestino: v.morada || '',
        ordem: i + 1,
        ref: v.ref || `Guia ${i + 1}`,
        nota: v.nota || '',
      }));
      if (lista.length) { this.guias = lista; this._guardar(); }
      return lista;
    } catch (e) { return []; }
  }

  /** Garante ordem 1..n sem buracos nem repetições. */
  _normalizar(lista) {
    return lista
      .filter((g) => g && g.id !== undefined)
      .sort((a, b) => (a.ordem || 9999) - (b.ordem || 9999))
      .map((g, i) => ({ ...g, ordem: i + 1, nome: g.nome || g.ref || `Guia ${i + 1}` }));
  }

  _guardar() {
    this.guias = this._normalizar(this.guias);
    try {
      localStorage.setItem(GUIAS_KEY, JSON.stringify(this.guias));
      try { window.dispatchEvent(new CustomEvent('benjamin:guias')); } catch (e2) { /* sem navegação */ }
      return true;
    } catch (e) {
      console.warn('Engine: sem espaço para guardar as guias:', e.message);
      alert('Sem espaço no dispositivo para guardar este ficheiro. Apaga guias antigas e tenta de novo.');
      return false;
    }
  }

  _achar(id) { return this.guias.find((g) => String(g.id) === String(id)); }
  _novoId() {
    let id = Date.now();
    while (this._achar(id)) id++;
    return id;
  }

  /** Guias por ordem de descarga (a primeira é a próxima entrega). */
  obterGuias() { return [...this.guias].sort((a, b) => a.ordem - b.ordem); }

  // =====================================================================
  // 2) IMPORTAÇÃO — acrescenta sem apagar
  // =====================================================================
  /**
   * importarGuia(ficheiroOuPath, { moradaDestino, origem })
   *   string        -> caminho/URI recebido: guardado tal como veio
   *   File | Blob   -> imagem (reduzida) ou PDF (até ~1,2 MB) guardado como data-URL
   *   origem 'partilha' -> veio do menu Partilhar do Android (muda a confirmação por voz)
   * Devolve a guia criada (ou null).
   */
  async importarGuia(ficheiroOuPath, {
    moradaDestino = '', origem = '' } = {}) {
    let ficheiroGuia = '';
    let nome = '';
    let canvasOcr = null;
    try {
      if (typeof ficheiroOuPath === 'string') {
        ficheiroGuia = ficheiroOuPath;
        nome = ficheiroOuPath.split(/[\\/]/).pop();
      } else if (ficheiroOuPath && typeof ficheiroOuPath.size === 'number') {
        nome = ficheiroOuPath.name || '';
        if ((ficheiroOuPath.type || '').startsWith('image/')) {
          // Descodifica UMA vez (lado maior 1600 px, nunca os 12+ MP da câmara): serve para guardar e para o OCR
          try {
            canvasOcr = await Leitor.imagemParaCanvas(ficheiroOuPath, 1600);
            ficheiroGuia = this._canvasParaJpeg(canvasOcr, 1280, 0.72);
          } catch (e1) {
            console.warn('Engine: redução da foto falhou, a tentar o método simples:', e1 && e1.message);
            canvasOcr = null;
            ficheiroGuia = await this._reduzirImagem(ficheiroOuPath, 1280, 0.7);
          }
        } else if (ficheiroOuPath.size <= MAX_PDF_BYTES) {
          ficheiroGuia = await this._lerDataUrl(ficheiroOuPath);
        } else {
          this.benjamin.falar('Esse ficheiro é demasiado grande para guardar. Envia-me uma foto da guia.');
          return null;
        }
      }
    } catch (e) {
      console.warn('Engine: importação falhou:', e);
      alert('Não foi possível ler o ficheiro. Tenta outra vez.');
      return null;
    }

    const ref = this._proximaRef('');
    const nomeBonito = this._nomeBonito(nome);
    const guia = {
      id: this._novoId(),
      ficheiroGuia,
      moradaDestino: moradaDestino.trim(),
      moradaAuto: false,
      ordem: this.guias.length + 1,            // entra no fim; o motorista reordena com 🔼 / 🔽
      ref,
      nome: nomeBonito || ref,
      docNumero: '',
      destinatario: '',
      nota: '',
    };
    this.guias.push(guia);
    if (!this._guardar()) { this.guias.pop(); return null; }

    // Há ficheiro e ainda não há morada: o Benjamin LÊ a guia (PDF -> texto, foto -> OCR) e preenche a morada.
    // A voz só fala quando a leitura acabar. Sem ficheiro (guia manual) ou com morada dada: anuncia já.
    if (ficheiroGuia && !guia.moradaDestino) {
      const fonte = canvasOcr || ficheiroOuPath;          // imagem já reduzida (ou o ficheiro, se for PDF)
      const mime = (typeof ficheiroOuPath === 'string') ? '' : (ficheiroOuPath.type || '');
      this._leituras.set(guia.id, this._lerAuto(guia.id, fonte, mime, origem, !nomeBonito));
      this.renderizar();
    } else {
      this.renderizar();
      this._anunciar(guia, origem);
    }
    return guia;
  }

  /** "Guia_de_Remessa_-_Teste_Benjamin.pdf" -> "Guia de Remessa - Teste Benjamin" ("" se for um nome inútil de câmara). */
  _nomeBonito(nome) {
    let n = String(nome || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const inutil = /^(?:whatsapp\s+(?:image|document)|jpe?g|png|heic|webp|image|img|photo|picture|pict|foto|pxl|dsc|screenshot|capture|scan|camera|cam|attachment|download|file|document|doc)[\s\d_.()-]*(?:\s+at\s+[\d.\s]+)?(?:am|pm)?$/i;
    if (!n || inutil.test(n) || /^[\d\s.()-]+$/.test(n)) return '';
    return n.slice(0, 60);
  }

  /**
   * Lê a guia e preenche a morada de descarga. Nunca rebenta: se falhar, o motorista dita/escreve.
   * Não sobrepõe uma morada que o motorista já tenha escrito entretanto.
   */
  async _lerAuto(id, fonte, mime, origem, nomeInutil) {
    const t0 = Date.now();
    let fase = 'A ler a guia…';
    let pct = 0;
    const mostrar = () => this._estadoLeitura(id, `${fase}${pct ? ' ' + pct + '%' : ''} · ${Math.round((Date.now() - t0) / 1000)} s`);
    this._aLer.set(id, fase);
    this.renderizar();
    const tick = setInterval(mostrar, 1000);                 // o motorista vê que está vivo (e há quanto tempo)

    let r = null;
    let motivo = '';
    let cortar;
    const cortada = new Promise((_, rej) => { cortar = rej; });
    this._cancelar.set(id, () => { try { Leitor.cancelar(); } catch (e) { /* ok */ } cortar(new Error('cancelada')); });
    try {
      const ehPdf = /pdf/i.test(mime) || (typeof fonte === 'string' && (/^data:application\/pdf/i.test(fonte) || /\.pdf($|\?)/i.test(fonte)));
      const limite = ehPdf ? 40000 : 120000;                 // teto absoluto: nunca fica "a ler" para sempre
      let relogio;
      const passouTempo = new Promise((_, rej) => { relogio = setTimeout(() => rej(new Error('demorou mais de ' + limite / 1000 + ' s')), limite); });
      try {
        r = await Promise.race([
          Leitor.lerGuia(fonte, mime, {
            aoProgresso: (p) => { pct = Math.round(p * 100); mostrar(); },
            aoEstado: (t) => { fase = t; pct = 0; mostrar(); },
          }),
          passouTempo,
          cortada,
        ]);
      } finally { clearTimeout(relogio); }
    } catch (e) {
      motivo = (e && e.message) || 'erro';
      console.warn('Engine: leitura da guia falhou:', motivo);
      if (motivo !== 'cancelada') { try { Leitor.cancelar(); } catch (e2) { /* ok */ } }   // não deixar um leitor preso a gastar bateria
    } finally {
      clearInterval(tick);                                    // o indicador "a ler" fecha SEMPRE
      this._aLer.delete(id);
      this._cancelar.delete(id);
    }

    try {
      const g = this._achar(id);
      if (!g) return null;                                    // eliminada entretanto
      if (r) {
        console.log(`Engine: guia lida (${r.metodo}${r.rotacao ? ', rodada ' + r.rotacao + '°' : ''}, ${r.origem || 'sem morada'}) em ${Date.now() - t0} ms →`, r.morada || '(nada)');
        if (r.docNumero) g.docNumero = r.docNumero;
        if (r.destinatario) g.destinatario = r.destinatario;
        if (nomeInutil && !g.nomeManual && (r.destinatario || r.docNumero)) g.nome = r.destinatario || r.docNumero;
        const aEscrever = this._editando.has(g.id) && (this._rascunhos.get(g.id) || '').trim();
        if (r.morada && !g.moradaDestino && !aEscrever) {
          g.moradaDestino = r.morada;
          g.moradaAuto = true;
          g.moradaOrigem = r.confianca || '';
        }
      }
      this._guardar();
      this.renderizar();
      this._anunciar(g, origem, r, motivo);
      return g;
    } catch (e) {
      console.warn('Engine: erro ao fechar a leitura:', e);
      this.renderizar();
      return null;
    }
  }

  /** ✖ Cancelar leitura (botão do cartão enquanto "a ler"). */
  cancelarLeitura(id) {
    const f = this._cancelar.get(id);
    if (f) f();
  }

  /** Aviso discreto no topo do ecrã (some sozinho). */
  _toast(txt, ms = 3500) {
    try {
      let t = document.getElementById('toast-benjamin');
      if (!t) {
        t = document.createElement('div');
        t.id = 'toast-benjamin';
        t.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:10001;max-width:90%;padding:10px 14px;border-radius:14px;background:#0F172A;border:1px solid #1d4ed8;color:#7dd3fc;font:600 12px system-ui,sans-serif;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.5);';
        document.body.appendChild(t);
      }
      t.textContent = txt;
      t.style.display = 'block';
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => { t.style.display = 'none'; }, ms);
    } catch (e) { /* ok */ }
  }

  _canvasParaJpeg(canvas, maxLado, qualidade) {
    const esc = Math.min(1, maxLado / Math.max(canvas.width, canvas.height));
    if (esc === 1) return canvas.toDataURL('image/jpeg', qualidade);
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * esc);
    c.height = Math.round(canvas.height * esc);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', qualidade);
  }

  _estadoLeitura(id, txt) {
    this._aLer.set(id, txt);
    const e = document.getElementById(`lendo-${id}`);
    if (e) e.textContent = '🔎 ' + txt;
  }

  /** Espera pelo fim da leitura automática de uma guia (útil em testes). */
  aguardarLeitura(id) { return this._leituras.get(id) || Promise.resolve(this._achar(id)); }

  /** 🔎 Reler: volta a ler a guia guardada (apaga a morada lida automaticamente, se ainda não foi confirmada). */
  async relerGuia(id) {
    const g = this._achar(id);
    if (!g || !g.ficheiroGuia || this._aLer.has(g.id)) return null;
    if (g.moradaDestino && !g.moradaAuto && !confirm('Substituir a morada atual pela que está na guia?')) return null;
    g.moradaDestino = '';
    g.moradaAuto = false;
    this._guardar();
    const p = this._lerAuto(g.id, g.ficheiroGuia, '', 'reler', false);
    this._leituras.set(g.id, p);
    return p;
  }

  /** Guia vazia (sem ficheiro): abre já em modo de edição para escrever ou ditar a morada. */
  async novaGuia() {
    const g = await this.importarGuia('');
    if (g) this.editarMorada(g.id);
    return g;
  }

  _proximaRef(nome) {
    let n = 1;
    try { n = parseInt(localStorage.getItem('benjamin_guia_seq') || '0', 10) + 1; localStorage.setItem('benjamin_guia_seq', String(n)); }
    catch (e) { n = this.guias.length + 1; }
    return nome ? `Guia #${n} · ${nome.slice(0, 18)}` : `Guia #${n}`;
  }

  _anunciar(guia, origem, leitura, motivo) {
    try {
      const lida = leitura !== undefined;              // houve tentativa de leitura automática
      const abre = origem === 'partilha' ? 'Recebi a guia partilhada. ' : origem === 'reler' ? '' : 'Guia registada. ';
      if (lida && guia.moradaAuto && guia.moradaDestino) {
        this.benjamin.falar(`${abre}Li a morada de descarga: ${guia.moradaDestino}. ` +
          (guia.moradaOrigem === 'baixa' ? 'Não tenho a certeza, confirma no cartão.' : 'Confirma no cartão se está certo.'));
      } else if (lida && motivo === 'cancelada') {
        this.benjamin.falar(`${abre}Leitura cancelada. Toca em Editar e depois em Ditar, no cartão da guia.`);
      } else if (lida) {
        this.benjamin.falar(`${abre}Não consegui ler a morada. Tira outra foto com o telemóvel na vertical, ou toca em Editar e depois em Ditar.`);
      } else if (origem === 'partilha') {
        this.benjamin.falar('Recebi a guia partilhada. ' + (guia.moradaDestino
          ? `Destino: ${guia.moradaDestino}.`
          : 'Ainda não tenho a morada. Toca em Editar e depois em Ditar, no cartão da guia.'));
      } else if (this.benjamin && this.benjamin.aoGuiaRegistada) {
        this.benjamin.aoGuiaRegistada({ ...guia, morada: guia.moradaDestino });
      }
    } catch (e) { /* voz opcional */ }
  }

  // ---- entradas de ficheiro do index.html ----
  _ligarEntradas() {
    const ligar = (idInput) => {
      const input = document.getElementById(idInput);
      if (!input || input.dataset.ligado) return;
      input.dataset.ligado = '1';
      input.addEventListener('change', async (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (f) await this.importarGuia(f);
        input.value = '';
      });
    };
    ligar('guia-foto-input');       // câmara
    ligar('guia-ficheiro-input');   // galeria / PDF
  }
  /** Se a app foi morta enquanto a câmara estava aberta (Android sem memória), avisa em vez de ficar calada. */
  _avisarReinicioCamara() {
    try {
      const t = parseInt(localStorage.getItem('benjamin_camara_aberta') || '0', 10);
      if (!t) return;
      localStorage.removeItem('benjamin_camara_aberta');
      if (Date.now() - t < 15 * 60 * 1000) {
        console.warn('Engine: a app foi reiniciada enquanto a câmara estava aberta (processo morto pelo Android).');
        setTimeout(() => this._toast('⚠️ O Android fechou o Benjamin enquanto tirava a foto. A foto perdeu-se: usa 📂 Importar (galeria) ou partilha a foto pelo WhatsApp.', 9000), 1500);
      }
    } catch (e) { /* ok */ }
  }

  fotografarGuia() {
    const i = document.getElementById('guia-foto-input');
    if (!i) return;
    try { localStorage.setItem('benjamin_camara_aberta', String(Date.now())); } catch (e) { /* ok */ }
    Leitor.aquecer();                                         // o leitor de texto arranca enquanto tiras a foto
    this._toast('📱 Segure o telemóvel na vertical (ao alto) para leitura correta da guia.');
    i.value = '';
    i.click();
  }
  importarFicheiro() {
    const i = document.getElementById('guia-ficheiro-input');
    if (!i) return;
    Leitor.aquecer();
    i.value = '';
    i.click();
  }

  _lerDataUrl(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(new Error('leitura falhou'));
      r.readAsDataURL(file);
    });
  }

  _reduzirImagem(file, maxLado, qualidade) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const esc = Math.min(1, maxLado / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * esc);
        c.height = Math.round(img.height * esc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', qualidade));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('imagem inválida')); };
      img.src = url;
    });
  }

  // =====================================================================
  // 3) RECEÇÃO DE FICHEIROS PARTILHADOS (menu "Partilhar" do Android → plugin BenjaminShare)
  // =====================================================================
  _pluginPartilha() {
    try {
      const C = window.Capacitor;
      const nativo = C && typeof C.isNativePlatform === 'function' && C.isNativePlatform();
      if (nativo && (typeof C.isPluginAvailable !== 'function' || C.isPluginAvailable('BenjaminShare'))) {
        return (C.Plugins && C.Plugins.BenjaminShare)
          || (typeof C.registerPlugin === 'function' ? C.registerPlugin('BenjaminShare') : null);
      }
    } catch (e) { /* sem plugin */ }
    return null;
  }

  _ligarPartilha() {
    const p = this._pluginPartilha();
    if (!p) {
      console.log('Benjamin SHARE: plugin BenjaminShare indisponível (browser, ou falta registerPlugin(BenjaminSharePlugin.class) no MainActivity).');
      return;
    }
    this._partilhaFeita = new Set();                  // ids já tratados (o evento e o "puxar" podem trazer o mesmo item)
    this._aResgatar = false;
    console.log('Benjamin SHARE: plugin ligado, a procurar partilhas pendentes...');
    try {
      // 1) tempo real: a app já estava aberta
      Promise.resolve(p.addListener('guiaPartilhada', (d) => this._aoPartilhar(d)))
        .catch((e) => console.warn('Benjamin SHARE: listener falhou:', e));
    } catch (e) { console.warn('Benjamin SHARE: listener falhou:', e); }
    // 2) arranque a frio: o Java guardou o que veio no Intent inicial; vamos buscá-lo já
    this._resgatarPartilhas();
    // 3) regresso à app (ex.: partilhou outra guia enquanto estava em segundo plano)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._resgatarPartilhas();
    });
  }

  /** Pede ao Java as partilhas pendentes (Intent inicial incluído) e trata cada uma. */
  async _resgatarPartilhas() {
    const p = this._pluginPartilha();
    if (!p || this._aResgatar) return;
    this._aResgatar = true;
    try {
      const r = await p.obterPartilhas();
      const itens = (r && r.itens) || [];
      if (itens.length) console.log(`Benjamin SHARE: ${itens.length} partilha(s) pendente(s)`);
      for (const item of itens) await this._aoPartilhar(item);
    } catch (e) {
      console.warn('Benjamin SHARE: obterPartilhas() falhou (plugin Java desatualizado?):', e && (e.message || e));
    } finally {
      this._aResgatar = false;
    }
  }

  async _aoPartilhar(d) {
    const B = this.benjamin;
    const p = this._pluginPartilha();
    if (d && d.id !== undefined) {                    // sem duplicados (evento + "puxar")
      if (this._partilhaFeita.has(d.id)) return;
      this._partilhaFeita.add(d.id);
    }
    console.log('Benjamin SHARE: recebido', d && d.nome, d && d.mime, d && d.erro ? '(erro: ' + d.erro + ')' : '');

    // 1) mostrar já o separador das guias, aconteça o que acontecer
    try { if (typeof window.switchTab === 'function') window.switchTab('opcoes'); } catch (e) { /* ok */ }

    if (!d || d.erro || !d.dados) {
      const msg = d && d.erro === 'grande' ? 'O ficheiro partilhado é demasiado grande.'
        : d && d.erro === 'tipo' ? 'Só consigo receber PDF ou imagens.'
          : 'Não consegui ler o ficheiro partilhado.';
      try { B.falar(msg); } catch (e) { /* ok */ }
      this._confirmarPartilha(p, d);
      return;
    }
    try {
      // 2) importar para benjamin_guias_v2 (cria o cartão)  3) o Benjamin confirma por voz (dentro de importarGuia)
      const file = this._base64ParaFile(d.dados, d.nome || 'guia', d.mime);
      const guia = await this.importarGuia(file, { origem: 'partilha' });
      if (guia) {
        const c = document.querySelector(`[data-guia-id="${guia.id}"]`);
        if (c && c.scrollIntoView) { try { c.scrollIntoView({ block: 'center' }); } catch (e) { /* ok */ } }
      }
    } catch (e) {
      console.warn('Benjamin SHARE: importação falhou:', e);
      try { B.falar('Não consegui guardar o ficheiro partilhado.'); } catch (_) { /* ok */ }
    }
    this._confirmarPartilha(p, d);
  }

  _confirmarPartilha(p, d) {
    if (!p || !d || d.id === undefined) return;
    try { Promise.resolve(p.confirmar({ id: d.id })).catch(() => {}); } catch (e) { /* ok */ }
  }

  _base64ParaFile(b64, nome, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], nome, { type: mime || 'application/octet-stream' });
  }

  // =====================================================================
  // 4) CARTÕES — um por guia
  // =====================================================================
  renderizar() {
    const cont = document.getElementById('guias-list');
    if (!cont) return;
    cont.replaceChildren();
    const lista = this.obterGuias();
    if (!lista.length) {
      cont.appendChild(el('p', 'text-[10px] text-gray-500 text-center py-2', 'Sem guias. Usa "Nova guia", "Importar" ou "Fotografar".'));
    }
    lista.forEach((g, i) => cont.appendChild(this._criarCartao(g, i, lista.length)));
    const cnt = document.getElementById('guias-counter');
    if (cnt) cnt.textContent = `${lista.length} guia(s)`;
  }

  _botao(cls, txt, onclick, desativado = false) {
    const b = el('button', cls + (desativado ? ' opacity-30' : ''), txt);
    b.type = 'button';
    if (desativado) b.disabled = true;
    else b.onclick = onclick;
    return b;
  }

  _criarCartao(g, i, total) {
    const primeira = i === 0;
    const aEditar = this._editando.has(g.id);
    const cartao = el('div', 'p-2.5 rounded-xl border flex flex-col gap-1.5 bg-[#1E293B] ' +
      (primeira ? 'border-emerald-500/60' : 'border-gray-700/60'));
    cartao.dataset.guiaId = String(g.id);

    // linha 1: posição + eliminar
    const topo = el('div', 'flex items-center justify-between gap-2');
    topo.appendChild(el('span', 'text-[10px] font-black ' + (primeira ? 'text-emerald-400' : 'text-gray-400'),
      primeira ? '🥇 1.ª ENTREGA' : `${g.ordem}.ª entrega`));
    topo.appendChild(this._botao('text-[11px] bg-red-900/40 text-red-300 border border-red-700/50 px-2 py-0.5 rounded-full',
      '🗑️', () => this.eliminarGuia(g.id)));
    cartao.appendChild(topo);

    // linha 2: NOME da guia (+ nº do documento e cliente, se foram lidos)
    if (aEditar) {
      const ni = el('input', 'w-full bg-[#0B132B] border border-cyan-500 rounded-lg px-2 py-1 text-[12px] font-bold text-white focus:outline-none');
      ni.type = 'text';
      ni.id = `nome-${g.id}`;
      ni.placeholder = 'Nome da entrega (ex.: Cliente Algés)';
      ni.maxLength = 60;
      ni.value = this._rascunhosNome.has(g.id) ? this._rascunhosNome.get(g.id) : (g.nome || '');
      ni.addEventListener('input', () => this._rascunhosNome.set(g.id, ni.value));
      ni.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { const m = document.getElementById(`morada-${g.id}`); if (m) m.focus(); else this.confirmarEdicao(g.id); } });
      cartao.appendChild(ni);
    } else {
      const nomeEl = el('p', 'text-[12px] font-bold text-white break-words leading-tight', `📄 ${g.nome || g.ref}`);
      nomeEl.dataset.campo = 'nome';
      cartao.appendChild(nomeEl);
    }
    const sub = [g.docNumero && g.docNumero !== g.nome ? g.docNumero : '', g.destinatario].filter(Boolean).join(' · ');
    if (sub) cartao.appendChild(el('p', 'text-[10px] text-gray-400 break-words leading-tight', sub));

    // linha 3: morada — a ler… | campo (edição) | texto (leitura)
    if (this._aLer.has(g.id)) {
      const l = el('p', 'text-[11px] text-cyan-300 animate-pulse', '🔎 ' + this._aLer.get(g.id));
      l.id = `lendo-${g.id}`;
      cartao.appendChild(l);
      cartao.appendChild(this._botao('text-[10px] bg-gray-800 border border-gray-600 text-gray-300 px-2 py-1 rounded-full font-bold',
        '✖ Cancelar leitura', () => this.cancelarLeitura(g.id)));
    } else if (aEditar) {
      const input = el('input', 'w-full bg-[#0B132B] border border-cyan-500 rounded-lg px-2 py-1 text-[11px] text-white focus:outline-none');
      input.type = 'text';
      input.id = `morada-${g.id}`;
      input.placeholder = 'Morada de destino';
      input.value = this._rascunhos.has(g.id) ? this._rascunhos.get(g.id) : (g.moradaDestino || '');
      input.addEventListener('input', () => this._rascunhos.set(g.id, input.value));   // rascunho, ainda não gravado
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') this.confirmarEdicao(g.id); });
      input.addEventListener('focus', () => setTimeout(() => { try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ok */ } }, 300));
      cartao.appendChild(input);
    } else {
      const lido = el('p', 'text-[11px] break-words leading-snug ' + (g.moradaDestino ? 'text-white' : 'text-gray-500 italic'),
        g.moradaDestino ? `📍 ${g.moradaDestino}` : 'Sem morada — toca em ✏️ Editar');
      lido.dataset.campo = 'morada';
      cartao.appendChild(lido);
      if (g.moradaDestino && g.moradaAuto) {
        cartao.appendChild(el('p', 'text-[9px] text-amber-300', '🔎 Lida da guia automaticamente — confirma se está certa'));
      }
    }

    // linha 3: ações DESTA guia
    const acoes = el('div', 'flex items-center gap-1.5 flex-wrap');
    const seta = 'text-[12px] bg-gray-800 border border-gray-600 text-white px-2.5 py-1 rounded-full font-bold';
    acoes.appendChild(this._botao(seta, '🔼', () => this.moverGuia(g.id, -1), primeira));
    acoes.appendChild(this._botao(seta, '🔽', () => this.moverGuia(g.id, +1), i === total - 1));

    if (aEditar) {
      const ditar = this._botao('text-[10px] bg-gray-800 border border-gray-700 text-cyan-300 px-2 py-1 rounded-full font-bold',
        this._ditadoId === g.id ? '🎤 A ouvir...' : '🗣️ Ditar', () => this.ditarMorada(g.id));
      ditar.id = `btn-ditar-${g.id}`;
      if (this._ditadoId === g.id) ditar.className += ' animate-pulse bg-emerald-700';
      acoes.appendChild(ditar);
      acoes.appendChild(this._botao('text-[10px] bg-emerald-600 border border-emerald-400 text-black px-2.5 py-1 rounded-full font-black',
        '✅ OK', () => this.confirmarEdicao(g.id)));
      acoes.appendChild(this._botao('text-[10px] bg-gray-800 border border-gray-600 text-gray-300 px-2 py-1 rounded-full font-bold',
        '✖ Cancelar', () => this.cancelarEdicao(g.id)));
    } else {
      acoes.appendChild(this._botao('text-[10px] bg-amber-600/20 border border-amber-500/50 text-amber-300 px-2 py-1 rounded-full font-bold',
        '✏️ Editar', () => this.editarMorada(g.id)));
    }
    if (!aEditar && g.moradaAuto && g.moradaDestino) {
      acoes.appendChild(this._botao('text-[10px] bg-emerald-600/30 border border-emerald-500/60 text-emerald-200 px-2 py-1 rounded-full font-bold',
        '✓ Está certa', () => this.confirmarMorada(g.id)));
    }
    if (g.ficheiroGuia) {
      acoes.appendChild(this._botao('text-[10px] bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 px-2 py-1 rounded-full font-bold',
        '📎 Ver guia', () => this.verFicheiro(g.id)));
      if (!aEditar && !this._aLer.has(g.id)) {
        acoes.appendChild(this._botao('text-[10px] bg-gray-800 border border-gray-600 text-gray-300 px-2 py-1 rounded-full font-bold',
          '🔎 Reler', () => this.relerGuia(g.id)));
      }
    }
    cartao.appendChild(acoes);
    return cartao;
  }

  // ---- edição: ✏️ Editar → (escrever / 🗣️ Ditar) → ✅ OK grava | ✖ Cancelar descarta ----
  editarMorada(id) {
    const g = this._achar(id);
    if (!g) return;
    this._editando.add(g.id);
    this.renderizar();
    const campo = document.getElementById(`morada-${g.id}`);
    if (campo) campo.focus();
  }

  /** ✅ OK: consolida o rascunho, fecha a edição e grava no localStorage. */
  confirmarEdicao(id) {
    const g = this._achar(id);
    if (!g) return;
    if (this._ditadoId !== null && String(this._ditadoId) === String(id)) this._terminarDitado();
    const campo = document.getElementById(`morada-${g.id}`);
    const texto = campo ? campo.value : (this._rascunhos.has(g.id) ? this._rascunhos.get(g.id) : g.moradaDestino);
    const campoNome = document.getElementById(`nome-${g.id}`);
    const nomeNovo = (campoNome ? campoNome.value : (this._rascunhosNome.has(g.id) ? this._rascunhosNome.get(g.id) : g.nome) || '').trim().slice(0, 60);
    g.moradaAuto = false;                                // o motorista viu e validou (antes de gravar: _guardar recria os objetos)
    if (nomeNovo && nomeNovo !== g.nome) { g.nome = nomeNovo; g.nomeManual = true; }   // nome escolhido por ele: a leitura automática nunca o troca
    else if (!nomeNovo) { g.nome = g.ref; g.nomeManual = false; }                       // campo vazio = volta ao nome por defeito
    this.atualizarMorada(g.id, texto);
    this._editando.delete(g.id);
    this._rascunhos.delete(g.id);
    this._rascunhosNome.delete(g.id);
    this.renderizar();
  }

  /** ✓ Está certa: o motorista validou a morada lida automaticamente. */
  confirmarMorada(id) {
    const g = this._achar(id);
    if (!g) return;
    g.moradaAuto = false;
    this._guardar();
    this.renderizar();
  }

  /** ✖ Cancelar: descarta o rascunho e mantém a morada gravada. */
  cancelarEdicao(id) {
    if (this._ditadoId !== null && String(this._ditadoId) === String(id)) this._terminarDitado();
    this._editando.delete(this._achar(id) ? this._achar(id).id : id);
    this._rascunhos.delete(this._achar(id) ? this._achar(id).id : id);
    this._rascunhosNome.delete(this._achar(id) ? this._achar(id).id : id);
    this.renderizar();
  }

  atualizarMorada(id, texto) {
    const g = this._achar(id);
    if (!g) return false;
    g.moradaDestino = normalizarMorada(String(texto || '').trim());   // também arruma moradas escritas/ditadas
    return this._guardar();
  }

  eliminarGuia(id) {
    const g = this._achar(id);
    if (!g || !confirm(`Eliminar ${g.nome || g.ref}?`)) return;
    if (this._ditadoId !== null && String(this._ditadoId) === String(id)) this._terminarDitado();
    this.guias = this.guias.filter((x) => String(x.id) !== String(id));
    this._editando.delete(g.id);
    this._rascunhos.delete(g.id);
    this._guardar();
    this.renderizar();
  }

  // ---- 📎 Ver guia: visualizador DENTRO da app (sem escolher aplicação, sem content://) ----
  /**
   * Abre a guia por cima de tudo, na própria app:
   *   imagem -> <img> a partir do data-URL guardado;  PDF -> páginas desenhadas em <canvas> (pdf.js).
   * ➖ / ➕ mudam o zoom (o ecrã desliza em todas as direções); ✖ ou "voltar" fecham.
   */
  verFicheiro(id) {
    const g = this._achar(id);
    if (!g || !g.ficheiroGuia) return;
    this._fecharVisualizador(true);
    const tok = ++this._vTok;
    const f = g.ficheiroGuia;
    const ehPdf = /^data:application\/pdf/i.test(f) || /\.pdf($|\?)/i.test(f);
    let zoom = 1;
    const ZOOMS = [1, 1.5, 2, 3];

    const caixa = document.createElement('div');
    caixa.id = 'guia-viewer';
    caixa.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#000;display:flex;flex-direction:column;';
    const barra = document.createElement('div');
    barra.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0B132B;color:#fff;font:600 13px system-ui,sans-serif;flex:0 0 auto;';
    const titulo = document.createElement('div');
    titulo.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titulo.textContent = g.nome || g.ref;
    const mkBtn = (txt, fn, cor) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = txt;
      b.style.cssText = `flex:0 0 auto;min-width:44px;height:40px;border-radius:20px;border:1px solid #1E3A8A;background:${cor || '#1E3A8A'};color:#fff;font-size:18px;font-weight:800;`;
      b.onclick = fn;
      return b;
    };
    const corpo = document.createElement('div');
    corpo.id = 'guia-viewer-corpo';
    corpo.style.cssText = 'flex:1;overflow:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y pinch-zoom;padding:6px 4px 40px;';
    const msg = document.createElement('p');
    msg.style.cssText = 'color:#9ca3af;text-align:center;padding:30px 12px;font:14px system-ui,sans-serif;';
    msg.textContent = 'A abrir a guia…';
    corpo.appendChild(msg);

    const desenhar = async () => {
      if (tok !== this._vTok) return;
      if (!ehPdf) {
        let src = f;
        if (!/^(data:|https?:|blob:)/.test(f) && window.Capacitor && window.Capacitor.convertFileSrc) src = window.Capacitor.convertFileSrc(f);
        let img = corpo.querySelector('img');
        if (!img) {
          corpo.replaceChildren();
          img = document.createElement('img');
          img.style.cssText = 'display:block;margin:0 auto;max-width:none;height:auto;background:#fff;';
          img.alt = g.nome || 'guia';
          img.onerror = () => { corpo.replaceChildren(msg); msg.textContent = 'Não foi possível abrir esta imagem.'; };
          img.src = src;
          corpo.appendChild(img);
        }
        img.style.width = (zoom * 100) + '%';
        return;
      }
      try {
        corpo.replaceChildren(msg);
        msg.textContent = 'A abrir a guia…';
        await Leitor.renderizarPdf(f, corpo, { zoom, token: () => tok === this._vTok });
      } catch (e) {
        console.warn('Engine: visualizador de PDF falhou:', e && (e.message || e));
        if (tok !== this._vTok) return;
        corpo.replaceChildren();
        const m2 = document.createElement('p');
        m2.style.cssText = 'color:#fca5a5;text-align:center;padding:24px 12px;font:14px system-ui,sans-serif;';
        m2.textContent = 'Não consegui mostrar o PDF dentro da app.';
        corpo.appendChild(m2);
        const b = mkBtn('Abrir noutra aplicação', () => this._abrirPdfNativo(g), '#2563eb');
        b.style.cssText += 'display:block;margin:0 auto;padding:0 16px;font-size:14px;';
        corpo.appendChild(b);
      }
    };

    barra.appendChild(titulo);
    barra.appendChild(mkBtn('−', () => { zoom = ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)]; desenhar(); }));
    barra.appendChild(mkBtn('+', () => { zoom = ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)]; desenhar(); }));
    barra.appendChild(mkBtn('✖', () => this._fecharVisualizador(), '#991b1b'));
    caixa.appendChild(barra);
    caixa.appendChild(corpo);
    document.body.appendChild(caixa);

    // botão "voltar" do Android fecha o visualizador em vez de fechar a app
    try { history.pushState({ guiaViewer: tok }, ''); this._vHist = true; } catch (e) { this._vHist = false; }
    this._vPop = () => this._fecharVisualizador(true);
    window.addEventListener('popstate', this._vPop);
    this._vKey = (ev) => { if (ev.key === 'Escape') this._fecharVisualizador(); };
    document.addEventListener('keydown', this._vKey);

    desenhar();
  }

  /** semHistoria = já não mexer no histórico (veio do "voltar"). */
  _fecharVisualizador(semHistoria = false) {
    const c = document.getElementById('guia-viewer');
    this._vTok++;
    if (this._vPop) { window.removeEventListener('popstate', this._vPop); this._vPop = null; }
    if (this._vKey) { document.removeEventListener('keydown', this._vKey); this._vKey = null; }
    if (c) c.remove();
    if (this._vHist && !semHistoria) { try { history.back(); } catch (e) { /* ok */ } }
    this._vHist = false;
  }

  /** Último recurso (só se o pdf.js falhar): entrega o PDF à aplicação de PDF do Android. */
  _abrirPdfNativo(g) {
    const p = this._pluginPartilha();
    if (!p || typeof p.abrirPdf !== 'function' || !/^data:/i.test(g.ficheiroGuia)) { alert('Não foi possível abrir o PDF.'); return; }
    Promise.resolve(p.abrirPdf({ dados: g.ficheiroGuia, nome: (g.nome || 'guia') + '.pdf' }))
      .catch((e) => alert('Não foi possível abrir o PDF: ' + (e && (e.message || e))));
  }

  // =====================================================================
  // 5) ROTA — reordenar com 🔼 / 🔽
  // =====================================================================
  /** Sobe (delta -1) ou desce (+1) uma posição; renumera tudo e anuncia se mudou a 1.ª entrega. */
  moverGuia(id, delta) {
    const lista = this.obterGuias();
    const i = lista.findIndex((g) => String(g.id) === String(id));
    const j = i + delta;
    if (i < 0 || j < 0 || j >= lista.length) return;
    const primeiraAntes = lista[0].id;
    [lista[i], lista[j]] = [lista[j], lista[i]];
    lista.forEach((g, k) => { g.ordem = k + 1; });
    this.guias = lista;
    this._guardar();
    this.renderizar();
    if (lista[0].id !== primeiraAntes) this._anunciarPrimeira(lista[0]);
  }

  /** A guia escolhida passa a ser a próxima descarga (as outras descem uma posição). */
  definirPrimeiraEntrega(id) {
    const g = this._achar(id);
    if (!g || g.ordem === 1) return;
    this.guias.forEach((x) => { if (x !== g && x.ordem < g.ordem) x.ordem += 1; });
    g.ordem = 1;
    this._guardar();
    this.renderizar();
    this._anunciarPrimeira(g);
  }

  _anunciarPrimeira(g) {
    const msg = g.moradaDestino
      ? `Primeira entrega: ${g.moradaDestino}.`
      : 'Primeira entrega alterada, mas essa guia ainda não tem morada.';
    try { this.benjamin.falar(msg); } catch (e) { /* voz opcional */ }
  }

  // =====================================================================
  // 6) DITADO ISOLADO POR GUIA (só dentro do modo de edição desse cartão)
  // =====================================================================
  /**
   * O botão "Ditar" de cada cartão chama isto com o id da SUA guia. O texto reconhecido entra só no campo
   * (e no rascunho) dessa guia; fica gravado quando o motorista carrega em ✅ OK.
   * Usa o microfone que o Benjamin já tem aberto (não cria um 2.º reconhecedor).
   */
  ditarMorada(id) {
    const g = this._achar(id);
    if (!g) return;
    if (!this._editando.has(g.id)) { this._editando.add(g.id); }
    if (this._ditadoId !== null) {                     // 2.º toque no mesmo botão = cancelar o ditado
      const era = this._ditadoId;
      this._terminarDitado();
      if (String(era) === String(g.id)) return;
    }
    this._ditadoId = g.id;
    this.renderizar();

    const B = this.benjamin;
    B.falar('Diz a morada.');
    B.capturarProximaFrase((texto) => {
      const alvo = this._ditadoId;
      this._ditadoId = null;
      if (alvo === null || String(alvo) !== String(g.id)) return;   // cancelado entretanto
      if (!texto) { this.renderizar(); B.falar('Não ouvi nenhuma morada.'); return; }
      this._aplicarMorada(g.id, this._limpar(texto));
      this.renderizar();
      B.falar('Apanhei: ' + this._limpar(texto) + '. Toca em OK para guardar.');
    }, 20000);
  }

  _terminarDitado() {
    this._ditadoId = null;
    try { this.benjamin.cancelarCaptura(); } catch (e) { /* ok */ }
    this.renderizar();
  }

  /** Preenche o campo DESSA guia e dispara input/change (o rascunho acompanha; a gravação é no OK). */
  _aplicarMorada(id, texto) {
    this._rascunhos.set(this._achar(id) ? this._achar(id).id : id, texto);
    const campo = document.getElementById(`morada-${id}`);
    if (campo) {
      campo.value = texto;
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      campo.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  _limpar(t) {
    const s = String(t).trim().replace(/[.\s]+$/, '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
