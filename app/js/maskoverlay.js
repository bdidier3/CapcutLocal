// Poignees interactives sur l'apercu : deplacer / redimensionner / tourner un masque,
// ajuster le contour progressif, editer les sommets d'une forme libre.
import { clamp, drag } from './util.js';
import { animVal, setKey, hasKeys, removeKey, activeAt } from './state.js';
import { clipScreenRect, clipSourceSize } from './compose.js';

const NS = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
};

export class MaskOverlay {
  constructor(svg, store, player) {
    this.svg = svg;
    this.store = store;
    this.player = player;
    this.autoKey = true;
    this.showTransform = false;
    this.stage = { w: 100, h: 100 };
    store.on('selection', () => this.draw());
    store.on('change', () => this.draw());
    store.on('seek', () => this.draw());
  }

  setStage(w, h) { this.stage = { w, h }; this.draw(); }

  // valeur animee courante du masque
  val(m, prop) {
    const s = this.store.soleClip;
    const tLocal = s ? this.store.playhead - s.clip.t0 : 0;
    return animVal(m, prop, tLocal);
  }

  /** Ecrit une propriete (avec keyframe si necessaire). */
  put(m, prop, v) {
    const s = this.store.soleClip;
    if (!s) return;
    const tLocal = this.store.playhead - s.clip.t0;
    if (this.autoKey && hasKeys(m, prop)) setKey(m, prop, tLocal, v);
    else if (this.autoKey && this.forceKey) setKey(m, prop, tLocal, v);
    else m[prop] = v;
  }

