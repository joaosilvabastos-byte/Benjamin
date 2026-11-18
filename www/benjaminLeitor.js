// benjaminLeitor.js — Lê guias de remessa (PDF ou foto) e descobre a MORADA DE DESCARGA.
//
//  • PDF com texto  -> pdf.js lê o texto e as posições (rápido, ~1 s, 100 % fiável)
//  • PDF digitalizado / foto -> OCR (Tesseract.js, português) feito no próprio telemóvel, sem rede
//  • extrairDados(): procura a morada de DESCARGA (não a do expedidor, nem a primeira linha do papel):
//        1) campo "Local de Descarga / Morada de Destino / Local de Entrega ..."
//        2) coluna "Destinatário" (a morada por baixo do nome e do NIF)
//        3) último código postal que não esteja na zona do expedidor / carga
//  • renderizarPdf(): desenha o PDF em <canvas> dentro da app (visualizador sem sair do Benjamin)
//
// As bibliotecas ficam na pasta libs/ (ao lado deste ficheiro) e só são carregadas quando fazem falta.

const LIBS = new URL('./libs/', import.meta.url).href;

// ---------------------------------------------------------------------------------------
// 1) PARSER (puro: não precisa de DOM nem de bibliotecas — testável em Node)
//    Tolerante a erros de OCR: etiquetas com letras trocadas, códigos postais mal lidos, linhas partidas.
// ---------------------------------------------------------------------------------------
const RE_CEP = /\b\d{4}-\d{3}\b/;

// palavras que denotam uma morada (usadas para validar e para o último recurso)
const RE_MORADA = /\b(?:rua|r\.|av\.?|avenida|estrada|e\.?n\.?\s?\d|travessa|largo|pra[cç]a|rotunda|zona\s+(?:industrial|empresarial)|parque|pol[ií]gono|lote|armaz[eé]m|cais|doca|quinta|urbaniza[cç][aã]o|bairro|edif[ií]cio|sector|setor|lugar|km\s?\d|n\.?\s?[ºo°]\s?\d)/i;
// cabeçalhos de zonas que NUNCA são o destino
const RE_ORIGEM = /\b(?:expedidor|remetente|emitente|fornecedor|origem|carga|vendedor|transportador|carregamento)\b/i;
// "quem recebe"
const RE_DESTINATARIO = /^(?:dados\s+d[oe]\s+)?(?:destinat[aá]rio|consignat[aá]rio|cliente|entregar\s+a|enviar\s+para)\b/i;
// o que marca o fim da morada
const RE_FIM = new RegExp(
  '^(?:contact[oa]|tel[.:\\s]|telefone|telem[oó]vel|telm|janela|hor[aá]rio|obs|observa|nif\\b|n\\.?\\s*contribuinte|' +
  'matr[ií]cula|local\\s+e\\s+hora|local\\s+de\\s+carga|identifica|expedidor|destinat|data\\b|assinatura|total|' +
  'ref\\b|ref\\.|\\d+\\.\\s+[A-ZÁÉÍÓÚ]|receç[aã]o|in[ií]cio|peso|volumes|unidades)', 'i');

const limpar = (s) => String(s || '').replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Minúsculas e sem acentos, SEM mudar o comprimento (os índices servem para cortar o texto original). */
const DE = 'áàâãäéèêëíìîïóòôõöúùûüçñ';
const PARA = 'aaaaaeeeeiiiiooooouuuucn';
export function fold(s) {
  let o = '';
  for (const ch of String(s)) {
    const l = ch.toLowerCase();
    const i = DE.indexOf(l);
    o += i >= 0 ? PARA[i] : l;
  }
  return o;
}

/** Arranja códigos postais mal lidos: "3O45 - 5O8" -> "3045-508"; "3045 508 Coimbra" -> "3045-508 Coimbra". */
export function corrigirCep(t) {
  const f = (x) => x.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  return String(t)
    .replace(/(?<![\w])([0-9OoIl|]{4})\s?[-–—_.]\s?([0-9OoIl|]{3})(?![\w])/g, (m, a, b) => {
      const A = f(a), B = f(b);
      return /^\d{4}$/.test(A) && /^\d{3}$/.test(B) ? `${A}-${B}` : m;
    })
    .replace(/(?<![\w-])(\d{4})\s(\d{3})(?=\s+[A-ZÀ-Ú][a-zà-ú])/g, '$1-$2');
}

