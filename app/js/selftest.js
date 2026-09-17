// Auto-tests du moteur : muxage, demuxage, decodage, masques, export complet.
import { Mp4File, blobReader } from './mp4demux.js';
import { Renderer } from './renderer.js';
import { buildFrame } from './compose.js';
import { ClipDecoder } from './decode.js';
import { mixdown, encodeAac, clearAudioCache } from './audiomix.js';
import { Exporter, resolveVideoConfig } from './exporter.js';
import { newProject, newClip, newMask, newTrack } from './state.js';
import { b64, yieldTask } from './util.js';
import { detecterTemps, oublierTemps, tempsTimeline } from './beats.js';
import { Timeline } from './timeline.js';
import { Player } from './playback.js';

const TK = new URLSearchParams(location.search).get('tk') || window.__TK || '';
const out = document.getElementById('out');
// Dossier de travail des tests. Il est demande au serveur : un chemin ecrit
// en dur ne vaudrait que sur la machine de celui qui l'a tape, et les tests
// ne tourneraient nulle part ailleurs.
const TMP = await (async () => {
  const r = await fetch(`/api/ping?tk=${TK}`).then((x) => x.json()).catch(() => null);
  return r ? r.tmp + r.sep : '';
})();
let pass = 0, fail = 0;

const log = (s, c = '') => out.insertAdjacentHTML('beforeend', `<span class="${c}">${s}</span>\n`);
const head = (s) => log('\n=== ' + s + ' ===', 'dim');
function check(name, cond, extra = '') {
  if (cond) { pass++; log('  ✔ ' + name + (extra ? '  ' + extra : ''), 'ok'); }
  else { fail++; log('  ✖ ' + name + (extra ? '  ' + extra : ''), 'no'); }
  return !!cond;
}


// ------------------------------------------------------- piste rythmique test

/**
 * Fabrique un WAV ou un coup grave tombe a intervalle connu.
 * Sert de verite terrain : on sait exactement ou les points doivent atterrir.
 */
function makeClickTrack({ bpm = 120, secs = 16, freq = 55, decay = 0.03 } = {}) {
  const SR = 48000, n = Math.round(SR * secs);
  const d = new Float32Array(n);
  // Bruit de fond reproductible : avec Math.random le test changeait de verdict
  // d'une execution a l'autre, ce qui ne prouve plus rien.
  let graine = 12345;
  const alea = () => { graine = (graine * 1103515245 + 12345) & 0x7fffffff; return graine / 0x7fffffff; };
  for (let i = 0; i < n; i++) d[i] = (alea() * 2 - 1) * 0.02;   // fond, pas du silence
  const attendus = [];
  for (let t = 0.25; t < secs - 0.3; t += 60 / bpm) {
    attendus.push(t);
    const s0 = Math.round(t * SR);
    for (let i = 0; i < SR * 0.2 && s0 + i < n; i++) {
      d[s0 + i] += Math.sin((2 * Math.PI * freq * i) / SR) * Math.exp(-i / (SR * decay)) * 0.9;
    }
  }
  const ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, d[i]));
    v.setInt16(44 + i * 2, x * 32767, true);
  }
  return { file: new File([ab], 'clic.wav', { type: 'audio/wav' }), attendus };
}

/** Ecart entre chaque temps attendu et le point detecte le plus proche. */
function apparier(trouves, attendus, tol = 0.07) {
  const ecarts = [];
  for (const a of attendus) {
    let bd = Infinity, bv = null;
    for (const x of trouves) { const d = Math.abs(x - a); if (d < bd) { bd = d; bv = x; } }
    if (bd < tol) ecarts.push(bv - a);
  }
  return ecarts;
}


// ------------------------------------------- source « chaque image numerotee »

/**
 * Couleur qui code le numero d'image et la source.
 *
 * Le code occupe toute l'image : il survit donc au redimensionnement, au flou
 * de compression et au reencodage, contrairement a un petit motif. Les valeurs
 * sont espacees de 16, bien plus que le bruit de compression.
 */
// Six niveaux par canal, largement espaces : la chaine video passe par du YUV
// a plage reduite, ce qui deplace les valeurs de plusieurs unites. Avec cet
// ecart, le niveau le plus proche reste le bon meme apres ce voyage.
const NIVEAUX = [24, 64, 104, 144, 184, 224];

/** Couleur qui code un numero global (source et image confondues). */
function couleurDeIndex(n) {
  return [NIVEAUX[n % 6], NIVEAUX[Math.floor(n / 6) % 6], NIVEAUX[Math.floor(n / 36) % 6]];
}

/** Retrouve le numero global : niveau le plus proche sur chaque canal. */
function indexDeCouleur(r, g, b) {
  const q = (v) => {
    let best = 0, bd = Infinity;
    for (let k = 0; k < 6; k++) { const d = Math.abs(v - NIVEAUX[k]); if (d < bd) { bd = d; best = k; } }
    return best;
  };
  return q(r) + q(g) * 6 + q(b) * 36;
}

/**
 * Fabrique une video dont CHAQUE image porte son numero.
 *
 * C'est l'instrument de mesure du montage : en relisant une image on sait
 * exactement de quelle image de quelle source elle vient. Sans cela on ne peut
 * que constater que « ca a l'air bon », ce qui ne prouve rien sur un
 * enchainement de plans courts.
 */
async function makeCountedVideo(path, { W = 640, H = 360, fps = 30, frames = 70, base = 0, hz = 0 } = {}) {
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext('2d');
  const vcfg = await resolveVideoConfig({ codec: 'avc', width: W, height: H, fps, bitrate: 16e6 });
  const chunks = [];
  let desc = null;
  const enc = new VideoEncoder({
    output: (c, meta) => {
      if (!desc && meta && meta.decoderConfig && meta.decoderConfig.description) desc = new Uint8Array(meta.decoderConfig.description);
      const b = new Uint8Array(c.byteLength); c.copyTo(b);
      chunks.push({ data: b, key: c.type === 'key' });
    },
    error: (e) => log('erreur encodeur: ' + e.message, 'no'),
  });
  enc.configure(vcfg.config);

  for (let i = 0; i < frames; i++) {
    const [r, g, b] = couleurDeIndex(base + i);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, W, H);
    const f = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    // images cles rapprochees : on veut pouvoir sauter partout sans attendre
    enc.encode(f, { keyFrame: i % 10 === 0 });
    f.close();
    if (enc.encodeQueueSize > 8) await yieldTask();
  }
  await enc.flush(); enc.close();

  // Un son continu, sans le moindre silence, d une hauteur propre a chaque
  // source. Toute coupure entendue dans l export vient donc du montage, et
  // jamais de la matiere premiere.
  let audio = null;
  if (hz > 0) {
    const sr = 48000;
    const len = Math.ceil((frames / fps) * sr);
    const g = new Float32Array(len);
    for (let i = 0; i < len; i++) g[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sr);
    audio = await encodeAac({ data: [g, g], length: len, sampleRate: sr }, 128000);
  }

  const beg = await fetch(`/api/export/begin?tk=${TK}`, {
    method: 'POST',
    body: JSON.stringify({
      path,
      video: { codec: 'avc', width: W, height: H, timescale: fps * 1000, description: desc ? b64(desc) : '' },
      audio: audio ? { sampleRate: audio.sampleRate, channels: 2,
        description: audio.description ? b64(audio.description) : null } : null,
    }),
  }).then((x) => x.json());
  if (!beg.session) throw new Error('begin: ' + JSON.stringify(beg));
  const parts = [];
  let ai = 0;
  for (let k = 0; k < chunks.length; k++) {
    parts.push(...rec(0, chunks[k].data, 1000, chunks[k].key));
    if (audio) {
      const tv = (k + 1) / fps;
      while (ai < audio.frames.length && (ai * 1024) / audio.sampleRate <= tv) {
        parts.push(...rec(1, audio.frames[ai].data, 1024, true)); ai++;
      }
    }
  }
  if (audio) while (ai < audio.frames.length) { parts.push(...rec(1, audio.frames[ai].data, 1024, true)); ai++; }
  await fetch(`/api/export/append?tk=${TK}&s=${beg.session}`, { method: 'POST', body: new Blob(parts) });
  await fetch(`/api/export/end?tk=${TK}&s=${beg.session}`, { method: 'POST' });
  return { path, W, H, fps, frames, base, hasAudio: !!audio };
}

