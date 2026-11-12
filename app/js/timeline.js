// Timeline : rendu canvas + interactions (deplacer, rogner, couper, transitions).
import { clamp, drag, fmtTime, niceStep, el, throttleRaf, modKey, toast } from './util.js';
import {
  newTrack, projectDuration, normalizeTrack, mediaOf,
  layoutTrack, relayoutAll, compactTrack, separateTrack,
} from './state.js';
import { tempsTimeline } from './beats.js';


const RULER_H = 26;
const EDGE = 9;
const NEWBAND = 26;          // bande de depot « nouvelle couche video »
const MIN_DUR = 0.05;

export class Timeline {
  constructor(host, store, library, player) {
    this.host = host;
    this.store = store;
    this.lib = library;
    this.player = player;
    this.pps = 60;          // pixels par seconde
    this.t0 = 0;            // temps au bord gauche
    this.scrollY = 0;
    this.snap = true;
    this.hit = [];
    this.hover = null;
    this.dropPreview = null;

    host.innerHTML = '';
    this.headers = el('div', { class: 'tl-headers' });
    this.wrap = el('div', { class: 'tl-canvas' });
    this.canvas = el('canvas');
    this.wrap.append(this.canvas);
    host.append(this.headers, this.wrap);

    this.ctx = this.canvas.getContext('2d');
    this.draw = throttleRaf(this._draw.bind(this));

    this._bind();
    new ResizeObserver(() => this.draw()).observe(this.wrap);
    store.on('change', () => this.draw());
    store.on('selection', () => this.draw());
    store.on('seek', (t) => {
      if (this.player && this.player.playing) this.followPlayhead(t);
      this.draw();
    });
    store.on('reload', () => this.draw());
  }

  // ------------------------------------------------------------- conversions
  get W() { return this.canvas.clientWidth || 800; }
  get H() { return this.canvas.clientHeight || 200; }
  xOf(t) { return (t - this.t0) * this.pps; }
  tOf(x) { return this.t0 + x / this.pps; }

  /**
   * Ordre d'affichage (de haut en bas) : superpositions video en haut,
   * piste principale au milieu, audio en bas — comme CapCut.
   * Renvoie des index de pistes.
   */
  displayOrder() {
    const p = this.store.project;
    const vids = [], auds = [];
    p.tracks.forEach((t, i) => (t.kind === 'audio' ? auds : vids).push(i));
    vids.reverse();                  // le dernier calque (dessus a l'image) en haut
    return [...vids, ...auds];
  }

  /** Hauteur de la bande « nouvelle superposition » (visible pendant un depot). */
  bandH() {
    const dp = this.dropPreview;
    return dp && dp.showBand && !dp.audio ? NEWBAND : 0;   // bande audio = en bas, pas de decalage
  }

  /** Bas de la derniere piste affichee (pour la bande « nouvelle piste audio »). */
  contentBottom() {
    const p = this.store.project;
    const tops = this.trackTops();
    let b = RULER_H + this.bandH() - this.scrollY;
    for (const i of this.displayOrder()) b = Math.max(b, tops[i] + p.tracks[i].height + 3);
    return b;
  }

  /** tops[indexDePiste] = position verticale de la piste. */
  trackTops() {
    const p = this.store.project;
    const tops = new Array(p.tracks.length).fill(0);
    let y = RULER_H + this.bandH() - this.scrollY;
    for (const i of this.displayOrder()) { tops[i] = y; y += p.tracks[i].height + 3; }
    return tops;
  }

  /** Nom de la prochaine couche de superposition. */
  nextOverlayName() {
    const n = this.store.project.tracks.filter((t) => t.kind === 'video').length + 1;
    return 'Video ' + n;
  }
  nextAudioName() {
    const n = this.store.project.tracks.filter((t) => t.kind === 'audio').length + 1;
    return 'Audio ' + n;
  }
  contentHeight() {
    return this.store.project.tracks.reduce((s, t) => s + t.height + 3, 0) + RULER_H + 20;
  }

  trackAtY(y) {
    const tops = this.trackTops();
    for (let i = 0; i < tops.length; i++) {
      const tr = this.store.project.tracks[i];
      if (y >= tops[i] && y < tops[i] + tr.height) return i;
    }
    return -1;
  }

  // --------------------------------------------------------------------- zoom

  /** Duree visible a l'ecran, en secondes. */
  get span() { return this.W / this.pps; }

  /**
   * Recadre la vue : jamais avant 0:00, et jamais au-dela de la fin du projet.
   * Des que tout tient a l'ecran, on revient a 0:00 — c'est ce qu'on attend
   * quand on dezoome.
   */
  clampView(loose = false) {
    const dur = projectDuration(this.store.project);
    const maxT0 = loose ? Math.max(0, dur) : Math.max(0, dur + 1.5 - this.span);
    this.t0 = clamp(this.t0, 0, maxT0);
  }

  zoom(factor, anchorX) {
    const ax = anchorX ?? this.W / 2;
    const tAnchor = this.tOf(ax);
    this.pps = clamp(this.pps * factor, 1.5, 900);
    this.t0 = tAnchor - ax / this.pps;
    this.clampView();
    this.draw();
  }

  /** Zoom absolu (curseur de la barre d'outils) : garde le centre et recadre. */
  setZoom(pps, anchorX) {
    const ax = anchorX ?? this.W / 2;
    const tAnchor = this.tOf(ax);
    this.pps = clamp(pps, 1.5, 900);
    this.t0 = tAnchor - ax / this.pps;
    this.clampView();
    this.draw();
  }

  fit() {
    // projet vide : on montre une demi-minute, pas une seconde zoomee en images
    const d = Math.max(1, projectDuration(this.store.project) || 30);
    this.pps = clamp((this.W - 40) / d, 1.5, 900);
    this.t0 = 0;
    this.draw();
  }

  /** Amene un instant dans la vue (recentre s'il est loin). */
  ensureVisible(t, center = false) {
    const x = this.xOf(t);
    if (center || x < -20 || x > this.W + 20) {
      this.t0 = t - this.span * 0.4;
    } else if (x < 40) {
      this.t0 = t - 40 / this.pps;
    } else if (x > this.W - 60) {
      this.t0 = t - (this.W - 60) / this.pps;
    } else return;
    this.clampView(true);
    this.draw();
  }

  /** Suit la tete de lecture pendant la lecture. */
  followPlayhead(t) {
    const x = this.xOf(t);
    if (x < 0 || x > this.W - 16) {
      this.t0 = Math.max(0, t - this.span * 0.12);
      this.clampView(true);
    }
  }

  // ------------------------------------------------ defilement sur les bords

  /**
   * Un pas de defilement si le curseur est pres d'un bord.
   * Appele en continu pendant un glissement (et a chaque mouvement, pour que
   * ca marche meme quand les animations sont en pause).
   */
  _edgeStep() {
    if (this._edgeX === null || this._edgeX === undefined) return false;
    const r = this.canvas.getBoundingClientRect();
    const MARGIN = 48;
    let over = 0;
    if (this._edgeX < r.left + MARGIN) over = this._edgeX - (r.left + MARGIN);
    else if (this._edgeX > r.right - MARGIN) over = this._edgeX - (r.right - MARGIN);
    if (!over) return false;
    const speed = clamp(over / MARGIN, -3, 3);          // proche du bord -> plus vite
    const before = this.t0;
    this.t0 = Math.max(0, this.t0 + (speed * 14) / this.pps);
    this.clampView(true);
    if (this.t0 === before) return false;
    if (this._edgeOnScroll) this._edgeOnScroll();
    this.draw();
    return true;
  }