/** Distância de edição (pequena) para comparar palavras com erros de OCR. */
function lev(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
const quase = (w, alvo) => {
  if (w === alvo) return true;
  const tol = alvo.length >= 8 ? 2 : alvo.length >= 5 ? 1 : 0;
  return tol > 0 && lev(w, alvo) <= tol;
};

// etiquetas, como sequências de palavras ("|" = alternativas). fraca = palavra solta (exige morada válida a seguir)
const ETIQUETAS = [
  { seq: ['local', 'de|da|do', 'descarga|entrega|destino|descarregamento'] },
  { seq: ['morada|endereco|morado', 'de|da|do', 'descarga|entrega|destino|descarregamento'] },
  { seq: ['ponto', 'de|da', 'descarga|entrega'] },
  { seq: ['descarregar', 'em'] },
  { seq: ['entregar', 'em'] },
  { seq: ['destino', 'final'] },
  { seq: ['local', 'descarga|entrega|destino'] },
  { seq: ['descarga|descarregamento'], fraca: true },
  { seq: ['entrega'], fraca: true },
  { seq: ['destino'], fraca: true },
  { seq: ['morada|endereco'], fraca: true },
];

/** Procura uma etiqueta no início do segmento; devolve { fim, fraca } (fim = índice onde acaba a etiqueta no texto original). */
export function acharEtiqueta(texto) {
  const f = fold(texto);
  const toks = [];
  const re = /[a-z0-9]+/g;
  let m;
  while ((m = re.exec(f)) && toks.length < 8) toks.push({ w: m[0], ini: m.index, fim: m.index + m[0].length });
  for (let i = 0; i <= Math.min(2, toks.length - 1); i++) {
    if (!toks.slice(0, i).every((t) => /^\d+$/.test(t.w) || t.w.length <= 2)) continue;   // antes da etiqueta só "2." ou palavras minúsculas ("1. a")
    for (const et of ETIQUETAS) {
      if (i + et.seq.length > toks.length) continue;
      let ok = true;
      for (let k = 0; k < et.seq.length && ok; k++) ok = et.seq[k].split('|').some((alvo) => quase(toks[i + k].w, alvo));
      if (ok) return { fim: toks[i + et.seq.length - 1].fim, fraca: !!et.fraca };
    }
  }
  return null;
}

const pareceMorada = (m) => RE_CEP.test(m) || RE_MORADA.test(m);

/**
 * Arruma o que o OCR estraga à volta do código postal, para o geocoding encontrar a morada:
 *   "Rua X 10 1495 038 Algés"  -> "Rua X 10, 1495-038 Algés"
 *   "Rua X 101495-038 Algés"   -> "Rua X 10, 1495-038 Algés"   (número colado ao código postal)
 *   "Rua X, 10 1495-038 Algés" -> "Rua X, 10, 1495-038 Algés"
 */
export function normalizarMorada(s) {
  let m = String(s || '');
  m = corrigirCep(m);
  // "1495 038" (espaço em vez de hífen), seguido de localidade ou do fim
  m = m.replace(/(?<![\d-])(\d{4})\s+(\d{3})(?!\d)(?=\s*[A-Za-zÀ-ÿ]|\s*$)/g, '$1-$2');
  // número da porta colado ao código postal: sobram dígitos antes dos 4 do código ("101495-038")
  m = m.replace(/(?<![\d-])(\d{1,4})(\d{4})-(\d{3})(?!\d)/g, '$1, $2-$3');
  // número da porta (e letra) logo antes do código postal: separa com vírgula
  m = m.replace(/(\d{1,4}[A-Za-z]?(?:\s*[-–]\s*\d{1,3}[A-Za-z]?)?)\s+(\d{4}-\d{3})(?!\d)/g, '$1, $2');
  m = m.replace(/,\s*,/g, ',').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ');
  return m.trim();
}

/** Tira vírgulas/traços das pontas e ", Portugal". */
function arranjarMorada(s) {
  let m = normalizarMorada(limpar(s))
    .replace(/[,;]\s*portugal\.?$/i, '')
    .replace(/^[\s,;:\-–—.]+|[\s,;:\-–—]+$/g, '');
  if (m.length > 170) m = m.slice(0, 170).replace(/\s\S*$/, '');
  return m;
}

/**
 * Converte itens de texto do pdf.js ({str, transform, width, height}) em SEGMENTOS:
 * pedaços de texto contíguos numa linha. Duas colunas lado a lado ficam em segmentos separados.
 */
export function segmentosDeItens(items, alturaPagina, deslocY = 0) {
  const its = [];
  for (const i of items || []) {
    if (!i || typeof i.str !== 'string' || !i.str.trim()) continue;
    const t = i.transform || [1, 0, 0, 1, 0, 0];
    its.push({ s: i.str, x: t[4], y: alturaPagina - t[5] + deslocY, h: Math.abs(t[3]) || i.height || 10, w: i.width || 0 });
  }
  its.sort((a, b) => a.y - b.y || a.x - b.x);
  const linhas = [];
  for (const it of its) {
    const l = linhas[linhas.length - 1];
    if (l && Math.abs(it.y - l.y) < Math.max(it.h, l.h) * 0.6) l.its.push(it);
    else linhas.push({ y: it.y, its: [it] });
  }
  const segs = [];
  for (const l of linhas) {
    l.its.sort((a, b) => a.x - b.x);
    let atual = null;
    for (const it of l.its) {
      if (atual && it.x - atual.x1 <= Math.max(it.h, atual.h) * 2) {
        const colar = it.x - atual.x1 < it.h * 0.12 || /\s$/.test(atual.t) || /^\s/.test(it.s);
        atual.t += (colar ? '' : ' ') + it.s;
        atual.x1 = Math.max(atual.x1, it.x + it.w);
      } else {
        if (atual) segs.push(atual);
        atual = { t: it.s, x0: it.x, x1: it.x + it.w, y: l.y, h: it.h };
      }
    }
    if (atual) segs.push(atual);
  }
  segs.forEach((s) => { s.t = limpar(s.t); });
  return segs.filter((s) => s.t);
}

/** Segmentos a partir das linhas do OCR ({text, bbox:{x0,y0,x1,y1}}). */
export function segmentosDeLinhasOcr(linhas) {
  const segs = [];
  for (const l of linhas || []) {
    const t = limpar(l.text);
    if (!t || !l.bbox) continue;
    segs.push({ t, x0: l.bbox.x0, x1: l.bbox.x1, y: l.bbox.y0, h: Math.max(8, l.bbox.y1 - l.bbox.y0) });
  }
  return segs.sort((a, b) => a.y - b.y || a.x0 - b.x0);
}

/** Segmentos a partir de texto simples (sem posições): cada linha é um segmento na mesma coluna. */
export function segmentosDeTexto(texto) {
  return String(texto || '').split(/\r?\n/).map((t, i) => ({ t: limpar(t), x0: 0, x1: 100, y: i * 12, h: 10 })).filter((s) => s.t);
}

const mesmaColuna = (a, b, tol) => Math.abs(a.x0 - b.x0) <= tol;

/** Linhas da morada que vêm DEPOIS do segmento i (mesma coluna; se não houver, as seguintes), até ao código postal ou a novo campo. */
function linhasDepois(segs, i, tol, max = 3) {
  const base = segs[i];
  const recolher = (soColuna) => {
    const out = [];
    let ultimoY = base.y;
    let h = base.h;
    for (let j = i + 1; j < segs.length && out.length < max; j++) {
      const s = segs[j];
      if (s.y <= base.y + 0.5 * h) continue;
      if (soColuna && !mesmaColuna(base, s, tol)) continue;
      if (s.y - ultimoY > Math.max(h, s.h) * 3.2) break;
      if (RE_FIM.test(s.t) || /^[\p{L}\s/.()ºª-]{2,40}:/u.test(s.t)) break;
      out.push(s.t);
      ultimoY = s.y;
      h = s.h;
      if (RE_CEP.test(s.t)) break;
    }
    return out;
  };
  const a = recolher(true);
  return a.length ? a : recolher(false);                     // o OCR nem sempre alinha as colunas: tenta sem exigir coluna
}

/** 1) etiqueta "Local de Descarga / Morada de Descarga / Descarga: / Entrega: / Destino: ..." */
function porEtiqueta(segs, tol) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const et = acharEtiqueta(s.t);
    if (!et) continue;
    let resto = s.t.slice(et.fim);
    for (let k = 0; k < 2; k++) {
      resto = resto.replace(/^\s*\([^)]*\)\s*/, '').replace(/^\s*[:\-–—.]\s*/, '');
      const e2 = acharEtiqueta(resto);
      if (e2 && !e2.fraca && e2.fim <= 24) resto = resto.slice(e2.fim);
    }
    const linhas = [];
    if (resto.trim().length >= 4) linhas.push(resto.trim());
    else {
      const dir = segs.find((o, j) => j !== i && Math.abs(o.y - s.y) < s.h * 0.6 && o.x0 >= s.x1 - 2);
      if (dir && !RE_FIM.test(dir.t)) linhas.push(dir.t);
    }
    if (!linhas.some((l) => RE_CEP.test(l))) linhas.push(...linhasDepois(segs, i, tol));
    else if (/\d{4}\s*-\s*\d{3}\s*$/.test(linhas[linhas.length - 1])) {
      // o código postal fechou a linha e a localidade passou para a linha de baixo ("... 1100-265" / "Lisboa")
      const base = segs[i];
      const seg = segs.find((o, j) => j > i && o.y > base.y + 0.5 * base.h && o.y - base.y < base.h * 3.2 &&
        /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]{2,30}$/.test(o.t.trim()) && o.t.trim().split(/\s+/).length <= 3 &&
        !acharEtiqueta(o.t) && !RE_FIM.test(o.t));
      const cid = seg && seg.t.trim().match(/^[A-ZÀ-Ý][A-Za-zÀ-ÿ'-]*(?:\s+(?:d[aeo]s?\s+)?[A-ZÀ-Ý][A-Za-zÀ-ÿ'-]*)*/);   // só as palavras com maiúscula (corta o ruído do OCR)
      if (cid) linhas[linhas.length - 1] += ' ' + cid[0];
    }
    const morada = arranjarMorada(linhas.join(', '));
    // validação: uma palavra solta ("Entrega: 14/11/2026") só vale se o que vem a seguir parecer uma morada
    if (morada.length >= 6 && (!et.fraca || pareceMorada(morada)) && pareceMorada(morada)) {
      return { morada, origem: 'etiqueta', confianca: 'alta' };
    }
  }
  return null;
}

