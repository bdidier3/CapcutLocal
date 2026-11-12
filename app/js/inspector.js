// Panneau de proprietes : transformation, masques, etalonnage, audio, texte.
import { el, clamp, fmtTime, toast } from './util.js';
import {
  animVal, setKey, removeKey, keyAt, hasKeys, allKeyTimes,
  newMask, MASK_SHAPES, MASK_EFFECTS, DEFAULT_COLOR, DEFAULT_CHROMA, mediaOf,
  layoutTrack, findClip,
} from './state.js';
import { invalidateText } from './compose.js';
import { FONTS, fontCss, TEXT_STYLES, applyStyle, ANCHORS } from './fonts.js';
import { detecterTemps, dejaAnalyse, tempsTimeline } from './beats.js';

export class Inspector {
  constructor(host, store, player, lib, overlay) {
    this.host = host;
    this.store = store;
    this.player = player;
    this.lib = lib;
    this.overlay = overlay;
    this.syncers = [];
    this.open = { transform: true, mask: true, color: false, chroma: false, audio: true, rythme: true, speed: true, text: true };
    store.on('selection', () => this.render());
    store.on('reload', () => this.render());
    store.on('change', (what) => { if (what === 'structure') this.render(); else this.sync(); });
    store.on('seek', () => this.sync());
  }

  get tLocal() {
    const s = this.store.soleClip;
    return s ? this.store.playhead - s.clip.t0 : 0;
  }

  // ------------------------------------------------------------- construction

  section(key, title, ...children) {
    const body = el('div', { class: 'sec-body' }, ...children);
    const head = el('div', {
      class: 'sec-head',
      onclick: () => { this.open[key] = !this.open[key]; wrap.classList.toggle('closed', !this.open[key]); },
    }, el('span', { class: 'chev', text: '▸' }), el('span', { text: title }));
    const wrap = el('div', { class: 'sec' + (this.open[key] ? '' : ' closed') }, head, body);
    return wrap;
  }

  /** Ligne slider + valeur + keyframe. */
  ctrl(o) {
    const { host, prop, label, min, max, step, pct, unit, animatable } = o;
    const get = () => (animatable ? animVal(host, prop, this.tLocal) : host[prop]) ?? 0;
    const disp = (v) => (pct ? (v * 100).toFixed(Math.abs(v * 100) < 10 ? 1 : 0) : (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1)));

    const range = el('input', { type: 'range', min, max, step, value: get() });
    const num = el('input', { class: 'num', type: 'text', value: disp(get()) });
    const kfBtn = animatable ? el('button', { class: 'kf', title: 'Keyframe a la tete de lecture' }) : null;

    const apply = (v, live) => {
      v = clamp(v, min, max);
      if (!live) this.store.snapshot(label);
      if (animatable && (hasKeys(host, prop) || (this.overlay.autoKey && this.forceKf))) {
        setKey(host, prop, this.tLocal, v);
      } else {
        host[prop] = v;
      }
      if (o.after) o.after();
      this.store.changed();
      this.player.invalidate();
      sync();
    };