  /** Demarre le defilement automatique quand le curseur approche d'un bord. */
  _startEdgeScroll(onScroll) {
    this._edgeX = null;
    this._edgeOnScroll = onScroll;
    this._edgeActive = true;
    const loop = () => {
      if (!this._edgeActive) return;
      this._edgeStep();
      this._edgeRaf = requestAnimationFrame(loop);
    };
    this._edgeRaf = requestAnimationFrame(loop);
  }

  _stopEdgeScroll() {
    this._edgeActive = false;
    if (this._edgeRaf) cancelAnimationFrame(this._edgeRaf);
    this._edgeRaf = 0;
    this._edgeX = null;
    this._edgeOnScroll = null;
    this.clampView();
  }

  /** Position horizontale du pointeur, en secondes. */
  _timeAt(clientX) {
    const r = this.canvas.getBoundingClientRect();
    return this.tOf(clientX - r.left);
  }

  // ------------------------------------------------------------------- snap
  snapPoints(excludeIds = []) {
    const pts = [0, this.store.playhead];
    for (const tr of this.store.project.tracks) {
      for (const c of tr.clips) {
        if (excludeIds.includes(c.id)) continue;
        pts.push(c.t0, c.t0 + c.dur);
        // Les temps forts servent d'aimant : c'est ce qui rend les points
        // utiles, poser une coupe pile sur un « boum » devient automatique.
        if (c.beats && c.beats.length) for (const t of tempsTimeline(c)) pts.push(t);
      }
    }
    return pts;
  }