/** 2) coluna "Destinatário": nome, NIF, depois a morada */
function porDestinatario(segs, tol) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.t.length > 45 || !RE_DESTINATARIO.test(s.t)) continue;
    const linhas = [];
    let nome = '';
    let ultimoY = s.y;
    for (let j = i + 1; j < segs.length && linhas.length < 4; j++) {
      const o = segs[j];
      if (o.y <= s.y + 0.5 * s.h || !mesmaColuna(s, o, tol * 1.6)) continue;
      if (o.y - ultimoY > Math.max(s.h, o.h) * 3.2) break;
      if (/^\d+\.\s+[A-ZÁÉÍÓÚ]/.test(o.t) || /^(?:local\s+e\s+hora|identifica)/i.test(o.t)) break;
      ultimoY = o.y;
      if (/^(?:nif|n\.?\s*contribuinte|contribuinte|tel|telefone|telem|e-?mail|contacto|vat)\b/i.test(o.t)) continue;
      if (!nome) { nome = o.t; if (RE_CEP.test(o.t)) { linhas.push(o.t); break; } continue; }
      linhas.push(o.t);
      if (RE_CEP.test(o.t)) break;
    }
    const morada = arranjarMorada(linhas.join(', '));
    if (morada.length >= 8 && pareceMorada(morada)) {
      return { morada, origem: 'destinatario', confianca: 'media', destinatario: limpar(nome) };
    }
  }
  return null;
}