    let dragging = false;
    range.addEventListener('pointerdown', () => { dragging = true; this.store.beginLive(label); });
    range.addEventListener('input', () => apply(parseFloat(range.value), true));
    range.addEventListener('change', () => { dragging = false; this.store.endLive(); });
    range.addEventListener('dblclick', () => { if (o.def !== undefined) apply(o.def); });
    num.addEventListener('change', () => {
      let v = parseFloat(num.value.replace(',', '.'));
      if (isNaN(v)) return sync();
      apply(pct ? v / 100 : v);
    });
    num.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1) * (pct ? 0.01 : step * 10);
        apply(get() + d);
      }
    });
    if (kfBtn) {
      kfBtn.addEventListener('click', () => {
        const k = keyAt(host, prop, this.tLocal);
        this.store.snapshot('keyframe');
        if (k) removeKey(host, prop, this.tLocal);
        else setKey(host, prop, this.tLocal, get());
        this.store.changed();
        this.player.invalidate();
        sync();
      });
    }

    const sync = () => {
      const v = get();
      if (document.activeElement !== range) range.value = v;
      if (document.activeElement !== num) num.value = disp(v) + (unit || (pct ? '%' : ''));
      if (kfBtn) {
        const has = hasKeys(host, prop);
        const at = has && keyAt(host, prop, this.tLocal);
        kfBtn.textContent = at ? '◆' : has ? '◇' : '◇';
        kfBtn.className = 'kf' + (at ? ' on' : has ? ' has' : '');
      }
    };
    this.syncers.push(sync);
    sync();
    return el('div', { class: 'ctrl' },
      el('label', { text: label }),
      el('div', { class: 'ctrl-row' }, range, num, kfBtn));
  }

  check(host, prop, label, after) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!host[prop];
    cb.addEventListener('change', () => {
      this.store.edit(label, () => { host[prop] = cb.checked; });
      after && after();
      this.player.invalidate();
    });
    this.syncers.push(() => { cb.checked = !!host[prop]; });
    return el('label', { class: 'chk' }, cb, el('span', { text: label }));
  }

  select(host, prop, label, options, after) {
    const s = el('select');
    for (const o of options) s.append(el('option', { value: o.id, text: o.label }));
    s.value = host[prop];
    s.addEventListener('change', () => {
      this.store.edit(label, () => { host[prop] = s.value; });
      after && after();
      this.player.invalidate();
    });
    this.syncers.push(() => { s.value = host[prop]; });
    return el('div', { class: 'ctrl' }, el('label', { text: label }), s);
  }

  // ------------------------------------------------------------------- rendu

  render() {
    this.syncers = [];
    const host = this.host;
    host.innerHTML = '';
    const sel = this.store.selectedClips;

    if (sel.length === 0) {
      host.append(el('div', { class: 'empty' },
        el('div', { class: 'big', text: '⌘' }),
        el('p', { text: 'Selectionnez un clip dans la timeline pour afficher ses proprietes.' }),
        el('p', { class: 'dim', text: 'Astuce : double-cliquez sur un clip pour l\'ouvrir.' })));
      return;
    }
    if (sel.length > 1) {
      host.append(el('div', { class: 'empty' }, el('p', { text: `${sel.length} clips selectionnes` })));
      host.append(this._multi(sel));
      return;
    }

    const { clip, track } = sel[0];
    const media = mediaOf(this.store.project, clip);

    host.append(el('div', { class: 'insp-head' },
      el('div', { class: 'title', text: clip.kind === 'text' ? (clip.text.content || 'Texte').slice(0, 28) : (media ? media.name : clip.kind) }),
      el('div', { class: 'sub', text: `${fmtTime(clip.dur, this.store.project.fps)} • ${track.name}` +
        (media && media.width ? ` • ${media.width}×${media.height}${media.fps ? ' ' + media.fps.toFixed(2) + 'i/s' : ''}` : '') })));

    if (clip.kind === 'text') host.append(this._text(clip));

    if (track.kind !== 'audio' && clip.kind !== 'audio') {
      host.append(this._masks(clip));
      host.append(this._transform(clip));
      if (clip.kind !== 'text') host.append(this._color(clip));
      if (clip.kind !== 'text') host.append(this._chroma(clip));
    }
    host.append(this._speed(clip, media));
    if (clip.kind !== 'text' && (!media || media.hasAudio || media.kind === 'audio')) {
      host.append(this._audio(clip));
      if (media) host.append(this._rythme(clip, media));
    }
    this.sync();
  }

  sync() { for (const f of this.syncers) { try { f(); } catch (_) {} } }

  _multi(sel) {
    const wrap = el('div', { class: 'sec-body' });
    const mk = (label, fn) => el('button', { class: 'btn', text: label, onclick: () => { this.store.edit(label, () => sel.forEach(({ clip }) => fn(clip))); this.player.invalidate(); } });
    wrap.append(el('div', { class: 'btn-grid' },
      mk('Muet', (c) => { c.mute = true; }),
      mk('Son actif', (c) => { c.mute = false; }),
      mk('Fondu 0,5 s', (c) => { c.fadeIn = c.fadeOut = 0.5; c.aFadeIn = c.aFadeOut = 0.5; }),
      mk('Sans fondu', (c) => { c.fadeIn = c.fadeOut = c.aFadeIn = c.aFadeOut = 0; }),
      mk('Reinitialiser', (c) => { c.x = 0; c.y = 0; c.scale = 1; c.rot = 0; c.opacity = 1; c.kf = {}; }),
    ));
    return wrap;
  }

  // ----------------------------------------------------------------- masques

  _masks(clip) {
    const store = this.store;
    const addBar = el('div', { class: 'mask-add' },
      ...MASK_SHAPES.map((s) => el('button', {
        class: 'shape', title: 'Ajouter : ' + s.label,
        onclick: () => {
          store.edit('ajouter masque', () => {
            const m = newMask(s.id);
            clip.masks.push(m);
            store.selection.maskId = m.id;
          });
          this.render();
          this.player.invalidate();
        },
      }, el('span', { class: 'ic', text: s.icon }), el('span', { text: s.label }))));

    const list = el('div', { class: 'mask-list' });
    clip.masks.forEach((m, i) => {
      const active = store.selection.maskId === m.id;
      const row = el('div', { class: 'mask-item' + (active ? ' on' : ''), onclick: () => { store.selection.maskId = m.id; this.render(); } },
        el('span', { class: 'ic', text: (MASK_SHAPES.find((s) => s.id === m.shape) || {}).icon || '◯' }),
        el('span', { class: 'nm', text: `${(MASK_SHAPES.find((s) => s.id === m.shape) || {}).label} · ${(MASK_EFFECTS.find((e) => e.id === m.effect) || {}).label}` }),
        el('button', {
          class: 'mini', title: m.hidden ? 'Afficher' : 'Ignorer',
          text: m.hidden ? '○' : '●',
          onclick: (e) => { e.stopPropagation(); store.edit('masque', () => { m.hidden = !m.hidden; }); this.render(); this.player.invalidate(); },
        }),
        el('button', {
          class: 'mini', title: 'Dupliquer', text: '⧉',
          onclick: (e) => {
            e.stopPropagation();
            store.edit('dupliquer masque', () => {
              const c = JSON.parse(JSON.stringify(m));
              c.id = 'm' + Math.random().toString(36).slice(2, 9);
              c.cx = clamp(c.cx + 0.04, 0, 1); c.cy = clamp(c.cy + 0.04, 0, 1);
              clip.masks.splice(i + 1, 0, c);
              store.selection.maskId = c.id;
            });
            this.render(); this.player.invalidate();
          },
        }),
        el('button', {
          class: 'mini danger', title: 'Supprimer', text: '✕',
          onclick: (e) => {
            e.stopPropagation();
            store.edit('supprimer masque', () => {
              clip.masks.splice(i, 1);
              if (store.selection.maskId === m.id) store.selection.maskId = clip.masks.length ? clip.masks[0].id : null;
            });
            this.render(); this.player.invalidate();
          },
        }));
      list.append(row);
    });

    const body = [addBar, list];

    if (!clip.masks.length) {
      body.push(el('p', { class: 'hint', text: 'Ajoutez un masque puis deplacez-le directement sur l\'apercu. Le flou s\'applique a l\'interieur du masque.' }));
    } else {
      const m = clip.masks.find((x) => x.id === store.selection.maskId) || clip.masks[0];
      store.selection.maskId = m.id;
      const detail = el('div', { class: 'mask-detail' });

      detail.append(this.select(m, 'effect', 'Effet', MASK_EFFECTS, () => this.render()));
      if (m.effect === 'blur' || m.effect === 'mosaic') {
        detail.append(this.ctrl({ host: m, prop: 'strength', label: m.effect === 'blur' ? 'Intensite du flou' : 'Taille des carreaux', min: 0, max: 100, step: 1, animatable: true, def: 55 }));
      }
      detail.append(this.ctrl({ host: m, prop: 'cx', label: 'Position X', min: -0.5, max: 1.5, step: 0.001, pct: true, animatable: true, def: 0.5 }));
      detail.append(this.ctrl({ host: m, prop: 'cy', label: 'Position Y', min: -0.5, max: 1.5, step: 0.001, pct: true, animatable: true, def: 0.5 }));
      if (m.shape !== 'linear') detail.append(this.ctrl({ host: m, prop: 'w', label: 'Largeur', min: 0.005, max: 3, step: 0.001, pct: true, animatable: true, def: 0.3 }));
      if (m.shape !== 'linear') detail.append(this.ctrl({ host: m, prop: 'h', label: 'Hauteur', min: 0.005, max: 3, step: 0.001, pct: true, animatable: true, def: 0.3 }));
      detail.append(this.ctrl({ host: m, prop: 'rot', label: 'Rotation', min: -180, max: 180, step: 0.5, unit: '°', animatable: true, def: 0 }));
      detail.append(this.ctrl({ host: m, prop: 'feather', label: 'Contour progressif', min: 0, max: 0.5, step: 0.002, pct: true, animatable: true, def: 0.03 }));
      if (m.shape === 'rect') detail.append(this.ctrl({ host: m, prop: 'round', label: 'Coins arrondis', min: 0, max: 0.3, step: 0.002, pct: true, def: 0.02 }));
      detail.append(el('div', { class: 'row-2' },
        this.check(m, 'invert', 'Inverser'),
        el('button', {
          class: 'btn sm', text: 'Effacer les keyframes',
          onclick: () => { this.store.edit('keyframes', () => { m.kf = {}; }); this.render(); this.player.invalidate(); },
        })));

      detail.append(this._tracking(clip, m));
      body.push(detail);
    }

    return this.section('mask', `Masques & flou${clip.masks.length ? ' (' + clip.masks.length + ')' : ''}`, ...body);
  }

  /** Bloc « suivi du mouvement » : points de trajectoire du masque. */
  _tracking(clip, m) {
    const pts = this.overlay.trackTimes(m);
    const t = this.tLocal;
    const atPoint = pts.find((x) => Math.abs(x - t) < 0.02);

    const addPoint = () => {
      this.store.snapshot('point de suivi');
      const cx = animVal(m, 'cx', t), cy = animVal(m, 'cy', t);
      setKey(m, 'cx', t, cx);
      setKey(m, 'cy', t, cy);
      this.store.changed();
      this.player.invalidate();
      this.render();
    };
    const delPoint = () => {
      if (atPoint === undefined) return;
      this.store.snapshot('retirer un point');
      removeKey(m, 'cx', atPoint);
      removeKey(m, 'cy', atPoint);
      this.store.changed();
      this.player.invalidate();
      this.render();
    };

    const wrap = el('div', { class: 'track-box' });
    wrap.append(el('div', { class: 'grp nb', text: 'Suivi du mouvement' }));
    wrap.append(el('div', { class: 'kfbar' },
      el('button', {
        class: 'btn sm', title: 'Point precedent', text: '‹',
        onclick: () => this._gotoPoint(clip, pts, -1),
      }),
      el('span', { class: 'dim', text: pts.length ? `${pts.length} point${pts.length > 1 ? 's' : ''}` : 'aucun point' }),
      el('button', {
        class: 'btn sm', title: 'Point suivant', text: '›',
        onclick: () => this._gotoPoint(clip, pts, 1),
      })));
    wrap.append(el('div', { class: 'row-2' },
      el('button', {
        class: 'btn sm' + (atPoint !== undefined ? ' on' : ''),
        text: atPoint !== undefined ? '◆ Point ici' : '＋ Poser un point',
        title: 'Ajoute un point de trajectoire a la position actuelle de la tete de lecture',
        onclick: addPoint,
      }),
      el('button', {
        class: 'btn sm', text: '✕ Retirer',
        title: 'Retire le point situe a la tete de lecture',
        onclick: delPoint,
      })));
    if (pts.length) {
      wrap.append(el('button', {
        class: 'btn sm wide', text: 'Effacer tout le suivi',
        onclick: () => {
          this.store.edit('effacer le suivi', () => { delete m.kf.cx; delete m.kf.cy; });
          this.render(); this.player.invalidate();
        },
      }));
    }
    const ak = el('input', { type: 'checkbox' });
    ak.checked = this.overlay.autoKey;
    ak.addEventListener('change', () => { this.overlay.autoKey = ak.checked; });
    wrap.append(el('label', { class: 'chk' }, ak, el('span', { text: 'Point automatique en deplacant' })));
    wrap.append(el('p', {
      class: 'hint',
      text: pts.length
        ? 'Avancez dans la video puis deplacez le rond sur le visage : un point est ajoute et le flou suit le mouvement entre les points. Les ronds verts sur l\'apercu sont deplacables ; clic droit pour en retirer un.'
        : 'Posez un point, avancez de quelques images, deplacez le rond sur le visage : le flou suivra automatiquement.',
    }));
    return wrap;
  }

  _gotoPoint(clip, pts, dir) {
    const t = this.tLocal;
    const cand = dir > 0 ? pts.find((x) => x > t + 0.001) : [...pts].reverse().find((x) => x < t - 0.001);
    if (cand === undefined) return toast('Pas d\'autre point', 'warn', 1400);
    this.player.seek(clip.t0 + cand);
  }

  // ------------------------------------------------------------ transformation

  _transform(clip) {
    const c = [];
    if (clip.kind !== 'text') {
      c.push(this.select(clip, 'fit', 'Cadrage', [
        { id: 'cover', label: 'Remplir (recadre)' },
        { id: 'contain', label: 'Contenir (bandes noires)' },
        { id: 'fill', label: 'Etirer' },
      ]));
    }
    c.push(this.ctrl({ host: clip, prop: 'x', label: 'Position X', min: -2, max: 2, step: 0.001, pct: true, animatable: true, def: 0 }));
    c.push(this.ctrl({ host: clip, prop: 'y', label: 'Position Y', min: -2, max: 2, step: 0.001, pct: true, animatable: true, def: 0 }));
    c.push(this.ctrl({ host: clip, prop: 'scale', label: 'Echelle', min: 0.02, max: 6, step: 0.005, pct: true, animatable: true, def: 1 }));
    c.push(this.ctrl({ host: clip, prop: 'rot', label: 'Rotation', min: -360, max: 360, step: 0.5, unit: '°', animatable: true, def: 0 }));
    c.push(this.ctrl({ host: clip, prop: 'opacity', label: 'Opacite', min: 0, max: 1, step: 0.01, pct: true, animatable: true, def: 1 }));
    c.push(el('div', { class: 'row-2' }, this.check(clip, 'flipH', 'Miroir H'), this.check(clip, 'flipV', 'Miroir V')));
    const crop = clip.crop;
    c.push(el('div', { class: 'grp', text: 'Rognage' }));
    c.push(this.ctrl({ host: crop, prop: 'l', label: 'Gauche', min: 0, max: 0.9, step: 0.002, pct: true, def: 0 }));
    c.push(this.ctrl({ host: crop, prop: 'r', label: 'Droite', min: 0, max: 0.9, step: 0.002, pct: true, def: 0 }));
    c.push(this.ctrl({ host: crop, prop: 't', label: 'Haut', min: 0, max: 0.9, step: 0.002, pct: true, def: 0 }));
    c.push(this.ctrl({ host: crop, prop: 'b', label: 'Bas', min: 0, max: 0.9, step: 0.002, pct: true, def: 0 }));
    c.push(el('div', { class: 'grp', text: 'Fondus video' }));
    c.push(this.ctrl({ host: clip, prop: 'fadeIn', label: 'Fondu entrant', min: 0, max: Math.max(0.1, clip.dur / 2), step: 0.01, unit: ' s', def: 0 }));
    c.push(this.ctrl({ host: clip, prop: 'fadeOut', label: 'Fondu sortant', min: 0, max: Math.max(0.1, clip.dur / 2), step: 0.01, unit: ' s', def: 0 }));
    c.push(el('button', {
      class: 'btn', text: 'Reinitialiser la transformation',
      onclick: () => {
        this.store.edit('reinit', () => {
          Object.assign(clip, { x: 0, y: 0, scale: 1, rot: 0, opacity: 1, flipH: false, flipV: false });
          clip.crop = { l: 0, r: 0, t: 0, b: 0 };
          for (const k of ['x', 'y', 'scale', 'rot', 'opacity']) if (clip.kf) delete clip.kf[k];
        });
        this.render(); this.player.invalidate();
      },
    }));
    return this.section('transform', 'Transformation', ...c);
  }

  // ---------------------------------------------------------------- etalonnage

  _color(clip) {
    const k = clip.color;
    const rows = [
      ['exposure', 'Exposition', -2, 2, 0.01],
      ['contrast', 'Contraste', -1, 1, 0.01],
      ['saturation', 'Saturation', -1, 2, 0.01],
      ['temperature', 'Temperature', -1, 1, 0.01],
      ['tint', 'Teinte', -1, 1, 0.01],
      ['highlights', 'Hautes lumieres', -1, 1, 0.01],
      ['shadows', 'Ombres', -1, 1, 0.01],
      ['vignette', 'Vignettage', 0, 1, 0.01],
      ['sharpen', 'Nettete', 0, 1, 0.01],
    ].map(([prop, label, min, max, step]) =>
      this.ctrl({ host: k, prop, label, min, max, step, pct: true, def: DEFAULT_COLOR[prop] }));
    rows.push(el('button', {
      class: 'btn', text: 'Reinitialiser l\'etalonnage',
      onclick: () => { this.store.edit('etalonnage', () => { Object.assign(clip.color, DEFAULT_COLOR); }); this.render(); this.player.invalidate(); },
    }));
    return this.section('color', 'Etalonnage', ...rows);
  }

  _chroma(clip) {
    if (!clip.chroma) clip.chroma = { ...DEFAULT_CHROMA };
    const k = clip.chroma;
    const swatch = el('input', { type: 'color', value: rgbToHex(k.r, k.g, k.b) });
    swatch.addEventListener('input', () => {
      const [r, g, b] = hexToRgb01(swatch.value);
      this.store.edit('incrustation', () => { k.r = r; k.g = g; k.b = b; });
      this.player.invalidate();
    });
    return this.section('chroma', 'Incrustation couleur',
      this.check(k, 'on', 'Activer'),
      el('div', { class: 'ctrl' }, el('label', { text: 'Couleur cle' }), swatch),
      this.ctrl({ host: k, prop: 'tol', label: 'Tolerance', min: 0, max: 1, step: 0.005, pct: true, def: 0.35 }),
      this.ctrl({ host: k, prop: 'soft', label: 'Adoucissement', min: 0.001, max: 0.5, step: 0.002, pct: true, def: 0.12 }),
      this.ctrl({ host: k, prop: 'spill', label: 'Anti-debordement', min: 0, max: 1, step: 0.01, pct: true, def: 0.2 }));
  }

  // -------------------------------------------------------------------- vitesse

  /** Recolle la piste du clip apres un changement de duree. */
  _relayout(clip) {
    const f = findClip(this.store.project, clip.id);
    if (f) layoutTrack(f.track);
  }

  _speed(clip, media) {
    const store = this.store;
    const presets = [0.25, 0.5, 1, 1.5, 2, 4];
    const setSpeed = (v) => {
      store.edit('vitesse', () => {
        const oldSpeed = clip.speed || 1;
        const srcLen = clip.dur * oldSpeed;
        clip.speed = v;
        clip.dur = srcLen / v;
        if (media && media.duration) clip.dur = Math.min(clip.dur, (media.duration - clip.in) / v);
        this._relayout(clip);
      });
      this.render(); this.player.invalidate();
    };
    return this.section('speed', 'Vitesse & duree',
      el('div', { class: 'btn-grid' }, ...presets.map((v) => el('button', {
        class: 'btn sm' + (Math.abs((clip.speed || 1) - v) < 1e-6 ? ' on' : ''),
        text: v + '×', onclick: () => setSpeed(v),
      }))),
      this.ctrl({ host: clip, prop: 'speed', label: 'Vitesse', min: 0.1, max: 8, step: 0.01, def: 1, after: () => {
        if (media && media.duration) clip.dur = Math.min(clip.dur, (media.duration - clip.in) / clip.speed);
        this._relayout(clip);
      } }),
      this.ctrl({ host: clip, prop: 'dur', label: 'Duree sur la timeline', min: 0.05, max: 3600, step: 0.01, unit: ' s',
        after: () => this._relayout(clip) }),
      el('p', { class: 'hint', text: media && media.duration ? `Source : ${fmtTime(media.duration)} — entree a ${fmtTime(clip.in)}` : '' }));
  }

  // --------------------------------------------------------------------- audio

  _audio(clip) {
    return this.section('audio', 'Audio',
      this.check(clip, 'mute', 'Muet'),
      this.ctrl({ host: clip, prop: 'volume', label: 'Volume', min: 0, max: 3, step: 0.01, pct: true, def: 1 }),
      this.ctrl({ host: clip, prop: 'aFadeIn', label: 'Fondu entrant', min: 0, max: Math.max(0.1, clip.dur / 2), step: 0.01, unit: ' s', def: 0 }),
      this.ctrl({ host: clip, prop: 'aFadeOut', label: 'Fondu sortant', min: 0, max: Math.max(0.1, clip.dur / 2), step: 0.01, unit: ' s', def: 0 }));
  }

  // -------------------------------------------------------------------- rythme

  /**
   * Points de rythme : les « boums » du morceau, poses sur le clip.
   *
   * Le reglage de sensibilite ne relance pas l'analyse — la courbe est gardee en
   * memoire, seul le choix des pics est refait, ce qui le rend instantane et
   * permet de chercher le bon niveau en glissant le curseur.
   */
  _rythme(clip, media) {
    const compte = el('span', { class: 'faint tiny' });
    const majCompte = () => {
      const n = clip.beats ? clip.beats.length : 0;
      const vus = tempsTimeline(clip).length;
      compte.textContent = !n ? 'aucun point'
        : vus === n ? `${n} point(s)` : `${vus} point(s) visibles sur ${n}`;
    };
    majCompte();

    const bouton = el('button', { class: 'btn sm primary' }, 'Detecter les temps');
    const etat = el('span', { class: 'faint tiny' });

    const sensi = el('input', {
      type: 'range', min: 0, max: 1, step: 0.02, value: clip.sensiBeat ?? 0.5,
      title: 'Plus haut : davantage de points, y compris les coups discrets',
    });

    const valeurSensi = el('span', { class: 'num-lite' });
    const majSensi = () => { valeurSensi.textContent = Math.round(sensi.value * 100) + ' %'; };
    majSensi();

    const poser = async (live) => {
      const file = this.lib.file(clip.mediaId);
      if (!file) return toast('Fichier du media introuvable', 'warn');
      bouton.disabled = true;
      const rapide = dejaAnalyse(clip.mediaId);
      if (!rapide) etat.textContent = 'analyse…';
      try {
        const temps = await detecterTemps(file, clip.mediaId, {
          sensibilite: +sensi.value,
          avance: rapide ? null : (part) => { etat.textContent = 'analyse ' + Math.round(part * 100) + ' %'; },
        });
        // Pendant l'analyse la selection a pu changer : on ne repose pas des
        // points sur un clip que l'utilisateur ne regarde plus.
        if (!findClip(this.store.project, clip.id)) return;
        this.store.edit(live ? 'sensibilite du rythme' : 'detecter les temps', () => {
          clip.beats = temps;
          clip.sensiBeat = +sensi.value;
        });
        majCompte();
        etat.textContent = '';
        if (!temps.length) toast('Aucun temps net trouve — montez la sensibilite', 'warn');
      } catch (e) {
        etat.textContent = '';
        toast('Analyse impossible : ' + e.message, 'error');
      } finally {
        bouton.disabled = false;
      }
    };

    bouton.onclick = () => poser(false);
    // Le curseur ne sert a rien tant qu'aucune analyse n'a eu lieu.
    sensi.oninput = () => { majSensi(); if (clip.beats) poser(true); };

    const ajouter = el('button', { class: 'btn sm' }, 'Point ici');
    ajouter.title = 'Poser un point a la tete de lecture';
    ajouter.onclick = () => {
      const local = this.store.playhead - clip.t0;
      if (local < 0 || local > clip.dur) return toast("La tete de lecture n'est pas sur ce clip", 'warn');
      const src = clip.in + local * (clip.speed || 1);
      this.store.edit('poser un point', () => {
        clip.beats = [...(clip.beats || []), src].sort((a, b) => a - b);
      });
      majCompte();
    };

    const retirer = el('button', { class: 'btn sm' }, 'Retirer');
    retirer.title = 'Retirer le point le plus proche de la tete de lecture';
    retirer.onclick = () => {
      if (!clip.beats || !clip.beats.length) return;
      const local = this.store.playhead - clip.t0;
      const src = clip.in + local * (clip.speed || 1);
      let best = -1, bd = Infinity;
      clip.beats.forEach((t, i) => { const d = Math.abs(t - src); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return;
      this.store.edit('retirer un point', () => { clip.beats = clip.beats.filter((_, i) => i !== best); });
      majCompte();
    };

    const vider = el('button', { class: 'btn sm' }, 'Tout effacer');
    vider.onclick = () => {
      this.store.edit('effacer les points', () => { clip.beats = null; });
      majCompte();
    };

    return this.section('rythme', 'Rythme',
      el('div', { class: 'row-btns' }, bouton, etat, compte),
      el('div', { class: 'ctrl' },
        el('label', { text: 'Sensibilite' }),
        el('div', { class: 'ctrl-row' }, sensi, valeurSensi)),
      el('div', { class: 'row-btns' }, ajouter, retirer, vider),
      el('p', {
        class: 'hint',
        text: "Les points marquent les attaques du son. Avec l'aimant actif, les clips"
          + " et les coupes viennent s'y coller.",
      }));
  }

  // --------------------------------------------------------------------- texte

  _text(clip) {
    const t = clip.text;
    const after = () => { invalidateText(clip.id); };

    // --- styles prets a l'emploi
    const styles = el('div', { class: 'style-grid' });
    for (const st of TEXT_STYLES) {
      const chip = el('button', {
        class: 'style-chip' + (t.style === st.id ? ' on' : ''),
        title: st.label,
        onclick: () => {
          this.store.edit('style de texte', () => applyStyle(t, st));
          invalidateText(clip.id);
          this.render(); this.player.invalidate();
        },
      }, el('span', { class: 'sp', text: 'Aa' }), el('em', { text: st.label }));
      const c = st.css;
      const sp = chip.querySelector('.sp');
      sp.style.fontFamily = fontCss(c.font || 'classic');
      sp.style.fontWeight = c.weight || 700;
      sp.style.color = c.color || '#fff';
      if (c.bg && c.bg !== 'none') { sp.style.background = c.bg; sp.style.padding = '0 4px'; sp.style.borderRadius = '3px'; }
      if (c.stroke) sp.style.webkitTextStroke = `${Math.max(0.6, c.stroke * 1.6)}px ${c.strokeColor || '#000'}`;
      if (c.glow) sp.style.textShadow = `0 0 7px ${c.glowColor || '#38e1ff'}`;
      else if (c.shadow) sp.style.textShadow = '0 1px 3px rgba(0,0,0,.8)';
      styles.append(chip);
    }

    // --- police
    const fontSel = el('select');
    for (const f of FONTS) {
      const o = el('option', { value: f.id, text: f.label });
      o.style.fontFamily = f.css;
      fontSel.append(o);
    }
    fontSel.value = t.font || 'classic';
    fontSel.style.fontFamily = fontCss(t.font);
    fontSel.addEventListener('change', () => {
      this.store.edit('police', () => { t.font = fontSel.value; delete t.family; });
      fontSel.style.fontFamily = fontCss(t.font);
      after(); this.player.invalidate();
    });

    // --- 9 emplacements
    const grid = el('div', { class: 'anchor-grid' });
    for (const a of ANCHORS) {
      grid.append(el('button', {
        class: 'anchor', title: 'Placer ici',
        onclick: () => {
          this.store.edit('emplacement', () => { clip.x = a.x; clip.y = a.y; });
          this.render(); this.player.invalidate();
        },
      }, el('span', { text: a.label })));
    }

    const ta = el('textarea', { rows: 3, spellcheck: 'false' });
    ta.value = t.content;
    ta.addEventListener('input', () => {
      this.store.beginLive('texte');
      t.content = ta.value;
      invalidateText(clip.id);
      this.store.changed();
      this.player.invalidate();
    });
    ta.addEventListener('blur', () => this.store.endLive());

    const colorIn = el('input', { type: 'color', value: t.color });
    colorIn.addEventListener('input', () => { this.store.beginLive('couleur'); t.color = colorIn.value; invalidateText(clip.id); this.store.changed(); this.player.invalidate(); });
    const strokeIn = el('input', { type: 'color', value: t.strokeColor });
    strokeIn.addEventListener('input', () => { this.store.beginLive('contour'); t.strokeColor = strokeIn.value; invalidateText(clip.id); this.store.changed(); this.player.invalidate(); });

    const glowIn = el('input', { type: 'color', value: t.glowColor || '#38e1ff' });
    glowIn.addEventListener('input', () => { this.store.beginLive('halo'); t.glowColor = glowIn.value; after(); this.store.changed(); this.player.invalidate(); });

    const bgBtns = el('div', { class: 'btn-grid' },
      ...[['none', 'Aucun'], ['#000000', 'Noir'], ['#ffffff', 'Blanc'], ['#4f7cff', 'Bleu'], ['#ff3d8b', 'Rose']]
        .map(([v, lbl]) => el('button', {
          class: 'btn sm' + (t.bg === v ? ' on' : ''), text: lbl,
          onclick: () => { this.store.edit('fond du texte', () => { t.bg = v; }); after(); this.render(); this.player.invalidate(); },
        })));

    return this.section('text', 'Texte',
      ta,
      el('div', { class: 'grp nb', text: 'Style' }),
      styles,
      el('div', { class: 'ctrl' }, el('label', { text: 'Police' }), fontSel),
      el('div', { class: 'grp nb', text: 'Emplacement' }),
      grid,
      el('p', { class: 'hint', text: 'Vous pouvez aussi glisser le texte directement sur l\'apercu, et le redimensionner par les coins jaunes.' }),
      this.ctrl({ host: t, prop: 'size', label: 'Taille', min: 0.01, max: 0.5, step: 0.002, pct: true, def: 0.05, after }),
      this.ctrl({ host: clip, prop: 'scale', label: 'Echelle', min: 0.05, max: 6, step: 0.005, pct: true, animatable: true, def: 1 }),
      this.ctrl({ host: clip, prop: 'x', label: 'Position X', min: -2, max: 2, step: 0.001, pct: true, animatable: true, def: 0 }),
      this.ctrl({ host: clip, prop: 'y', label: 'Position Y', min: -2, max: 2, step: 0.001, pct: true, animatable: true, def: 0 }),
      this.ctrl({ host: clip, prop: 'rot', label: 'Rotation', min: -180, max: 180, step: 0.5, unit: '°', animatable: true, def: 0 }),
      el('div', { class: 'grp nb', text: 'Apparence' }),
      el('div', { class: 'row-2' },
        el('div', { class: 'ctrl' }, el('label', { text: 'Couleur' }), colorIn),
        el('div', { class: 'ctrl' }, el('label', { text: 'Contour' }), strokeIn)),
      this.ctrl({ host: t, prop: 'weight', label: 'Graisse', min: 100, max: 900, step: 100, def: 700, after }),
      this.ctrl({ host: t, prop: 'stroke', label: 'Epaisseur du contour', min: 0, max: 1, step: 0.02, pct: true, def: 0, after }),
      this.ctrl({ host: t, prop: 'shadow', label: 'Ombre', min: 0, max: 1, step: 0.02, pct: true, def: 0.35, after }),
      this.ctrl({ host: t, prop: 'glow', label: 'Halo lumineux', min: 0, max: 1, step: 0.02, pct: true, def: 0, after }),
      el('div', { class: 'ctrl' }, el('label', { text: 'Couleur du halo' }), glowIn),
      el('div', { class: 'ctrl' }, el('label', { text: 'Fond' }), bgBtns),
      this.ctrl({ host: t, prop: 'lineHeight', label: 'Interligne', min: 0.8, max: 2.5, step: 0.02, def: 1.2, after }),
      this.select(t, 'align', 'Alignement', [{ id: 'left', label: 'Gauche' }, { id: 'center', label: 'Centre' }, { id: 'right', label: 'Droite' }], after),
      this.check(t, 'italic', 'Italique', after));
  }
}

function rgbToHex(r, g, b) {
  const h = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
function hexToRgb01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
