// Construit la liste de rendu a partir de l'etat du projet a un instant donne.
// Utilise a l'identique par l'apercu et par l'export.
import { animVal, activeAt, sourceTime, fadeGain, mediaOf } from './state.js';
import { clamp } from './util.js';
import { fontCss } from './fonts.js';

const SHAPE_ID = { rect: 0, ellipse: 1, linear: 2, mirror: 3, poly: 4 };

/** Recouvrement avec le clip precedent de la piste => fondu enchaine. */
export function overlapFade(track, clip, t) {
  const i = track.clips.indexOf(clip);
  if (i <= 0) return 1;
  const prev = track.clips[i - 1];
  const ov = (prev.t0 + prev.dur) - clip.t0;
  if (ov <= 1e-4) return 1;
  return clamp((t - clip.t0) / ov, 0, 1);
}

/** Fondu sortant du clip pendant son recouvrement avec le suivant (audio). */
export function overlapFadeOut(track, clip, t) {
  const i = track.clips.indexOf(clip);
  const next = track.clips[i + 1];
  if (!next) return 1;
  const ov = (clip.t0 + clip.dur) - next.t0;
  if (ov <= 1e-4) return 1;
  const start = next.t0;
  if (t < start) return 1;
  return clamp(1 - (t - start) / ov, 0, 1);
}

// ------------------------------------------------------------------- texte 2D

const textCache = new Map();

export function textTexture(clip, renderH) {
  const tx = clip.text;
  const fontPx = Math.max(8, Math.round(tx.size * renderH));
  const key = JSON.stringify([tx, fontPx]);
  const hit = textCache.get(clip.id);
  if (hit && hit.key === key) return hit;

  // OffscreenCanvas quand il existe : c'est ce qui permet au rendu de tourner
  // dans un Web Worker (l'export parallele), ou `document` n'existe pas.
  const cv = hit ? hit.canvas
    : (typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(16, 16));
  const ctx = cv.getContext('2d');
  const family = tx.family || fontCss(tx.font);
  const font = `${tx.italic ? 'italic ' : ''}${tx.weight} ${fontPx}px ${family}`;
  ctx.font = font;
  const lines = String(tx.content || '').split('\n');
  const lh = fontPx * (tx.lineHeight || 1.2);
  let maxW = 0;
  for (const l of lines) {
    let w = ctx.measureText(l).width;
    if (tx.letterSpacing) w += tx.letterSpacing * fontPx * Math.max(0, l.length - 1);
    maxW = Math.max(maxW, w);
  }
  const padStroke = (tx.stroke || 0) * fontPx * 0.6;
  const padShadow = (tx.shadow || 0) * fontPx * 0.5;
  const padGlow = (tx.glow || 0) * fontPx * 0.9;
  const padBg = tx.bg && tx.bg !== 'none' ? (tx.bgPad || 0) * renderH : 0;
  const pad = Math.ceil(padStroke + padShadow + padGlow + padBg + fontPx * 0.2);
  cv.width = Math.max(2, Math.ceil(maxW) + pad * 2);
  cv.height = Math.max(2, Math.ceil(lines.length * lh) + pad * 2);

  ctx.clearRect(0, 0, cv.width, cv.height);
  if (tx.bg && tx.bg !== 'none') {
    ctx.fillStyle = tx.bg;
    const r = Math.min(cv.width, cv.height) * 0.08;
    ctx.beginPath();
    ctx.roundRect(pad - padBg, pad - padBg, cv.width - 2 * (pad - padBg), cv.height - 2 * (pad - padBg), r);
    ctx.fill();
  }
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.textAlign = tx.align === 'left' ? 'left' : tx.align === 'right' ? 'right' : 'center';
  const cx = tx.align === 'left' ? pad : tx.align === 'right' ? cv.width - pad : cv.width / 2;
  // halo lumineux (style neon) : plusieurs passes de plus en plus larges
  if (tx.glow > 0) {
    ctx.shadowColor = tx.glowColor || '#38e1ff';
    ctx.fillStyle = tx.color;
    for (const mul of [0.5, 0.85, 1.3]) {
      ctx.shadowBlur = fontPx * mul * clamp(tx.glow, 0, 1);
      lines.forEach((line, i) => ctx.fillText(line, cx, pad + i * lh));
    }
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }
  if (tx.shadow > 0) {
    ctx.shadowColor = 'rgba(0,0,0,' + clamp(tx.shadow, 0, 1) + ')';
    ctx.shadowBlur = fontPx * 0.18;
    ctx.shadowOffsetY = fontPx * 0.05;
  }
  lines.forEach((line, i) => {
    const y = pad + i * lh;
    if (tx.stroke > 0) {
      ctx.lineWidth = tx.stroke * fontPx * 0.14;
      ctx.strokeStyle = tx.strokeColor;
      ctx.lineJoin = 'round';
      ctx.strokeText(line, cx, y);
    }
    ctx.fillStyle = tx.color;
    ctx.fillText(line, cx, y);
  });
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  const entry = { key, canvas: cv, w: cv.width, h: cv.height, version: (hit ? hit.version + 1 : 1) };
  textCache.set(clip.id, entry);
  return entry;
}

