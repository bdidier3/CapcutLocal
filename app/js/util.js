// Petits utilitaires partages.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const uid = (p = 'i') => p + Math.random().toString(36).slice(2, 9) + (uid.n = (uid.n || 0) + 1).toString(36);

export function fmtTime(s, fps = 0) {
  if (!isFinite(s)) s = 0;
  const neg = s < 0;
  s = Math.abs(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  let out = (h ? h + ':' : '') + pad(m) + ':' + pad(sec);
  if (fps) out += ':' + pad(Math.floor((s % 1) * fps + 1e-6));
  else out += '.' + pad(Math.floor((s % 1) * 100));
  return (neg ? '-' : '') + out;
}

export function fmtSize(b) {
  if (b < 1024) return b + ' o';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' Ko';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' Mo';
  return (b / 1073741824).toFixed(2) + ' Go';
}

export function fmtBitrate(bps) {
  if (bps >= 1e6) return (bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1) + ' Mb/s';
  return (bps / 1e3).toFixed(0) + ' kb/s';
}

/** Cree un element avec classes/attributs/enfants. */
export function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Emetteur d'evenements minimal. */
export class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, new Set());
    this._h.get(ev).add(fn);
    return () => this.off(ev, fn);
  }
  off(ev, fn) { const s = this._h.get(ev); if (s) s.delete(fn); }
  emit(ev, ...a) {
    const s = this._h.get(ev);
    if (s) for (const fn of [...s]) { try { fn(...a); } catch (e) { console.error(e); } }
    const all = this._h.get('*');
    if (all) for (const fn of [...all]) { try { fn(ev, ...a); } catch (e) { console.error(e); } }
  }
}

export function throttleRaf(fn) {
  let queued = false, lastArgs = null;
  return (...a) => {
    lastArgs = a;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
  };
}

export function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Gestion generique d'un drag souris. onMove recoit (dx, dy, ev). */
export function drag(startEv, { onMove, onEnd, cursor }) {
  startEv.preventDefault();
  const sx = startEv.clientX, sy = startEv.clientY;
  const prevCursor = document.body.style.cursor;
  if (cursor) document.body.style.cursor = cursor;
  document.body.classList.add('dragging');
  let moved = false;
  const mv = (e) => {
    if (Math.abs(e.clientX - sx) > 2 || Math.abs(e.clientY - sy) > 2) moved = true;
    onMove && onMove(e.clientX - sx, e.clientY - sy, e);
  };
  const up = (e) => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    document.body.style.cursor = prevCursor;
    document.body.classList.remove('dragging');
    onEnd && onEnd(moved, e);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
}

export function toast(msg, kind = 'info', ms = 3200) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { id: 'toasts' });
    document.body.append(host);
  }
  const t = el('div', { class: 'toast ' + kind, text: msg });
  host.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 250); }, ms);
  return t;
}

/** Attend qu'un evenement se produise (avec timeout). */
export function once(target, ev, ms = 15000) {
  return new Promise((res, rej) => {
    const to = ms ? setTimeout(() => { cleanup(); rej(new Error('timeout ' + ev)); }, ms) : 0;
    const ok = (e) => { cleanup(); res(e); };
    const bad = () => { cleanup(); rej(new Error('erreur ' + ev)); };
    const cleanup = () => {
      clearTimeout(to);
      target.removeEventListener(ev, ok);
      target.removeEventListener('error', bad);
    };
    target.addEventListener(ev, ok);
    target.addEventListener('error', bad);
  });
}

export function b64(bytes) {
  let s = '';
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CH = 0x8000;
  for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
  return btoa(s);
}

/** Choisit un pas de graduation "rond" pour une echelle donnee. */
export function niceStep(target) {
  const steps = [1 / 60, 1 / 30, 1 / 10, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const s of steps) if (s >= target) return s;
  return 3600;
}

/**
 * Cede la main au navigateur SANS passer par setTimeout : les minuteries sont
 * bridees a 1 Hz dans un onglet en arriere-plan, ce qui ferait ramper l'export.
 * Les messages de MessageChannel ne subissent pas ce bridage.
 */
let _mc = null;
export function yieldTask() {
  if (!_mc) {
    _mc = new MessageChannel();
    _mc.waiting = [];
    _mc.port1.onmessage = () => { const f = _mc.waiting.shift(); if (f) f(); };
    _mc.port1.start();
  }
  return new Promise((res) => { _mc.waiting.push(res); _mc.port2.postMessage(0); });
}

/** Attend `ms` sans bridage d'onglet (boucle de micro-taches + horloge). */
export async function yieldFor(ms) {
  const end = performance.now() + ms;
  do { await yieldTask(); } while (performance.now() < end);
}

export const isMac = navigator.platform.toLowerCase().includes('mac');
export const modKey = (e) => (isMac ? e.metaKey : e.ctrlKey);

/**
 * Attend qu'un encodeur/decodeur WebCodecs ait de la place, SANS attente active.
 * Une boucle `while (q > n) await yieldTask()` monopolise le thread principal —
 * or c'est ce meme thread qui livre les images du codec materiel : on ralentit
 * donc exactement ce qu'on attend. Ici on dort sur l'evenement `dequeue`.
 */
export function whenDrained(codec, max, signal) {
  if (!codec || codec.state === 'closed') return Promise.resolve();
  const size = () => (codec.encodeQueueSize !== undefined ? codec.encodeQueueSize : codec.decodeQueueSize);
  if (size() <= max) return Promise.resolve();
  return new Promise((res) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      clearTimeout(tid);
      try { codec.removeEventListener('dequeue', tick); } catch (_) {}
      res();
    };
    const tick = () => { if (size() <= max || (signal && signal.aborted) || codec.state === 'closed') fin(); };
    try { codec.addEventListener('dequeue', tick); } catch (_) { }
    // une annulation doit reveiller l'attente TOUT DE SUITE, pas au prochain tour
    if (signal) try { signal.addEventListener('abort', fin, { once: true }); } catch (_) {}
    // filet de securite : si `dequeue` n'existe pas sur ce navigateur
    const tid = setTimeout(fin, 250);
    tick();
  });
}