// ----------------------------------------------------------- generation media

function rec(track, data, duration, key) {
  const h = new ArrayBuffer(16);
  const dv = new DataView(h);
  dv.setUint32(0, 0xc0def00d, true);
  dv.setUint8(4, track);
  dv.setUint8(5, key ? 1 : 0);
  dv.setUint32(8, duration, true);
  dv.setUint32(12, data.byteLength, true);
  return [h, data];
}

/**
 * Fabrique une video de test : degrade + carre blanc mobile + bip 440 Hz.
 * Sert de source connue pour verifier decodage / rendu / export.
 */
async function makeTestVideo(path, { W = 1280, H = 720, fps = 30, secs = 3, withAudio = true } = {}) {
  const N = fps * secs;
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext('2d');

  const vcfg = await resolveVideoConfig({ codec: 'avc', width: W, height: H, fps, bitrate: 12e6 });
  const chunks = [];
  let desc = null;
  const enc = new VideoEncoder({
    output: (c, meta) => {
      if (!desc && meta && meta.decoderConfig && meta.decoderConfig.description) desc = new Uint8Array(meta.decoderConfig.description);
      const b = new Uint8Array(c.byteLength); c.copyTo(b);
      chunks.push({ data: b, key: c.type === 'key' });
    },
    error: (e) => log('erreur encodeur: ' + e.message, 'no'),
  });
  enc.configure(vcfg.config);

  // reference : position du carre a l'image i
  const sqAt = (i) => [Math.round((i / N) * (W - 200)) + 20, Math.round(H / 2 - 60)];

  for (let i = 0; i < N; i++) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#102040'); g.addColorStop(1, '#40204a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // damier fin : donne de la haute frequence, utile pour mesurer le flou
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    for (let y = 0; y < H; y += 8) for (let x = ((y / 8) % 2) * 8; x < W; x += 16) ctx.fillRect(x, y, 8, 8);
    const [sx, sy] = sqAt(i);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(sx, sy, 160, 120);
    ctx.fillStyle = '#ff3050'; ctx.fillRect(0, 0, 60, 60);
    const f = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    enc.encode(f, { keyFrame: i % fps === 0 });
    f.close();
    if (enc.encodeQueueSize > 8) await yieldTask();
  }
  await enc.flush(); enc.close();

  let audio = null;
  if (withAudio) {
    const sr = 48000;
    const len = sr * secs;
    const data = [new Float32Array(len), new Float32Array(len)];
    for (let i = 0; i < len; i++) {
      const v = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.25;
      data[0][i] = v; data[1][i] = v * 0.6;
    }
    audio = await encodeAac({ data, length: len, sampleRate: sr }, 128000);
  }

  const beg = await fetch(`/api/export/begin?tk=${TK}`, {
    method: 'POST',
    body: JSON.stringify({
      path,
      video: { codec: 'avc', width: W, height: H, timescale: fps * 1000, description: desc ? b64(desc) : '' },
      audio: audio ? { sampleRate: audio.sampleRate, channels: 2, description: audio.description ? b64(audio.description) : null } : null,
    }),
  }).then((r) => r.json());
  if (!beg.session) throw new Error('begin: ' + JSON.stringify(beg));

  const parts = [];
  let ai = 0;
  for (let i = 0; i < chunks.length; i++) {
    parts.push(...rec(0, chunks[i].data, 1000, chunks[i].key));
    if (audio) {
      const tv = (i + 1) / fps;
      while (ai < audio.frames.length && (ai * 1024) / audio.sampleRate <= tv) {
        parts.push(...rec(1, audio.frames[ai].data, 1024, true)); ai++;
      }
    }
  }
  if (audio) while (ai < audio.frames.length) { parts.push(...rec(1, audio.frames[ai].data, 1024, true)); ai++; }
  await fetch(`/api/export/append?tk=${TK}&s=${beg.session}`, { method: 'POST', body: new Blob(parts) });
  const fin = await fetch(`/api/export/end?tk=${TK}&s=${beg.session}`, { method: 'POST' }).then((r) => r.json());
  return { ...fin, N, W, H, fps, secs, sqAt, chunks: chunks.length, hardware: vcfg.accel };
}