  draw() {
    const svg = this.svg;
    svg.innerHTML = '';
    const mask = this.store.selectedMask;
    const S = this.stage.w, HH = this.stage.h;
    svg.setAttribute('viewBox', `0 0 ${S} ${HH}`);
    svg.style.pointerEvents = 'auto';

    // fond cliquable : attrape ce qui se trouve sous le curseur
    this._drawHitLayer(svg, S, HH);
    // grille + reperes d'alignement pendant un deplacement
    this._drawGuides(svg, S, HH);

    if (!mask) {
      // pas de masque : cadre de transformation du clip selectionne
      this._drawClipFrame(svg, S, HH);
      return;
    }

    const cx = this.val(mask, 'cx') * S;
    const cy = this.val(mask, 'cy') * HH;
    const w = this.val(mask, 'w') * S;
    const h = this.val(mask, 'h') * S;
    const rot = this.val(mask, 'rot');
    const feather = this.val(mask, 'feather') * S;

    // trajectoire de suivi (dessinee sous le masque)
    this._drawMotionPath(svg, mask, S, HH);

    const g = mk('g', { transform: `translate(${cx} ${cy}) rotate(${rot})` });
    svg.append(g);

    const stroke = { stroke: '#4cc2ff', 'stroke-width': 1.6, fill: 'none', 'vector-effect': 'non-scaling-stroke' };
    const dash = { ...stroke, stroke: 'rgba(76,194,255,.55)', 'stroke-dasharray': '5 4' };

    if (mask.shape === 'poly') {
      this._drawPoly(svg, mask, S, HH);
    } else if (mask.shape === 'rect') {
      g.append(mk('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: (mask.round || 0) * S, ...stroke }));
      if (feather > 0.5) g.append(mk('rect', { x: -w / 2 - feather / 2, y: -h / 2 - feather / 2, width: w + feather, height: h + feather, rx: (mask.round || 0) * S + feather / 2, ...dash }));
    } else if (mask.shape === 'ellipse') {
      g.append(mk('ellipse', { rx: w / 2, ry: h / 2, ...stroke }));
      if (feather > 0.5) g.append(mk('ellipse', { rx: w / 2 + feather / 2, ry: h / 2 + feather / 2, ...dash }));
    } else if (mask.shape === 'linear') {
      const L = Math.max(S, HH) * 1.5;
      g.append(mk('line', { x1: -L, y1: 0, x2: L, y2: 0, ...stroke }));
      if (feather > 0.5) {
        g.append(mk('line', { x1: -L, y1: -feather / 2, x2: L, y2: -feather / 2, ...dash }));
        g.append(mk('line', { x1: -L, y1: feather / 2, x2: L, y2: feather / 2, ...dash }));
      }
      // fleche indiquant le cote actif
      const dir = mask.invert ? -1 : 1;
      g.append(mk('path', { d: `M0 0 L0 ${28 * dir} M-6 ${20 * dir} L0 ${28 * dir} L6 ${20 * dir}`, ...stroke }));
    } else if (mask.shape === 'mirror') {
      const L = Math.max(S, HH) * 1.5;
      g.append(mk('line', { x1: -L, y1: -h / 2, x2: L, y2: -h / 2, ...stroke }));
      g.append(mk('line', { x1: -L, y1: h / 2, x2: L, y2: h / 2, ...stroke }));
      if (feather > 0.5) {
        g.append(mk('line', { x1: -L, y1: -h / 2 - feather / 2, x2: L, y2: -h / 2 - feather / 2, ...dash }));
        g.append(mk('line', { x1: -L, y1: h / 2 + feather / 2, x2: L, y2: h / 2 + feather / 2, ...dash }));
      }
    }

    if (mask.shape === 'poly') return;

    // --- poignees
    const rad = rot * Math.PI / 180;
    const toScreen = (lx, ly) => [
      cx + lx * Math.cos(rad) - ly * Math.sin(rad),
      cy + lx * Math.sin(rad) + ly * Math.cos(rad),
    ];
    const toLocal = (sx, sy) => {
      const dx = sx - cx, dy = sy - cy;
      return [dx * Math.cos(-rad) - dy * Math.sin(-rad), dx * Math.sin(-rad) + dy * Math.cos(-rad)];
    };
    this._toLocal = toLocal;

    const handle = (lx, ly, kind, cursor, color = '#fff') => {
      const [sx, sy] = toScreen(lx, ly);
      const c = mk('circle', { cx: sx, cy: sy, r: 6, fill: color, stroke: '#0b0d12', 'stroke-width': 1.5, style: `cursor:${cursor}` });
      c.addEventListener('pointerdown', (e) => { e.stopPropagation(); this._start(e, mask, kind, { cx, cy, w, h, rot, feather, S, HH }); });
      svg.append(c);
      return c;
    };

    // deplacement : centre
    const centre = mk('circle', { cx, cy, r: 8, fill: 'rgba(76,194,255,.85)', stroke: '#0b0d12', 'stroke-width': 1.5, style: 'cursor:move' });
    centre.addEventListener('pointerdown', (e) => { e.stopPropagation(); this._start(e, mask, 'move', { cx, cy, w, h, rot, feather, S, HH }); });
    svg.append(centre);

    // zone de deplacement invisible (tout l'interieur)
    if (mask.shape === 'rect' || mask.shape === 'ellipse') {
      const hitG = mk('g', { transform: `translate(${cx} ${cy}) rotate(${rot})` });
      const hit = mask.shape === 'rect'
        ? mk('rect', { x: -w / 2, y: -h / 2, width: w, height: h, fill: 'transparent', style: 'cursor:move' })
        : mk('ellipse', { rx: w / 2, ry: h / 2, fill: 'transparent', style: 'cursor:move' });
      hit.addEventListener('pointerdown', (e) => { e.stopPropagation(); this._start(e, mask, 'move', { cx, cy, w, h, rot, feather, S, HH }); });
      hitG.append(hit);
      svg.insertBefore(hitG, svg.firstChild);
    }

    if (mask.shape === 'rect' || mask.shape === 'ellipse') {
      handle(w / 2, 0, 'w', 'ew-resize');
      handle(-w / 2, 0, 'w-', 'ew-resize');
      handle(0, h / 2, 'h', 'ns-resize');
      handle(0, -h / 2, 'h-', 'ns-resize');
      handle(w / 2, h / 2, 'wh', 'nwse-resize', '#ffd166');
      handle(-w / 2, -h / 2, 'wh-', 'nwse-resize', '#ffd166');
    } else if (mask.shape === 'mirror') {
      handle(0, h / 2, 'h', 'ns-resize');
      handle(0, -h / 2, 'h-', 'ns-resize');
    }

    // rotation
    const rotDist = (mask.shape === 'linear' ? 0 : h / 2) + 34;
    const [rx, ry] = toScreen(0, -rotDist);
    const [ax, ay] = toScreen(0, -(mask.shape === 'linear' ? 0 : h / 2));
    svg.append(mk('line', { x1: ax, y1: ay, x2: rx, y2: ry, stroke: 'rgba(255,255,255,.5)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
    handle(0, -rotDist, 'rot', 'grab', '#7ef7a0');

    // contour progressif
    const [fx, fy] = toScreen((mask.shape === 'linear' || mask.shape === 'mirror' ? 60 : w / 2 + 18), (mask.shape === 'linear' ? -18 : -h / 2 - 18));
    const fh = mk('circle', { cx: fx, cy: fy, r: 6, fill: '#c084fc', stroke: '#0b0d12', 'stroke-width': 1.5, style: 'cursor:nwse-resize' });
    fh.addEventListener('pointerdown', (e) => { e.stopPropagation(); this._start(e, mask, 'feather', { cx, cy, w, h, rot, feather, S, HH }); });
    svg.append(fh);
    svg.append(mk('text', { x: fx + 10, y: fy + 4, fill: '#c084fc', 'font-size': 10, 'font-family': 'monospace' , style:'pointer-events:none'}));
    svg.lastChild.textContent = 'flou bord';
  }

  // ------------------------------------------------- clic direct sur l'apercu

  /** Rectangle a l'ecran (pixels du plateau) d'un clip a un instant donne. */
  _rectOf(clip, tLocal, S, HH) {
    let srcW, srcH;
    try { [srcW, srcH] = clipSourceSize(this.store.project, clip, this.store.project.height); }
    catch (_) { return null; }
    const r = clipScreenRect(this.store.project, clip, tLocal, srcW, srcH);
    return { cx: r.cx * S, cy: r.cy * HH, w: r.w * S, h: r.h * HH, rot: r.rot, norm: r };
  }

  static inside(px, py, cx, cy, w, h, rot, ellipse) {
    const rad = -rot * Math.PI / 180;
    const dx = px - cx, dy = py - cy;
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
    if (ellipse) return (lx / (w / 2)) ** 2 + (ly / (h / 2)) ** 2 <= 1;
    return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
  }

  /** Calque invisible qui recoit les clics et selectionne ce qui est dessous. */
  _drawHitLayer(svg, S, HH) {
    const hit = mk('rect', { x: 0, y: 0, width: S, height: HH, fill: 'transparent', style: 'cursor:default' });
    hit.addEventListener('pointerdown', (e) => this._pickAndDrag(e, S, HH));
    svg.append(hit);
  }

  _pickAndDrag(ev, S, HH) {
    if (ev.button === 2) return;
    const rect = this.svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (S / rect.width);
    const py = (ev.clientY - rect.top) * (HH / rect.height);
    const store = this.store;
    const p = store.project;
    const t = store.playhead;

    // 1) un masque du clip selectionne ?
    const sole = store.soleClip;
    if (sole && sole.clip.masks && sole.clip.masks.length) {
      const tLocal = t - sole.clip.t0;
      for (let i = sole.clip.masks.length - 1; i >= 0; i--) {
        const m = sole.clip.masks[i];
        if (m.hidden) continue;
        const mcx = animVal(m, 'cx', tLocal) * S;
        const mcy = animVal(m, 'cy', tLocal) * HH;
        const mw = animVal(m, 'w', tLocal) * S;
        const mh = animVal(m, 'h', tLocal) * S;
        const rot = animVal(m, 'rot', tLocal);
        const isEll = m.shape === 'ellipse';
        if (m.shape === 'linear' || m.shape === 'poly') continue;
        if (MaskOverlay.inside(px, py, mcx, mcy, mw, mh, rot, isEll)) {
          store.selection.maskId = m.id;
          store.emit('selection');
          this._start(ev, m, 'move', { cx: mcx, cy: mcy, w: mw, h: mh, rot, feather: animVal(m, 'feather', tLocal) * S, S, HH });
          return;
        }
      }
    }

    // 2) le calque le plus haut sous le curseur
    const acts = activeAt(p, t)
      .filter((a) => a.track.kind !== 'audio' && a.clip.kind !== 'audio')
      .sort((a, b) => b.trackIndex - a.trackIndex);
    for (const a of acts) {
      const r = this._rectOf(a.clip, a.tLocal, S, HH);
      if (!r) continue;
      if (!MaskOverlay.inside(px, py, r.cx, r.cy, r.w, r.h, r.rot, false)) continue;
      const already = store.selection.clipIds.length === 1 && store.selection.clipIds[0] === a.clip.id;
      if (!already) { store.selection.maskId = null; store.select(a.clip.id); }
      const tLocal = clamp(t - a.clip.t0, 0, a.clip.dur);
      this._startClip(ev, a.clip, 'move', { r: r.norm, S, HH, tLocal });
      return;
    }

    // 3) rien sous le curseur
    store.select([]);
  }

  // --------------------------------------------- grille et reperes d'alignement

  _drawGuides(svg, S, HH) {
    if (!this.dragging) return;
    const g = mk('g', { style: 'pointer-events:none' });
    // quadrillage en tiers
    for (const f of [1 / 3, 2 / 3]) {
      g.append(mk('line', { x1: f * S, y1: 0, x2: f * S, y2: HH, stroke: 'rgba(255,255,255,.16)', 'stroke-width': 1 }));
      g.append(mk('line', { x1: 0, y1: f * HH, x2: S, y2: f * HH, stroke: 'rgba(255,255,255,.16)', 'stroke-width': 1 }));
    }
    g.append(mk('rect', { x: 0.5, y: 0.5, width: S - 1, height: HH - 1, fill: 'none', stroke: 'rgba(255,255,255,.12)', 'stroke-width': 1 }));
    // reperes actifs (aimantation)
    const gu = this.snapGuides || {};
    if (gu.x !== undefined && gu.x !== null) {
      g.append(mk('line', { x1: gu.x * S, y1: 0, x2: gu.x * S, y2: HH, stroke: '#ffd166', 'stroke-width': 1.6 }));
    }
    if (gu.y !== undefined && gu.y !== null) {
      g.append(mk('line', { x1: 0, y1: gu.y * HH, x2: S, y2: gu.y * HH, stroke: '#ffd166', 'stroke-width': 1.6 }));
    }
    svg.append(g);
  }

  /**
   * Aimante une valeur sur des reperes. Renvoie {v, guide}.
   * @param v      valeur voulue (fraction de la frame)
   * @param half   demi-taille de l'element (pour aligner ses bords)
   * @param tolN   tolerance en fraction de frame
   */
  static snap1(v, half, tolN) {
    const cands = [
      { at: 0.5, guide: 0.5 },            // centre
      { at: 1 / 3, guide: 1 / 3 },
      { at: 2 / 3, guide: 2 / 3 },
      { at: half, guide: 0 },             // bord contre bord
      { at: 1 - half, guide: 1 },
      { at: 0.05 + half, guide: 0.05 },   // marges de securite
      { at: 0.95 - half, guide: 0.95 },
    ];
    let best = null, bd = tolN;
    for (const c of cands) {
      const d = Math.abs(v - c.at);
      if (d < bd) { bd = d; best = c; }
    }
    return best ? { v: best.at, guide: best.guide } : { v, guide: null };
  }

  /**
   * Cadre de transformation du clip selectionne : glisser pour deplacer,
   * coins pour redimensionner, poignee du haut pour tourner.
   */
  _drawClipFrame(svg, S, HH) {
    // NB : on ne touche jamais a pointerEvents ici. Le calque de clic doit rester
    // actif meme sans selection, sinon cliquer sur l'apercu ne fait rien.
    const sel = this.store.soleClip;
    if (!sel || sel.track.kind === 'audio' || sel.clip.kind === 'audio') return;
    const clip = sel.clip;
    const tLocal = clamp(this.store.playhead - clip.t0, 0, clip.dur);
    let srcW, srcH;
    try {
      [srcW, srcH] = clipSourceSize(this.store.project, clip, this.store.project.height);
    } catch (_) { return; }
    const r = clipScreenRect(this.store.project, clip, tLocal, srcW, srcH);

    const cx = r.cx * S, cy = r.cy * HH;
    const w = r.w * S, h = r.h * HH;
    const g = mk('g', { transform: `translate(${cx} ${cy}) rotate(${r.rot})` });
    svg.append(g);
    g.append(mk('rect', {
      x: -w / 2, y: -h / 2, width: w, height: h,
      fill: 'transparent', stroke: 'rgba(255,255,255,.85)', 'stroke-width': 1.4,
      'stroke-dasharray': '7 5', style: 'cursor:move',
    }));
    g.lastChild.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this._startClip(e, clip, 'move', { r, S, HH, tLocal });
    });

    const rad = r.rot * Math.PI / 180;
    const toScreen = (lx, ly) => [
      cx + lx * Math.cos(rad) - ly * Math.sin(rad),
      cy + lx * Math.sin(rad) + ly * Math.cos(rad),
    ];
    const handle = (lx, ly, kind, color, cursor) => {
      const [sx, sy] = toScreen(lx, ly);
      const n = mk('circle', {
        cx: sx, cy: sy, r: 6, fill: color, stroke: '#0b0d12', 'stroke-width': 1.5,
        style: `cursor:${cursor}`,
      });
      n.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this._startClip(e, clip, kind, { r, S, HH, tLocal });
      });
      svg.append(n);
    };
    for (const [lx, ly] of [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]]) {
      handle(lx, ly, 'scale', '#ffd166', 'nwse-resize');
    }
    const [ax, ay] = toScreen(0, -h / 2);
    const [rx, ry] = toScreen(0, -h / 2 - 32);
    svg.append(mk('line', { x1: ax, y1: ay, x2: rx, y2: ry, stroke: 'rgba(255,255,255,.5)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
    handle(0, -h / 2 - 32, 'rot', '#7ef7a0', 'grab');
  }

  _startClip(ev, clip, kind, o) {
    const store = this.store;
    const rect = this.svg.getBoundingClientRect();
    const kx = o.S / rect.width, ky = o.HH / rect.height;
    const start = {
      x: animVal(clip, 'x', o.tLocal), y: animVal(clip, 'y', o.tLocal),
      scale: animVal(clip, 'scale', o.tLocal), rot: animVal(clip, 'rot', o.tLocal),
    };
    const cxPx = o.r.cx * o.S, cyPx = o.r.cy * o.HH;
    const diag0 = Math.hypot(o.r.w * o.S, o.r.h * o.HH) / 2 || 1;
    store.beginLive('transformer');
    this.dragging = true;
    this.snapGuides = {};
    const put = (prop, v) => {
      if (this.autoKey && hasKeys(clip, prop)) setKey(clip, prop, o.tLocal, v);
      else clip[prop] = v;
    };
    const tolX = 8 / o.S, tolY = 8 / o.HH;

    drag(ev, {
      onMove: (dxp, dyp, e) => {
        const dx = dxp * kx, dy = dyp * ky;
        if (kind === 'move') {
          // centre voulu, en fraction de la frame
          let wantCx = 0.5 + start.x + dx / o.S;
          let wantCy = 0.5 + start.y + dy / o.HH;
          if (!e.altKey) {
            const sx = MaskOverlay.snap1(wantCx, o.r.w / 2, tolX);
            const sy = MaskOverlay.snap1(wantCy, o.r.h / 2, tolY);
            wantCx = sx.v; wantCy = sy.v;
            this.snapGuides = { x: sx.guide, y: sy.guide };
          } else this.snapGuides = {};
          put('x', clamp(wantCx - 0.5, -3, 3));
          put('y', clamp(wantCy - 0.5, -3, 3));
        } else if (kind === 'scale') {
          const sx = ev.clientX - rect.left + dxp, sy = ev.clientY - rect.top + dyp;
          const d = Math.hypot(sx * kx - cxPx, sy * ky - cyPx);
          put('scale', clamp(start.scale * (d / diag0), 0.02, 8));
        } else if (kind === 'rot') {
          const sx = ev.clientX - rect.left + dxp, sy = ev.clientY - rect.top + dyp;
          let a = Math.atan2(sy * ky - cyPx, sx * kx - cxPx) * 180 / Math.PI + 90;
          if (e.shiftKey) a = Math.round(a / 15) * 15;
          while (a > 180) a -= 360;
          while (a < -180) a += 360;
          put('rot', Math.round(a * 10) / 10);
        }
        store.changed();
        this.player.invalidate();
      },
      onEnd: () => {
        store.endLive();
        this.dragging = false;
        this.snapGuides = {};
        this.draw();
      },
    });
  }

  /** Temps de tous les points de suivi (keyframes de position), triés. */
  trackTimes(mask) {
    const set = new Set();
    for (const p of ['cx', 'cy']) {
      const arr = mask.kf && mask.kf[p];
      if (arr) for (const k of arr) set.add(Math.round(k.t * 1000) / 1000);
    }
    return [...set].sort((a, b) => a - b);
  }

  /**
   * Trajectoire du masque : la courbe suivie au fil du temps, avec un point
   * deplacable a chaque instant cle. C'est le suivi de visage.
   */
  _drawMotionPath(svg, mask, S, HH) {
    const sel = this.store.soleClip;
    if (!sel) return;
    const times = this.trackTimes(mask);
    if (times.length < 1) return;

    const clip = sel.clip;
    const tNow = this.store.playhead - clip.t0;
    const at = (t) => [animVal(mask, 'cx', t) * S, animVal(mask, 'cy', t) * HH];

    // courbe interpolee
    if (times.length > 1) {
      const a = times[0], b = times[times.length - 1];
      const N = clamp(Math.round((b - a) * 24), 8, 400);
      let d = '';
      for (let i = 0; i <= N; i++) {
        const [x, y] = at(a + ((b - a) * i) / N);
        d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      }
      svg.append(mk('path', { d, stroke: 'rgba(126,247,160,.35)', 'stroke-width': 5, fill: 'none', 'stroke-linecap': 'round' }));
      svg.append(mk('path', { d, stroke: '#7ef7a0', 'stroke-width': 1.4, fill: 'none', 'stroke-dasharray': '5 4' }));
    }

    // un point par instant cle
    for (const t of times) {
      const [x, y] = at(t);
      const isNow = Math.abs(t - tNow) < 0.02;
      const dot = mk('circle', {
        cx: x, cy: y, r: isNow ? 6.5 : 5,
        fill: isNow ? '#7ef7a0' : '#0f1218',
        stroke: '#7ef7a0', 'stroke-width': 2,
        style: 'cursor:move',
      });
      dot.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (e.button === 2) return;
        this._dragPoint(e, mask, t, S, HH, clip);
      });
      dot.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (times.length <= 1) return;
        this.store.edit('retirer un point', () => {
          removeKey(mask, 'cx', t);
          removeKey(mask, 'cy', t);
        });
        this.player.invalidate();
      });
      svg.append(dot);
    }
  }

  /** Deplace un point de suivi (modifie le keyframe de CE temps, pas du temps courant). */
  _dragPoint(ev, mask, t, S, HH, clip) {
    const store = this.store;
    const r = this.svg.getBoundingClientRect();
    const kx = S / r.width, ky = HH / r.height;
    const o = { cx: animVal(mask, 'cx', t), cy: animVal(mask, 'cy', t) };
    store.beginLive('deplacer un point');
    drag(ev, {
      onMove: (dxp, dyp) => {
        setKey(mask, 'cx', t, clamp(o.cx + (dxp * kx) / S, -0.5, 1.5));
        setKey(mask, 'cy', t, clamp(o.cy + (dyp * ky) / HH, -0.5, 1.5));
        store.changed();
        this.player.invalidate();
      },
      onEnd: (moved) => {
        store.endLive();
        // simple clic : on se place sur ce point
        if (!moved) this.player.seek(clip.t0 + t);
      },
    });
  }

  _drawPoly(svg, mask, S, HH) {
    const pts = mask.pts || [];
    if (pts.length < 2) return;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0] * S} ${p[1] * HH}`).join(' ') + ' Z';
    svg.append(mk('path', { d, stroke: '#4cc2ff', 'stroke-width': 1.6, fill: 'rgba(76,194,255,.08)' }));
    pts.forEach((p, i) => {
      const c = mk('circle', { cx: p[0] * S, cy: p[1] * HH, r: 6, fill: '#fff', stroke: '#0b0d12', 'stroke-width': 1.5, style: 'cursor:move' });
      c.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (e.button === 2) return;
        const o = [p[0], p[1]];
        this.store.beginLive('sommet');
        drag(e, {
          onMove: (dx, dy) => {
            const r = svg.getBoundingClientRect();
            const kx = S / r.width, ky = HH / r.height;
            p[0] = clamp(o[0] + (dx * kx) / S, -0.5, 1.5);
            p[1] = clamp(o[1] + (dy * ky) / HH, -0.5, 1.5);
            this.store.changed();
            this.player.invalidate();
          },
          onEnd: () => this.store.endLive(),
        });
      });
      c.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (pts.length <= 3) return;
        this.store.edit('retirer sommet', () => { pts.splice(i, 1); });
        this.player.invalidate();
      });
      svg.append(c);
    });
    // milieux : cliquer pour ajouter un sommet
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const mx = (p[0] + q[0]) / 2 * S, my = (p[1] + q[1]) / 2 * HH;
      const c = mk('circle', { cx: mx, cy: my, r: 4, fill: 'rgba(255,255,255,.35)', style: 'cursor:copy' });
      c.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (pts.length >= 32) return;
        this.store.edit('ajouter sommet', () => {
          pts.splice(i + 1, 0, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
        });
        this.player.invalidate();
      });
      svg.append(c);
    });
  }

  _start(ev, mask, kind, o) {
    const store = this.store;
    const r = this.svg.getBoundingClientRect();
    const kx = o.S / r.width, ky = o.HH / r.height;
    store.beginLive('masque');
    this.forceKey = this.autoKey && this._anyKeys(mask);
    const rad = o.rot * Math.PI / 180;
    this.dragging = true;
    this.snapGuides = {};
    const tolX = 8 / o.S, tolY = 8 / o.HH;

    drag(ev, {
      onMove: (dxp, dyp, e) => {
        const dx = dxp * kx, dy = dyp * ky;
        // delta dans le repere local du masque
        const lx = dx * Math.cos(-rad) - dy * Math.sin(-rad);
        const ly = dx * Math.sin(-rad) + dy * Math.cos(-rad);
        switch (kind) {
          case 'move': {
            let wcx = (o.cx + dx) / o.S;
            let wcy = (o.cy + dy) / o.HH;
            if (!e.altKey) {
              const sx = MaskOverlay.snap1(wcx, o.w / 2 / o.S, tolX);
              const sy = MaskOverlay.snap1(wcy, o.h / 2 / o.HH, tolY);
              wcx = sx.v; wcy = sy.v;
              this.snapGuides = { x: sx.guide, y: sy.guide };
            } else this.snapGuides = {};
            this.put(mask, 'cx', clamp(wcx, -0.5, 1.5));
            this.put(mask, 'cy', clamp(wcy, -0.5, 1.5));
            break;
          }
          case 'w': case 'w-':
            this.put(mask, 'w', clamp((o.w + 2 * (kind === 'w' ? lx : -lx)) / o.S, 0.005, 4));
            break;
          case 'h': case 'h-':
            this.put(mask, 'h', clamp((o.h + 2 * (kind === 'h' ? ly : -ly)) / o.S, 0.005, 4));
            break;
          case 'wh': case 'wh-': {
            const sgn = kind === 'wh' ? 1 : -1;
            const nw = clamp((o.w + 2 * sgn * lx) / o.S, 0.005, 4);
            if (e.shiftKey && o.w > 1e-6) {
              this.put(mask, 'w', nw);
              this.put(mask, 'h', clamp(nw * (o.h / o.w), 0.005, 4));
            } else {
              this.put(mask, 'w', nw);
              this.put(mask, 'h', clamp((o.h + 2 * sgn * ly) / o.S, 0.005, 4));
            }
            break;
          }
          case 'rot': {
            const sx = ev.clientX - r.left + dxp, sy = ev.clientY - r.top + dyp;
            const ang = Math.atan2((sy * ky) - o.cy, (sx * kx) - o.cx) * 180 / Math.PI + 90;
            let v = e.shiftKey ? Math.round(ang / 15) * 15 : Math.round(ang * 10) / 10;
            while (v > 180) v -= 360;
            while (v < -180) v += 360;
            this.put(mask, 'rot', v);
            break;
          }
          case 'feather':
            this.put(mask, 'feather', clamp((o.feather + (lx - ly) * 0.5) / o.S, 0, 0.5));
            break;
        }
        store.changed();
        this.player.invalidate();
      },
      onEnd: () => {
        store.endLive();
        this.forceKey = false;
        this.dragging = false;
        this.snapGuides = {};
        this.draw();
      },
    });
  }

  _anyKeys(mask) {
    return !!(mask.kf && Object.keys(mask.kf).length);
  }
}