export function invalidateText(clipId) { textCache.delete(clipId); }

// -------------------------------------------------------------------- matrice

function layerMatrix(W, H, srcW, srcH, crop, fit, scale, rot, tx, ty, srcRot = 0) {
  const cw = Math.max(1e-3, srcW * (1 - crop.l - crop.r));
  const ch = Math.max(1e-3, srcH * (1 - crop.t - crop.b));
  // Source « a tourner de 90° » : elle sort couchee du decodeur. Le CADRAGE se
  // calcule donc sur ses dimensions une fois redressee (ce qu'on veut voir),
  // alors que le quadrilatere garde les dimensions brutes (ce qu'on a) : c'est
  // la rotation ajoutee plus bas qui fait le lien entre les deux.
  const couche = srcRot === 90 || srcRot === 270;
  const fw = couche ? ch : cw;
  const fh = couche ? cw : ch;
  let sx, sy;
  if (fit === 'none') { sx = sy = 1; }            // 1:1 — utilise par le texte
  else if (fit === 'fill') { sx = W / fw; sy = H / fh; }
  else if (fit === 'contain') { sx = sy = Math.min(W / fw, H / fh); }
  else { sx = sy = Math.max(W / fw, H / fh); }
  const qw = cw * sx * scale;
  const qh = ch * sy * scale;
  const th = (rot + srcRot) * Math.PI / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const kx = 2 / W, ky = 2 / H;
  const m = new Float32Array(9);
  m[0] = kx * qw * c;   m[1] = -ky * qw * s;  m[2] = 0;
  m[3] = -kx * qh * s;  m[4] = -ky * qh * c;  m[5] = 0;
  m[6] = kx * tx;       m[7] = -ky * ty;      m[8] = 1;
  return m;
}

/**
 * Rectangle occupe par un clip a l'ecran, en fraction de la frame.
 * Sert au cadre de transformation (deplacer / redimensionner sur l'apercu).
 */
export function clipScreenRect(project, clip, tLocal, srcW, srcH) {
  const W = project.width, H = project.height;
  const crop = clip.crop || { l: 0, r: 0, t: 0, b: 0 };
  const cw = Math.max(1e-3, srcW * (1 - crop.l - crop.r));
  const ch = Math.max(1e-3, srcH * (1 - crop.t - crop.b));
  const fit = clip.fit || 'cover';
  let sx, sy;
  if (fit === 'none') { sx = sy = 1; }
  else if (fit === 'fill') { sx = W / cw; sy = H / ch; }
  else if (fit === 'contain') { sx = sy = Math.min(W / cw, H / ch); }
  else { sx = sy = Math.max(W / cw, H / ch); }
  const scale = animVal(clip, 'scale', tLocal);
  return {
    w: (cw * sx * scale) / W,
    h: (ch * sy * scale) / H,
    cx: 0.5 + animVal(clip, 'x', tLocal),
    cy: 0.5 + animVal(clip, 'y', tLocal),
    rot: animVal(clip, 'rot', tLocal),
  };
}

/** Taille naturelle de la source d'un clip (pour clipScreenRect). */
export function clipSourceSize(project, clip, renderH) {
  if (clip.kind === 'text') {
    const e = textTexture(clip, renderH || project.height);
    return [e.w, e.h];
  }
  const m = mediaOf(project, clip);
  return m && m.width ? [m.width, m.height] : [project.width, project.height];
}

// ------------------------------------------------------------------- masques

function buildMaskGroups(clip, tLocal, renderW) {
  if (!clip.masks || !clip.masks.length) return null;
  const groups = [];
  for (const m of clip.masks) {
    if (m.hidden) continue;
    const strength = animVal(m, 'strength', tLocal);
    const quant = (m.effect === 'blur' || m.effect === 'mosaic') ? Math.round(strength) : 0;
    const key = m.effect + ':' + quant;
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = {
        key, effect: m.effect, masks: [],
        sigmaPx: (quant / 100) * 0.05 * renderW,
        cellPx: (0.003 + (quant / 100) * 0.045) * renderW,
      };
      groups.push(g);
    }
    const res = {
      shapeId: SHAPE_ID[m.shape] ?? 1,
      cx: animVal(m, 'cx', tLocal),
      cy: animVal(m, 'cy', tLocal),
      w: animVal(m, 'w', tLocal),
      h: animVal(m, 'h', tLocal),
      rot: animVal(m, 'rot', tLocal),
      feather: animVal(m, 'feather', tLocal),
      round: m.round || 0,
      invert: !!m.invert,
      ptCount: 0, pts: null,
    };
    if (m.shape === 'poly' && m.pts && m.pts.length >= 3) {
      const n = Math.min(32, m.pts.length);
      const f = new Float32Array(64);
      for (let i = 0; i < n; i++) { f[i * 2] = m.pts[i][0]; f[i * 2 + 1] = m.pts[i][1]; }
      res.ptCount = n;
      res.pts = f;
    }
    g.masks.push(res);
  }
  return groups.length ? groups : null;
}