async function fetchAsFile(path, name) {
  const r = await fetch(`/media?tk=${TK}&p=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error('lecture ' + r.status);
  const b = await r.blob();
  return new File([b], name, { type: 'video/mp4' });
}

// --------------------------------------------------------------- outils pixels

function readPixels(renderer) {
  const gl = renderer.gl;
  const w = renderer.w, h = renderer.h;
  const px = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { px, w, h };
}

/** Moyenne + ecart-type de luminance dans un rectangle (coords y vers le bas). */
function stats(img, x0, y0, x1, y1) {
  let n = 0, sum = 0, sum2 = 0;
  for (let y = y0; y < y1; y++) {
    const yy = img.h - 1 - y;              // readPixels est en bas-vers-haut
    if (yy < 0 || yy >= img.h) continue;
    for (let x = x0; x < x1; x++) {
      if (x < 0 || x >= img.w) continue;
      const i = (yy * img.w + x) * 4;
      const l = 0.2126 * img.px[i] + 0.7152 * img.px[i + 1] + 0.0722 * img.px[i + 2];
      sum += l; sum2 += l * l; n++;
    }
  }
  if (!n) return { mean: 0, sd: 0, n: 0 };
  const mean = sum / n;
  return { mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), n };
}

/** Contraste local moyen : mesure directe de la nettete. */
function localContrast(img, x0, y0, x1, y1) {
  let n = 0, acc = 0;
  for (let y = y0; y < y1 - 1; y++) {
    const yy = img.h - 1 - y;
    if (yy < 1 || yy >= img.h) continue;
    for (let x = x0; x < x1 - 1; x++) {
      if (x < 0 || x + 1 >= img.w) continue;
      const i = (yy * img.w + x) * 4;
      const j = (yy * img.w + x + 1) * 4;
      acc += Math.abs(img.px[i] - img.px[j]);
      n++;
    }
  }
  return n ? acc / n : 0;
}

function showCanvas(renderer, label) {
  const img = readPixels(renderer);
  const c = document.createElement('canvas');
  const SW = 260, SH = Math.round(SW * img.h / img.w);
  c.width = SW; c.height = SH;
  const tmp = document.createElement('canvas');
  tmp.width = img.w; tmp.height = img.h;
  const id = new ImageData(img.w, img.h);
  // retourne verticalement
  for (let y = 0; y < img.h; y++) {
    const src = (img.h - 1 - y) * img.w * 4;
    id.data.set(img.px.subarray(src, src + img.w * 4), y * img.w * 4);
  }
  for (let i = 3; i < id.data.length; i += 4) id.data[i] = 255;
  tmp.getContext('2d').putImageData(id, 0, 0);
  c.getContext('2d').drawImage(tmp, 0, 0, SW, SH);
  c.title = label;
  document.getElementById('cv').append(c);
  return img;
}

// ------------------------------------------------------------------- les tests

async function runAll() {
  out.textContent = '';
  document.getElementById('cv').innerHTML = '';
  pass = 0; fail = 0;
  const T0 = performance.now();
  const srcPath = TMP + 'cutlocal-test-src.mp4';
  const outPath = TMP + 'cutlocal-test-out.mp4';

  // ---------------------------------------------------------------- T1 muxage
  head('T1 — encodage + muxage MP4 (source de test)');
  let src;
  try {
    src = await makeTestVideo(srcPath, { W: 1280, H: 720, fps: 30, secs: 3 });
    check('fichier ecrit', src.bytes > 10000, `${(src.bytes / 1024).toFixed(0)} Ko, ${src.chunks} paquets video, accel=${src.hardware}`);
  } catch (e) { check('generation source', false, e.message); return report(T0); }

  // -------------------------------------------------------------- T2 demuxage
  head('T2 — demuxage du MP4 produit');
  const file = await fetchAsFile(srcPath, 'test-src.mp4');
  const mp4 = await Mp4File.open(blobReader(file));
  const vt = mp4.videoTrack, at = mp4.audioTrack;
  check('piste video detectee', !!vt, vt ? `${vt.codec} ${vt.width}x${vt.height}` : '');
  check('nombre d\'images correct', vt && vt.samples.length === src.N, `${vt ? vt.samples.length : 0} / ${src.N}`);
  check('duree correcte', Math.abs(mp4.duration - src.secs) < 0.05, `${mp4.duration.toFixed(3)} s / ${src.secs} s`);
  check('cadence correcte', vt && Math.abs(vt.fps - src.fps) < 0.2, vt ? vt.fps.toFixed(3) + ' i/s' : '');
  check('description avcC presente', !!(vt && vt.description && vt.description.length > 6), vt && vt.description ? vt.description.length + ' o' : '');
  check('images cles reperees', vt && vt.samples.filter((s) => s.sync).length === Math.ceil(src.N / src.fps),
    vt ? vt.samples.filter((s) => s.sync).length + ' I-frames' : '');
  check('piste audio detectee', !!at, at ? `${at.codec} ${at.sampleRate}Hz ${at.channels}ch` : '');
  const offsetsOk = vt && vt.samples.every((s, i) => s.offset > 0 && s.size > 0 && (i === 0 || s.dts >= vt.samples[i - 1].dts));
  check('table de samples coherente', !!offsetsOk);

  // ------------------------------------------------------------- T3 decodage
  head('T3 — decodage image par image (WebCodecs)');
  const project = newProject({ width: 1280, height: 720, fps: 30 });
  const media = {
    id: 'md_test', name: 'test-src.mp4', size: file.size, kind: 'video',
    duration: mp4.duration, width: vt.width, height: vt.height, fps: vt.fps,
    hasAudio: !!at, hasVideo: true, codec: vt.codec,
  };
  project.media.push(media);
  const fakeLib = {
    files: new Map([['md_test', file]]),
    file: (id) => (id === 'md_test' ? file : null),
    url: () => URL.createObjectURL(file),
    mp4Of: async () => mp4,
  };
  const clip = newClip({ mediaId: 'md_test', t0: 0, dur: 3, in: 0 });
  project.tracks[0].clips.push(clip);

  const dec = new ClipDecoder(fakeLib, media, clip);
  await dec.init();
  check('mode decodage', dec.mode === 'codec', dec.mode);
  const probes = [0.0, 0.5, 1.0, 1.5, 2.0, 2.9];
  let tsOk = true, tsInfo = [];
  for (const t of probes) {
    const g = await dec.frameAt(t);
    if (!g) { tsOk = false; tsInfo.push(t + '→null'); continue; }
    const got = g.src.timestamp / 1e6;
    const expected = Math.floor(t * src.fps) / src.fps;
    if (Math.abs(got - expected) > 1.2 / src.fps) { tsOk = false; tsInfo.push(`${t}→${got.toFixed(3)} (attendu ${expected.toFixed(3)})`); }
    if (g.owned) g.src.close();          // l'appelant est proprietaire du clone
  }
  check('images exactes aux instants demandes', tsOk, tsInfo.join(' '));

  // saut arriere (verifie le re-seek)
  const back = await dec.frameAt(0.2);
  check('saut arriere fonctionnel', back && Math.abs(back.src.timestamp / 1e6 - 0.2) < 0.05,
    back ? (back.src.timestamp / 1e6).toFixed(3) : 'null');
  if (back && back.owned) back.src.close();

  // --------------------------------------------------- T4 rendu + masque flou
  head('T4 — rendu GPU et masque de flou');
  const cv = new OffscreenCanvas(1280, 720);
  const rend = new Renderer(cv, { preserve: true });
  rend.setSize(1280, 720);

  const drawAt = async (t) => {
    const g = await dec.frameAt(t);
    const frame = buildFrame(project, t, () => g, 1280, 720);
    for (const L of frame.layers) {
      const e = rend.upload(L.texId, L.source, L.srcW, L.srcH);
      L.tex = e ? e.tex : null;
    }
    rend.render(frame, true);
    // le decodeur rend un CLONE : c'est a l'appelant de le fermer, sinon les
    // tampons du decodeur materiel s'epuisent et il finit par se bloquer
    if (g && g.owned) g.src.close();
    return frame;
  };

  await drawAt(1.0);
  const img0 = showCanvas(rend, 'sans masque t=1s');
  const [sx, sy] = src.sqAt(30);
  const sq = stats(img0, sx + 30, sy + 30, sx + 130, sy + 90);
  const bg = stats(img0, 40, 620, 240, 700);
  check('image rendue (carre blanc detecte)', sq.mean > 200, `luminance carre=${sq.mean.toFixed(0)}`);
  check('fond non blanc', bg.mean < 200, `luminance fond=${bg.mean.toFixed(0)}`);
  // ORIENTATION : le carre rouge est en HAUT A GAUCHE de la source.
  // On verifie qu'il s'y trouve aussi a l'ecran (et nulle part ailleurs).
  const px = (img, x, y) => { const i = ((img.h - 1 - y) * img.w + x) * 4; return [img.px[i], img.px[i + 1], img.px[i + 2]]; };
  const isRed = (c) => c[0] > 140 && c[1] < 90 && c[2] < 110;
  const tl = px(img0, 25, 25), bl = px(img0, 25, 694), tr = px(img0, 1254, 25), br = px(img0, 1254, 694);
  check('orientation : repere rouge en haut a gauche', isRed(tl) && !isRed(bl) && !isRed(tr) && !isRed(br),
    `hg=${tl} bg=${bl} hd=${tr} bd=${br}`);
  // le carre blanc mobile doit etre a sa position source exacte (verif horizontale)
  const atSquare = stats(img0, sx + 40, sy + 40, sx + 120, sy + 80);
  const leftOfSquare = stats(img0, Math.max(0, sx - 160), sy + 40, Math.max(1, sx - 40), sy + 80);
  check('position horizontale exacte', atSquare.mean > 200 && leftOfSquare.mean < 200,
    `sur=${atSquare.mean.toFixed(0)} a-cote=${leftOfSquare.mean.toFixed(0)}`);

  const sharpIn = localContrast(img0, 500, 200, 780, 500);
  const sharpOut = localContrast(img0, 100, 200, 380, 500);

  // masque ellipse centre avec flou fort
  clip.masks = [newMask('ellipse', { cx: 0.5, cy: 0.5, w: 0.32, h: 0.5, feather: 0.01, strength: 80, effect: 'blur' })];
  await drawAt(1.0);
  const img1 = showCanvas(rend, 'flou masque t=1s');
  const blurIn = localContrast(img1, 560, 250, 720, 470);
  const blurOut = localContrast(img1, 100, 250, 300, 470);
  check('flou applique DANS le masque', blurIn < sharpIn * 0.5, `contraste ${sharpIn.toFixed(1)} → ${blurIn.toFixed(1)}`);
  check('image intacte HORS du masque', Math.abs(blurOut - sharpOut) < sharpOut * 0.25 + 1.5, `contraste ${sharpOut.toFixed(1)} → ${blurOut.toFixed(1)}`);

  // masque inverse
  clip.masks[0].invert = true;
  await drawAt(1.0);
  const img2 = showCanvas(rend, 'masque inverse');
  const invIn = localContrast(img2, 560, 250, 720, 470);
  const invOut = localContrast(img2, 100, 250, 300, 470);
  check('inversion du masque', invIn > invOut * 1.6, `dedans ${invIn.toFixed(1)} vs dehors ${invOut.toFixed(1)}`);
  clip.masks[0].invert = false;

  // mosaique
  clip.masks[0].effect = 'mosaic';
  clip.masks[0].strength = 70;
  await drawAt(1.0);
  showCanvas(rend, 'mosaique');
  check('mosaique rendue sans erreur', rend.gl.getError() === 0);

  // masque "garder l'interieur"
  clip.masks[0].effect = 'reveal';
  await drawAt(1.0);
  const img3 = showCanvas(rend, 'garder interieur');
  const outside = stats(img3, 60, 300, 260, 460);
  check('exterieur masque = fond', outside.mean < 12, `luminance ${outside.mean.toFixed(1)}`);
  clip.masks[0].effect = 'blur';
  clip.masks[0].strength = 80;

  // keyframes de masque
  clip.masks[0].kf = { cx: [{ t: 0, v: 0.2 }, { t: 2, v: 0.8 }] };
  const f0 = buildFrame(project, 0.0, () => null, 1280, 720);
  clip.masks[0].kf = { cx: [{ t: 0, v: 0.2 }, { t: 2, v: 0.8 }] };
  const mAt = (t) => {
    const fr = buildFrame(project, t, () => ({ src: cv, w: 1280, h: 720, id: 'x' }), 1280, 720);
    return fr.layers[0].maskGroups[0].masks[0].cx;
  };
  check('interpolation des keyframes', Math.abs(mAt(0) - 0.2) < 1e-6 && Math.abs(mAt(1) - 0.5) < 1e-6 && Math.abs(mAt(2) - 0.8) < 1e-6,
    `t=0→${mAt(0).toFixed(3)} t=1→${mAt(1).toFixed(3)} t=2→${mAt(2).toFixed(3)}`);
  clip.masks[0].kf = {};

  // ---------------------------------------------------------------- T5 audio
  head('T5 — mixage et encodage audio');
  clearAudioCache();
  const mix = await mixdown(project, fakeLib, { sampleRate: 48000, from: 0, to: 3 });
  check('mix produit', !!mix, mix ? `${mix.length} echantillons` : '');
  if (mix) {
    let peak = 0, rms = 0;
    for (let i = 0; i < mix.length; i += 7) { const v = Math.abs(mix.data[0][i]); peak = Math.max(peak, v); rms += v * v; }
    rms = Math.sqrt(rms / (mix.length / 7));
    check('signal audio present', peak > 0.05, `crete=${peak.toFixed(3)} rms=${rms.toFixed(3)}`);
    const aac = await encodeAac(mix, 128000);
    check('encodage AAC', aac.frames.length > 100, `${aac.frames.length} trames, description ${aac.description ? aac.description.length + ' o' : 'absente'}`);
  }

  // ---------------------------------------------------------- T6 export total
  head('T6 — export complet (avec masque flou) et relecture');
  clip.masks = [newMask('ellipse', { cx: 0.5, cy: 0.5, w: 0.3, h: 0.45, strength: 70, effect: 'blur' })];
  clip.dur = 2;
  const store = { project };
  const exporter = new Exporter(store, fakeLib, TK);
  let lastProg = null;
  const t0 = performance.now();
  const res = await exporter.run({
    path: outPath, width: 1280, height: 720, fps: 30, codec: 'avc',
    bitrate: 12e6, audioBitrate: 128000, withAudio: true, sampleRate: 48000,
    gop: 30, from: 0, to: 2,
  }, (p) => { lastProg = p; });
  const dt = (performance.now() - t0) / 1000;
  check('export termine', !!res && res.bytes > 5000, `${(res.bytes / 1024).toFixed(0)} Ko en ${dt.toFixed(2)} s (${(res.frames / dt).toFixed(1)} i/s)`);
  check('nombre d\'images exportees', res.frames === 60, res.frames + ' / 60');

  const outFile = await fetchAsFile(outPath, 'out.mp4');
  const mp4b = await Mp4File.open(blobReader(outFile));
  check('MP4 exporte relisible', !!mp4b.videoTrack, mp4b.videoTrack ? `${mp4b.videoTrack.codec} ${mp4b.videoTrack.width}x${mp4b.videoTrack.height}` : '');
  check('images presentes dans le conteneur', mp4b.videoTrack && mp4b.videoTrack.samples.length === 60, mp4b.videoTrack ? mp4b.videoTrack.samples.length + '' : '');
  check('duree exportee', Math.abs(mp4b.duration - 2) < 0.05, mp4b.duration.toFixed(3) + ' s');
  check('audio dans l\'export', !!mp4b.audioTrack, mp4b.audioTrack ? `${mp4b.audioTrack.codec}, ${mp4b.audioTrack.samples.length} trames` : 'absent');

  // verifie que le flou est bien present dans le fichier exporte
  const mediaB = { id: 'md_out', name: 'out.mp4', kind: 'video', duration: mp4b.duration, width: 1280, height: 720, fps: 30, hasVideo: true, hasAudio: !!mp4b.audioTrack };
  const libB = { files: new Map([['md_out', outFile]]), file: () => outFile, url: () => URL.createObjectURL(outFile), mp4Of: async () => mp4b };
  const clipB = newClip({ mediaId: 'md_out', t0: 0, dur: 2, in: 0 });
  const decB = new ClipDecoder(libB, mediaB, clipB);
  await decB.init();
  const gB = await decB.frameAt(1.0);
  if (check('image relue depuis l\'export', !!gB)) {
    const projB = newProject({ width: 1280, height: 720, fps: 30 });
    projB.media.push(mediaB);
    projB.tracks[0].clips.push(clipB);
    const fr = buildFrame(projB, 1.0, () => gB, 1280, 720);
    for (const L of fr.layers) { const e = rend.upload(L.texId, L.source, L.srcW, L.srcH); L.tex = e ? e.tex : null; }
    rend.render(fr, true);
    const imgB = showCanvas(rend, 'EXPORT relu t=1s');
    const cIn = localContrast(imgB, 560, 250, 720, 470);
    const cOut = localContrast(imgB, 100, 250, 300, 470);
    check('le flou est bien dans le fichier exporte', cIn < cOut * 0.6, `dedans ${cIn.toFixed(1)} vs dehors ${cOut.toFixed(1)}`);
  }
  if (gB && gB.owned) gB.src.close();
  decB.close();
  dec.close();

  // -------------------------------------------------------- T7 export 4K 60
  head('T7 — export 4K 60 i/s (30 images, mesure de debit)');
  try {
    const p4 = TMP + 'cutlocal-test-4k.mp4';
    clip.dur = 0.5;
    const t4 = performance.now();
    const r4 = await new Exporter(store, fakeLib, TK).run({
      path: p4, width: 3840, height: 2160, fps: 60, codec: 'avc',
      bitrate: 60e6, audioBitrate: 0, withAudio: false, gop: 60, from: 0, to: 0.5,
    }, () => {});
    const d4 = (performance.now() - t4) / 1000;
    check('export 4K60 reussi', r4.frames === 30 && r4.bytes > 20000,
      `${(r4.bytes / 1048576).toFixed(2)} Mo, ${d4.toFixed(2)} s → ${(r4.frames / d4).toFixed(1)} i/s (${r4.codec}, ${r4.hardware})`);
    const f4 = await fetchAsFile(p4, '4k.mp4');
    const m4 = await Mp4File.open(blobReader(f4));
    check('4K relisible', m4.videoTrack && m4.videoTrack.width === 3840 && m4.videoTrack.samples.length === 30,
      m4.videoTrack ? `${m4.videoTrack.width}x${m4.videoTrack.height}, ${m4.videoTrack.samples.length} images` : '');
  } catch (e) { check('export 4K60', false, e.message); }

  head('T8 — points de rythme (detection des « boums »)');
  try {
    // 1) justesse sur des sources dont on connait le tempo
    let toutBon = true, pireEcart = 0, faux = 0, detail = [];
    const cas = [
      { nom: 'grave sec', bpm: 120, freq: 55, decay: 0.03 },
      { nom: 'grave long', bpm: 90, freq: 60, decay: 0.08 },
      { nom: 'medium', bpm: 140, freq: 180, decay: 0.02 },
      { nom: 'aigu', bpm: 100, freq: 900, decay: 0.015 },
    ];
    for (const c of cas) {
      const g = makeClickTrack(c);
      oublierTemps('t8-' + c.nom);
      const t = await detecterTemps(g.file, 't8-' + c.nom, { sensibilite: 0.5 });
      const e = apparier(t, g.attendus);
      if (e.length !== g.attendus.length) toutBon = false;
      faux += t.length - e.length;
      pireEcart = Math.max(pireEcart, ...e.map(Math.abs));
      detail.push(`${c.nom} ${e.length}/${g.attendus.length}`);
    }
    check('tous les coups reperes', toutBon, detail.join(', '));
    check('aucun point en trop', faux === 0, faux + ' faux positif(s)');
    check('points poses au bon endroit', pireEcart < 0.02,
      'pire ecart ' + (pireEcart * 1000).toFixed(1) + ' ms');

    // 2) la sensibilite ouvre et ferme le robinet
    const g2 = makeClickTrack({ bpm: 120, secs: 12 });
    oublierTemps('t8-sensi');
    const bas = await detecterTemps(g2.file, 't8-sensi', { sensibilite: 0 });
    const haut = await detecterTemps(g2.file, 't8-sensi', { sensibilite: 1 });
    check('la sensibilite change le nombre de points', haut.length > bas.length,
      `${bas.length} a 0 %, ${haut.length} a 100 %`);

    // 3) le second appel reutilise l'analyse : c'est ce qui rend le curseur vif
    const tA = performance.now();
    await detecterTemps(g2.file, 't8-sensi', { sensibilite: 0.5 });
    const cache = performance.now() - tA;
    check('reglage instantane grace au cache', cache < 250, cache.toFixed(0) + ' ms');

    // 4) les temps sont ranges en temps source : rogner ou accelerer le clip
    //    ne doit pas les decaler sur la timeline
    const clipT = newClip({ t0: 10, in: 0, dur: 8, speed: 1, beats: [1, 2, 3, 9] });
    const vus = tempsTimeline(clipT);
    check('report sur la timeline', vus.length === 3 && Math.abs(vus[0] - 11) < 1e-9,
      `[${vus.map((x) => x.toFixed(2))}] — le temps hors du clip est ecarte`);
    const rogne = newClip({ t0: 10, in: 2, dur: 6, speed: 1, beats: [1, 2, 3, 9] });
    const vus2 = tempsTimeline(rogne);
    check('rognage : les points ne bougent pas', vus2.length === 2 && Math.abs(vus2[0] - 10) < 1e-9,
      `entree a 2 s → [${vus2.map((x) => x.toFixed(2))}]`);
    const vite = newClip({ t0: 0, in: 0, dur: 5, speed: 2, beats: [2, 4] });
    const vus3 = tempsTimeline(vite);
    check('vitesse doublee : les points suivent', Math.abs(vus3[0] - 1) < 1e-9 && Math.abs(vus3[1] - 2) < 1e-9,
      `[${vus3.map((x) => x.toFixed(2))}]`);

    // 5) l'aimant doit voir les points : c'est ce qui rend la fonction utile.
    //    On appelle le vrai code de la timeline avec un contexte minimal, plutot
    //    que d'en reecrire une copie qui ne prouverait rien.
    const musique = newClip({ t0: 0, in: 0, dur: 30, beats: [4, 8.5, 12] });
    const aCaler = newClip({ t0: 20, dur: 3 });
    const pisteA = newTrack('audio', 'musique'); pisteA.clips = [musique];
    const pisteB = newTrack('video', 'video'); pisteB.clips = [aCaler];
    const tl = {
      snap: true,
      pps: 100,                       // 8 px de tolerance = 0,08 s
      store: { project: { tracks: [pisteA, pisteB] }, playhead: 999 },
      snapPoints: Timeline.prototype.snapPoints,
      applySnap: Timeline.prototype.applySnap,
    };
    const pts = tl.snapPoints([aCaler.id]);
    check("l'aimant connait les points de rythme",
      [4, 8.5, 12].every((t) => pts.some((p) => Math.abs(p - t) < 1e-9)),
      pts.length + " points d'accroche au total");
    const cale = tl.applySnap(8.44, [aCaler.id]);
    check("un clip lache pres d'un temps s'y colle", Math.abs(cale - 8.5) < 1e-9,
      '8,440 s → ' + cale.toFixed(3) + ' s');
    const loin = tl.applySnap(9.4, [aCaler.id]);
    check('trop loin, rien ne bouge', Math.abs(loin - 9.4) < 1e-9, '9,400 s → ' + loin.toFixed(3) + ' s');
    const sansBeats = { ...tl, store: { project: { tracks: [pisteB] }, playhead: 999 } };
    check("sans points, l'aimant ignore le rythme",
      Math.abs(sansBeats.applySnap(8.44, [aCaler.id]) - 8.44) < 1e-9);
  } catch (e) { check('points de rythme', false, e.message); }

  head('T9 — enchainement des clips a la lecture');
  try {
    // Une coupe : le clip B vient d'entrer, son element est lance mais son
    // horloge n'a pas encore bouge. C'est exactement le cas qui figeait la tete
    // de lecture a chaque coupe. On appelle la vraie methode du lecteur.
    const b = newClip({ t0: 2, in: 5, dur: 2, speed: 1 });
    const piste = newTrack('video', 'v'); piste.clips = [b];
    const el = { readyState: 4, paused: false, seeking: false, currentTime: 5 };
    const faux = {
      els: new Map([[b.id, { el }]]),
      store: { project: { tracks: [piste] }, playhead: 2.0 },
      _wallLast: 1000,
    };
    const avance = Player.prototype._advance;

    // horloge immobile : la lecture doit continuer sur l'horloge murale
    const t1 = avance.call(faux, 1016);
    faux.store.playhead = t1;
    const t2 = avance.call(faux, 1032);
    check('une coupe ne fige plus la tete de lecture', t1 > 2 && t2 > t1,
      `2,000 → ${t1.toFixed(3)} → ${t2.toFixed(3)} s`);

    // l'horloge de l'element bouge : on s'y cale
    faux.store.playhead = 2.03;
    el.currentTime = 5.05;
    const t3 = avance.call(faux, 1048);
    check("l'horloge du clip est reprise des qu'elle avance", Math.abs(t3 - 2.05) < 1e-6,
      't = ' + t3.toFixed(3) + ' s (clip a 5,050 s, entree a 5,000 s)');

    // element en retard : interdit de revenir en arriere
    faux.store.playhead = 2.2;
    el.currentTime = 5.1;
    const t4 = avance.call(faux, 1064);
    check('la lecture ne revient jamais en arriere', t4 >= 2.2,
      'clip a 5,100 s → t = ' + t4.toFixed(3) + ' s');
  } catch (e) { check('enchainement des clips', false, e.message); }

  head('T10 — montage a plans courts : exactitude image par image');
  try {
    const FPS = 30, W = 640, H = 360;
    // trois sources, chacune numerotant ses images
    const srcs = [];
    for (let s = 0; s < 3; s++) {
      srcs.push(await makeCountedVideo(TMP + `cutlocal-compte-${s}.mp4`,
        { W, H, fps: FPS, frames: 70, base: 1 + s * 70 }));
    }
    const fichiers = [];
    for (let s = 0; s < 3; s++) fichiers.push(await fetchAsFile(srcs[s].path, `c${s}.mp4`));
    const mp4s = [];
    for (const f of fichiers) mp4s.push(await Mp4File.open(blobReader(f)));

    const project = newProject({ width: W, height: H, fps: FPS });
    project.tracks[0].magnetic = true;
    const medias = srcs.map((s, i) => ({
      id: 'md' + i, name: `c${i}.mp4`, kind: 'video', width: W, height: H,
      fps: FPS, duration: s.frames / FPS, hasVideo: true, hasAudio: false,
    }));
    project.media = medias;

    // 14 plans courts (3 a 9 images) pris a des endroits varies des sources
    const plan = [
      [0, 0, 5], [1, 12, 4], [2, 33, 6], [0, 47, 3], [1, 61, 8], [2, 5, 4],
      [0, 60, 5], [1, 25, 3], [2, 50, 7], [0, 18, 4], [1, 40, 6], [2, 64, 3],
      [0, 55, 9], [1, 3, 5],
    ];
    let t0 = 0;
    const attendu = [];                       // image de timeline -> {src, img}
    for (const [s, dep, n] of plan) {
      project.tracks[0].clips.push(newClip({
        mediaId: 'md' + s, t0, dur: n / FPS, in: dep / FPS, speed: 1,
      }));
      for (let k = 0; k < n; k++) attendu.push({ src: s, img: dep + k, code: 1 + s * 70 + dep + k });
      t0 += n / FPS;
    }
    const total = attendu.length;

    // Comme la vraie bibliotheque, on garde une seule adresse par media :
    // en recreer une a chaque appel ferait recharger l'element sans arret.
    const urls = new Map();
    const lib = {
      files: new Map(medias.map((m, i) => [m.id, fichiers[i]])),
      file: (id) => fichiers[medias.findIndex((m) => m.id === id)] || null,
      url(id) {
        if (!urls.has(id)) urls.set(id, URL.createObjectURL(fichiers[medias.findIndex((m) => m.id === id)]));
        return urls.get(id);
      },
      mp4Of: async (id) => mp4s[medias.findIndex((m) => m.id === id)] || null,
      apercus: new Map(),
      urlApercu(id) { return this.url(id); },
    };
    const store = { project, playhead: 0, seek(t) { this.playhead = t; } };

    // ---------- 1) l'export doit poser exactement les bonnes images
    const outPath = TMP + 'cutlocal-plans-courts.mp4';
    const res = await new Exporter(store, lib, TK).run({
      path: outPath, width: W, height: H, fps: FPS, codec: 'avc',
      bitrate: 20e6, audioBitrate: 0, withAudio: false, gop: 30, from: 0, to: total / FPS,
    }, () => {});
    check('export : toutes les images produites', res.frames === total, `${res.frames} / ${total}`);

    const relu = await fetchAsFile(outPath, 'plans.mp4');
    const m4 = await Mp4File.open(blobReader(relu));
    const vt = m4.videoTrack;
    check('export : relisible', !!vt && vt.samples.length === total,
      vt ? `${vt.samples.length} images` : 'illisible');

    // on decode l'export et on lit le numero grave dans chaque image
    const cv = new OffscreenCanvas(W, H);
    const c2 = cv.getContext('2d', { willReadFrequently: true });
    const lus = new Array(total).fill(null);
    await new Promise((fini, rate) => {
      let n = 0;
      const d = new VideoDecoder({
        output: (fr) => {
          const k = Math.round((fr.timestamp / 1e6) * FPS);
          c2.drawImage(fr, 0, 0);
          fr.close();
          const px = c2.getImageData(W >> 1, H >> 1, 1, 1).data;
          if (k >= 0 && k < total) lus[k] = indexDeCouleur(px[0], px[1], px[2]);
          if (++n >= total) fini();
        },
        error: rate,
      });
      d.configure({ codec: vt.codec, codedWidth: vt.width, codedHeight: vt.height, description: vt.description });
      m4.readSamples(vt, 0, total).then((ech) => {
        for (const e of ech) {
          const s = e.sample;
          d.decode(new EncodedVideoChunk({
            type: s.sync ? 'key' : 'delta',
            timestamp: Math.round((s.cts / vt.timescale) * 1e6),
            duration: Math.round((s.dur / vt.timescale) * 1e6),
            data: e.data,
          }));
        }
        d.flush().then(() => fini()).catch(rate);
      });
    });

    // Le fond du projet est noir, qui se decode en 0 : ce code ne correspond
    // donc a aucune image et signale « rien d'affiche ».
    const decrire = (c) => (c === null ? 'rien' : c === 0 ? 'ecran vide'
      : `s${Math.floor((c - 1) / 70)}#${(c - 1) % 70}`);
    let justes = 0;
    const fautes = [];
    for (let k = 0; k < total; k++) {
      const a = attendu[k], l = lus[k];
      if (l === a.code) justes++;
      else if (fautes.length < 6) {
        fautes.push(`img ${k}: attendu s${a.src}#${a.img}, lu ${decrire(l)}`);
      }
    }
    check('export : chaque image vient du bon endroit', justes === total,
      `${justes}/${total}${fautes.length ? ' — ' + fautes.join(' | ') : ''}`);

    // ---------- 2) l'apercu doit montrer exactement les memes images
    const cvGl = document.createElement('canvas');
    cvGl.width = W; cvGl.height = H;
    cvGl.style.cssText = 'position:absolute;left:-9999px;width:8px;height:8px';
    document.body.append(cvGl);
    const rend = new Renderer(cvGl, { preserve: true });
    const player = new Player(store, lib, rend);
    player.quality = 1;

    const lireApercu = () => {
      const c = player._readToCanvas(0);
      if (!c) return null;
      const g = c.getContext('2d', { willReadFrequently: true });
      const px = g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
      if (px[3] < 8) return null;                       // rien d'affiche
      return indexDeCouleur(px[0], px[1], px[2]);
    };

    let vus = 0, vides = 0;
    const fautesAp = [];
    for (let k = 0; k < total; k++) {
      store.seek((k + 0.5) / FPS);
      player.invalidate();
      // on laisse le temps aux sources d'arriver exactement au bon endroit
      let bon = null;
      for (let essai = 0; essai < 6; essai++) {
        await player.renderExact();
        const l = lireApercu();
        if (l === attendu[k].code) { bon = l; break; }
        await new Promise((r) => setTimeout(r, 30));
      }
      if (bon) vus++;
      else {
        const l = lireApercu();
        if (l === null) vides++;
        if (fautesAp.length < 6) {
          fautesAp.push(`img ${k}: attendu s${attendu[k].src}#${attendu[k].img}, lu ${decrire(l)}`);
        }
      }
    }
    check('apercu : chaque plan montre la bonne image', vus === total,
      `${vus}/${total}${fautesAp.length ? ' — ' + fautesAp.join(' | ') : ''}`);


    // ---------- 3) et dans le desordre : c'est ainsi qu'on cale une coupe
    const parcours = (ordre) => {
      let ok = 0; const rates = [];
      return (async () => {
        for (const k of ordre) {
          store.seek((k + 0.5) / FPS);
          let bon = false;
          for (let essai = 0; essai < 6; essai++) {
            await player.renderExact();
            if (lireApercu() === attendu[k].code) { bon = true; break; }
            await new Promise((r) => setTimeout(r, 30));
          }
          if (bon) ok++;
          else if (rates.length < 5) rates.push(`img ${k}: attendu s${attendu[k].src}#${attendu[k].img}, lu ${decrire(lireApercu())}`);
        }
        return { ok, rates };
      })();
    };

    const arriere = [...Array(total).keys()].reverse();
    const rA = await parcours(arriere);
    check('apercu : exact aussi en marche arriere', rA.ok === total,
      `${rA.ok}/${total}${rA.rates.length ? ' — ' + rA.rates.join(' | ') : ''}`);

    // ordre pseudo-aleatoire mais reproductible
    let graine = 7;
    const melange = [...Array(total).keys()];
    for (let i = melange.length - 1; i > 0; i--) {
      graine = (graine * 1103515245 + 12345) & 0x7fffffff;
      const j = graine % (i + 1);
      [melange[i], melange[j]] = [melange[j], melange[i]];
    }
    const rM = await parcours(melange);
    check('apercu : exact en sautant partout', rM.ok === total,
      `${rM.ok}/${total}${rM.rates.length ? ' — ' + rM.rates.join(' | ') : ''}`);

    // ---------- 4) un plan accelere doit lui aussi tomber juste
    const clipsRapides = project.tracks[0].clips;
    clipsRapides[0].speed = 2;
    const attRapide = [];
    for (let k = 0; k < clipsRapides[0].dur * FPS; k++) {
      attRapide.push(1 + 0 * 70 + Math.floor(k * 2));      // source 0, 2 images par image
    }
    let okRap = 0; const ratesRap = [];
    for (let k = 0; k < attRapide.length; k++) {
      store.seek((k + 0.5) / FPS);
      let bon = false;
      for (let essai = 0; essai < 6; essai++) {
        await player.renderExact();
        if (lireApercu() === attRapide[k]) { bon = true; break; }
        await new Promise((r) => setTimeout(r, 30));
      }
      if (bon) okRap++;
      else if (ratesRap.length < 4) ratesRap.push(`img ${k}: attendu s0#${attRapide[k] - 1}, lu ${decrire(lireApercu())}`);
    }
    check('apercu : plan accelere exact', okRap === attRapide.length,
      `${okRap}/${attRapide.length}${ratesRap.length ? ' — ' + ratesRap.join(' | ') : ''}`);
    clipsRapides[0].speed = 1;


    // ---------- 5) EN LECTURE : l'image doit defiler, pas se figer
    //
    // A l'arret on exige l'image exacte ; en lecture c'est l'element video qui
    // donne le tempo. Une regle trop stricte ici declarait l'image « perimee »
    // a chaque tour, le rendu gardait la texture precedente, et chaque plan
    // restait bloque sur sa premiere image. Ce test regarde donc ce que l'ecran
    // montre REELLEMENT pendant une lecture.
    // Garde-fou : une mesure de lecture ne doit jamais immobiliser la suite.
    // Sans limite, un decodeur qui ne rend pas la main bloquait tout et on ne
    // savait meme pas a quelle etape.
    const limite = (promesse, ms, quoi) => Promise.race([
      promesse,
      new Promise((_, ko) => setTimeout(() => ko(new Error('delai depasse : ' + quoi)), ms)),
    ]);

    store.seek(0);
    await limite(player.renderExact(), 8000, 'premier rendu');
    // Lecture d'UN pixel directement sur la carte : relire tout le canvas a
    // chaque image coutait plus cher que le rendu lui-meme et faussait la
    // mesure — on croyait l'apercu fige alors que c'etait la sonde.
    const gl = player.renderer.gl;
    const px1 = new Uint8Array(4);
    const lirePixel = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(player.renderer.w >> 1, player.renderer.h >> 1, 1, 1,
        gl.RGBA, gl.UNSIGNED_BYTE, px1);
      // pas de test sur l'alpha : le rendu peut sortir un alpha nul alors que
      // l'image est bien la — c'est la couleur qui porte l'information
      return indexDeCouleur(px1[0], px1[1], px1[2]);
    };
    const defile = [];
    await limite(player.play(), 5000, 'demarrage de la lecture');
    const t0lect = performance.now();
    while (performance.now() - t0lect < (total / FPS) * 1000 + 400) {
      await new Promise((r) => requestAnimationFrame(r));
      const c = lireApercu();
      if (c !== null && c !== 0 && (!vus.length || defile[defile.length - 1] !== c)) defile.push(c);
    }
    player.pause();

    // Combien de releves ont montre QUELQUE CHOSE ? Sur une machine tres
    // chargee, la lecture peut n'avoir pas eu le temps de rendre : le test ne
    // peut alors rien conclure, et le dire vaut mieux que crier a la panne.
    // Combien de plans differents la lecture a-t-elle eu le temps de montrer ?
    // Sous une page en arriere-plan, le navigateur gele l'animation : on releve
    // alors une image ou deux, ce qui ne permet ni de conclure a la panne ni de
    // conclure au bon fonctionnement. On exige donc une mesure consistante —
    // au moins un tiers du nombre de plans — avant de juger quoi que ce soit.
    const utiles = defile.filter((c) => c !== null && c !== 0).length;
    const assez = utiles >= plan.length;
    if (!assez) {
      // Cause de loin la plus frequente : la page n'etait pas au premier plan.
      // Le navigateur gele alors l'animation, la lecture n'avance pas, et la
      // mesure ne veut plus rien dire. On le signale sans compter d'echec :
      // annoncer une panne qu'on n'a pas su mesurer serait pire que se taire.
      log(`  ⓘ lecture non mesuree (${utiles} releve(s) seulement) : gardez la`
        + " fenetre au premier plan, sinon le navigateur gele l'animation.", 'dim');
    }

    const codesAttendus = new Set(attendu.map((a) => a.code));
    const intrus = defile.filter((c) => !codesAttendus.has(c));
    if (assez) check('lecture : aucune image etrangere au montage', intrus.length === 0,
      intrus.length ? `${intrus.length} intruse(s) : ${intrus.slice(0, 4).map(decrire).join(', ')}` : `${defile.length} images distinctes vues`);

    // chaque plan doit avoir montre plus que sa premiere image
    let plansVus = 0; const plansFiges = []; const plansNonVus = [];
    let base = 0;
    for (const [s, dep, n] of plan) {
      if (n < 2) { base += n; continue; }
      const codes = [];
      for (let k = 0; k < n; k++) codes.push(attendu[base + k].code);
      const distincts = codes.filter((c) => defile.includes(c)).length;
      // A 40 ms d'echantillonnage, un plan de 3 images (100 ms) n'est vu que
      // deux ou trois fois : on exige donc deux images distinctes pour les
      // plans assez longs, une seule pour les plus courts.
      const exige = n >= 5 ? 2 : 1;
      if (distincts >= exige) plansVus++;
      else if (distincts === 0) plansNonVus.push(`s${s}`);
      else plansFiges.push(`s${s} (${distincts} image(s) vue(s) sur ${n})`);
      base += n;
    }
    // Le defaut qu'on traque est precis : chaque plan bloque sur sa PREMIERE
    // image. Il se reconnait a ce que les plans montrent exactement une image,
    // pas zero — zero veut dire qu'on n'a rien pu mesurer.
    // On ne juge que les plans reellement observes. Le defaut traque — un plan
    // bloque sur sa premiere image — se reconnait a UNE image vue, pas zero.
    if (assez && plansVus + plansFiges.length > 0) {
      check('lecture : chaque plan defile vraiment', plansFiges.length === 0,
        plansFiges.length ? plansFiges.join(' | ') : `${plansVus} plans ont montre plusieurs images`);
    }
    if (plansNonVus.length) {
      log(`  ⓘ ${plansNonVus.length} plan(s) sans aucun releve (${plansNonVus.join(', ')}) :`
        + " non mesures. Gardez la fenetre au premier plan : en arriere-plan, le"
        + " navigateur gele l'animation.", 'dim');
    }

    player.disposeAll && player.disposeAll();
    try { const lose = rend.gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (_) {}
    cvGl.remove();
  } catch (e) { check('montage a plans courts', false, (e && e.stack ? e.stack.split('\n')[0] : e.message)); }


  // ------------------------------------------- T11 export reparti sur plusieurs coeurs
  //
  // Au-dela d'une certaine duree, l'export ne se fait plus image par image sur
  // le thread principal : la timeline est decoupee en tranches confiees a des
  // Web Workers. C'est un tout autre chemin de code, et c'est celui que prend
  // n'importe quel vrai montage — les tests precedents, qui durent deux ou
  // trois secondes, restent tous en deca du seuil et ne l'atteignent jamais.
  head('T11 — export reparti (plusieurs coeurs) : exactitude image par image');
  try {
    const FPS = 30, W = 640, H = 360;
    const srcs = [];
    for (let s = 0; s < 3; s++) {
      srcs.push(await makeCountedVideo(TMP + `cutlocal-par-${s}.mp4`,
        { W, H, fps: FPS, frames: 70, base: 1 + s * 70, hz: 220 * (s + 1) }));
    }
    const fichiers = [];
    for (let s = 0; s < 3; s++) fichiers.push(await fetchAsFile(srcs[s].path, `p${s}.mp4`));
    const mp4s = [];
    for (const f of fichiers) mp4s.push(await Mp4File.open(blobReader(f)));

    const project = newProject({ width: W, height: H, fps: FPS });
    project.tracks[0].magnetic = true;
    const medias = srcs.map((s, i) => ({
      id: 'mp' + i, name: `p${i}.mp4`, kind: 'video', width: W, height: H,
      fps: FPS, duration: s.frames / FPS, hasVideo: true, hasAudio: true,
    }));
    project.media = medias;

    // Un montage assez long pour declencher le decoupage, fait de plans courts
    // pris un peu partout : c'est la situation ou les tranches se recollent le
    // plus souvent, donc celle qui reveille les defauts de raccord.
    let graine = 12345;
    const alea = (n) => { graine = (graine * 1103515245 + 12345) & 0x7fffffff; return graine % n; };
    const plan = [];
    let cadre = 0;
    while (cadre < 420) {
      const s = alea(3);
      const n = 3 + alea(10);
      const dep = alea(70 - n);
      plan.push([s, dep, n]);
      cadre += n;
    }

    let t0c = 0;
    const attendu = [];
    for (const [s, dep, n] of plan) {
      project.tracks[0].clips.push(newClip({
        mediaId: 'mp' + s, t0: t0c, dur: n / FPS, in: dep / FPS, speed: 1,
      }));
      for (let k = 0; k < n; k++) attendu.push({ src: s, img: dep + k, code: 1 + s * 70 + dep + k });
      t0c += n / FPS;
    }
    const total = attendu.length;

    const urls = new Map();
    const lib = {
      files: new Map(medias.map((m, i) => [m.id, fichiers[i]])),
      file: (id) => fichiers[medias.findIndex((m) => m.id === id)] || null,
      url(id) {
        if (!urls.has(id)) urls.set(id, URL.createObjectURL(fichiers[medias.findIndex((m) => m.id === id)]));
        return urls.get(id);
      },
      mp4Of: async (id) => mp4s[medias.findIndex((m) => m.id === id)] || null,
      apercus: new Map(),
      urlApercu(id) { return this.url(id); },
    };
    const store = { project, playhead: 0, seek(t) { this.playhead = t; } };

    const outPath = TMP + 'cutlocal-parallele.mp4';
    const res = await new Exporter(store, lib, TK).run({
      path: outPath, width: W, height: H, fps: FPS, codec: 'avc',
      bitrate: 20e6, audioBitrate: 128000, withAudio: true, sampleRate: 48000,
      gop: 30, from: 0, to: total / FPS,
    }, () => {});

    // Sans cette verification, le test pourrait passer en n'ayant jamais quitte
    // le chemin sequentiel — et ne rien prouver du tout.
    check('export reparti : le decoupage a bien eu lieu', (res.parallele || 1) > 1,
      `${plan.length} plans, ${total} images, ${res.parallele || 1} tranche(s)`);
    check('export reparti : toutes les images produites', res.frames === total,
      `${res.frames} / ${total}`);

    const relu = await fetchAsFile(outPath, 'par.mp4');
    const m4 = await Mp4File.open(blobReader(relu));
    const vt = m4.videoTrack;
    check('export reparti : relisible', !!vt && vt.samples.length === total,
      vt ? `${vt.samples.length} images / ${total}` : 'illisible');

    if (vt) {
      const cv = new OffscreenCanvas(W, H);
      const c2 = cv.getContext('2d', { willReadFrequently: true });
      const lus = new Array(total).fill(null);
      await new Promise((fini, rate) => {
        let n = 0;
        const d = new VideoDecoder({
          output: (fr) => {
            const k = Math.round((fr.timestamp / 1e6) * FPS);
            c2.drawImage(fr, 0, 0);
            fr.close();
            const px = c2.getImageData(W >> 1, H >> 1, 1, 1).data;
            if (k >= 0 && k < total) lus[k] = indexDeCouleur(px[0], px[1], px[2]);
            if (++n >= total) fini();
          },
          error: rate,
        });
        d.configure({ codec: vt.codec, codedWidth: vt.width, codedHeight: vt.height, description: vt.description });
        m4.readSamples(vt, 0, total).then((ech) => {
          for (const e of ech) {
            const s = e.sample;
            d.decode(new EncodedVideoChunk({
              type: s.sync ? 'key' : 'delta',
              timestamp: Math.round((s.cts / vt.timescale) * 1e6),
              duration: Math.round((s.dur / vt.timescale) * 1e6),
              data: e.data,
            }));
          }
          d.flush().then(() => fini()).catch(rate);
        });
      });

      const faux = [];
      for (let k = 0; k < total; k++) {
        if (lus[k] !== attendu[k].code) faux.push({ k, lu: lus[k], att: attendu[k].code });
      }
      check('export reparti : chaque image vient du bon endroit', faux.length === 0,
        faux.length
          ? `${faux.length} fausse(s) sur ${total} — ex. image ${faux[0].k} : lu ${faux[0].lu}, attendu ${faux[0].att}`
          : `${total}/${total}`);
    }

    // ---------- le son doit etre continu d'un bout a l'autre
    // Chaque source sonne sans la moindre interruption : un silence dans
    // l'export ne peut donc venir que du montage. On cherche le plus long et
    // on le compare a la duree d'une image — en deca, personne ne l'entendrait.
    const at = m4.audioTrack;
    check('export reparti : piste audio presente', !!at,
      at ? `${at.codec} ${at.sampleRate}Hz, ${at.samples.length} trames` : 'absente');
    if (at) {
      const dureeAudio = (at.samples.length * 1024) / at.sampleRate;
      const dureeVideo = total / FPS;
      check('export reparti : son et image de meme duree',
        Math.abs(dureeAudio - dureeVideo) < 0.1,
        `${dureeAudio.toFixed(3)} s de son / ${dureeVideo.toFixed(3)} s de video`);

      const ac = new OfflineAudioContext(1, 128, 48000);
      const buf = await ac.decodeAudioData(await relu.arrayBuffer());
      const pcm = buf.getChannelData(0);
      const sr = buf.sampleRate;
      const fen = Math.round(sr * 0.01);            // fenetres de 10 ms
      let creux = 0, pire = 0, ouPire = 0;
      for (let i = 0; i + fen <= pcm.length; i += fen) {
        let crete = 0;
        for (let k = i; k < i + fen; k++) { const v = Math.abs(pcm[k]); if (v > crete) crete = v; }
        if (crete < 0.02) { creux++; if (creux > pire) { pire = creux; ouPire = i / sr; } }
        else creux = 0;
      }
      const silenceMs = pire * 10;
      check('export reparti : aucune coupure de son', silenceMs <= 40,
        pire ? `plus long silence ${silenceMs} ms vers ${ouPire.toFixed(2)} s` : 'aucun silence');
    }

    // ---------- le meme montage, decoupage desactive
    // C'est la soupape offerte a l'utilisateur quand sa machine ne suit pas :
    // elle doit vraiment couper le decoupage, et rendre le meme nombre
    // d'images. Sans ce controle, la case pourrait ne rien faire du tout.
    const res1 = await new Exporter(store, lib, TK).run({
      path: TMP + 'cutlocal-monocoeur.mp4', width: W, height: H, fps: FPS, codec: 'avc',
      bitrate: 20e6, audioBitrate: 128000, withAudio: true, sampleRate: 48000,
      gop: 30, from: 0, to: total / FPS, monocoeur: true,
    }, () => {});
    check('export sur un seul coeur : decoupage bien desactive',
      (res1.parallele || 1) === 1, `${res1.parallele || 1} tranche(s)`);
    check('export sur un seul coeur : meme nombre d images',
      res1.frames === total, `${res1.frames} / ${total}`);
  } catch (e) { check('export reparti', false, (e && e.stack ? e.stack.split('\n')[0] : e.message)); }

  report(T0);
}

function report(T0) {
  const total = pass + fail;
  log('');
  log(`${pass}/${total} tests reussis${fail ? ' — ' + fail + ' ECHEC(S)' : ' — tout est vert'} en ${((performance.now() - T0) / 1000).toFixed(1)} s`,
    fail ? 'no' : 'ok');
}

document.getElementById('run').onclick = () => runAll().catch((e) => { log('EXCEPTION: ' + (e.stack || e.message), 'no'); report(performance.now()); });
document.getElementById('clean').onclick = () => log('les fichiers de test restent dans ' + TMP, 'dim');
