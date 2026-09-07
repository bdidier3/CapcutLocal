// Modele de projet, keyframes, historique undo/redo.
import { Emitter, uid, clamp } from './util.js';

// ------------------------------------------------------------ valeurs par defaut

export const DEFAULT_COLOR = {
  exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0,
  highlights: 0, shadows: 0, vignette: 0, sharpen: 0,
};

export const DEFAULT_CHROMA = { on: false, r: 0, g: 1, b: 0, tol: 0.35, soft: 0.12, spill: 0.2 };

/** Proprietes animables d'un clip (nom -> {min,max,step,label,unit}) */
export const CLIP_ANIM = {
  x: { min: -2, max: 2, step: 0.001, label: 'Position X', pct: true },
  y: { min: -2, max: 2, step: 0.001, label: 'Position Y', pct: true },
  scale: { min: 0.02, max: 8, step: 0.001, label: 'Echelle', pct: true },
  rot: { min: -360, max: 360, step: 0.1, label: 'Rotation', unit: '°' },
  opacity: { min: 0, max: 1, step: 0.01, label: 'Opacite', pct: true },
};

export const MASK_ANIM = {
  cx: { min: -0.5, max: 1.5, step: 0.001, label: 'Centre X', pct: true },
  cy: { min: -0.5, max: 1.5, step: 0.001, label: 'Centre Y', pct: true },
  w: { min: 0.005, max: 3, step: 0.001, label: 'Largeur', pct: true },
  h: { min: 0.005, max: 3, step: 0.001, label: 'Hauteur', pct: true },
  rot: { min: -180, max: 180, step: 0.5, label: 'Rotation', unit: '°' },
  feather: { min: 0, max: 0.5, step: 0.002, label: 'Contour progressif', pct: true },
  strength: { min: 0, max: 100, step: 1, label: 'Intensite' },
};

export const MASK_SHAPES = [
  { id: 'rect', label: 'Rectangle', icon: '▭' },
  { id: 'ellipse', label: 'Ellipse', icon: '◯' },
  { id: 'linear', label: 'Lineaire', icon: '▬' },
  { id: 'mirror', label: 'Miroir', icon: '≡' },
  { id: 'poly', label: 'Forme libre', icon: '⬟' },
];

export const MASK_EFFECTS = [
  { id: 'blur', label: 'Flou' },
  { id: 'mosaic', label: 'Mosaique' },
  { id: 'black', label: 'Noir' },
  { id: 'reveal', label: 'Garder l\'interieur' },
  { id: 'hide', label: 'Masquer l\'interieur' },
];

export function newMask(shape = 'ellipse', over = {}) {
  return {
    id: uid('m'),
    shape,
    effect: 'blur',
    cx: 0.5, cy: 0.5,
    w: shape === 'linear' || shape === 'mirror' ? 1.2 : 0.3,
    h: shape === 'linear' ? 1.2 : shape === 'mirror' ? 0.3 : 0.3,
    rot: 0,
    feather: 0.03,
    strength: 55,
    invert: false,
    round: shape === 'rect' ? 0.02 : 0,
    pts: shape === 'poly'
      ? [[0.35, 0.3], [0.65, 0.3], [0.72, 0.62], [0.5, 0.75], [0.28, 0.62]]
      : [],
    kf: {},
    ...over,
  };
}

export function newClip(over = {}) {
  return {
    id: uid('c'),
    kind: 'video',
    mediaId: null,
    t0: 0, dur: 5, in: 0, speed: 1,
    // transformation
    fit: 'cover',
    x: 0, y: 0, scale: 1, rot: 0, opacity: 1,
    flipH: false, flipV: false,
    crop: { l: 0, r: 0, t: 0, b: 0 },
    color: { ...DEFAULT_COLOR },
    chroma: { ...DEFAULT_CHROMA },
    fadeIn: 0, fadeOut: 0,
    // audio
    volume: 1, aFadeIn: 0, aFadeOut: 0, mute: false,
    // temps forts du son, en secondes depuis le debut du FICHIER : ainsi ils
    // resistent au rognage et au changement de vitesse
    beats: null, sensiBeat: 0.5,
    // transition sortante vers le clip suivant de la piste
    transition: { kind: 'none', dur: 0 },
    masks: [],
    text: null,
    kf: {},
    ...over,
  };
}