/** Cabeçalho (texto sem dígitos) mais próximo, para cima, na mesma coluna. */
function cabecalhoDe(segs, i, tol) {
  for (let j = i - 1; j >= 0 && i - j < 12; j--) {
    if (mesmaColuna(segs[j], segs[i], tol * 2) && !/\d/.test(segs[j].t) && segs[j].t.length <= 70) return segs[j].t;
  }
  return '';
}

/** Bloco de morada à volta do segmento i (a linha + até 2 anteriores que pareçam rua) */
function blocoAte(segs, i, tol) {
  const linhas = [segs[i].t];
  if (!RE_MORADA.test(segs[i].t)) {
    for (let j = i - 1; j >= 0 && i - j <= 2; j--) {
      const o = segs[j];
      if (!mesmaColuna(o, segs[i], tol * 2) || segs[i].y - o.y > Math.max(o.h, segs[i].h) * 3.2) break;
      if (/^(?:nif|tel|contribuinte|data|contact)/i.test(o.t) || RE_FIM.test(o.t)) break;
      if (RE_MORADA.test(o.t) || /\d/.test(o.t)) linhas.unshift(o.t);
      else if (linhas.length === 1) linhas.unshift(o.t);          // nome da zona/empresa colado ao código postal
      if (RE_MORADA.test(o.t)) break;
    }
  }
  return arranjarMorada(linhas.join(', '));
}

