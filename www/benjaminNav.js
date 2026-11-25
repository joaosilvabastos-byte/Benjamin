// benjaminNav.js — Mapa limpo de rota (silencioso) do Benjamin
//
//  Fluxo:  GPS do telemóvel + morada de descarga da 1.ª guia → coordenadas (Nominatim/OSM) → rota (OSRM, ou OpenRouteService
//          camião se houver chave) → mapa Leaflet/OpenStreetMap centrado no veículo, linha da rota, distância e hora de chegada.
//  • SEM turn-by-turn: o mapa só mostra o melhor percurso. Em silêncio por definição (localStorage "benjamin_nav_voz" = "1" liga
//    os avisos opcionais: recalcular e chegada). O aviso inicial da rota é sempre dito (uma vez completo por turno, depois curto).
//  • Trânsito: o Benjamin pergunta à rede com a posição e o destino desta rota (ver contextoRota()).
//  • Pontos úteis (combustível / áreas de descanso): Overpass (e Nominatim de reserva), marcados no próprio mapa.
//  • Leaflet carrega-se do ./libs/leaflet/ (offline, sem CDN). Sem ele, o painel mostra só distância e hora.
//
// A parte matemática/parsing está em funções exportadas (testáveis em Node); a classe Navegacao trata de GPS, rede e UI.

import { normalizarMorada } from './benjaminLeitor.js';

const KEY_VOZ = 'benjamin_nav_voz';
const KEY_ORS = 'benjamin_ors_key';
const KEY_GEO = 'benjamin_geo_v1';
const KEY_TT = 'benjamin_tomtom_key';          // chave gratuita do TomTom (trânsito)
const KEY_TRAF = 'benjamin_trafego_mapa';      // camada de trânsito no mapa ligada ("1") ou não
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
// Mosaicos: OpenStreetMap (gratuito, sem chave nem plano). O aspeto escuro vem de um filtro CSS (ver index.html, .estilo-osm).
const URL_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