  applySnap(t, excludeIds) {
    if (!this.snap) return t;
    const tol = 8 / this.pps;
    let best = t, bd = tol;
    for (const p of this.snapPoints(excludeIds)) {
      const d = Math.abs(p - t);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  // -------------------------------------------------------------- interactions

  _bind() {
    const cv = this.canvas;

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (modKey(e)) {
        this.zoom(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.offsetX);
      } else if (e.shiftKey) {
        this.scrollY = clamp(this.scrollY + e.deltaY, 0, Math.max(0, this.contentHeight() - this.H));
        this.draw();
      } else {
        const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.t0 += dx / this.pps;
        this.clampView();
        this.draw();
      }
    }, { passive: false });

    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const h = this._hitTest(x, y);
      const cur = h ? (h.zone === 'l' || h.zone === 'r' ? 'ew-resize'
        : h.zone === 'trans' ? 'col-resize'
        : h.zone === 'fade' ? 'ew-resize'
        : (h.zone === 'mute' || h.zone === 'badge') ? 'pointer' : 'grab') : 'default';
      cv.style.cursor = cur;
      // info-bulle native
      cv.title = !h ? ''
        : h.zone === 'badge' ? h.badgeLabel + ' — cliquer pour retirer'
        : h.zone === 'fade' ? (h.isFade === 'in' ? 'Fondu entrant' : 'Fondu sortant') + ' — glisser (jusqu\'au bord pour l\'enlever)'
        : h.zone === 'mute' ? 'Couper / remettre le son'
        : h.zone === 'trans' ? 'Glisser pour un fondu enchaine'
        : '';
      const key = h ? h.clip.id + h.zone : null;
      if (key !== this.hover) { this.hover = key; this.draw(); }
    });
    cv.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });

    cv.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (y < RULER_H) return this._dragPlayhead(e, x);
      const h = this._hitTest(x, y);
      if (!h) {
        // zone vide : rectangle de selection (comme CapCut)
        this._dragMarquee(e, x, y, modKey(e) || e.shiftKey);
        return;
      }
      if (h.track.locked) { toast('Piste verrouillee', 'warn'); return; }
      // pastille d'effet : un clic la retire
      if (h.zone === 'badge') {
        this.removeEffect(h.clip, h.isBadge);
        toast(h.badgeLabel + ' retire', 'ok', 1600);
        return;
      }
      // poignee de fondu : glisser pour regler, jusqu'au bord pour enlever
      if (h.zone === 'fade') { this._dragFade(e, h, x); return; }
      // pastille haut-parleur : coupe / remet le son du clip
      if (h.zone === 'mute') {
        this.store.edit(h.clip.mute ? 'remettre le son' : 'couper le son', () => { h.clip.mute = !h.clip.mute; });
        this.player.invalidate();
        toast(h.clip.mute ? 'Son du clip coupe' : 'Son du clip reactive', 'ok', 1400);
        return;
      }
      // Ctrl / Maj + clic : on ajoute ou retire de la selection, SANS deplacer.
      // (avant, on lancait un deplacement du clip qu'on venait de deselectionner)
      if (modKey(e) || e.shiftKey) {
        this.store.select(h.clip.id, true);
        return;
      }
      const already = this.store.selection.clipIds.includes(h.clip.id);
      if (!already) this.store.select(h.clip.id);
      if (h.zone === 'l' || h.zone === 'r') this._dragTrim(e, h);
      else if (h.zone === 'trans') this._dragTransition(e, h);
      else this._dragMove(e, h);
    });

    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const h = this._hitTest(e.clientX - r.left, e.clientY - r.top);
      this._menu(e, h);
    });

    cv.addEventListener('dblclick', (e) => {
      const r = cv.getBoundingClientRect();
      const h = this._hitTest(e.clientX - r.left, e.clientY - r.top);
      if (h) { this.store.select(h.clip.id); this.store.emit('openInspector'); }
    });

    // depot depuis la bibliotheque
    this.wrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const types = [...(e.dataTransfer.types || [])];
      const hasMedia = types.includes('text/media-id');
      const isAudio = types.includes('text/kind-audio');
      // video/image -> bande sous la regle (nouvelle couche par-dessus)
      // audio       -> bande sous les pistes (nouvelle piste son a superposer)
      this.dropPreview = {
        t: Math.max(0, this.tOf(x)), showBand: hasMedia, audio: isAudio, newTrack: false, track: -1,
      };
      const inBand = hasMedia && (isAudio
        ? (y >= this.contentBottom() - 4 && y < this.contentBottom() + NEWBAND)
        : (y >= RULER_H - 2 && y < RULER_H + NEWBAND));
      this.dropPreview.newTrack = inBand;
      this.dropPreview.track = inBand ? -1 : this.trackAtY(y);
      this.dropPreview.t = this.applySnap(this.dropPreview.t, []);
      this.draw();
    });
    this.wrap.addEventListener('dragleave', () => { this.dropPreview = null; this.draw(); });
    this.wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      const dp = this.dropPreview;
      this.dropPreview = null;
      const mediaId = e.dataTransfer.getData('text/media-id');
      if (mediaId && dp) {
        this.store.emit('dropMedia', {
          mediaId, t: dp.t,
          // -2 = nouvelle couche video au-dessus, -3 = nouvelle piste audio
          trackIndex: dp.newTrack ? (dp.audio ? -3 : -2) : dp.track,
        });
      } else if (e.dataTransfer.files && e.dataTransfer.files.length) {
        this.store.emit('dropFiles', e.dataTransfer.files);
      }
      this.draw();
    });
  }

  _hitTest(x, y) {
    for (let i = this.hit.length - 1; i >= 0; i--) {
      const r = this.hit[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        if (r.isBadge) return { ...r, zone: 'badge' };
        if (r.isFade) return { ...r, zone: 'fade' };
        if (r.isMute) return { ...r, zone: 'mute' };
        if (r.isHandle) return { ...r, zone: 'trans' };
        let zone = 'body';
        if (x - r.x < EDGE) zone = 'l';
        else if (r.x + r.w - x < EDGE) zone = 'r';
        return { ...r, zone };
      }
    }
    return null;
  }

  _dragPlayhead(e, x0) {
    // on travaille en temps absolu : le defilement automatique reste coherent
    const apply = (clientX) => {
      let t = Math.max(0, this._timeAt(clientX));
      t = this.applySnap(t, []);
      this.player.seek(t);
    };
    apply(e.clientX);
    this._startEdgeScroll(() => apply(this._edgeX));
    drag(e, {
      cursor: 'ew-resize',
      onMove: (dx, dy, ev) => { this._edgeX = ev.clientX; this._edgeStep(); apply(ev.clientX); },
      onEnd: () => this._stopEdgeScroll(),
    });
  }

  /** Rectangle de selection : glisser dans le vide pour selectionner plusieurs clips. */
  _dragMarquee(ev, x0, y0, additive) {
    const store = this.store;
    const base = additive ? [...store.selection.clipIds] : [];
    let engaged = false;
    this.marquee = { x0, y0, x1: x0, y1: y0 };

    drag(ev, {
      cursor: 'crosshair',
      onMove: (dx, dy) => {
        if (!engaged && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        engaged = true;
        this.marquee.x1 = x0 + dx;
        this.marquee.y1 = y0 + dy;
        const r = {
          x0: Math.min(x0, this.marquee.x1), x1: Math.max(x0, this.marquee.x1),
          y0: Math.min(y0, this.marquee.y1), y1: Math.max(y0, this.marquee.y1),
        };
        const ids = new Set(base);
        for (const it of this.hit) {
          if (it.isHandle || it.track.locked) continue;
          if (it.x < r.x1 && it.x + it.w > r.x0 && it.y < r.y1 && it.y + it.h > r.y0) ids.add(it.clip.id);
        }
        store.select([...ids]);
        this.draw();
      },
      onEnd: () => {
        this.marquee = null;
        // simple clic dans le vide : on deselectionne et on place la tete de lecture
        this._stopEdgeScroll();
        if (!engaged) {
          store.select(base);
          this.player.seek(this.applySnap(Math.max(0, this.tOf(x0)), []));
        }
        this.draw();
      },
    });
  }

  _dragMove(ev, h) {
    const store = this.store;
    const picked = store.selectedClips.filter((s) => !s.track.locked);
    const set = picked.length ? picked : [{ clip: h.clip, track: h.track }];
    const orig = set.map((s) => ({ clip: s.clip, track: s.track, t0: s.clip.t0, ti: store.project.tracks.indexOf(s.track) }));
    const baseTrack = store.project.tracks.indexOf(h.track);
    // Position de depart figee : le clip bouge pendant le glissement, il ne faut
    // donc PAS s'y referer pour calculer le deplacement.
    const baseT0 = h.clip.t0;
    const grab = baseT0 - this._timeAt(ev.clientX);
    let started = false;

    const apply = (clientX, clientY) => {
      // temps absolu : suit le defilement automatique des bords
      const dt = (this._timeAt(clientX) + grab) - baseT0;

      // changement de piste d'apres la position verticale
      const r = this.canvas.getBoundingClientRect();
      const targetTi = this.trackAtY(clientY - r.top);
      const dti = targetTi >= 0 ? targetTi - baseTrack : 0;

      // accrochage sur le clip pointe
      let snapDelta = 0;
      if (this.snap) {
        const ids = orig.map((o) => o.clip.id);
        const wanted = baseT0 + dt;
        const snapA = this.applySnap(wanted, ids);
        const snapB = this.applySnap(wanted + h.clip.dur, ids) - h.clip.dur;
        snapDelta = Math.abs(snapA - wanted) <= Math.abs(snapB - wanted) ? snapA - wanted : snapB - wanted;
      }

      for (const o of orig) {
        o.clip.t0 = Math.max(0, o.t0 + dt + snapDelta);
        if (dti !== 0) {
          const ni = clamp(o.ti + dti, 0, store.project.tracks.length - 1);
          const nt = store.project.tracks[ni];
          if (nt !== o.track && !nt.locked && compatible(nt, o.clip)) {
            o.track.clips.splice(o.track.clips.indexOf(o.clip), 1);
            nt.clips.push(o.clip);
            o.track = nt;
          }
        }
      }
      for (const tr of store.project.tracks) normalizeTrack(tr);
      store.changed();
    };

    this._startEdgeScroll(() => { if (this._edgeX !== null) apply(this._edgeX, this._edgeY); });
    drag(ev, {
      cursor: 'grabbing',
      onMove: (dx, dy, e) => {
        if (!started) { store.beginLive('deplacer'); started = true; }
        this._edgeX = e.clientX; this._edgeY = e.clientY;
        this._edgeStep();
        apply(e.clientX, e.clientY);
      },
      onEnd: (moved) => {
        this._stopEdgeScroll();
        store.endLive();
        if (!moved) return;
        relayoutAll(store.project);   // recolle les pistes magnetiques
        store.changed();
        this.player.invalidate();
      },
    });
  }

  _dragTrim(ev, h) {
    const store = this.store;
    const clip = h.clip;
    const side = h.zone;
    const o = { t0: clip.t0, dur: clip.dur, in: clip.in };
    const media = mediaOf(store.project, clip);
    const srcDur = media ? media.duration : Infinity;
    const speed = clip.speed || 1;
    // reference en temps absolu (le bord saisi), pour suivre le defilement
    const refT = side === 'l' ? o.t0 : o.t0 + o.dur;
    const grab = refT - this._timeAt(ev.clientX);
    let started = false;

    const apply = (clientX) => {
        let dt = (this._timeAt(clientX) + grab) - refT;
        if (side === 'l') {
          let nt0 = this.applySnap(o.t0 + dt, [clip.id]);
          dt = nt0 - o.t0;
          // limite : ne pas depasser le debut de la source ni la fin du clip
          const maxBack = clip.kind === 'image' ? Infinity : o.in / speed;
          dt = Math.max(dt, -maxBack);
          dt = Math.min(dt, o.dur - MIN_DUR);
          if (o.t0 + dt < 0) dt = -o.t0;
          clip.t0 = o.t0 + dt;
          clip.dur = o.dur - dt;
          clip.in = Math.max(0, o.in + dt * speed);
        } else {
          let end = this.applySnap(o.t0 + o.dur + dt, [clip.id]);
          let ndur = Math.max(MIN_DUR, end - o.t0);
          if (clip.kind !== 'image' && isFinite(srcDur)) ndur = Math.min(ndur, (srcDur - clip.in) / speed);
          clip.dur = ndur;
        }
        // piste magnetique : on recolle en direct, les clips suivants suivent
        if (h.track.magnetic) compactTrack(h.track);
        store.changed();
    };

    this._startEdgeScroll(() => { if (this._edgeX !== null) apply(this._edgeX); });
    drag(ev, {
      cursor: 'ew-resize',
      onMove: (dx, dy, e) => {
        if (!started) { store.beginLive('rogner'); started = true; }
        this._edgeX = e.clientX;
        this._edgeStep();
        apply(e.clientX);
      },
      onEnd: () => {
        this._stopEdgeScroll();
        store.endLive();
        layoutTrack(h.track);
        store.changed();
        this.player.invalidate();
      },
    });
  }

  /** Poignee de fondu : video et audio couples, retour a zero = fondu enleve. */
  _dragFade(ev, h, x0) {
    const store = this.store;
    const clip = h.clip;
    const side = h.isFade;
    const clipX = this.xOf(clip.t0);
    const clipW = clip.dur * this.pps;
    let started = false;
    drag(ev, {
      cursor: 'ew-resize',
      onMove: (dx) => {
        if (!started) { store.beginLive('fondu'); started = true; }
        const px = x0 + dx;
        let v = side === 'in' ? (px - clipX) / this.pps : (clipX + clipW - px) / this.pps;
        v = clamp(v, 0, clip.dur * 0.9);
        if (v < 0.03) v = 0;                       // colle a zero : plus de fondu
        if (side === 'in') { clip.fadeIn = v; clip.aFadeIn = v; }
        else { clip.fadeOut = v; clip.aFadeOut = v; }
        store.changed();
      },
      onEnd: () => { store.endLive(); this.player.invalidate(); },
    });
  }

  _dragTransition(ev, h) {
    const store = this.store;
    const track = h.track;
    const i = track.clips.indexOf(h.clip);
    const prev = track.clips[i - 1];
    if (!prev) return;
    const o = { t0: h.clip.t0, after: track.clips.slice(i).map((c) => ({ c, t0: c.t0 })) };
    let started = false;
    drag(ev, {
      cursor: 'col-resize',
      onMove: (dx) => {
        if (!started) { store.beginLive('transition'); started = true; }
        const maxOv = Math.min(prev.dur, h.clip.dur) * 0.9;
        const dt = clamp(-dx / this.pps, 0, maxOv);
        for (const a of o.after) a.c.t0 = a.t0 - dt;
        prev.transition = { kind: dt > 0.01 ? 'dissolve' : 'none', dur: dt };
        if (track.magnetic) compactTrack(track);
        store.changed();
      },
      onEnd: () => { store.endLive(); layoutTrack(track); store.changed(); this.player.invalidate(); },
    });
  }

  _menu(e, h) {
    const store = this.store;
    const items = [];
    if (h) {
      if (!store.selection.clipIds.includes(h.clip.id)) store.select(h.clip.id);
      items.push(
        { label: 'Couper ici', key: 'S', fn: () => store.emit('cmd', 'split') },
        { label: 'Dupliquer', key: 'Ctrl+D', fn: () => store.emit('cmd', 'duplicate') },
        { label: 'Supprimer', key: 'Suppr', fn: () => store.emit('cmd', 'delete') },
        { label: 'Supprimer et combler', key: 'Maj+Suppr', fn: () => store.emit('cmd', 'rippleDelete') },
        { sep: true },
        { label: 'Ajouter un masque flou', fn: () => store.emit('cmd', 'addBlurMask') },
        { label: 'Detacher l\'audio', fn: () => store.emit('cmd', 'detachAudio') },
        { label: h.clip.beats && h.clip.beats.length ? 'Effacer les points de rythme' : 'Reperer le rythme',
          fn: () => store.emit('cmd', h.clip.beats && h.clip.beats.length ? 'clearBeats' : 'detectBeats') },
        { sep: true },
        { label: 'Fondu enchaine 0,5 s avec le suivant', fn: () => store.emit('cmd', 'transition', 0.5) },
        { label: 'Retirer la transition', fn: () => store.emit('cmd', 'transition', 0) },
      );
    } else {
      items.push(
        { label: 'Ajouter une piste video', fn: () => store.edit('piste video', (p) => { p.tracks.splice(indexOfLastVideo(p) + 1, 0, newTrack('video', 'Video ' + (countKind(p, 'video') + 1))); }) },
        { label: 'Ajouter une piste audio', fn: () => store.edit('piste audio', (p) => { p.tracks.push(newTrack('audio', 'Audio ' + (countKind(p, 'audio') + 1))); }) },
        { sep: true },
        { label: this.snap ? 'Desactiver l\'aimant' : 'Activer l\'aimant', fn: () => { this.snap = !this.snap; store.changed(); } },
        { label: 'Ajuster a la fenetre', fn: () => this.fit() },
      );
    }
    showMenu(e.clientX, e.clientY, items);
  }

  // ------------------------------------------------------------------- rendu

  _draw() {
    const cv = this.canvas, ctx = this.ctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#161618';
    ctx.fillRect(0, 0, w, h);

    const p = this.store.project;
    const tops = this.trackTops();
    this.hit = [];

    // fond des pistes
    for (let i = 0; i < p.tracks.length; i++) {
      const tr = p.tracks[i];
      // pistes sur le fond du panneau, separees d'un filet discret
      ctx.fillStyle = '#161618';
      ctx.fillRect(0, tops[i], w, tr.height);
      ctx.fillStyle = 'rgba(255,255,255,.03)';
      ctx.fillRect(0, tops[i] + tr.height - 1, w, 1);
    }

    this._drawGrid(ctx, w, h);

    // clips
    for (let i = 0; i < p.tracks.length; i++) {
      const tr = p.tracks[i];
      const y = tops[i];
      if (y + tr.height < RULER_H || y > h) continue;
      for (const clip of tr.clips) this._drawClip(ctx, clip, tr, i, y);
    }

    // apercu de depot
    if (this.dropPreview) {
      const dp = this.dropPreview;
      const x = this.xOf(dp.t);

      // bande « nouvelle couche » : sous la regle (video) ou sous les pistes (audio)
      if (dp.showBand) {
        const by = dp.audio ? this.contentBottom() : RULER_H + 2, bh = NEWBAND - 5;
        ctx.save();
        ctx.fillStyle = dp.newTrack ? 'rgba(79,124,255,.26)' : 'rgba(255,255,255,.04)';
        roundRect(ctx, 4, by, Math.max(40, w - 8), bh, 5);
        ctx.fill();
        ctx.strokeStyle = dp.newTrack ? '#6b91ff' : 'rgba(255,255,255,.22)';
        ctx.lineWidth = dp.newTrack ? 1.6 : 1;
        ctx.setLineDash([5, 4]);
        roundRect(ctx, 4.5, by + 0.5, Math.max(40, w - 9), bh - 1, 5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = dp.newTrack ? '#dbe6ff' : 'rgba(200,210,225,.6)';
        ctx.font = '600 10.5px Inter, Segoe UI, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(dp.audio
          ? `＋ ${this.nextAudioName()} — deposer ici pour un son en plus`
          : `＋ ${this.nextOverlayName()} — deposer ici pour superposer`, 12, by + bh / 2);
        ctx.restore();
      }

      const ti = dp.track;
      if (!dp.newTrack && ti >= 0) {
        ctx.fillStyle = 'rgba(79,124,255,.25)';
        ctx.fillRect(x, tops[ti], 90, p.tracks[ti].height);
      }
      ctx.strokeStyle = '#6b91ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H + this.bandH());
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // rectangle de selection
    if (this.marquee) {
      const m = this.marquee;
      const rx = Math.min(m.x0, m.x1), ry = Math.min(m.y0, m.y1);
      const rw = Math.abs(m.x1 - m.x0), rh = Math.abs(m.y1 - m.y0);
      ctx.fillStyle = 'rgba(79,124,255,.16)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = 'rgba(120,158,255,.9)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
      ctx.setLineDash([]);
    }

    this._drawRuler(ctx, w);
    this._drawPlayhead(ctx, h);
    this._syncHeaders(tops);
  }

  _drawGrid(ctx, w, h) {
    const step = niceStep(70 / this.pps);
    const first = Math.floor(this.t0 / step) * step;
    ctx.strokeStyle = 'rgba(255,255,255,.025)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = first; ; t += step) {
      const x = Math.round(this.xOf(t)) + 0.5;
      if (x > w) break;
      if (x < 0) continue;
      ctx.moveTo(x, RULER_H); ctx.lineTo(x, h);
    }
    ctx.stroke();
  }

  _drawRuler(ctx, w) {
    ctx.fillStyle = '#161618';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = '#232327';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(w, RULER_H - 0.5); ctx.stroke();

    const step = niceStep(70 / this.pps);
    const sub = step / 5;
    const first = Math.floor(this.t0 / step) * step;
    ctx.font = "11px 'Segoe UI Variable Text', 'Segoe UI', Inter, sans-serif";
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.beginPath();
    for (let t = first; ; t += sub) {
      const x = Math.round(this.xOf(t)) + 0.5;
      if (x > w) break;
      if (x < -2) continue;
      const major = Math.abs((t / step) % 1) < 1e-6;
      ctx.moveTo(x, RULER_H - (major ? 8 : 4)); ctx.lineTo(x, RULER_H - 1);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(160,160,170,.9)';
    for (let t = first; ; t += step) {
      const x = this.xOf(t);
      if (x > w + 40) break;
      if (x < -40 || t < 0) continue;
      ctx.fillText(fmtTime(t, step < 0.5 ? this.store.project.fps : 0), x + 5, 9);
    }
  }

  _drawPlayhead(ctx, h) {
    const x = Math.round(this.xOf(this.store.playhead)) + 0.5;
    if (x < -2 || x > this.W + 2) return;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, RULER_H - 8); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, x - 5, RULER_H - 15, 10, 11, 3);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 5, RULER_H - 6); ctx.lineTo(x + 5, RULER_H - 6); ctx.lineTo(x, RULER_H - 1); ctx.closePath();
    ctx.fill();
  }

  _drawClip(ctx, clip, track, ti, y) {
    const x = this.xOf(clip.t0);
    const w = Math.max(2, clip.dur * this.pps);
    if (x + w < 0 || x > this.W) return;
    const hgt = track.height;
    const selected = this.store.selection.clipIds.includes(clip.id);
    const media = mediaOf(this.store.project, clip);

    const rec = { clip, track, ti, x, y, w, h: hgt };
    const ovPrev = prevOverlap(track, clip);
    if (ovPrev > 0) rec.transX = x;
    this.hit.push(rec);

    ctx.save();
    roundRect(ctx, x, y + 1, w, hgt - 2, 7);
    ctx.clip();

    // fond (aplats sobres, sans degrade)
    const isAudio = track.kind === 'audio' || clip.kind === 'audio';
    ctx.fillStyle = clip.kind === 'text' ? '#3b3170' : isAudio ? '#1d7a45' : '#26262b';
    ctx.fillRect(x, y, w, hgt);

    // pellicule
    if (!isAudio && clip.kind !== 'text' && media && media.hasVideo && w > 24) {
      this._drawStrip(ctx, clip, media, x, y, w, hgt);
    }
    // forme d'onde
    if (isAudio && media) this._drawWave(ctx, clip, media, x, y, w, hgt);
    // points de rythme
    if (clip.beats && clip.beats.length) this._drawBeats(ctx, clip, x, y, w, hgt);

    // fondus video
    if (clip.fadeIn > 0) {
      const fw = Math.min(w, clip.fadeIn * this.pps);
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + fw, y); ctx.lineTo(x, y + hgt); ctx.fill();
    }
    if (clip.fadeOut > 0) {
      const fw = Math.min(w, clip.fadeOut * this.pps);
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w - fw, y); ctx.lineTo(x + w, y + hgt); ctx.fill();
    }

    // recouvrement (transition)
    if (ovPrev > 0) {
      const ow = ovPrev * this.pps;
      ctx.fillStyle = 'rgba(232,176,75,.22)';
      ctx.fillRect(x, y, ow, hgt);
      ctx.strokeStyle = 'rgba(232,176,75,.8)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y + hgt); ctx.lineTo(x + ow, y); ctx.stroke();
    }

    // bandeau de titre
    const label = clip.kind === 'text' ? (clip.text.content || 'Texte').slice(0, 40)
      : media ? media.name : clip.kind;
    ctx.textBaseline = 'middle';
    let tag = '';
    if (clip.masks && clip.masks.length) tag += '  ◍' + clip.masks.length;
    if (clip.speed && Math.abs(clip.speed - 1) > 0.001) tag += '  ' + clip.speed.toFixed(2).replace(/0$/, '') + '×';
    // place reservee a droite pour la pastille de son
    const hasSound = clip.kind !== 'text' && media && media.hasAudio;
    const reserve = hasSound && w > 46 ? 20 : 0;
    {
      const dureeTxt = clip.dur >= 60 ? fmtTime(clip.dur, 0) : clip.dur.toFixed(1).replace('.', ',') + ' s';
      ctx.font = "600 11px 'Segoe UI Variable Text', 'Segoe UI', Inter, sans-serif";
      const nomW = ctx.measureText(label + tag).width;
      ctx.font = "11px 'Segoe UI Variable Text', 'Segoe UI', Inter, sans-serif";
      const durW = ctx.measureText(dureeTxt).width;
      const dispo = Math.max(0, w - 12 - reserve);
      const plein = 8 + nomW + 7 + durW + 8;
      const pw = Math.min(dispo, plein);
      if (pw > 14) {
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        roundRect(ctx, x + 4, y + 4, pw, 17, 5);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = "600 11px 'Segoe UI Variable Text', 'Segoe UI', Inter, sans-serif";
        ctx.fillText(tronquer(ctx, label + tag, Math.max(4, pw - 16)), x + 12, y + 12.5);
        if (plein <= dispo) {
          ctx.fillStyle = 'rgba(255,255,255,.62)';
          ctx.font = "11px 'Segoe UI Variable Text', 'Segoe UI', Inter, sans-serif";
          ctx.fillText(dureeTxt, x + 12 + nomW + 7, y + 12.5);
        }
      }
    }

    ctx.restore();

    // --- pastilles d'effets appliques (cliquer pour retirer)
    if (w > 60) this._drawBadges(ctx, clip, track, ti, x, y, w, reserve);

    // --- poignees de fondu (comme CapCut) : glisser vers l'interieur
    if (selected && w > 30) {
      const fi = Math.min(clip.fadeIn * this.pps, w * 0.9);
      const fo = Math.min(clip.fadeOut * this.pps, w * 0.9);
      for (const [side, hx] of [['in', x + fi], ['out', x + w - fo]]) {
        ctx.beginPath();
        ctx.arc(hx, y + hgt - 11, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = 'rgba(8,10,14,.8)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        this.hit.push({ clip, track, ti, x: hx - 7, y: y + hgt - 18, w: 14, h: 14, isFade: side });
      }
    }

    // pastille haut-parleur cliquable
    if (reserve) {
      const bx = x + w - 21, by = y + 5;
      ctx.fillStyle = clip.mute ? 'rgba(239,91,100,.92)' : 'rgba(255,255,255,.14)';
      roundRect(ctx, bx, by, 15, 13, 3.5);
      ctx.fill();
      drawSpeaker(ctx, bx + 7.5, by + 6.5, clip.mute);
      this.hit.push({ clip, track, ti, x: bx - 1, y: by - 1, w: 17, h: 15, isMute: true });
    }

    // contour
    if (selected) {
      ctx.strokeStyle = '#2a7fff';
      ctx.lineWidth = 2.5;
      roundRect(ctx, x + 1.25, y + 2.25, w - 2.5, hgt - 4.5, 6);
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.lineWidth = 1;
      roundRect(ctx, x + 0.5, y + 1.5, w - 1, hgt - 3, 7);
      ctx.stroke();
    }

    // poignees de rognage
    if (selected || this.hover === clip.id + 'l' || this.hover === clip.id + 'r') {
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      roundRect(ctx, x + 2, y + hgt / 2 - 8, 3, 16, 1.5); ctx.fill();
      roundRect(ctx, x + w - 5, y + hgt / 2 - 8, 3, 16, 1.5); ctx.fill();
    }
    // poignee de transition entre clips accoles
    const i = track.clips.indexOf(clip);
    const next = track.clips[i + 1];
    if (next && Math.abs(next.t0 - (clip.t0 + clip.dur)) < 0.002 && w > 20) {
      const jx = this.xOf(next.t0);
      ctx.fillStyle = 'rgba(232,176,75,.9)';
      roundRect(ctx, jx - 7, y + 2.5, 14, 11, 3); ctx.fill();
      ctx.fillStyle = '#1a1206';
      ctx.font = '600 9px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⇄', jx, y + 8.5);
      ctx.textAlign = 'left';
      this.hit.push({ clip: next, track, ti, x: jx - 8, y, w: 16, h: 16, transX: jx, isHandle: true });
    }
  }

  /**
   * Liste des effets appliques a un clip, avec de quoi les retirer.
   * Sert aux pastilles sur le clip ET au bandeau sous la barre d'outils.
   */
  static effectsOf(clip) {
    const out = [];
    const c = clip.color || {};
    if (clip.masks && clip.masks.length) out.push({ kind: 'masks', glyph: '◍', label: `${clip.masks.length} masque(s)`, icon: 'mask' });
    if (clip.fadeIn > 0.001) out.push({ kind: 'fadeIn', glyph: '◤', label: 'Fondu entrant', icon: 'fade' });
    if (clip.fadeOut > 0.001) out.push({ kind: 'fadeOut', glyph: '◥', label: 'Fondu sortant', icon: 'fade' });
    if (clip.aFadeIn > 0.001) out.push({ kind: 'aFadeIn', glyph: '♪', label: 'Fondu audio entrant', icon: 'vol' });
    if (clip.aFadeOut > 0.001) out.push({ kind: 'aFadeOut', glyph: '♪', label: 'Fondu audio sortant', icon: 'vol' });
    if (Math.abs((clip.speed || 1) - 1) > 0.001) out.push({ kind: 'speed', glyph: '⏩', label: `Vitesse ${(clip.speed).toFixed(2).replace(/0$/, '')}×`, icon: 'fast' });
    if (clip.mute) out.push({ kind: 'mute', glyph: '✕', label: 'Son coupe', icon: 'vol-off' });
    if (Object.values(c).some((v) => Math.abs(v || 0) > 0.001)) out.push({ kind: 'color', glyph: '◐', label: 'Etalonnage', icon: 'color' });
    if (clip.chroma && clip.chroma.on) out.push({ kind: 'chroma', glyph: '⬢', label: 'Incrustation', icon: 'mask' });
    if (clip.x || clip.y || (clip.scale || 1) !== 1 || clip.rot || clip.flipH || clip.flipV) {
      out.push({ kind: 'transform', glyph: '⤢', label: 'Transformation', icon: 'expand' });
    }
    const cr = clip.crop || {};
    if (cr.l || cr.r || cr.t || cr.b) out.push({ kind: 'crop', glyph: '⌗', label: 'Rognage', icon: 'crop' });
    if (clip.kf && Object.keys(clip.kf).length) out.push({ kind: 'kf', glyph: '◆', label: 'Keyframes', icon: 'key' });
    if (clip.transition && clip.transition.dur > 0.001) out.push({ kind: 'transition', glyph: '⇄', label: 'Transition', icon: 'transition' });
    if (clip.reversed) out.push({ kind: 'reversed', glyph: '↺', label: 'Inverse', icon: 'reverse', info: true });
    return out;
  }

  /** Retire un effet d'un clip. */
  removeEffect(clip, kind) {
    const store = this.store;
    if (kind === 'reversed') return toast('Utilisez Ctrl+Z pour revenir a la source d\'origine', 'warn', 3000);
    store.edit('retirer ' + kind, () => {
      switch (kind) {
        case 'masks': clip.masks = []; store.selection.maskId = null; break;
        case 'fadeIn': clip.fadeIn = 0; break;
        case 'fadeOut': clip.fadeOut = 0; break;
        case 'aFadeIn': clip.aFadeIn = 0; break;
        case 'aFadeOut': clip.aFadeOut = 0; break;
        case 'mute': clip.mute = false; break;
        case 'chroma': if (clip.chroma) clip.chroma.on = false; break;
        case 'color': for (const k of Object.keys(clip.color || {})) clip.color[k] = 0; break;
        case 'crop': clip.crop = { l: 0, r: 0, t: 0, b: 0 }; break;
        case 'kf': clip.kf = {}; break;
        case 'transform':
          Object.assign(clip, { x: 0, y: 0, scale: 1, rot: 0, flipH: false, flipV: false });
          break;
        case 'speed': {
          const media = mediaOf(store.project, clip);
          const srcLen = clip.dur * (clip.speed || 1);
          clip.speed = 1;
          clip.dur = media && media.duration ? Math.min(srcLen, media.duration - clip.in) : srcLen;
          break;
        }
        case 'transition': {
          const f = store.project.tracks.find((t) => t.clips.includes(clip));
          if (f) {
            const i = f.clips.indexOf(clip);
            const next = f.clips[i + 1];
            const ov = clip.transition.dur;
            clip.transition = { kind: 'none', dur: 0 };
            if (next) for (let j = i + 1; j < f.clips.length; j++) f.clips[j].t0 += ov;
          }
          break;
        }
      }
      relayoutAll(store.project);
    });
    this.player.invalidate();
  }

  _drawBadges(ctx, clip, track, ti, x, y, w, reserve) {
    const fx = Timeline.effectsOf(clip).filter((e) => e.kind !== 'mute');
    if (!fx.length) return;
    const BW = 15, GAP = 2;
    let bx = x + w - reserve - 4;
    const maxN = Math.max(0, Math.floor((w - 48 - reserve) / (BW + GAP)));
    const show = fx.slice(0, maxN);
    ctx.save();
    ctx.font = '10px Inter, Segoe UI, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const e of show) {
      bx -= BW + GAP;
      ctx.fillStyle = 'rgba(79,124,255,.32)';
      roundRect(ctx, bx, y + 6, BW, 13, 3);
      ctx.fill();
      ctx.fillStyle = '#dbe6ff';
      ctx.fillText(e.glyph, bx + BW / 2, y + 12.5);
      this.hit.push({ clip, track, ti, x: bx - 1, y: y + 5, w: BW + 2, h: 15, isBadge: e.kind, badgeLabel: e.label });
    }
    ctx.restore();
  }

  _drawStrip(ctx, clip, media, x, y, w, hgt) {
    // la pellicule occupe tout le clip ; l'etiquette flotte par-dessus
    const stripY = y + 1;
    const stripH = hgt - 2;
    if (stripH < 8) return;
    // vignettes a l'instant exact de chaque tuile (voir lib.vignetteA)
    {
      const tw = Math.max(8, stripH * ((media.width || 16) / (media.height || 9)));
      const debut = Math.max(0, Math.floor(-x / tw));
      const fin = Math.ceil(Math.min(w, this.W - x) / tw);
      let gere = true;
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      ctx.fillRect(x, stripY, w, stripH);
      for (let i = debut; i < fin; i++) {
        const px = x + i * tw;
        const tSrc = clip.in + ((i + 0.5) * tw / this.pps) * (clip.speed || 1);
        // priorite : distance a la tete de lecture (ce qui est a l'ecran passe devant)
        const tTl = clip.t0 + (i + 0.5) * tw / this.pps;
        const bmp = this.lib.vignetteA(media.id, tSrc, this._redessiner || (this._redessiner = throttleRaf(() => this.draw())),
          Math.abs(tTl - this.store.playhead));
        if (bmp === undefined) { gere = false; break; }
        if (!bmp) continue;
        const bw = Math.min(tw, x + w - px);
        if (bw <= 0) continue;
        ctx.drawImage(bmp, 0, 0, bmp.width * (bw / tw), bmp.height, px, stripY, bw, stripH);
      }
      if (gere) return;
    }
    const want = clamp(Math.ceil(w / 70), 1, 24);
    const entry = this.lib.requestStrip(media.id, want, () => this.draw());
    if (!entry || !entry.bitmaps.length) {
      // aplat pendant la generation
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      ctx.fillRect(x, stripY, w, stripH);
      return;
    }
    const bmps = entry.bitmaps;
    const tw = Math.max(6, stripH * (bmps[0].width / bmps[0].height));
    const n = Math.ceil(w / tw);
    const srcDur = media.duration || 1;
    for (let i = 0; i < n; i++) {
      const px = x + i * tw;
      if (px > this.W || px + tw < 0) continue;
      const tClip = (i * tw) / this.pps;
      const tSrc = clip.in + tClip * (clip.speed || 1);
      const bi = clamp(Math.floor((tSrc / srcDur) * bmps.length), 0, bmps.length - 1);
      const bw = Math.min(tw, x + w - px);
      if (bw <= 0) continue;
      ctx.drawImage(bmps[bi], 0, 0, bmps[bi].width * (bw / tw), bmps[bi].height,
        px, stripY, bw, stripH);
    }
  }

  _drawWave(ctx, clip, media, x, y, w, hgt) {
    const env = this.lib.waves.get(media.id);
    const top = y + 22, hh = hgt - 25;
    if (!env) {
      if (!this.lib.waves.has(media.id)) this.lib.waveform(media.id).then(() => this.draw());
      ctx.strokeStyle = 'rgba(255,255,255,.25)';
      ctx.beginPath(); ctx.moveTo(x + 2, top + hh / 2); ctx.lineTo(x + w - 2, top + hh / 2); ctx.stroke();
      return;
    }
    ctx.fillStyle = 'rgba(150,240,180,.85)';
    const srcDur = media.duration || 1;
    const step = Math.max(1, Math.round(1));
    for (let px = 0; px < w; px += step) {
      const tSrc = clip.in + (px / this.pps) * (clip.speed || 1);
      const i = clamp(Math.floor((tSrc / srcDur) * env.length), 0, env.length - 1);
      const a = env[i] * hh * 0.48;
      ctx.fillRect(x + px, top + hh / 2 - a, step, a * 2 || 1);
    }
  }

  /**
   * Les temps forts, marques par un trait clair et une pointe en bas.
   *
   * Le trait traverse toute la hauteur du clip : c'est ce qui permet d'aligner
   * une coupe a l'oeil, et la pointe reste lisible quand la forme d'onde est
   * dense au meme endroit.
   */
  _drawBeats(ctx, clip, x, y, w, hgt) {
    const top = y + 15, bas = y + hgt;
    const temps = tempsTimeline(clip);
    if (!temps.length) return;
    ctx.save();
    // Un liftage sombre sous la bande des pastilles : sans lui, un point tombant
    // sur une vignette claire devient invisible, or c'est justement la qu'on a
    // besoin de le voir pour caler une coupe.
    const bandeH = 9;
    ctx.fillStyle = 'rgba(8,10,14,.5)';
    ctx.fillRect(x, bas - bandeH, w, bandeH);
    for (const t of temps) {
      const px = Math.round(this.xOf(t)) + 0.5;
      if (px < x - 1 || px > x + w + 1) continue;
      // trait sombre d'abord, trait clair par-dessus : lisible sur tous les fonds
      ctx.strokeStyle = 'rgba(8,10,14,.55)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bas - bandeH); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,214,102,.85)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bas - bandeH); ctx.stroke();
      ctx.fillStyle = '#ffd666';
      ctx.beginPath();
      ctx.moveTo(px, bas - bandeH);
      ctx.lineTo(px - 4, bas - 1);
      ctx.lineTo(px + 4, bas - 1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // --------------------------------------------------------------- en-tetes

  _syncHeaders(tops) {
    const p = this.store.project;
    const host = this.headers;
    const sig = p.tracks.map((t) => t.id).join(',');
    if (host.dataset.sig !== sig) {
      host.dataset.sig = sig;
      host.innerHTML = '';
      host.append(el('div', { class: 'tl-corner' }));
      for (const tr of p.tracks) host.append(this._headerRow(tr));
    }
    const rows = [...host.children].slice(1);
    p.tracks.forEach((tr, i) => {
      const row = rows[i];
      if (!row) return;
      row.style.top = tops[i] + 'px';
      row.style.height = tr.height + 'px';
      row.dataset.id = tr.id;
      row.querySelector('.tn').textContent = tr.name;
      row.classList.toggle('muted', !!tr.muted);
      row.classList.toggle('hidden-tr', !!tr.hidden);
      row.classList.toggle('locked', !!tr.locked);
      row.classList.toggle('magnetic', !!tr.magnetic);
      const [bEye, bMute, bLock, bMag] = row.querySelectorAll('button');
      if (!bEye || !bEye.querySelector('use')) return;
      // visibilite : seulement pour la video
      bEye.classList.toggle('hidden', tr.kind === 'audio');
      bEye.querySelector('use').setAttribute('href', tr.hidden ? '#i-eye-off' : '#i-eye');
      bEye.title = tr.hidden ? 'Afficher la piste' : 'Masquer la piste';
      bEye.classList.toggle('off', !!tr.hidden);
      // son : pour toutes les pistes, video comprise
      bMute.querySelector('use').setAttribute('href', tr.muted ? '#i-vol-off' : '#i-vol');
      bMute.title = tr.muted
        ? `Remettre le son de « ${tr.name} »`
        : `Couper le son de « ${tr.name} »`;
      bMute.classList.toggle('off', !!tr.muted);
      bLock.querySelector('use').setAttribute('href', tr.locked ? '#i-lock' : '#i-unlock');
      bLock.title = tr.locked ? 'Deverrouiller' : 'Verrouiller';
      bMag.classList.toggle('act', !!tr.magnetic);
      bMag.title = tr.magnetic
        ? 'Piste collee : aucun trou, le premier clip demarre a 0:00 (cliquer pour liberer)'
        : 'Piste libre (cliquer pour coller les clips sans trou)';
    });
    host.style.height = this.H + 'px';
  }

  _headerRow(track) {
    const store = this.store;
    const ic = (name) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('class', 'i');
      const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      u.setAttribute('href', '#i-' + name);
      s.append(u);
      return s;
    };
    const row = el('div', { class: 'tl-head' },
      el('span', { class: 'tn', text: track.name }),
      el('div', { class: 'tbtns' },
        // 1) visibilite (video uniquement)
        el('button', {
          class: 'eyebtn',
          onclick: () => {
            store.edit('piste', () => {
              const tr = store.project.tracks.find((t) => t.id === row.dataset.id);
              if (tr) tr.hidden = !tr.hidden;
            });
            this.player.invalidate();
          },
        }, ic('eye')),
        // 2) son de la piste — y compris pour une piste VIDEO
        el('button', {
          class: 'mutebtn',
          onclick: () => {
            store.edit('son de la piste', () => {
              const tr = store.project.tracks.find((t) => t.id === row.dataset.id);
              if (tr) tr.muted = !tr.muted;
            });
            this.player.invalidate();
            const tr = store.project.tracks.find((t) => t.id === row.dataset.id);
            if (tr) toast(tr.muted ? `Son de « ${tr.name} » coupe` : `Son de « ${tr.name} » reactive`, 'ok', 1500);
          },
        }, ic('vol')),
        el('button', {
          onclick: () => store.edit('piste', () => {
            const tr = store.project.tracks.find((t) => t.id === row.dataset.id);
            if (tr) tr.locked = !tr.locked;
          }),
        }, ic('unlock')),
        el('button', {
          class: 'magbtn',
          onclick: () => {
            store.edit('piste collee', () => {
              const tr = store.project.tracks.find((t) => t.id === row.dataset.id);
              if (!tr) return;
              tr.magnetic = !tr.magnetic;
              layoutTrack(tr);
            });
            this.player.invalidate();
          },
        }, ic('magnet')),
        el('button', {
          title: 'Options de la piste',
          onclick: (e) => {
            const tr = store.project.tracks.find((t) => t.id === row.dataset.id);
            showMenu(e.clientX, e.clientY, [
              { label: 'Renommer', fn: () => { const n = prompt('Nom de la piste', tr.name); if (n) store.edit('renommer', () => { tr.name = n; }); } },
              { label: 'Vider la piste', fn: () => store.edit('vider', () => { tr.clips.length = 0; }) },
              { label: 'Supprimer la piste', fn: () => store.edit('supprimer piste', (p) => {
                if (p.tracks.length <= 1) return toast('Il faut au moins une piste', 'warn');
                p.tracks.splice(p.tracks.indexOf(tr), 1);
              }) },
              { sep: true },
              { label: 'Piste plus haute', fn: () => store.edit('hauteur', () => { tr.height = clamp(tr.height + 14, 32, 160); }) },
              { label: 'Piste plus basse', fn: () => store.edit('hauteur', () => { tr.height = clamp(tr.height - 14, 32, 160); }) },
            ]);
          },
        }, ic('more')),
      ),
      // poignee de hauteur : glisser pour agrandir / rétrécir la piste
      el('div', {
        class: 'tr-grip', title: 'Glisser pour changer la hauteur de la piste',
        onpointerdown: (e) => {
          const tr = store.project.tracks.find((t) => t.id === row.dataset.id);
          if (!tr) return;
          const h0 = tr.height;
          let started = false;
          drag(e, {
            cursor: 'row-resize',
            onMove: (dx, dy) => {
              if (!started) { store.beginLive('hauteur de piste'); started = true; }
              tr.height = clamp(Math.round(h0 + dy), 34, 220);
              store.changed();
            },
            onEnd: () => store.endLive(),
          });
        },
      }),
    );
    row.dataset.id = track.id;
    return row;
  }
}

// ------------------------------------------------------------------ utilitaires

function compatible(track, clip) {
  const clipAudio = clip.kind === 'audio';
  return track.kind === 'audio' ? clipAudio : !clipAudio;
}

function prevOverlap(track, clip) {
  const i = track.clips.indexOf(clip);
  if (i <= 0) return 0;
  const prev = track.clips[i - 1];
  return Math.max(0, (prev.t0 + prev.dur) - clip.t0);
}

/** Conserve pour compatibilite : delegue au modele. */
export const resolveOverlaps = layoutTrack;

function indexOfLastVideo(p) {
  let last = 0;
  p.tracks.forEach((t, i) => { if (t.kind === 'video') last = i; });
  return last;
}
function countKind(p, k) { return p.tracks.filter((t) => t.kind === k).length; }

/** Petit haut-parleur dessine au canvas (centre en cx,cy). */
function drawSpeaker(ctx, cx, cy, muted) {
  ctx.save();
  ctx.strokeStyle = muted ? '#2a0d10' : 'rgba(255,255,255,.92)';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 1.1;
  ctx.lineCap = 'round';
  // corps
  ctx.beginPath();
  ctx.moveTo(cx - 3.4, cy - 1.4);
  ctx.lineTo(cx - 1.8, cy - 1.4);
  ctx.lineTo(cx + 0.2, cy - 3.4);
  ctx.lineTo(cx + 0.2, cy + 3.4);
  ctx.lineTo(cx - 1.8, cy + 1.4);
  ctx.lineTo(cx - 3.4, cy + 1.4);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  if (muted) {
    ctx.moveTo(cx + 1.6, cy - 2); ctx.lineTo(cx + 4.4, cy + 2);
    ctx.moveTo(cx + 4.4, cy - 2); ctx.lineTo(cx + 1.6, cy + 2);
  } else {
    ctx.arc(cx + 0.6, cy, 2.4, -0.9, 0.9);
    ctx.moveTo(cx + 3.6, cy - 2.6);
    ctx.arc(cx + 0.6, cy, 3.9, -0.75, 0.75);
  }
  ctx.stroke();
  ctx.restore();
}

/** Coupe un texte trop long avec « … » (au lieu de l'ecraser en largeur). */
function tronquer(ctx, txt, max) {
  if (ctx.measureText(txt).width <= max) return txt;
  let a = 0, b = txt.length;
  while (a < b) {
    const m = (a + b + 1) >> 1;
    if (ctx.measureText(txt.slice(0, m) + '…').width <= max) a = m; else b = m - 1;
  }
  return a > 0 ? txt.slice(0, a) + '…' : '';
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------- menu contextuel

export function showMenu(x, y, items) {
  document.querySelectorAll('.ctxmenu').forEach((n) => n.remove());
  const m = el('div', { class: 'ctxmenu' });
  for (const it of items) {
    if (it.sep) { m.append(el('div', { class: 'sep' })); continue; }
    m.append(el('div', {
      class: 'mi' + (it.disabled ? ' dis' : ''),
      onclick: () => { if (!it.disabled) { m.remove(); it.fn && it.fn(); } },
    }, el('span', { text: it.label }), it.key ? el('kbd', { text: it.key }) : null));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  const close = (e) => {
    if (m.contains(e.target)) return;
    m.remove();
    window.removeEventListener('pointerdown', close, true);
  };
  setTimeout(() => window.addEventListener('pointerdown', close, true), 0);
  return m;
}