/** 3) códigos postais: último fora das zonas do expedidor/carga; 4) à falta, o último de todos (confiança baixa) */
function porCodigoPostal(segs, tol) {
  const todos = [];
  const bons = [];
  segs.forEach((s, i) => {
    if (!RE_CEP.test(s.t)) return;
    todos.push(i);
    if (!RE_ORIGEM.test(cabecalhoDe(segs, i, tol))) bons.push(i);
  });
  if (bons.length) {
    const morada = blocoAte(segs, bons[bons.length - 1], tol);
    if (morada.length >= 8) return { morada, origem: 'codigo-postal', confianca: 'baixa' };
  }
  if (todos.length) {
    const morada = blocoAte(segs, todos[todos.length - 1], tol);
    if (morada.length >= 8) return { morada, origem: 'codigo-postal-origem', confianca: 'baixa' };
  }
  return null;
}

/** 5) sem código postal legível: a última linha com palavras de morada (rua, avenida, parque, armazém...) + a seguinte */
function porPalavrasChave(segs, tol) {
  const cand = [];
  segs.forEach((s, i) => {
    if (!RE_MORADA.test(s.t) || s.t.length < 8 || RE_FIM.test(s.t) || /^(?:matr[ií]cula|local e hora)/i.test(s.t)) return;
    if (/\b(?:kg|paletes?|caixas?|volumes?)\b/i.test(s.t)) return;
    if (!RE_ORIGEM.test(cabecalhoDe(segs, i, tol))) cand.push(i);
  });
  if (!cand.length) return null;
  const i = cand[cand.length - 1];
  const linhas = [segs[i].t];
  const prox = segs[i + 1];
  if (prox && mesmaColuna(prox, segs[i], tol * 2) && prox.y - segs[i].y <= Math.max(prox.h, segs[i].h) * 3.2 && !RE_FIM.test(prox.t)) linhas.push(prox.t);
  const morada = arranjarMorada(linhas.join(', '));
  return morada.length >= 8 ? { morada, origem: 'palavras-chave', confianca: 'baixa' } : null;
}

/** Número do documento ("GR 2026/00482") */
function numeroDocumento(segs) {
  const texto = segs.map((s) => s.t).join('\n');
  let m = texto.match(/n[.º°o]*\s*(?:de\s+)?documento\s*:?\s*([A-Z]{0,5}\s?\d[\w\s/.-]{2,18}?)(?=\s{2,}|\n|$|\s[A-Za-zÀ-ú]{4,})/i);
  if (m) return limpar(m[1]);
  m = texto.match(/\b([A-Z]{1,5}\s?\d{4}\s?\/\s?\d{1,9})\b/);
  return m ? limpar(m[1]) : '';
}

/**
 * Procura a morada de descarga. Devolve { morada, origem, confianca, docNumero, destinatario }
 * ({ morada: '' } só se o texto não tiver nada que se pareça com uma morada).
 */
export function extrairDados(segs, larguraPagina = 600) {
  const tol = Math.max(14, larguraPagina * 0.06);
  const lista = (segs || []).filter((s) => s && s.t).map((s) => ({ ...s, t: corrigirCep(s.t) }));
  const docNumero = numeroDocumento(lista);
  const r = porEtiqueta(lista, tol) || porDestinatario(lista, tol) || porCodigoPostal(lista, tol) || porPalavrasChave(lista, tol)
    || { morada: '', origem: '', confianca: '' };
  if (!r.destinatario) {
    for (let i = 0; i < lista.length; i++) {
      if (lista[i].t.length <= 45 && RE_DESTINATARIO.test(lista[i].t)) {
        const o = lista.slice(i + 1).find((x) => x.y > lista[i].y + 0.5 * lista[i].h && mesmaColuna(lista[i], x, tol * 1.6)
          && !/^(?:nif|n\.?\s*contribuinte|tel)/i.test(x.t));
        if (o && !RE_CEP.test(o.t)) r.destinatario = o.t;
        break;
      }
    }
  }
  return { ...r, docNumero, destinatario: r.destinatario || '' };
}

// ---------------------------------------------------------------------------------------
// 2) CARREGAMENTO PREGUIÇOSO DAS BIBLIOTECAS (só quando há uma guia para ler/ver)
// ---------------------------------------------------------------------------------------
const MAX_LADO_OCR = 1600;          // px do lado maior enviado ao OCR (a câmara dá 4000+; o OCR a 1600 é muito mais leve)
const T_INICIO_OCR = 45000;         // ms para o leitor arrancar (descarrega ~5 MB locais)
const T_RECONHECER = 70000;         // ms para ler uma imagem
const ORCAMENTO_RODAR = 40000;      // ms: só tenta rodar a imagem se ainda houver tempo

/** Promise com tempo-limite: rejeita em vez de ficar à espera para sempre. */
function comTimeout(p, ms, msg) {
  let t;
  const limite = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg || 'tempo esgotado')), ms); });
  return Promise.race([Promise.resolve(p), limite]).finally(() => clearTimeout(t));
}