export function newTextClip(content = 'Texte') {
  const c = newClip({
    kind: 'text', dur: 4,
    fit: 'none',            // le texte garde sa taille reelle (pas d'etirement)
    text: {
      content, size: 0.05, font: 'classic', weight: 700, style: 'classic',
      color: '#ffffff', align: 'center', italic: false,
      stroke: 0, strokeColor: '#000000',
      bg: 'none', bgPad: 0.016, shadow: 0.45,
      glow: 0, glowColor: '#38e1ff',
      letterSpacing: 0, lineHeight: 1.2,
    },
  });
  return c;
}

export function newTrack(kind = 'video', name, over = {}) {
  return {
    id: uid('t'), kind,
    name: name || (kind === 'video' ? 'Video' : 'Audio'),
    clips: [], muted: false, hidden: false, locked: false, height: kind === 'video' ? 62 : 46,
    volume: 1,
    // piste magnetique : les clips restent colles, le premier demarre a 0:00
    magnetic: false,
    ...over,
  };
}

export function newProject(over = {}) {
  const p = {
    version: 1,
    name: 'Projet sans titre',
    width: 1920, height: 1080, fps: 30, sampleRate: 48000,
    background: '#000000',
    media: [],
    tracks: [newTrack('video', 'Video 1', { magnetic: true }), newTrack('audio', 'Audio 1')],
    ...over,
  };
  return p;
}

/** Complete un projet charge d'une ancienne version. */
export function migrateProject(p) {
  if (!p || !p.tracks) return p;
  let firstVideo = true;
  for (const t of p.tracks) {
    if (t.magnetic === undefined) {
      t.magnetic = t.kind === 'video' && firstVideo;
    }
    if (t.kind === 'video') firstVideo = false;
    if (t.volume === undefined) t.volume = 1;
    // le texte ne doit pas etre etire pour remplir l'image
    for (const c of t.clips || []) if (c.kind === 'text' && c.fit !== 'none') c.fit = 'none';
    for (const c of t.clips || []) {
      if (c.beats === undefined) c.beats = null;
      if (c.sensiBeat === undefined) c.sensiBeat = 0.5;
    }
  }
  return p;
}

// ------------------------------------------------------------------- keyframes

/** Ajoute/remplace un keyframe. t est relatif au debut du clip (secondes). */
export function setKey(host, prop, t, v) {
  if (!host.kf) host.kf = {};
  const arr = host.kf[prop] || (host.kf[prop] = []);
  t = Math.round(t * 1000) / 1000;
  const i = arr.findIndex((k) => Math.abs(k.t - t) < 0.0005);
  if (i >= 0) arr[i].v = v;
  else { arr.push({ t, v }); arr.sort((a, b) => a.t - b.t); }
  host[prop] = v;
}

export function removeKey(host, prop, t) {
  const arr = host.kf && host.kf[prop];
  if (!arr) return;
  const i = arr.findIndex((k) => Math.abs(k.t - t) < 0.02);
  if (i >= 0) arr.splice(i, 1);
  if (arr.length === 0) delete host.kf[prop];
}

export function keyAt(host, prop, t) {
  const arr = host.kf && host.kf[prop];
  if (!arr) return null;
  return arr.find((k) => Math.abs(k.t - t) < 0.02) || null;
}

export function hasKeys(host, prop) {
  return !!(host.kf && host.kf[prop] && host.kf[prop].length);
}

/** Interpolation douce (ease in/out) entre keyframes. */
function ease(t) { return t * t * (3 - 2 * t); }