// =========================================================================================
// 1) GEOMETRIA
// =========================================================================================
/** Distância em metros entre dois pontos [lat, lon]. */
export function dist(a, b) {
  const dLa = rad(b[0] - a[0]);
  const dLo = rad(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function projSeg(p, a, b) {
  const k = Math.cos(rad(a[0]));
  const bx = (b[1] - a[1]) * k, by = b[0] - a[0];
  const px = (p[1] - a[1]) * k, py = p[0] - a[0];
  const L2 = bx * bx + by * by;
  let t = L2 ? (px * bx + py * by) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { t, d: Math.hypot(px - t * bx, py - t * by) * rad(1) * R };
}

/** Projeta a posição na rota. desde = índice do segmento onde se estava (janela de procura); se ficar longe, procura em tudo. */
export function snapRota(rota, pos, desde = 0) {
  const { pts, cum } = rota;
  const n = pts.length - 1;
  const procurar = (i0, i1) => {
    let melhor = null;
    for (let i = Math.max(0, i0); i <= Math.min(n - 1, i1); i++) {
      const r = projSeg(pos, pts[i], pts[i + 1]);
      if (!melhor || r.d < melhor.d) melhor = { i, t: r.t, d: r.d };
    }
    return melhor;
  };
  let m = procurar(desde - 3, desde + 150);
  if (!m || m.d > 80) { const t = procurar(0, n - 1); if (t && (!m || t.d < m.d)) m = t; }
  m.s = cum[m.i] + m.t * (cum[m.i + 1] - cum[m.i]);
  return m;
}

// =========================================================================================
// 2) ROTAS: normalização OSRM / OpenRouteService → { pts, dur, total }   (só a linha: sem manobras)
// =========================================================================================
export function normalizarOsrm(j) {
  const r = j && j.routes && j.routes[0];
  if (!r) throw new Error('sem rota');
  return { pts: r.geometry.coordinates.map(([lo, la]) => [la, lo]), dur: r.duration, total: r.distance };
}

export function normalizarOrs(j) {
  const f = j && j.features && j.features[0];
  if (!f) throw new Error('sem rota');
  return { pts: f.geometry.coordinates.map(([lo, la]) => [la, lo]), dur: f.properties.summary.duration, total: f.properties.summary.distance };
}

/** Distâncias acumuladas ao longo da linha. */
export function finalizarRota(r) {
  const cum = [0];
  for (let i = 1; i < r.pts.length; i++) cum.push(cum[i - 1] + dist(r.pts[i - 1], r.pts[i]));
  r.cum = cum;
  r.total = cum[cum.length - 1] || r.total || 0;
  return r;
}

/** O que falta, à distância s (metros) já percorrida: distância e tempo (proporcional ao previsto pela rota). */
export function progresso(rota, s) {
  const f = rota.total > 0 ? Math.min(1, Math.max(0, s / rota.total)) : 0;
  return { restM: Math.max(0, rota.total - s), restS: Math.max(0, rota.dur * (1 - f)) };
}

/** Pontos [lat,lon] da rota à frente de s, espaçados `passo` metros, até `ate` metros (para consultar pontos úteis ao longo do caminho). */
export function amostrarAdiante(rota, s, ate = 60000, passo = 4000, max = 16) {
  const out = [];
  let prox = s;
  let ultimo = -1;
  for (let i = 0; i < rota.pts.length; i++) {
    if (rota.cum[i] < s) continue;
    if (rota.cum[i] > s + ate) break;
    ultimo = i;
    if (rota.cum[i] >= prox && out.length < max - 1) { out.push(rota.pts[i]); prox = rota.cum[i] + passo; }
  }
  if (ultimo >= 0 && out[out.length - 1] !== rota.pts[ultimo]) out.push(rota.pts[ultimo]);   // o fim do troço consultado conta sempre
  return out;
}

// =========================================================================================
// 3) TEXTOS
// =========================================================================================
export function fmtDist(m) {
  if (m < 30) return 'Agora';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}
export function fmtTempo(s) {
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
export function fmtHora(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** Distância para ser dita em voz ("2,3 quilómetros", "300 metros"). */
export function falaDist(m) {
  if (m >= 950) { const km = Math.round(m / 100) / 10; return km === 1 ? 'um quilómetro' : `${String(km).replace('.', ',')} quilómetros`; }
  return `${Math.max(50, Math.round(m / 50) * 50)} metros`;
}

/** "Largo da Graça 45, 1100-265 Lisboa" → "Largo da Graça 45, Lisboa" (sem o código postal, que soa mal em voz). */
export function destinoFalado(morada) {
  const partes = String(morada || '').split(',').map((x) => x.replace(/\b\d{4}\s*-\s*\d{3}\b/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return partes.slice(0, 3).join(', ') || 'o destino';
}

export const LEGENDA_MAPA = 'O mapa apenas indica o melhor percurso · Se precisares, pergunta-me pelo trânsito ou pelo combustível';

/** Seta do veículo (estilo TomTom): azul com contorno branco e sombra escura, nítida sobre a rota e o mapa. */
const SETA_SVG = '<svg width="36" height="36" viewBox="0 0 36 36" style="display:block;overflow:visible"><path d="M18 2 L31 32 L18 25 L5 32 Z" fill="#1D5BFF" stroke="#FFFFFF" stroke-width="3" stroke-linejoin="round"/><path d="M18 2 L31 32 L18 25 L5 32 Z" fill="none" stroke="#0B1B4D" stroke-width="1" stroke-linejoin="round" opacity=".6"/></svg>';

/** Aviso inicial da rota: completo na 1.ª vez do turno, curto nas seguintes. */
export function fraseAviso(morada, completo) {
  const d = destinoFalado(morada);
  return completo
    ? `Rota traçada para ${d}. Lembra-te: este mapa mostra apenas o melhor percurso. Se quiseres saber como está o trânsito ou onde há combustível, basta perguntares-me.`
    : `Rota traçada para ${d}.`;
}

// =========================================================================================
// 4) GEOCODIFICAÇÃO: morada → coordenadas
// =========================================================================================
/** Variantes da morada, da mais completa para a mais vaga (as guias trazem "Cais 3 — Armazém B4", que o OSM não conhece). */
export function candidatosGeocode(morada) {
  const limpa = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s*,\s*,/g, ',').replace(/^[\s,]+|[\s,]+$/g, '');
  const m = limpa(normalizarMorada(morada));
  const out = [];
  const add = (x) => { x = limpa(x); if (x.length >= 4 && !out.includes(x)) out.push(x); };
  add(m);
  const semDoca = m
    .replace(/\b(?:cais|doca|porta|gate)\s*\d+\s*[—–-]\s*/gi, '')
    .replace(/,?\s*\b(?:armaz[eé]m|pavilh[aã]o|loja|fra[cç][aã]o|piso)\s+[\w.-]+/gi, '')
    .replace(/\s+[—–]\s+/g, ', ');
  add(semDoca);
  const cp = semDoca.match(/(\d{4}-\d{3})\s+([^,]+)/);
  if (cp) {
    const antes = limpa(semDoca.slice(0, cp.index).replace(/,\s*$/, ''));
    const partes = antes.split(',').map((x) => x.trim());
    const rua = partes[0];
    if (partes[1] && /^\d{1,4}[A-Za-z]?$/.test(partes[1])) add(`${rua} ${partes[1]}, ${cp[2]}`);   // rua + nº da porta + localidade
    add(`${rua}, ${cp[2]}`);                 // rua + localidade (sem o código postal)
    add(`${cp[1]} ${cp[2]}`);                // só código postal + localidade (aproximado)
  }
  return out;
}

// =========================================================================================
// 5) PONTOS ÚTEIS (Overpass; Nominatim de reserva)
// =========================================================================================
export const TIPOS_PONTO = {
  transito: { icone: '⚠️', plural: 'ocorrências', singular: 'ocorrência', filtros: [] },
  combustivel: { icone: '⛽', plural: 'postos de combustível', singular: 'posto de combustível', nominatim: 'posto de combustível',
    filtros: ['["amenity"="fuel"]'] },
  descanso: { icone: '🅿️', plural: 'áreas de descanso', singular: 'área de descanso', nominatim: 'área de serviço',
    filtros: ['["highway"="rest_area"]', '["highway"="services"]', '["amenity"="parking"]["hgv"="designated"]'] },
};

/** Consulta Overpass: o que há perto de `pos` (raio `raio` m) e, se houver rota, ao longo da linha à frente (1,5 km de cada lado). */
export function construirConsultaOverpass(tipo, pos, linha, raio) {
  const t = TIPOS_PONTO[tipo];
  if (!t) throw new Error('tipo desconhecido: ' + tipo);
  const f = (area) => t.filtros.map((x) => `nwr${x}${area};`).join('');      // nó, via ou relação numa só cláusula
  let corpo = f(`(around:${raio},${pos[0].toFixed(5)},${pos[1].toFixed(5)})`);
  if (linha && linha.length >= 2) {
    const passo = Math.max(1, Math.ceil(linha.length / 12));                // consulta leve: no máximo ~12 pontos da rota
    const pts = linha.filter((_, i) => i % passo === 0);
    corpo += f(`(around:1500,${pts.map((p) => p[0].toFixed(4) + ',' + p[1].toFixed(4)).join(',')})`);
  }
  return `[out:json][timeout:10];(${corpo});out center 40;`;
}

/** Resposta do Overpass → itens ordenados por distância a `pos`. */
export function lerOverpass(j, pos, tipo, max = 6) {
  const vistos = new Set();
  const itens = [];
  for (const e of (j && j.elements) || []) {
    const lat = e.lat ?? (e.center && e.center.lat);
    const lon = e.lon ?? (e.center && e.center.lon);
    if (lat === undefined || lon === undefined) continue;
    const tg = e.tags || {};
    const nome = tg.name || tg.brand || tg.operator || (tipo === 'combustivel' ? 'Posto sem nome' : 'Área sem nome');
    const chave = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    itens.push({ nome, lat, lon, dist: dist(pos, [lat, lon]), tipo });
  }
  return itens.sort((a, b) => a.dist - b.dist).slice(0, max);
}

/** Frase falada com o resultado da procura. */
export function fraseResultado(itens, tipo) {
  const t = TIPOS_PONTO[tipo];
  if (!itens.length) return `Não encontrei ${t.plural} aqui perto. Tenta outra vez mais à frente.`;
  const p = itens[0];
  const n = itens.length;
  return `${n === 1 ? `Encontrei um ${t.singular}` : `Encontrei ${n} ${t.plural}`}. O mais próximo é ${p.nome}, a ${falaDist(p.dist)}. Marquei no mapa.`;
}

// =========================================================================================
// 5b) TRÂNSITO (TomTom, plano gratuito sem cartão): mosaicos de fluxo no mapa + incidentes ao longo da rota
// =========================================================================================
export const URL_FLUXO = (chave) => `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(chave)}`;

/** Caixa [minLon,minLat,maxLon,maxLat] à volta da rota à frente de s; encolhe o troço até caber nos 10 000 km² que a API aceita. */
export function bboxAdiante(rota, s, maxKm = 150, maxArea = 9000) {
  for (let km = maxKm; km >= 10; km = Math.floor(km / 2)) {
    const pts = rota.pts.filter((_, i) => rota.cum[i] >= s - 500 && rota.cum[i] <= s + km * 1000);
    if (pts.length < 2) continue;
    const la = pts.map((p) => p[0]), lo = pts.map((p) => p[1]);
    const m = 0.02;                                                     // ~2 km de folga
    const b = [Math.min(...lo) - m, Math.min(...la) - m, Math.max(...lo) + m, Math.max(...la) + m];
    const area = ((b[2] - b[0]) * 111.32 * Math.cos(rad((b[1] + b[3]) / 2))) * ((b[3] - b[1]) * 110.57);
    if (area <= maxArea) return { bbox: b, km };
  }
  return null;
}

export function urlIncidentes(bbox, chave) {
  const fields = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,iconCategory},from,to,length,delay,roadNumbers}}}';
  return `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${encodeURIComponent(chave)}&bbox=${bbox.map((x) => x.toFixed(4)).join(',')}` +
    `&fields=${encodeURIComponent(fields)}&language=pt-PT&timeValidityFilter=present`;
}

const CAT_INCIDENTE = { 1: 'um acidente', 2: 'nevoeiro', 3: 'condições perigosas', 4: 'chuva forte', 5: 'gelo', 6: 'trânsito lento', 7: 'uma faixa cortada',
  8: 'a estrada cortada', 9: 'obras', 10: 'vento forte', 11: 'inundação', 14: 'um veículo avariado' };

/** Incidentes da resposta que estão na rota (a ≤ margem m da linha) e à frente do veículo, por ordem de aparição. */
export function lerIncidentes(j, rota, s, margem = 1500) {
  const out = [];
  for (const f of (j && j.incidents) || []) {
    const pr = f.properties || {};
    const g = f.geometry || {};
    const cs = g.type === 'Point' ? [g.coordinates] : (g.coordinates || []);
    if (!cs.length || pr.iconCategory === 0) continue;
    let melhor = null;
    for (const c of [cs[0], cs[Math.floor(cs.length / 2)]]) {
      const sn = snapRota(rota, [c[1], c[0]], 0);
      if (!melhor || sn.d < melhor.sn.d) melhor = { sn, c };
    }
    if (melhor.sn.d > margem) continue;
    const ahead = melhor.sn.s - s;
    if (ahead < -300) continue;                                         // já ficou para trás
    const ev = (pr.events && pr.events[0]) || {};
    out.push({
      cat: pr.iconCategory, mag: pr.magnitudeOfDelay || 0, atrasoS: pr.delay || 0, ahead: Math.max(0, ahead),
      estrada: (pr.roadNumbers && pr.roadNumbers[0]) || '', de: pr.from || '', para: pr.to || '', desc: ev.description || '',
      lat: melhor.c[1], lon: melhor.c[0], comprimento: pr.length || 0,
    });
  }
  return out.sort((a, b) => a.ahead - b.ahead);
}

/** Frase falada do estado do trânsito na rota. */
export function fraseTransito(itens, restM, restS) {
  const prev = restM ? ` O percurso previsto é de ${falaDist(restM)}, cerca de ${Math.max(1, Math.round(restS / 60))} minutos, sem contar com os atrasos.` : '';
  if (!itens.length) return `Não há ocorrências registadas na tua rota.${prev} No mapa, o que estiver a laranja ou vermelho é trânsito lento.`;
  const um = (i) => {
    const nome = CAT_INCIDENTE[i.cat] || 'uma ocorrência';
    const onde = i.estrada ? ` na ${i.estrada}` : (i.de ? ` em ${i.de}` : '');
    const atraso = i.atrasoS >= 60 ? `, com cerca de ${Math.round(i.atrasoS / 60)} minutos de atraso` : '';
    return `${nome}${onde}, a ${falaDist(i.ahead)}${atraso}`;
  };
  const n = itens.length;
  const lista = itens.slice(0, 3).map(um);
  const total = itens.reduce((a, i) => a + (i.cat === 8 ? 0 : i.atrasoS), 0);
  const fechadas = itens.filter((i) => i.cat === 8).length;
  let f = `${n === 1 ? 'Há uma ocorrência no teu caminho' : `Há ${n} ocorrências no teu caminho`}: ${lista.join('; ')}.`;
  if (fechadas) f += ' Atenção: há estrada cortada.';
  if (total >= 120) f += ` Conta com cerca de ${Math.round(total / 60)} minutos de atraso no total.`;
  return f.charAt(0).toUpperCase() + f.slice(1);
}

// =========================================================================================
// 6) NAVEGAÇÃO (GPS + rede + mapa)
// =========================================================================================
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let avisoCompletoDado = false;               // por turno: 1.ª rota com aviso completo, as seguintes curtas

export class Navegacao {
  constructor(benjamin) {
    this.B = benjamin;
    this.estado = 'sem-guia';   // sem-guia | sem-morada | gps | gps-negado | localizar | rota | navegar | chegou | erro
    this.msg = '';
    this.pos = null;
    this.destino = null;        // { id, morada, coord:[lat,lon], aprox, nome }
    this.rota = null;
    this.p = null;
    this.vozLigada = this._lerVoz();
    this._tok = 0;
    this._chave = null;
    this._idxSeg = 0;
    this._fora = 0;
    this._ultimoCalculo = 0;
    this._ultimoAviso = 0;
    this._watch = null;
    this._timerSync = null;
    this._timerRetry = null;
    this._seguir = true;
    this.pontos = [];
    this.fetch = (...a) => window.fetch(...a);
  }

  // ---------- arranque ----------
  iniciar() {
    this._atualizarBotaoVoz();
    this._aplicarTrafego();
    window.addEventListener('benjamin:guias', () => {
      clearTimeout(this._timerSync);
      this._timerSync = setTimeout(() => this.sincronizar(), 500);
    });
    window.addEventListener('online', () => { if (this.estado === 'erro') this.sincronizar(true); });
    window.getNavegacao = () => this.resumo();
    window.navegacaoVoz = (on) => this.definirVoz(on);
    window.navegacaoPontos = (tipo) => this.procurarPontos(tipo);
    window.navegacaoLimparPontos = () => this.limparPontos();
    window.navegacaoTransito = () => this.consultarTransito();
    window.navegacaoTrafego = (on) => this.definirTrafego(on);
    this._ligarGps();
    this._jaMostrou = !!this._guiaAtiva();      // no arranque quem abre a vista é o index.html (DOMContentLoaded)
    this.sincronizar();
    return this;
  }

  /** Há uma 1.ª guia: o index.html abre logo na vista GPS. */
  temDestino() { return !!this._guiaAtiva(); }

  /** Novo turno de trabalho: a próxima rota volta a ter o aviso completo. */
  novoTurno() { avisoCompletoDado = false; }

  /** O condutor carregou no botão GPS: repete o aviso (completo na 1.ª vez do turno, curto depois). */
  aoAbrirGps() {
    setTimeout(() => this._mapaRedimensionar(), 50);
    if (!this.destino) return;
    if (this.rota) this._avisoRota();
    else this._pendenteAviso = true;           // a rota ainda está a ser calculada: avisa quando estiver pronta
  }

  /** Na 1.ª vez que aparece um destino (ex.: guia partilhada com a app aberta), mostra o painel. */
  _mostrarPainelUmaVez() {
    if (this._jaMostrou) return;
    this._jaMostrou = true;
    try { if (typeof window.mostrarVista === 'function') window.mostrarVista('gps'); } catch (e) { /* ok */ }
  }

  _guiaAtiva() { return ((typeof window.getGuias === 'function' ? window.getGuias() : []) || [])[0] || null; }

  /** Compara a 1.ª guia com o destino atual; se mudou, recomeça. */
  sincronizar(forcar = false) {
    const g = this._guiaAtiva();
    const chave = g ? `${g.id}|${g.morada || ''}` : '';
    if (chave === this._chave && !forcar) { this._desenhar(); return; }
    this._chave = chave;
    this._tok++;
    this.rota = null;
    this.p = null;
    this.destino = null;
    this._anunciouRota = false;
    this._pendenteAviso = false;
    this._limparRotaNoMapa();
    this.limparPontos();
    clearTimeout(this._timerRetry);
    if (!g) { this.estado = 'sem-guia'; this._desenhar(); return; }
    if (!g.morada) { this.estado = 'sem-morada'; this.msg = g.nome || g.ref || ''; this._desenhar(); return; }
    this.destino = { id: g.id, morada: g.morada, auto: !!g.moradaAuto };
    this._mostrarPainelUmaVez();
    this.estado = 'localizar';
    this._desenhar();
    this._localizar(this._tok);
  }

  // ---------- GPS ----------
  _ligarGps() {
    if (this._watch !== null || !navigator.geolocation) {
      if (!navigator.geolocation) { this.estado = this.estado === 'sem-guia' ? this.estado : 'gps-negado'; }
      return;
    }
    this._watch = navigator.geolocation.watchPosition(
      (p) => this._aoPosicao(p),
      (e) => {
        if (e && e.code === 1) { this.estado = 'gps-negado'; this._desenhar(); }
        else console.warn('Benjamin NAV: GPS erro', e && e.message);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
  }

  _aoPosicao(p) {
    const c = p.coords;
    this.pos = { lat: c.latitude, lon: c.longitude, prec: c.accuracy || 0, vel: c.speed, heading: c.heading };
    this._posEm = Date.now();
    if (window.BenjaminSeguranca) window.BenjaminSeguranca.posicao(this.pos);   // velocidade/posição para o ROTT e o SOS nativos
    if (this.estado === 'gps-negado') this.estado = this.destino ? 'localizar' : 'sem-guia';
    if (this.destino && this.destino.coord && !this.rota && (this.estado === 'gps' || this.estado === 'localizar')) {
      this._calcular(this._tok);
      return;
    }
    if (this.rota) this._atualizar();
    else this._desenhar();
  }

  // ---------- geocodificação ----------
  _lerCache() { try { return JSON.parse(localStorage.getItem(KEY_GEO) || '{}') || {}; } catch (e) { return {}; } }
  _gravarCache(c) {
    const chaves = Object.keys(c);
    if (chaves.length > 60) chaves.slice(0, chaves.length - 60).forEach((k) => delete c[k]);
    try { localStorage.setItem(KEY_GEO, JSON.stringify(c)); } catch (e) { /* ok */ }
  }

  async _localizar(tok) {
    const d = this.destino;
    const cache = this._lerCache();
    if (cache[d.morada]) {
      Object.assign(d, cache[d.morada]);
    } else {
      const cands = candidatosGeocode(d.morada);
      for (let i = 0; i < cands.length && tok === this._tok; i++) {
        if (i) await dormir(1100);                                   // política do Nominatim: máx. 1 pedido/s
        try {
          const j = await this._json(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=pt&q=${encodeURIComponent(cands[i])}`, {}, 9000);
          if (j && j[0]) {
            d.coord = [parseFloat(j[0].lat), parseFloat(j[0].lon)];
            d.nome = j[0].display_name || cands[i];
            d.aprox = i >= 2;
            cache[d.morada] = { coord: d.coord, nome: d.nome, aprox: d.aprox };
            this._gravarCache(cache);
            break;
          }
        } catch (e) {
          console.warn('Benjamin NAV: geocodificação falhou:', e && e.message);
          if (i === 0 && !/HTTP 4/.test(String(e && e.message))) { this._falhar(tok, 'Sem ligação para localizar a morada.', true); return; }
        }
      }
    }
    if (tok !== this._tok) return;
    if (!d.coord) { this._falhar(tok, 'Não encontrei esta morada no mapa. Volta às opções e edita o endereço (rua e localidade).', false); return; }
    this._marcarDestino();
    if (!this.pos) { this.estado = 'gps'; this._desenhar(); return; }
    this._calcular(tok);
  }

  // ---------- rota ----------
  async _json(url, opcoes, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await this.fetch(url, { ...opcoes, signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  _chaveOrs() { try { return (localStorage.getItem(KEY_ORS) || '').trim(); } catch (e) { return ''; } }

  async _calcular(tok) {
    if (!this.pos || !this.destino || !this.destino.coord) return;
    this.estado = 'rota';
    this._ultimoCalculo = Date.now();
    this._desenhar();
    const a = [this.pos.lat, this.pos.lon];
    const b = this.destino.coord;
    const key = this._chaveOrs();
    let bruta;
    try {
      if (key) {
        const j = await this._json('https://api.openrouteservice.org/v2/directions/driving-hgv/geojson', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: key },
          body: JSON.stringify({ coordinates: [[a[1], a[0]], [b[1], b[0]]], language: 'pt', instructions: false }),
        }, 15000);
        bruta = normalizarOrs(j);
        this.perfil = 'camião';
      } else {
        const j = await this._json(`https://router.project-osrm.org/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson&steps=false`, {}, 15000);
        bruta = normalizarOsrm(j);
        this.perfil = 'carro';
      }
    } catch (e) {
      console.warn('Benjamin NAV: rota falhou:', e && e.message);
      this._falhar(tok, 'Não consegui calcular a rota. A tentar de novo…', true);
      return;
    }
    if (tok !== this._tok) return;
    this.rota = finalizarRota(bruta);
    this._idxSeg = 0;
    this._fora = 0;
    this.estado = 'navegar';
    this._desenharRotaNoMapa(true);
    if (!this._anunciouRota || this._pendenteAviso) this._avisoRota();
    this._atualizar();
  }

  _falhar(tok, msg, repetir) {
    if (tok !== this._tok) return;
    this.estado = 'erro';
    this.msg = msg;
    this._desenhar();
    if (repetir) {
      clearTimeout(this._timerRetry);
      this._timerRetry = setTimeout(() => { if (tok === this._tok) this.sincronizar(true); }, 30000);
    }
  }

  // ---------- acompanhamento ----------
  _atualizar() {
    const r = this.rota;
    if (!r || !this.pos) return;
    const pos = [this.pos.lat, this.pos.lon];
    const snap = snapRota(r, pos, this._idxSeg);
    this._idxSeg = snap.i;
    const limite = Math.max(60, (this.pos.prec || 0) * 1.5);
    this._noCaminho = snap.d <= limite;
    if (snap.d > limite) {
      this._fora++;
      if (this._fora >= 3 && Date.now() - this._ultimoCalculo > 15000) {
        this._fora = 0;
        this._falar('A recalcular a rota.');
        this._calcular(this._tok);
        return;
      }
    } else this._fora = 0;

    const p = progresso(r, snap.s);
    this.p = p;
    if (p.restM < 30) {
      if (this.estado !== 'chegou') { this.estado = 'chegou'; this._falar('Chegou ao destino.'); }
    } else this.estado = 'navegar';
    this._atualizarMapa(snap);
    this._desenhar();
  }

  // ---------- aviso inicial / voz ----------
  /** Aviso falado da rota (sempre dito, mesmo com a voz do mapa OFF: é o aviso do Benjamin, não uma indicação do mapa). */
  _avisoRota() {
    if (!this.destino) return;
    const agora = Date.now();
    if (agora - this._ultimoAviso < 15000) return;                     // não repetir se carregarem várias vezes seguidas
    this._ultimoAviso = agora;
    this._anunciouRota = true;
    this._pendenteAviso = false;
    // (aviso falado "Rota traçada para..." removido: o Benjamin só fala da viagem quando o condutor carrega em Iniciar)
  }

  _lerVoz() { try { return localStorage.getItem(KEY_VOZ) === '1'; } catch (e) { return false; } }
  definirVoz(on) {
    this.vozLigada = !!on;
    try { localStorage.setItem(KEY_VOZ, on ? '1' : '0'); } catch (e) { /* ok */ }
    this._atualizarBotaoVoz();
    if (on) this._falar('Voz do mapa ligada.', true);
    return this.vozLigada;
  }
  alternarVoz() { return this.definirVoz(!this.vozLigada); }
  /** Nunca interrompe o Benjamin: entra na fila da fala dele. */
  _falar(t, forcar) {
    if (!this.vozLigada && !forcar) return;                              // OFF por defeito: em silêncio
    try { if (this.B && !this.B.modoEmEspera) this.B.falar(t); } catch (e) { /* ok */ }
  }
  _atualizarBotaoVoz() {
    const b = document.getElementById('nav-voz-btn');
    if (!b) return;
    b.textContent = this.vozLigada ? '🔊 Voz ON' : '🔇 Voz OFF';
    b.classList.toggle('ligada', this.vozLigada);
  }

  // ---------- trânsito ----------
  _chaveTt() { try { return (localStorage.getItem(KEY_TT) || '').trim(); } catch (e) { return ''; } }
  temTrafego() { return !!this._chaveTt(); }
  _trafegoLigado() { try { return localStorage.getItem(KEY_TRAF) === '1'; } catch (e) { return false; } }

  /** Liga/desliga a camada de trânsito do mapa (botão 🚦 ou voz). Devolve a frase para o Benjamin dizer. */
  async definirTrafego(on) {
    if (!this._chaveTt()) return 'Para ver o trânsito no mapa preciso da chave gratuita do TomTom. Põe-na nas Opções, em chave de trânsito.';
    try { localStorage.setItem(KEY_TRAF, on ? '1' : '0'); } catch (e) { /* ok */ }
    await this._garantirMapa();
    this._aplicarTrafego();
    return on ? 'Trânsito ligado no mapa. Laranja e vermelho é trânsito lento.' : 'Trânsito retirado do mapa.';
  }
  alternarTrafego() { return this.definirTrafego(!this._trafegoLigado()); }

  _aplicarTrafego() {
    const b = document.getElementById('nav-trafego-btn');
    if (b) { b.style.display = this._chaveTt() ? 'block' : 'none'; b.style.borderColor = this._trafegoLigado() ? '#38bdf8' : '#1E40AF'; b.style.opacity = this._trafegoLigado() ? '1' : '.7'; }
    if (!this._mapa) return;
    const L = this._L;
    const quer = this._trafegoLigado() && !!this._chaveTt();
    if (!this._mapa.getPane('trafego')) { const p = this._mapa.createPane('trafego'); p.style.zIndex = 250; p.style.pointerEvents = 'none'; }   // por cima dos mosaicos (e fora do filtro escuro), por baixo da rota
    if (quer && !this._camadaTrafego) {
      this._camadaTrafego = L.tileLayer(URL_FLUXO(this._chaveTt()), { pane: 'trafego', maxZoom: 19, opacity: 0.85, updateWhenIdle: true, keepBuffer: 1, attribution: '© TomTom' }).addTo(this._mapa);
    } else if (!quer && this._camadaTrafego) {
      this._mapa.removeLayer(this._camadaTrafego);
      this._camadaTrafego = null;
    }
  }

  /**
   * "Como está o trânsito?" com dados reais (TomTom). Liga o trânsito no mapa, procura incidentes ao longo da rota e devolve a frase.
   * Devolve null se não há chave (o Benjamin recorre então ao Gemini).
   */
  async consultarTransito() {
    const chave = this._chaveTt();
    if (!chave) return null;
    if (!this.rota || !this.p || !this.pos) return 'Ainda não tenho uma rota ativa. Preciso do GPS e da morada da primeira guia.';
    try { localStorage.setItem(KEY_TRAF, '1'); } catch (e) { /* ok */ }
    this._garantirMapa().then(() => this._aplicarTrafego());
    const s = this.rota.total - this.p.restM;
    const area = bboxAdiante(this.rota, s);
    if (!area) return 'Não consegui preparar a consulta do trânsito para esta rota.';
    let j;
    try { j = await this._json(urlIncidentes(area.bbox, chave), {}, 15000); } catch (e) {
      console.warn('Benjamin NAV: TomTom falhou:', e && e.message);
      return /HTTP 40[13]/.test(String(e && e.message)) ? 'A chave do TomTom não foi aceite. Confirma-a nas Opções.' : 'Não consegui consultar o trânsito agora, mas o mapa continua a funcionar.';
    }
    const itens = lerIncidentes(j, this.rota, s);
    if (itens.length) this._mostrarPontos(itens.map((i) => ({ nome: `${CAT_INCIDENTE[i.cat] || 'Ocorrência'}${i.estrada ? ' · ' + i.estrada : ''}`.replace(/^./, (c) => c.toUpperCase()), lat: i.lat, lon: i.lon, dist: i.ahead, tipo: 'transito' })), 'transito');
    else this.limparPontos();
    const extra = area.km < 150 ? ` Só consultei os próximos ${area.km} quilómetros.` : '';
    return fraseTransito(itens, this.p.restM, this.p.restS) + (itens.length ? '' : '') + extra;
  }

  // ---------- pontos úteis ----------
  /** "Preciso de abastecer" / "área de descanso": procura, marca no mapa e devolve a frase para o Benjamin dizer. */
  async procurarPontos(tipo) {
    const t = TIPOS_PONTO[tipo];
    if (!t) return 'Não percebi o que queres procurar.';
    if (!this.pos || Date.now() - (this._posEm || 0) > 180000) await this._posicaoAgora();   // sem posição recente: pede uma leitura única
    if (!this.pos) return 'Ainda não tenho o sinal de GPS. Assim que o tiver, procuro.';
    const pos = [this.pos.lat, this.pos.lon];
    const linha = this.rota && this.p ? amostrarAdiante(this.rota, this.rota.total - this.p.restM) : null;
    let itens = [];
    let falhouRede = false;
    const t0 = Date.now();
    for (const raio of [8000, 25000]) {                                 // 2.ª volta só se a 1.ª trouxer pouco e ainda houver tempo
      try { itens = await this._overpass(tipo, pos, linha, raio); falhouRede = false; } catch (e) { falhouRede = true; console.warn('Benjamin NAV: Overpass falhou:', e && e.message); break; }
      if (itens.length >= 2 || Date.now() - t0 > 9000) break;
    }
    if (falhouRede || !itens.length) {                                   // reserva: pesquisa do Nominatim em volta
      try { itens = await this._nominatimPontos(tipo, pos, Math.max(4000, 14000 - (Date.now() - t0))); falhouRede = false; } catch (e) { console.warn('Benjamin NAV: Nominatim falhou:', e && e.message); }
    }
    console.log(`Benjamin NAV: pontos '${tipo}' em ${pos[0].toFixed(4)},${pos[1].toFixed(4)}: ${itens.length} resultados, falhouRede=${falhouRede}`);
    if (falhouRede) return 'Não consegui consultar a rede agora, mas o mapa continua a funcionar. Tenta daqui a pouco.';
    this._mostrarPontos(itens, tipo);
    return fraseResultado(itens, tipo);
  }

  /** Leitura única do GPS (até 8 s) para quando a posição contínua ainda não chegou ou está velha. */
  _posicaoAgora() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(); return; }
      let feito = false;
      const fim = () => { if (!feito) { feito = true; resolve(); } };
      setTimeout(fim, 8500);
      try {
        navigator.geolocation.getCurrentPosition((p) => { if (!feito) this._aoPosicao(p); fim(); }, fim, { enableHighAccuracy: true, maximumAge: 30000, timeout: 8000 });
      } catch (e) { fim(); }
    });
  }

  async _overpass(tipo, pos, linha, raio) {
    const q = construirConsultaOverpass(tipo, pos, linha, raio);
    // Os servidores são consultados EM PARALELO: ganha o primeiro que responder (máx. 9 s), em vez de esperar um a um
    // Um servidor sobrecarregado responde RÁPIDO com HTTP 200 e "elements" vazio + "remark" (erro/timeout): isso NÃO é "zero postos".
    // Só conta como resposta válida a que traz resultados; respostas vazias/erro deixam ganhar os outros servidores.
    const pedir = (url) => this._json(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) }, 12000)
      .then((j) => {
        const n = j && Array.isArray(j.elements) ? j.elements.length : -1;
        const host = url.split('/')[2];
        if (n < 0) { console.log(`Benjamin NAV: Overpass ${host}: resposta sem "elements"`, j && j.remark); throw new Error(`${host}: resposta inválida`); }
        if (n === 0) { console.log(`Benjamin NAV: Overpass ${host}: 0 elementos`, (j && j.remark) || ''); const e = new Error(`${host}: vazio ${(j && j.remark) || ''}`); e.vazio = !(j && j.remark); throw e; }
        console.log(`Benjamin NAV: Overpass ${host}: ${n} elementos`);
        return lerOverpass(j, pos, tipo);
      });
    try {
      return await Promise.any(OVERPASS.map(pedir));
    } catch (e) {
      const erros = (e && e.errors) || [e];
      erros.forEach((x) => console.log('Benjamin NAV: Overpass falhou:', x && x.message));
      if (erros.every((x) => x && x.vazio)) return [];          // todos disseram, sem erro, que não há nada: zero real
      throw erros.find((x) => x && !x.vazio) || new Error('Overpass indisponível');
    }
  }

  async _nominatimPontos(tipo, pos, ms = 8000) {
    const d = 0.2;                                                         // ~22 km de cada lado
    const vb = `${pos[1] - d},${pos[0] + d},${pos[1] + d},${pos[0] - d}`;  // Nominatim: esquerda,topo,direita,fundo = lon,lat,lon,lat
    const termos = tipo === 'combustivel' ? [TIPOS_PONTO[tipo].nominatim, 'gas station', 'fuel'] : [TIPOS_PONTO[tipo].nominatim];
    let ultimoErro = null;
    for (const termo of termos) {
      try {
        const j = await this._json(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=15&bounded=1&accept-language=pt&viewbox=${vb}&q=${encodeURIComponent(termo)}`, {}, ms);
        const elementos = (Array.isArray(j) ? j : []).map((x) => ({ lat: parseFloat(x.lat), lon: parseFloat(x.lon), tags: { name: x.name || (x.display_name || '').split(',')[0] } })).filter((x) => !isNaN(x.lat) && !isNaN(x.lon));
        console.log(`Benjamin NAV: Nominatim "${termo}": ${elementos.length} resultados`);
        if (elementos.length) return lerOverpass({ elements: elementos }, pos, tipo);
      } catch (e) { ultimoErro = e; console.log(`Benjamin NAV: Nominatim "${termo}" falhou:`, e && e.message); }
    }
    if (ultimoErro) throw ultimoErro;
    return [];
  }

  limparPontos() {
    this.pontos = [];
    if (this._camadaPontos) { try { this._camadaPontos.clearLayers(); } catch (e) { /* ok */ } }
    const el = document.getElementById('nav-pontos');
    if (el) { el.innerHTML = ''; el.style.display = 'none'; }
  }

  // ---------- mapa (Leaflet) ----------
  async _carregarLeaflet() {
    if (window.L && window.L.map) return window.L;
    if (this._pLeaflet) return this._pLeaflet;
    const base = new URL('./libs/leaflet/', import.meta.url).href;
    this._pLeaflet = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = base + 'leaflet.css';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = base + 'leaflet.js';
      const t = setTimeout(() => reject(new Error('Leaflet: tempo esgotado')), 15000);
      s.onload = () => { clearTimeout(t); window.L ? resolve(window.L) : reject(new Error('Leaflet: sem L')); };
      s.onerror = () => { clearTimeout(t); reject(new Error('Leaflet: não carregou (libs/leaflet/ em falta?)')); };
      document.head.appendChild(s);
    });
    this._pLeaflet.catch((e) => { console.warn('Benjamin NAV:', e.message); this._pLeaflet = null; });
    return this._pLeaflet;
  }

  /** Cria o mapa quando o contentor existe (ele só tem tamanho com a vista GPS aberta). */
  async _garantirMapa() {
    if (this._mapa) return this._mapa;
    const el = document.getElementById('mapa-gps');
    if (!el) return null;
    let L;
    try { L = await this._carregarLeaflet(); } catch (e) { this._semMapa = true; return null; }
    if (this._mapa) return this._mapa;
    const m = L.map(el, { zoomControl: false, attributionControl: true, zoomSnap: 0.5, preferCanvas: true, tap: true });
    m.attributionControl.setPrefix(false);
    el.classList.add('estilo-osm');
    L.tileLayer(URL_TILES, { maxZoom: 19, attribution: '© OpenStreetMap', updateWhenIdle: true, keepBuffer: 1 }).addTo(m);
    const centro = this.pos ? [this.pos.lat, this.pos.lon] : (this.destino && this.destino.coord) || [39.6, -8.0];
    m.setView(centro, this.pos ? 14 : 7);
    this._camadaRota = L.layerGroup().addTo(m);
    this._camadaPontos = L.layerGroup().addTo(m);
    m.on('dragstart', () => this._pausarSeguir());                     // o condutor mexeu no mapa: deixa de seguir durante 25 s
    m.on('popupopen', () => this._pausarSeguir());                     // com um balão aberto o mapa volta a Norte (texto legível)
    this._mapa = m;
    this._L = L;
    this._aplicarTrafego();
    this._desenharRotaNoMapa(true);
    this._marcarDestino();
    if (this.pos) this._atualizarMapa();
    if (this.pontos.length) this._mostrarPontos(this.pontos, this.pontos[0].tipo);
    return m;
  }

  _mapaRedimensionar() {
    if (!this._mapa) { this._garantirMapa(); return; }
    try { if (this._rotOn) this._dimsRotacao(true); this._mapa.invalidateSize(); if (this._seguir) this._centrar(); } catch (e) { /* ok */ }
  }

  // ---------- mapa com a frente para cima (heading-up) ----------
  /** Rumo suavizado: só muda com o veículo em andamento (>= ~7 km/h); parado, mantém o último (sem rotações bruscas). */
  _rumoSuave() {
    const p = this.pos;
    if (p) {
      let h = null;
      const andar = typeof p.vel === 'number' && !isNaN(p.vel) ? p.vel >= 2 : null;      // null = o GPS não dá velocidade
      // O rumo do GPS só vale com velocidade conhecida >= 2 m/s (parado, muitos telemóveis dão 0 ou lixo). Sem velocidade usa-se o deslocamento.
      if ((andar === true || (typeof p.vel === 'number' && p.vel >= 1)) && typeof p.heading === 'number' && !isNaN(p.heading)) h = p.heading;
      // Sem rumo do GPS: calcula-o pelo deslocamento real (>= 15 m). Parado ou com ruído de GPS (< 15 m) não roda.
      const r = this._refRumo;
      if (!r) this._refRumo = { lat: p.lat, lon: p.lon };
      else {
        const rad = Math.PI / 180, dy = (p.lat - r.lat) * 111320, dx = (p.lon - r.lon) * 111320 * Math.cos(p.lat * rad);
        if (Math.hypot(dx, dy) >= 15) {
          if (h === null) h = (Math.atan2(dx, dy) / rad + 360) % 360;      // >= 15 m deslocados é movimento real, mesmo a pé ou devagar
          this._refRumo = { lat: p.lat, lon: p.lon };
        }
      }
      // Em cima da rota, o mapa acompanha o sentido da ESTRADA (como o TomTom): estável, sem tremer, e roda mesmo a andar devagar.
      if (this._noCaminho && this.rota) { const br = this._rumoRota(); if (br !== null) h = br; }
      if (h !== null) {
        if (this._hdgS == null) this._hdgS = h;
        else { const d = ((h - this._hdgS + 540) % 360) - 180; this._hdgS = (this._hdgS + d * 0.3 + 360) % 360; }
      }
    }
    if (this._simul !== null && this._simul !== undefined) { this._hdgS = this._simul; return this._hdgS; }   // teste manual (simularRumo)
    // Orientação inicial: ainda sem rumo do GPS, usa o sentido da própria rota (assim o percurso aponta para cima desde o início)
    if (this._hdgS == null) { const br = this._rumoRota(); if (br !== null) this._hdgS = br; }
    return this._hdgS == null ? null : this._hdgS;
  }

  /** Sentido da rota à frente (~60 m) a partir do segmento atual, em graus (0 = Norte). null sem rota. */
  _rumoRota() {
    const r = this.rota;
    if (!r || !r.pts || r.pts.length < 2) return null;
    const i = Math.max(0, Math.min(this._idxSeg || 0, r.pts.length - 2));
    let j = i + 1;
    while (j < r.pts.length - 1 && r.cum[j] - r.cum[i] < 60) j++;
    const a = r.pts[i], b = r.pts[j];
    const dy = (b[0] - a[0]) * 111320, dx = (b[1] - a[1]) * 111320 * Math.cos(rad(a[0]));
    if (Math.hypot(dx, dy) < 5) return null;
    return (Math.atan2(dx, dy) / rad(1) + 360) % 360;
  }

  /**
   * Centro do mapa que põe o veículo em ~80% da altura visível (muita estrada à frente, para cima).
   * O contentor do mapa está rodado (-ângulo), por isso "para cima no ecrã" = vetor (sin a, -cos a) nas coordenadas do mapa.
   * Calcula-se por project/unproject (um único setView/panTo), em vez de setView + panBy.
   */
  _centroComOffset(ll, zoom) {
    try {
      const m = this._mapa, L = this._L;
      const P = m.getContainer().parentElement;
      const H = P ? P.clientHeight : 0;
      if (!H || H < 100) return ll;
      const D = Math.min(H * 0.30, Math.max(0, H / 2 - 48));              // 0,30 da altura (=> 80%), sem encostar à borda de baixo
      const a = (((this._rotOn ? this._rotAcum : 0) || 0) * Math.PI) / 180;
      const z = zoom === undefined ? m.getZoom() : zoom;
      const pt = m.project(ll, z);
      return m.unproject(L.point(pt.x + D * Math.sin(a), pt.y - D * Math.cos(a)), z);
    } catch (e) { return ll; }
  }

  /** Escreve estilos com !important no contentor: nenhum CSS (index.html, Leaflet, WebView) pode anular a rotação. */
  _estilo(el, props) {
    for (const k of Object.keys(props)) el.style.setProperty(k, props[k], 'important');
  }

  /** O contentor do mapa passa a ser um quadrado maior (a diagonal) para não aparecerem cantos vazios ao rodar. */
  _dimsRotacao(ligar) {
    const el = this._mapa.getContainer();
    const P = el.parentElement;
    if (!P) return;
    P.style.overflow = 'hidden';
    if (ligar) {
      const w = P.clientWidth, h = P.clientHeight, d = Math.ceil(Math.hypot(w, h)) + 8;
      this._estilo(el, { right: 'auto', bottom: 'auto', width: d + 'px', height: d + 'px', left: ((w - d) / 2) + 'px', top: ((h - d) / 2) + 'px', 'transform-origin': '50% 50%' });
    } else {
      for (const k of ['width', 'height', 'transform', '-webkit-transform', 'transition']) el.style.removeProperty(k);
      this._estilo(el, { right: '0', bottom: '0', left: '0', top: '0' });
    }
  }

  /** graus = rumo (frente para cima) ou null (Norte para cima, como antes). */
  _aplicarRotacao(graus) {
    if (!this._mapa) { this._rotMotivo = 'sem mapa'; return; }
    const el = this._mapa.getContainer();
    const pai = el && el.parentElement;
    if (pai && (pai.clientWidth < 50 || pai.clientHeight < 50)) { this._rotMotivo = `pai pequeno ${pai.clientWidth}x${pai.clientHeight}`; return; }   // vista GPS escondida
    this._rotMotivo = '';
    if (pai) {
      pai.style.overflow = 'hidden';
      if (!pai.style.backgroundColor) pai.style.backgroundColor = '#160f24';
    }

    const quer = graus !== null && graus !== undefined && !Number.isNaN(Number(graus));
    const anguloAlvo = quer ? ((Number(graus) % 360) + 360) % 360 : null;
    const rodar = (deg, trans) => {
      this._estilo(el, { transition: trans, transform: `rotate(${deg}deg)`, '-webkit-transform': `rotate(${deg}deg)` });
    };

    if (quer !== !!this._rotOn) {
      this._rotOn = quer;
      this._dimsRotacao(quer);
      try { this._mapa.invalidateSize({ animate: false }); } catch (e) { /* ok */ }
      if (quer) {
        this._rotAcum = anguloAlvo;
        rodar(-this._rotAcum, 'none');
        void el.offsetWidth;
        this._estilo(el, { transition: 'transform .6s ease-out' });
      } else {
        this._rotAcum = 0;
        rodar(0, 'none');
      }
      return;
    }

    if (!quer) return;
    const d = ((anguloAlvo - this._rotAcum + 540) % 360) - 180;
    if (Math.abs(d) < 2) return; // ignora oscilações pequenas
    this._rotAcum += d; // ângulo acumulado: nunca dá a volta ao contrário
    rodar(-this._rotAcum, 'transform .6s ease-out');
  }

  /** Para de seguir (e de rodar o mapa) durante 25 s: arrastar o mapa ou abrir um balão tem de ser com o Norte para cima. */
  _pausarSeguir() {
    this._seguir = false;
    clearTimeout(this._timerSeguir);
    this._timerSeguir = setTimeout(() => { this._seguir = true; this._centrar(); }, 25000);
    this._aplicarRotacao(null);
    this._orientarSeta(null);
  }

  /** Mapa a rodar: a seta contra-roda o mesmo ângulo do mapa e fica SEMPRE para cima. Norte para cima: aponta ao rumo. */
  _orientarSeta(head) {
    if (!this._mVeiculo) return;
    const elV = this._mVeiculo.getElement();
    const inner = elV && elV.querySelector('.nav-veiculo');
    if (!inner) return;
    const ang = this._rotOn ? this._rotAcum : (head !== null && head !== undefined ? head : (this._hdgS || 0));
    inner.style.transform = `rotate(${ang}deg)`;
  }

  _centrar() {
    if (!this._mapa || !this.pos) return;
    try {
      this._aplicarRotacao(this._seguir ? this._rumoSuave() : null);
      const ll = [this.pos.lat, this.pos.lon];
      this._mapa.setView(this._seguir ? this._centroComOffset(ll, 17.0) : ll, 17.0, { animate: false });
      this._orientarSeta(null);
    } catch (e) { this._erroRot = String((e && e.message) || e); console.warn('Benjamin NAV: centrar', e && e.message); }       // nunca pode travar o resto (rota, painel, GPS)
  }
  /** Estado da rotação, para ver na consola: benjaminNav.diagnosticoRotacao() */
  diagnosticoRotacao() {
    const m = this._mapa;
    const el = m && m.getContainer();
    const pai = el && el.parentElement;
    const cs = el && getComputedStyle(el);
    return {
      mapaExiste: !!m, vista: typeof vistaAtual !== 'undefined' ? vistaAtual : '(n/d)',
      seguir: this._seguir, rotOn: !!this._rotOn, rotAcum: this._rotAcum, hdgS: this._hdgS, simul: this._simul,
      motivoSemRotar: this._rotMotivo || '', erro: this._erroRot || '',
      inlineTransform: el ? el.style.transform : null, computedTransform: cs ? cs.transform : null,
      contentor: el ? `${el.clientWidth}x${el.clientHeight}` : null, pai: pai ? `${pai.clientWidth}x${pai.clientHeight}` : null,
      posicao: !!this.pos, rota: !!this.rota, estado: this.estado,
    };
  }

  /** Teste sem andar: benjaminNav.simularRumo(90) roda o mapa para esse rumo (0-359) durante ~15 s. simularRumo(null) cancela. */
  async simularRumo(graus) {
    clearTimeout(this._timerSimul);
    if (graus === null || graus === undefined) { this._simul = null; return; }
    this._simul = ((Number(graus) % 360) + 360) % 360;
    this._hdgS = this._simul;
    this._timerSimul = setTimeout(() => { this._simul = null; }, 15000);
    this._seguir = true;
    this._erroRot = '';
    try {
      if (!this._mapa) await this._garantirMapa();
      if (!this.pos) { this._erroRot = 'sem posição GPS (this.pos vazio)'; }
      else this._centrar();
    } catch (e) { this._erroRot = String((e && e.message) || e); }
    await dormir(800);
    const d = this.diagnosticoRotacao();
    console.log('Benjamin NAV: simularRumo', JSON.stringify(d));
    return d;
  }

  /** Botão 📍 */
  centrarNaPosicao() { this._seguir = true; clearTimeout(this._timerSeguir); this._centrar(); }
  /** Botão 🗺️ */
  verRotaToda() {
    if (!this._mapa) return;
    this._pausarSeguir();
    const pts = [];
    if (this.pos) pts.push([this.pos.lat, this.pos.lon]);
    if (this.destino && this.destino.coord) pts.push(this.destino.coord);
    if (this.rota) pts.push(...this.rota.pts.filter((_, i) => i % 20 === 0));
    if (pts.length > 1) this._mapa.fitBounds(pts, { padding: [24, 24], animate: false });
  }

  _limparRotaNoMapa() {
    if (this._camadaRota) { try { this._camadaRota.clearLayers(); } catch (e) { /* ok */ } }
    this._linha = this._halo = this._mDestino = null;
  }

  _marcarDestino() {
    if (!this._mapa || !this.destino || !this.destino.coord) return;
    const L = this._L;
    if (this._mDestino) this._camadaRota.removeLayer(this._mDestino);
    this._mDestino = L.marker(this.destino.coord, {
      icon: L.divIcon({ className: '', html: '<div class="nav-pino-destino">🏁</div>', iconSize: [30, 30], iconAnchor: [15, 26] }),
      keyboard: false,
    }).addTo(this._camadaRota);
  }

  _desenharRotaNoMapa(ajustar) {
    if (!this._mapa || !this.rota) return;
    const L = this._L;
    this._camadaRota.clearLayers();
    this._mDestino = null;
    this._halo = L.polyline(this.rota.pts, { color: '#04210f', weight: 27, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(this._camadaRota);
    this._linha = L.polyline(this.rota.pts, { color: '#39FF14', weight: 15, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(this._camadaRota);
    this._marcarDestino();
    if (ajustar) {
      if (this.pos) {
        this._seguir = true;
        this._centrar();
      } else {
        this.verRotaToda();
      }
    }
  }

  _atualizarMapa(snap) {
    if (!this._mapa || !this.pos) return;
    const L = this._L;
    const ll = [this.pos.lat, this.pos.lon];
    const rumo = this._rumoSuave();
    const head = rumo !== null ? rumo : ((typeof this.pos.heading === 'number' && !isNaN(this.pos.heading)) ? this.pos.heading : 0);
    if (!this._mVeiculo) {
      const htmlVeiculo = `<div class="nav-veiculo" style="transform: rotate(${head}deg);">${SETA_SVG}</div>`;
      this._mVeiculo = L.marker(ll, {
        icon: L.divIcon({ className: '', html: htmlVeiculo, iconSize: [36, 36], iconAnchor: [18, 18] }),
        interactive: false, keyboard: false, zIndexOffset: 1000,
      }).addTo(this._mapa);
    } else {
      this._mVeiculo.setLatLng(ll);
    }
    if (snap && this._linha && Date.now() - (this._ultimoTraco || 0) > 3000) {     // só desenha o que falta
      this._ultimoTraco = Date.now();
      const resto = [ll, ...this.rota.pts.slice(snap.i + 1)];
      this._linha.setLatLngs(resto);
      this._halo.setLatLngs(resto);
    }
    this._aplicarRotacao(this._seguir ? rumo : null);
    this._orientarSeta(head);
    if (this._seguir) {
      this._mapa.panTo(this._centroComOffset(ll), { animate: true, duration: 0.5 });
    }
  }

  _mostrarPontos(itens, tipo) {
    this.pontos = itens;
    if (!this._camadaPontos) { this._garantirMapa(); this._renderPontos(itens, tipo); return; }
    this._camadaPontos.clearLayers();
    const L = this._L;
    const icone = TIPOS_PONTO[tipo].icone;
    this._marcadores = itens.map((p) => L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: '', html: `<div class="nav-ponto">${icone}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).bindPopup(`<b>${p.nome.replace(/[<>&]/g, '')}</b><br>${fmtDist(p.dist)}`).addTo(this._camadaPontos));
    if (itens.length && this.pos) {
      this._pausarSeguir();
      this._mapa.fitBounds([[this.pos.lat, this.pos.lon], ...itens.map((p) => [p.lat, p.lon])], { padding: [30, 30], maxZoom: 15, animate: false });
    }
    this._renderPontos(itens, tipo);
  }

  _renderPontos(itens, tipo) {
    const el = document.getElementById('nav-pontos');
    if (!el) return;
    el.innerHTML = '';
    if (!itens.length) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    const icone = TIPOS_PONTO[tipo].icone;
    itens.slice(0, 4).forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nav-chip';
      b.textContent = `${icone} ${p.nome} · ${fmtDist(p.dist)}`;
      b.onclick = () => { if (this._mapa) { this._pausarSeguir(); this._mapa.setView([p.lat, p.lon], 16); if (this._marcadores && this._marcadores[i]) this._marcadores[i].openPopup(); } };
      el.appendChild(b);
    });
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'nav-chip nav-chip-x';
    x.textContent = '✖';
    x.onclick = () => this.limparPontos();
    el.appendChild(x);
  }

  // ---------- painel ----------
  redesenhar() { this._desenhar(); this._mapaRedimensionar(); }

  _desenhar() {
    const f = typeof window.atualizarPainelMapa === 'function' ? window.atualizarPainelMapa : null;
    if (!f) return;
    const d = this.destino;
    const base = { destino: d ? `${d.auto ? '⚠ ' : ''}${d.morada}` : '', distancia: '—', chegada: '—', tempo: '', legenda: LEGENDA_MAPA, estado: this.estado };
    const msg = (t) => f({ ...base, aviso: t });
    switch (this.estado) {
      case 'sem-guia': return msg('Sem guia — importa uma guia');
      case 'sem-morada': return msg('A 1.ª guia ainda não tem morada');
      case 'gps-negado': return msg('Ativa a localização do telemóvel');
      case 'gps': return msg('A obter sinal GPS…');
      case 'localizar': return msg('A localizar a morada…');
      case 'rota': return msg('A calcular a rota…');
      case 'erro': return msg(this.msg || 'Sem rota');
      default: break;
    }
    if (!this.rota || !this.p) return msg('A calcular a rota…');
    const p = this.p;
    if (this.estado === 'chegou') return f({ ...base, distancia: '🏁', chegada: 'Chegou', aviso: 'Chegou ao destino' });
    return f({ ...base, distancia: fmtDist(p.restM), chegada: fmtHora(Date.now() + p.restS * 1000), tempo: fmtTempo(p.restS),
      aviso: this.perfil === 'carro' ? 'Rota de carro' : '' });
  }

  /** Dados da rota ativa para o Benjamin: "quanto falta?", "como está o trânsito?". */
  resumo() {
    const base = { estado: this.estado, posicao: this.pos ? [this.pos.lat, this.pos.lon] : null,
      destino: this.destino && this.destino.coord ? { morada: this.destino.morada, coord: this.destino.coord } : null, perfil: this.perfil || '' };
    if (!this.rota || !this.p) return base;
    return { ...base, restM: this.p.restM, restS: this.p.restS, eta: Date.now() + this.p.restS * 1000 };
  }

  reconfigurar() { this.sincronizar(true); }
}