const _scripts = new Map();
function carregarScript(url) {
  if (_scripts.has(url)) return _scripts.get(url);
  const p = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url;
    const falhou = (m) => { _scripts.delete(url); rej(new Error(m + ' ' + url)); };
    const t = setTimeout(() => falhou('timeout a carregar'), 20000);
    s.onload = () => { clearTimeout(t); res(); };
    s.onerror = () => { clearTimeout(t); falhou('não carregou'); };
    document.head.appendChild(s);
  });
  _scripts.set(url, p);
  return p;
}

export const Leitor = {
  _pdfjs: null,
  _tess: null,

  async pdfjs() {
    if (this._pdfjs) return this._pdfjs;
    if (!window.pdfjsLib) await carregarScript(LIBS + 'pdf.min.js');
    const lib = window.pdfjsLib;
    if (!lib) throw new Error('pdf.js indisponível');
    lib.GlobalWorkerOptions.workerSrc = LIBS + 'pdf.worker.min.js';
    this._pdfjs = lib;
    return lib;
  },

  /** Permite injetar o pdf.js (testes em Node). */
  usarPdfjs(lib) { this._pdfjs = lib; },

  /** data-URL / caminho / ArrayBuffer -> Uint8Array */
  async _bytes(fonte) {
    if (fonte instanceof Uint8Array) return fonte;
    if (fonte instanceof ArrayBuffer) return new Uint8Array(fonte);
    if (typeof fonte === 'string' && /^data:/i.test(fonte)) {
      const b64 = fonte.slice(fonte.indexOf(',') + 1);
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    }
    if (typeof fonte === 'string') {
      const src = (!/^(https?:|blob:)/.test(fonte) && window.Capacitor && window.Capacitor.convertFileSrc)
        ? window.Capacitor.convertFileSrc(fonte) : fonte;
      return new Uint8Array(await (await fetch(src)).arrayBuffer());
    }
    if (fonte && typeof fonte.arrayBuffer === 'function') return new Uint8Array(await fonte.arrayBuffer());
    throw new Error('fonte desconhecida');
  },

  async abrirPdf(fonte) {
    const lib = await this.pdfjs();
    const data = await this._bytes(fonte);
    return lib.getDocument({ data: data.slice(0), disableFontFace: false }).promise;
  },

  // ---- leitura de texto de PDF ----
  async lerPdf(fonte) {
    const doc = await this.abrirPdf(fonte);
    const segs = [];
    let largura = 600;
    let desl = 0;
    const n = Math.min(doc.numPages, 3);
    for (let p = 1; p <= n; p++) {
      const pg = await doc.getPage(p);
      const vp = pg.getViewport({ scale: 1 });
      if (p === 1) largura = vp.width;
      const tc = await pg.getTextContent();
      segs.push(...segmentosDeItens(tc.items, vp.height, desl));
      desl += vp.height + 50;
    }
    return { segs, largura, paginas: doc.numPages, doc };
  },

  // ---- OCR ----
  async tesseract() {
    if (this._tess) return this._tess;
    if (!window.Tesseract) await carregarScript(LIBS + 'tesseract.min.js');
    if (!window.Tesseract) throw new Error('Tesseract indisponível');
    this._tess = window.Tesseract;
    return this._tess;
  },

  /**
   * Descodifica a imagem UMA vez e devolve um canvas com o lado maior = maxLado (nunca a resolução da câmara:
   * 12 MP descodificados + copiados rebentam a memória / o tempo num telemóvel de gama baixa).
   * Aceita File/Blob, data-URL, caminho ou um canvas já pronto. Respeita a orientação EXIF.
   */
  async imagemParaCanvas(fonte, maxLado = MAX_LADO_OCR) {
    let origem;
    let w;
    let h;
    let fechar = null;
    if (typeof HTMLCanvasElement !== 'undefined' && fonte instanceof HTMLCanvasElement) {
      origem = fonte; w = fonte.width; h = fonte.height;
    } else {
      let bmp = null;
      if (typeof createImageBitmap === 'function' && fonte && typeof fonte !== 'string') {
        try { bmp = await createImageBitmap(fonte); } catch (e) { bmp = null; }
      }
      if (bmp) { origem = bmp; w = bmp.width; h = bmp.height; fechar = () => bmp.close && bmp.close(); }
      else {
        let src = fonte;
        let revogar = null;
        if (typeof fonte !== 'string') { src = URL.createObjectURL(fonte); revogar = src; }
        else if (!/^(data:|https?:|blob:)/.test(fonte) && window.Capacitor && window.Capacitor.convertFileSrc) src = window.Capacitor.convertFileSrc(fonte);
        try {
          const img = await comTimeout(new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = () => rej(new Error('imagem inválida'));
            i.src = src;
          }), 25000, 'a imagem demorou a abrir');
          origem = img; w = img.naturalWidth; h = img.naturalHeight;
        } finally { if (revogar) URL.revokeObjectURL(revogar); }
      }
    }
    try {
      const esc = Math.min(1.6, maxLado / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * esc));
      c.height = Math.max(1, Math.round(h * esc));
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(origem, 0, 0, c.width, c.height);
      console.log(`Benjamin OCR: imagem ${w}x${h} -> ${c.width}x${c.height}`);
      return c;
    } finally { if (fechar) fechar(); }
  },

  /** Cópia em tons de cinza com mais contraste (o que o OCR prefere). O canvas original fica a cores. */
  _tonsDeCinza(canvas) {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const ctx = c.getContext('2d');
    try { ctx.filter = 'grayscale(1) contrast(1.35)'; } catch (e) { /* sem filtro */ }
    ctx.drawImage(canvas, 0, 0);
    return c;
  },

  _rodar(canvas, graus) {
    const c = document.createElement('canvas');
    const q = graus === 90 || graus === 270;
    c.width = q ? canvas.height : canvas.width;
    c.height = q ? canvas.width : canvas.height;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((graus * Math.PI) / 180);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return c;
  },

  // ---- leitor OCR (worker do Tesseract): criado uma vez, reutilizado, libertado ao fim de um minuto ----
  _w: null,
  _wTimer: null,
  _aoEstado: null,
  _aoProg: null,

  async _worker() {
    clearTimeout(this._wTimer);
    if (this._w) return this._w;
    const t0 = Date.now();
    const p = (async () => {
      const T = await this.tesseract();
      return T.createWorker('por', 1, {
        workerPath: LIBS + 'worker.min.js',
        corePath: LIBS,
        langPath: LIBS,
        gzip: true,
        workerBlobURL: false,
        cacheMethod: 'none',
        logger: (m) => {
          if (!m) return;
          if (m.status === 'recognizing text') { if (this._aoProg) this._aoProg(m.progress); }
          else if (this._aoEstado && /load|initiali/i.test(m.status || '')) this._aoEstado('A preparar o leitor…');
        },
      });
    })();
    this._w = comTimeout(p, T_INICIO_OCR, 'o leitor de texto não arrancou');
    try {
      const w = await this._w;
      console.log(`Benjamin OCR: leitor pronto em ${Date.now() - t0} ms`);
      return w;
    } catch (e) {
      this._w = null;
      p.then((w) => w && w.terminate && w.terminate()).catch(() => {});
      throw e;
    }
  },

  /** Chamar quando se abre a câmara / o seletor de ficheiros: o leitor arranca enquanto o motorista tira a foto. */
  aquecer() { this._worker().then(() => this._libertar(90000)).catch((e) => console.warn('Benjamin OCR: aquecer falhou:', e && e.message)); },

  _libertar(ms = 60000) {
    clearTimeout(this._wTimer);
    this._wTimer = setTimeout(() => this._matar(), ms);
  },

  /** Termina o leitor (também usado quando fica preso, para nunca o reutilizar). */
  _matar() {
    clearTimeout(this._wTimer);
    const p = this._w;
    this._w = null;
    if (p) Promise.resolve(p).then((w) => w && w.terminate && w.terminate()).catch(() => {});
  },

  /** Cancela a leitura em curso (botão ✖ do cartão). */
  cancelar() { this._matar(); },

  /** OCR de um canvas -> { segs, largura, texto, conf }. Falha (nunca fica à espera) ao fim de `ms`. */
  async ocrCanvas(canvas, { aoProgresso, aoEstado, ms = T_RECONHECER } = {}) {
    this._aoProg = aoProgresso || null;
    this._aoEstado = aoEstado || null;
    const t0 = Date.now();
    try {
      const worker = await this._worker();
      if (aoEstado) aoEstado('A ler a guia…');
      const r = await comTimeout(worker.recognize(canvas, {}, { text: true, blocks: true, hocr: false, tsv: false }), ms, 'a leitura demorou demasiado');
      const d = r.data || {};
      let linhas = d.lines;
      if ((!linhas || !linhas.length) && d.blocks) {
        linhas = [];
        d.blocks.forEach((b) => (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => linhas.push(l))));
      }
      const segs = (linhas && linhas.length) ? segmentosDeLinhasOcr(linhas) : segmentosDeTexto(d.text);
      console.log(`Benjamin OCR: ${Date.now() - t0} ms, ${segs.length} linhas, confiança ${Math.round(d.confidence || 0)}`);
      return { segs, largura: canvas.width, texto: d.text || '', conf: d.confidence || 0 };
    } catch (e) {
      this._matar();                                       // leitor preso ou avariado: não reutilizar
      throw e;
    } finally {
      this._aoProg = null;
      this._aoEstado = null;
      this._libertar(60000);
    }
  },

  /**
   * Ponto de entrada: lê uma guia (PDF ou imagem; File, data-URL, caminho ou canvas) e devolve
   * { morada, origem, confianca, docNumero, destinatario, metodo }.
   * Foto tirada "deitada": se não encontra morada, volta a tentar com a imagem rodada (até ao orçamento de tempo).
   */
  async lerGuia(fonte, mime = '', { aoProgresso, aoEstado } = {}) {
    const t0 = Date.now();
    const m = String(mime || (typeof fonte === 'string' ? (fonte.match(/^data:([^;,]+)/i) || [])[1] : fonte && fonte.type) || '');
    const ehPdf = /pdf/i.test(m) || (typeof fonte === 'string' && /\.pdf($|\?)/i.test(fonte));

    if (ehPdf) {
      if (aoEstado) aoEstado('A abrir o PDF…');
      const r = await this.lerPdf(fonte);
      const dados = extrairDados(r.segs, r.largura);
      if (r.segs.length >= 5) return { ...dados, metodo: 'texto-pdf' };
      // PDF digitalizado (sem texto): desenha a 1.ª página e faz OCR
      const pg = await r.doc.getPage(1);
      const base = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: MAX_LADO_OCR / Math.max(base.width, base.height) });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const o = await this.ocrCanvas(c, { aoProgresso, aoEstado });
      return { ...extrairDados(o.segs, o.largura), metodo: 'ocr-pdf' };
    }

    if (aoEstado) aoEstado('A preparar a imagem…');
    let canvas = this._tonsDeCinza(await this.imagemParaCanvas(fonte));
    const tentativas = canvas.width > canvas.height ? [0, 90, 270] : [0];      // "deitada": a página está rodada dentro da foto
    let melhor = null;
    for (let i = 0; i < tentativas.length; i++) {
      if (i > 0 && Date.now() - t0 > ORCAMENTO_RODAR) break;
      const c = tentativas[i] ? this._rodar(canvas, tentativas[i]) : canvas;
      const o = await this.ocrCanvas(c, { aoProgresso, aoEstado });
      const dados = { ...extrairDados(o.segs, o.largura), metodo: 'ocr-imagem', texto: o.texto, conf: o.conf, rotacao: tentativas[i] };
      if (!melhor || (dados.morada && !melhor.morada) || (!!dados.morada === !!melhor.morada && dados.conf > melhor.conf)) melhor = dados;
      if (dados.morada) break;
    }
    canvas = null;
    return melhor;
  },

  // ---------------------------------------------------------------------------------------
  // 3) VISUALIZAÇÃO DE PDF DENTRO DA APP
  // ---------------------------------------------------------------------------------------
  /**
   * Desenha todas as páginas (até 12) em canvases dentro de `cont`.
   * zoom 1 = largura do contentor; maior que 1 = mais largo (o contentor tem scroll).
   * Devolve { paginas }.  `token()` devolve false se entretanto o visualizador mudou/fechou.
   */
  async renderizarPdf(fonte, cont, { zoom = 1, token = () => true } = {}) {
    const doc = await this.abrirPdf(fonte);
    const n = Math.min(doc.numPages, 12);
    const larguraCss = Math.max(200, (cont.clientWidth || 360) - 8) * zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    cont.replaceChildren();
    for (let p = 1; p <= n; p++) {
      if (!token()) return { paginas: n };
      const pg = await doc.getPage(p);
      const base = pg.getViewport({ scale: 1 });
      const escalaCss = larguraCss / base.width;
      let escala = escalaCss * dpr;
      const maxPx = 3200;                                    // não rebentar a memória do telemóvel
      if (base.width * escala > maxPx) escala = maxPx / base.width;
      const vp = pg.getViewport({ scale: escala });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      c.style.width = Math.round(larguraCss) + 'px';
      c.style.height = Math.round(larguraCss * base.height / base.width) + 'px';
      c.style.display = 'block';
      c.style.margin = '0 auto 10px';
      c.style.background = '#fff';
      c.dataset.pagina = String(p);
      cont.appendChild(c);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    }
    return { paginas: n };
  },
};