/** Valeur animee de host[prop] au temps local t. */
export function animVal(host, prop, t) {
  const arr = host.kf && host.kf[prop];
  if (!arr || arr.length === 0) return host[prop];
  if (arr.length === 1) return arr[0].v;
  if (t <= arr[0].t) return arr[0].v;
  const last = arr[arr.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) lo = mid; else hi = mid; }
  const a = arr[lo], b = arr[hi];
  const span = b.t - a.t;
  const f = span <= 0 ? 0 : ease((t - a.t) / span);
  return a.v + (b.v - a.v) * f;
}

/** Liste triee de tous les temps de keyframes d'un hote. */
export function allKeyTimes(host) {
  const set = new Set();
  for (const arr of Object.values(host.kf || {})) for (const k of arr) set.add(Math.round(k.t * 1000) / 1000);
  return [...set].sort((a, b) => a - b);
}

// --------------------------------------------------------------------- requetes

export function projectDuration(p) {
  let d = 0;
  for (const tr of p.tracks) for (const c of tr.clips) d = Math.max(d, c.t0 + c.dur);
  return d;
}

export function findClip(p, id) {
  for (const tr of p.tracks) {
    const c = tr.clips.find((x) => x.id === id);
    if (c) return { clip: c, track: tr };
  }
  return null;
}

export function mediaOf(p, clip) {
  return clip.mediaId ? p.media.find((m) => m.id === clip.mediaId) : null;
}

/** Trie les clips d'une piste par position. */
export function normalizeTrack(track) {
  track.clips.sort((a, b) => a.t0 - b.t0);
}

/**
 * Recolle les clips d'une piste : le premier demarre a 0:00 et il n'y a aucun
 * trou. Les recouvrements volontaires (transitions) sont conserves.
 */
export function compactTrack(track) {
  const cl = track.clips;
  cl.sort((a, b) => a.t0 - b.t0);
  let cursor = 0;
  for (let i = 0; i < cl.length; i++) {
    const c = cl[i];
    const next = cl[i + 1];
    c.t0 = cursor;
    let ov = 0;
    if (next && c.transition && c.transition.dur > 0) {
      ov = Math.min(c.transition.dur, Math.min(c.dur, next.dur) * 0.9);
      c.transition.dur = ov;
      c.transition.kind = ov > 0.01 ? (c.transition.kind === 'none' ? 'dissolve' : c.transition.kind) : 'none';
    } else if (!next && c.transition && c.transition.dur > 0) {
      c.transition = { kind: 'none', dur: 0 };   // plus de clip suivant
    }
    cursor = c.t0 + c.dur - ov;
  }
}

/** Piste libre : on empeche seulement les chevauchements involontaires. */
export function separateTrack(track) {
  normalizeTrack(track);
  for (let i = 1; i < track.clips.length; i++) {
    const a = track.clips[i - 1], b = track.clips[i];
    const wanted = (a.transition && a.transition.dur) || 0;
    const ov = (a.t0 + a.dur) - b.t0;
    if (ov > wanted + 1e-4) b.t0 = a.t0 + a.dur - wanted;
  }
}

/** Applique la bonne mise en page selon le mode de la piste. */
export function layoutTrack(track) {
  if (!track) return;
  if (track.magnetic) compactTrack(track);
  else separateTrack(track);
}

export function relayoutAll(project) {
  for (const t of project.tracks) layoutTrack(t);
}

/** Clips actifs a l'instant t (avec temps local). */
export function activeAt(p, t) {
  const out = [];
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const tr = p.tracks[ti];
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (t >= c.t0 - 1e-6 && t < c.t0 + c.dur - 1e-6) {
        out.push({ clip: c, track: tr, trackIndex: ti, tLocal: t - c.t0 });
      }
    }
  }
  return out;
}

/** Temps source correspondant a un temps local du clip. */
export function sourceTime(clip, tLocal) {
  return clip.in + tLocal * (clip.speed || 1);
}

/** Opacite resultant des fondus video. */
export function fadeGain(clip, tLocal) {
  let g = 1;
  if (clip.fadeIn > 0 && tLocal < clip.fadeIn) g *= tLocal / clip.fadeIn;
  const rem = clip.dur - tLocal;
  if (clip.fadeOut > 0 && rem < clip.fadeOut) g *= Math.max(0, rem / clip.fadeOut);
  return clamp(g, 0, 1);
}