// ------------------------------------------------------------- liste de rendu

/**
 * @param {object} project
 * @param {number} t             temps timeline (s)
 * @param {function} getSource   (clip, media, srcTime) => {src, w, h, id} | null
 * @param {number} renderW
 * @param {number} renderH
 */
export function buildFrame(project, t, getSource, renderW, renderH) {
  const layers = [];
  const acts = activeAt(project, t);
  acts.sort((a, b) => a.trackIndex - b.trackIndex);

  for (const a of acts) {
    const { clip, track, tLocal } = a;
    if (track.kind === 'audio' || clip.kind === 'audio') continue;

    let src = null, srcW = 0, srcH = 0, texId = null, stale = false, same = false, srcRot = 0;
    if (clip.kind === 'text') {
      const e = textTexture(clip, renderH);
      src = e.canvas; srcW = e.w; srcH = e.h;
      texId = 'txt:' + clip.id;   // stable : la texture est reecrite a chaque rendu
    } else {
      const media = mediaOf(project, clip);
      if (!media) continue;
      const got = getSource(clip, media, sourceTime(clip, tLocal));
      if (!got || !got.src) continue;
      src = got.src; srcW = got.w; srcH = got.h; texId = got.id;
      srcRot = got.rotation || 0;
      stale = !!got.stale;
      same = !!got.same;
    }
    if (!src || !srcW || !srcH) continue;

    const opacity = clamp(
      animVal(clip, 'opacity', tLocal) * fadeGain(clip, tLocal) * overlapFade(track, clip, t),
      0, 1);
    if (opacity <= 0.001) continue;

    const crop = clip.crop || { l: 0, r: 0, t: 0, b: 0 };
    const m = layerMatrix(renderW, renderH, srcW, srcH, crop, clip.fit || 'cover',
      animVal(clip, 'scale', tLocal), animVal(clip, 'rot', tLocal),
      animVal(clip, 'x', tLocal) * renderW, animVal(clip, 'y', tLocal) * renderH, srcRot);

    let u0 = crop.l, u1 = 1 - crop.r, v0 = crop.t, v1 = 1 - crop.b;
    if (clip.flipH) { const t2 = u0; u0 = u1; u1 = t2; }
    if (clip.flipV) { const t2 = v0; v0 = v1; v1 = t2; }
    const ex = 0.5 / srcW, ey = 0.5 / srcH;
    const uv = new Float32Array([u0, v0, u1, v1]);
    const uvClamp = new Float32Array([
      Math.min(u0, u1) + ex, Math.min(v0, v1) + ey,
      Math.max(u0, u1) - ex, Math.max(v0, v1) - ey,
    ]);

    layers.push({
      clip, track, tLocal, texId, source: src, srcW, srcH, stale, same,
      m, uv, uvClamp, opacity,
      color: clip.color || {}, chroma: clip.chroma || null,
      maskGroups: buildMaskGroups(clip, tLocal, renderW),
    });
  }

  const bg = hexToRgb(project.background || '#000000');
  return { bg, layers, t };
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Etat audio a l'instant t : liste des clips audibles avec leur gain. */
export function audioStateAt(project, t) {
  const out = [];
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (t < clip.t0 - 1e-6 || t >= clip.t0 + clip.dur - 1e-6) continue;
      if (clip.kind === 'text') continue;
      const tLocal = t - clip.t0;
      let g = clip.mute ? 0 : (clip.volume ?? 1) * (track.volume ?? 1);
      if (clip.aFadeIn > 0 && tLocal < clip.aFadeIn) g *= tLocal / clip.aFadeIn;
      const rem = clip.dur - tLocal;
      if (clip.aFadeOut > 0 && rem < clip.aFadeOut) g *= Math.max(0, rem / clip.aFadeOut);
      g *= overlapFade(track, clip, t) * overlapFadeOut(track, clip, t);
      out.push({ clip, track, tLocal, gain: clamp(g, 0, 4) });
    }
  }
  return out;
}