export function audioGain(clip, tLocal) {
  let g = clip.mute ? 0 : (clip.volume ?? 1);
  if (clip.aFadeIn > 0 && tLocal < clip.aFadeIn) g *= tLocal / clip.aFadeIn;
  const rem = clip.dur - tLocal;
  if (clip.aFadeOut > 0 && rem < clip.aFadeOut) g *= Math.max(0, rem / clip.aFadeOut);
  return clamp(g, 0, 4);
}

/** Transition sortante active : renvoie {other, f} ou null. f=0..1 progression. */
export function transitionAt(track, clip, t) {
  const tr = clip.transition;
  if (!tr || tr.kind === 'none' || tr.dur <= 0) return null;
  const i = track.clips.indexOf(clip);
  const next = track.clips[i + 1];
  if (!next) return null;
  const start = clip.t0 + clip.dur - tr.dur;
  if (t < start) return null;
  const f = clamp((t - start) / tr.dur, 0, 1);
  return { next, f, kind: tr.kind };
}

// ------------------------------------------------------------------- historique

export class Store extends Emitter {
  constructor(project) {
    super();
    this.project = project || newProject();
    this.selection = { clipIds: [], maskId: null };
    this.playhead = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.limit = 80;
    this._pending = null;
  }

  /** Enregistre un point d'annulation avant modification. */
  snapshot(label = 'edition') {
    this.undoStack.push({ label, data: JSON.stringify(this.project), sel: JSON.stringify(this.selection) });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Modification atomique : snapshot + fn + emit. */
  edit(label, fn) {
    this.snapshot(label);
    const r = fn(this.project);
    this.changed();
    return r;
  }

  /** Modification continue (drag) : un seul snapshot pour toute la sequence. */
  beginLive(label) {
    if (this._pending) return;
    this._pending = label;
    this.snapshot(label);
  }
  endLive() { this._pending = null; }

  changed(what = 'project') { this.emit('change', what); }

  undo() {
    if (!this.undoStack.length) return false;
    const cur = { label: 'redo', data: JSON.stringify(this.project), sel: JSON.stringify(this.selection) };
    const s = this.undoStack.pop();
    this.redoStack.push(cur);
    this.project = JSON.parse(s.data);
    this.selection = JSON.parse(s.sel);
    this.emit('reload');
    this.changed();
    return s.label;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push({ label: 'undo', data: JSON.stringify(this.project), sel: JSON.stringify(this.selection) });
    const s = this.redoStack.pop();
    this.project = JSON.parse(s.data);
    this.selection = JSON.parse(s.sel);
    this.emit('reload');
    this.changed();
    return true;
  }

  // --------------------------------------------------------------- selection
  select(ids, additive = false) {
    const arr = Array.isArray(ids) ? ids : ids ? [ids] : [];
    if (additive) {
      const s = new Set(this.selection.clipIds);
      for (const i of arr) s.has(i) ? s.delete(i) : s.add(i);
      this.selection.clipIds = [...s];
    } else {
      this.selection.clipIds = arr;
    }
    if (arr.length !== 1) this.selection.maskId = null;
    this.emit('selection');
  }

  get selectedClips() {
    const out = [];
    for (const tr of this.project.tracks) for (const c of tr.clips) if (this.selection.clipIds.includes(c.id)) out.push({ clip: c, track: tr });
    return out;
  }

  get soleClip() {
    const s = this.selectedClips;
    return s.length === 1 ? s[0] : null;
  }

  get selectedMask() {
    const s = this.soleClip;
    if (!s || !this.selection.maskId) return null;
    return s.clip.masks.find((m) => m.id === this.selection.maskId) || null;
  }

  seek(t, emit = true) {
    const d = projectDuration(this.project);
    this.playhead = clamp(t, 0, Math.max(d, 0.001));
    if (emit) this.emit('seek', this.playhead);
  }

  get duration() { return projectDuration(this.project); }
  get frameDur() { return 1 / this.project.fps; }
}
