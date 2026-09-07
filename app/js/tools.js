// Outils de montage : inversion de la video, image figee, coupes rapides.
import { mediaOf, layoutTrack, normalizeTrack, newClip, newTrack, findClip } from './state.js';
import { resolveVideoConfig } from './exporter.js';
import { decodeAudio, encodeAac } from './audiomix.js';
import { b64, clamp, yieldTask } from './util.js';

const REC_MAGIC = 0xc0def00d;

// ------------------------------------------------------------------- ecriture

function record(track, data, duration, key) {
  const h = new ArrayBuffer(16);
  const dv = new DataView(h);
  dv.setUint32(0, REC_MAGIC, true);
  dv.setUint8(4, track);
  dv.setUint8(5, key ? 1 : 0);
  dv.setUint32(8, duration, true);
  dv.setUint32(12, data.byteLength, true);
  return [h, data];
}

class FileWriter {
  constructor(tk) { this.tk = tk; this.parts = []; this.bytes = 0; this.session = null; }
  async begin(cfg) {
    const r = await fetch(`/api/export/begin?tk=${this.tk}`, { method: 'POST', body: JSON.stringify(cfg) }).then((x) => x.json());
    if (!r.session) throw new Error(r.error || 'ouverture du fichier impossible');
    this.session = r.session;
  }
  push(track, data, duration, key) {
    this.parts.push(...record(track, data, duration, key));
    this.bytes += 16 + data.byteLength;
  }
  async flush(force) {
    if (!this.session || !this.parts.length) return;
    if (!force && this.bytes < 3 * 1024 * 1024) return;
    const body = new Blob(this.parts);
    this.parts = []; this.bytes = 0;
    const j = await fetch(`/api/export/append?tk=${this.tk}&s=${this.session}`, { method: 'POST', body }).then((x) => x.json());
    if (j.error) throw new Error(j.error);
  }
  async end() {
    await this.flush(true);
    return fetch(`/api/export/end?tk=${this.tk}&s=${this.session}`, { method: 'POST' }).then((x) => x.json());
  }
  async abort() {
    if (this.session) await fetch(`/api/export/abort?tk=${this.tk}&s=${this.session}`, { method: 'POST' }).catch(() => {});
  }
}

async function cachePath(tk, name) {
  const r = await fetch(`/api/cache?tk=${tk}&name=${encodeURIComponent(name)}`, { method: 'POST' }).then((x) => x.json());
  if (!r.path) throw new Error('dossier de cache indisponible');
  return r.path;
}

// -------------------------------------------------------- decodage d'un groupe

/**
 * Decode les samples [from..to] en partant de l'image cle keyIdx et renvoie des
 * ImageBitmap (t en secondes), triees par temps de presentation.
 *
 * IMPORTANT : les VideoFrame issues d'un decodeur materiel viennent d'un pool de
 * tampons tres limite. On les copie donc en ImageBitmap et on les referme
 * immediatement, par petits lots — sinon le decodeur se bloque au bout de
 * quelques images.
 */
async function decodeRangeBitmaps(mp4, vt, keyIdx, from, to) {
  const kept = [];
  const pend = [];
  let err = null;
  let notify = null;
  const dec = new VideoDecoder({
    output: (f) => { pend.push(f); if (notify) { notify(); notify = null; } },
    error: (e) => { err = e; if (notify) { notify(); notify = null; } },
  });
  dec.configure({
    codec: vt.codec,
    description: vt.description || undefined,
    codedWidth: vt.width, codedHeight: vt.height,
    hardwareAcceleration: 'no-preference',
  });

  const tFrom = vt.samples[from].cts / vt.timescale - 1e-6;
  const drain = async () => {
    while (pend.length) {
      const f = pend.shift();
      const t = f.timestamp / 1e6;
      if (t >= tFrom) {
        try { kept.push({ t, bmp: await createImageBitmap(f) }); } catch (_) {}
      }
      f.close();
    }
  };
  const waitOut = () => Promise.race([
    new Promise((res) => { notify = res; }),
    new Promise((res) => setTimeout(res, 250)),
  ]);

  try {
    let idx = keyIdx;
    const LOT = 4;                       // on garde tres peu d'images en vol
    while (idx <= to) {
      if (err) throw err;
      const upto = Math.min(idx + LOT - 1, to);
      const list = await mp4.readSamples(vt, idx, upto);
      for (const c of list) {
        dec.decode(new EncodedVideoChunk({
          type: c.sample.sync ? 'key' : 'delta',
          timestamp: Math.round((c.sample.cts / vt.timescale) * 1e6),
          duration: Math.round((c.sample.dur / vt.timescale) * 1e6),
          data: c.data,
        }));
      }
      idx = upto + 1;
      // laisse sortir puis libere aussitot
      let guard = 0;
      while (dec.decodeQueueSize > LOT && guard++ < 60) { await waitOut(); await drain(); }
      await drain();
    }
    await dec.flush();
    await drain();
    if (err) throw err;
  } catch (e) {
    for (const f of pend) { try { f.close(); } catch (_) {} }
    for (const k of kept) { try { k.bmp.close(); } catch (_) {} }
    try { dec.close(); } catch (_) {}
    throw e;
  }
  try { dec.close(); } catch (_) {}
  kept.sort((a, b) => a.t - b.t);
  return kept;
}

// ------------------------------------------------------------------ inversion

/**
 * Rend une copie inversee du clip et remplace sa source.
 * Le fichier produit est un vrai MP4 : l'apercu et l'export fonctionnent ensuite
 * normalement, sans traitement particulier.
 */
export async function reverseClip({ store, lib, tk, clip, onProgress = () => {}, isCancelled = () => false }) {
  const project = store.project;
  const media = mediaOf(project, clip);
  if (!media) throw new Error('media introuvable');
  if (media.kind === 'image') throw new Error('Une image n\'a rien a inverser');

  const mp4 = await lib.mp4Of(media.id);
  const vt = mp4 && mp4.videoTrack;
  if (!vt || !vt.codec || !vt.samples.length) {
    throw new Error('Inversion possible seulement sur MP4/MOV (H.264, H.265, AV1)');
  }

  const speed = clip.speed || 1;
  const srcStart = clamp(clip.in, 0, media.duration);
  const srcEnd = clamp(clip.in + clip.dur * speed, srcStart + 0.05, media.duration);
  const D = srcEnd - srcStart;
  const fps = Math.max(1, project.fps);
  const dt = 1 / fps;
  const N = Math.max(1, Math.round(D * fps));

  onProgress({ phase: 'Preparation', ratio: 0 });

  const cfg = await resolveVideoConfig({
    codec: 'avc', width: vt.width, height: vt.height, fps,
    bitrate: Math.round(clamp(vt.width * vt.height * fps * 0.12, 4e6, 120e6)),
  });

  // --- audio inverse (si la source en a)
  let audio = null;
  if (media.hasAudio) {
    try {
      onProgress({ phase: 'Audio', ratio: 0.03 });
      const pcm = await decodeAudio(lib, media);
      if (pcm && pcm.data.length) {
        const sr = pcm.sampleRate;
        const a = Math.max(0, Math.floor((srcStart - (pcm.offset || 0)) * sr));
        const b = Math.min(pcm.data[0].length, Math.ceil((srcEnd - (pcm.offset || 0)) * sr));
        const len = Math.max(1, b - a);
        const chans = [new Float32Array(len), new Float32Array(len)];
        for (let ch = 0; ch < 2; ch++) {
          const src = pcm.data[Math.min(ch, pcm.data.length - 1)];
          for (let i = 0; i < len; i++) chans[ch][i] = src[b - 1 - i] || 0;
        }
        audio = await encodeAac({ data: chans, length: len, sampleRate: sr }, 192000);
      }
    } catch (e) { console.warn('audio inverse impossible', e); }
  }

  // --- fichier de sortie
  const outName = `inv-${Date.now().toString(36)}-${(media.name || 'clip').replace(/[^\w.-]/g, '_')}`.slice(0, 60) + '.mp4';
  const outPath = await cachePath(tk, outName);
  const writer = new FileWriter(tk);
  const timescale = fps * 1000;

  // temps sources voulus, du dernier au premier
  const wanted = new Array(N);
  for (let n = 0; n < N; n++) wanted[n] = clamp(srcEnd - (n + 0.5) * dt, srcStart, srcEnd);

  // decoupage en groupes d'images (GOP)
  const s = vt.samples;
  const firstIdx = mp4.indexAt(vt, srcStart);
  const lastIdx = mp4.indexAt(vt, Math.max(srcStart, srcEnd - 1e-4));
  // taille de bloc bornee par la memoire (les copies sont en RGBA)
  const MAX = clamp(Math.floor(180e6 / (vt.width * vt.height * 4)), 4, 40);
  const blocks = [];
  let i = mp4.keyBefore(vt, firstIdx);
  while (i <= lastIdx) {
    let j = i + 1;
    while (j <= lastIdx && !s[j].sync) j++;
    const a = i, b = Math.min(j - 1, lastIdx);
    for (let k = b; k >= a; k -= MAX) blocks.push({ key: a, from: Math.max(a, k - MAX + 1), to: k });
    i = j;
  }
  blocks.sort((x, y) => x.to - y.to);   // ordre croissant, on le parcourt a l'envers

  let encErr = null;
  let description = null;
  const pending = [];
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
        description = new Uint8Array(meta.decoderConfig.description);
      }
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      pending.push({ data: buf, key: chunk.type === 'key' });
    },
    error: (e) => { encErr = e; },
  });
  enc.configure(cfg.config);

  let outN = 0;
  let headDone = false;
  let audioIdx = 0;
  const gop = Math.max(1, Math.round(fps));

  try {
    for (let bi = blocks.length - 1; bi >= 0 && outN < N; bi--) {
      if (isCancelled()) throw new Error('annule');
      if (encErr) throw encErr;
      const blk = blocks[bi];
      const frames = await decodeRangeBitmaps(mp4, vt, blk.key, blk.from, blk.to);
      const tMin = s[blk.from].cts / vt.timescale;

      while (outN < N && wanted[outN] >= tMin - 1e-6) {
        const target = wanted[outN];
        let best = frames[0], bd = Infinity;
        for (const f of frames) {
          const d = Math.abs(f.t - target);
          if (d < bd) { bd = d; best = f; }
        }
        if (!best) break;
        const vf = new VideoFrame(best.bmp, {
          timestamp: Math.round((outN * 1e6) / fps),
          duration: Math.round(1e6 / fps),
        });
        enc.encode(vf, { keyFrame: outN % gop === 0 });
        vf.close();
        outN++;

        if (!headDone && description) {
          await writer.begin({
            path: outPath,
            video: { codec: 'avc', width: vt.width, height: vt.height, timescale, description: b64(description) },
            audio: audio ? { sampleRate: audio.sampleRate, channels: audio.channels, description: audio.description ? b64(audio.description) : null } : null,
          });
          headDone = true;
        }
        if (headDone) {
          while (pending.length) { const p = pending.shift(); writer.push(0, p.data, 1000, p.key); }
          if (audio) {
            const tv = outN / fps;
            while (audioIdx < audio.frames.length && (audioIdx * 1024) / audio.sampleRate <= tv) {
              writer.push(1, audio.frames[audioIdx].data, 1024, true); audioIdx++;
            }
          }
          await writer.flush(false);
        }
        // regulation : borne l'attente pour ne jamais rester bloque
        const waitUntil = performance.now() + 8000;
        while (enc.encodeQueueSize > 6) {
          if (encErr) throw encErr;
          if (enc.state !== 'configured') throw new Error('encodeur arrete (' + enc.state + ')');
          if (performance.now() > waitUntil) throw new Error('encodeur bloque a l\'image ' + outN);
          await yieldTask();
        }
        if (encErr) throw encErr;
        if ((outN & 3) === 0) {
          onProgress({ phase: 'Inversion', ratio: 0.05 + 0.9 * (outN / N), frame: outN, total: N });
          await yieldTask();
        }
      }
      for (const f of frames) { try { f.bmp.close(); } catch (_) {} }
    }

    onProgress({ phase: 'Finalisation', ratio: 0.97, frame: N, total: N });
    await enc.flush();
    if (encErr) throw encErr;
    if (!headDone) {
      if (!description) throw new Error('l\'encodeur n\'a rien produit');
      await writer.begin({
        path: outPath,
        video: { codec: 'avc', width: vt.width, height: vt.height, timescale, description: b64(description) },
        audio: audio ? { sampleRate: audio.sampleRate, channels: audio.channels, description: audio.description ? b64(audio.description) : null } : null,
      });
    }
    while (pending.length) { const p = pending.shift(); writer.push(0, p.data, 1000, p.key); }
    if (audio) while (audioIdx < audio.frames.length) { writer.push(1, audio.frames[audioIdx].data, 1024, true); audioIdx++; }
    const res = await writer.end();
    if (res.error) throw new Error(res.error);

    // --- remplace la source du clip par la version inversee
    const file = await fetchAsFile(tk, outPath, outName);
    const added = await lib.add([file]);
    const nm = added[0];
    if (!nm) throw new Error('reimport impossible');
    nm.reversedFrom = media.name;

    store.edit('inverser', () => {
      const f = findClip(store.project, clip.id);
      if (!f) return;
      f.clip.mediaId = nm.id;
      f.clip.in = 0;
      f.clip.dur = Math.min(f.clip.dur, (nm.duration || D) / (f.clip.speed || 1));
      f.clip.reversed = !f.clip.reversed;
      layoutTrack(f.track);
    });
    onProgress({ phase: 'Termine', ratio: 1, frame: N, total: N });
    return { path: outPath, frames: N, media: nm };
  } catch (e) {
    await writer.abort();
    throw e;
  } finally {
    try { if (enc.state !== 'closed') enc.close(); } catch (_) {}
  }
}

async function fetchAsFile(tk, path, name) {
  const r = await fetch(`/media?tk=${tk}&p=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error('relecture impossible (' + r.status + ')');
  return new File([await r.blob()], name, { type: 'video/mp4' });
}

// --------------------------------------------------------------- image figee

/**
 * Insere l'image courante de l'apercu comme photo fixe, juste apres le clip.
 * Rend l'image au format du projet (avec tous les effets appliques).
 */
export async function freezeFrame({ store, lib, player, tk, seconds = 2 }) {
  const project = store.project;
  const png = await player.snapshotBlob(project.width, project.height);
  if (!png) throw new Error('capture impossible');
  const name = `image-${Date.now().toString(36)}.png`;
  const file = new File([png], name, { type: 'image/png' });
  const added = await lib.add([file]);
  const m = added[0];
  if (!m) throw new Error('import impossible');

  const t = store.playhead;
  let target = null;
  store.edit('image figee', (p) => {
    // pose la photo sur une couche de superposition libre, a la tete de lecture
    let ov = p.tracks.find((x) => x.kind === 'video' && !x.magnetic && !x.locked
      && !x.clips.some((c) => t < c.t0 + c.dur - 1e-4 && t + seconds > c.t0 + 1e-4));
    if (!ov) {
      ov = newTrack('video', 'Image figee', { magnetic: false, height: 54 });
      let last = 0;
      p.tracks.forEach((x, i) => { if (x.kind === 'video') last = i; });
      p.tracks.splice(last + 1, 0, ov);
    }
    const c = newClip({ mediaId: m.id, kind: 'image', t0: t, dur: seconds, in: 0, fit: 'cover' });
    ov.clips.push(c);
    normalizeTrack(ov);
    target = c.id;
  });
  if (target) store.select(target);
  return { media: m, clipId: target };
}

// --------------------------------------------------------------- coupes rapides

/** Supprime tout ce qui precede la tete de lecture (sur les pistes concernees). */
export function trimBefore(store, tracks) {
  const t = store.playhead;
  store.edit('couper avant', () => {
    for (const tr of tracks) {
      if (tr.locked) continue;
      const keep = [];
      for (const c of tr.clips) {
        const end = c.t0 + c.dur;
        if (end <= t + 1e-4) continue;                    // entierement avant
        if (c.t0 < t) {
          const cut = t - c.t0;
          c.in += cut * (c.speed || 1);
          c.dur -= cut;
          c.t0 = t;
          c.fadeIn = 0; c.aFadeIn = 0;
          shift(c, -cut);
        }
        c.t0 = Math.max(0, c.t0 - t);
        keep.push(c);
      }
      tr.clips = keep;
      normalizeTrack(tr);
      layoutTrack(tr);
    }
  });
  store.seek(0);
}

/** Supprime tout ce qui suit la tete de lecture. */
export function trimAfter(store, tracks) {
  const t = store.playhead;
  store.edit('couper apres', () => {
    for (const tr of tracks) {
      if (tr.locked) continue;
      const keep = [];
      for (const c of tr.clips) {
        if (c.t0 >= t - 1e-4) continue;                   // entierement apres
        if (c.t0 + c.dur > t) {
          c.dur = t - c.t0;
          c.fadeOut = 0; c.aFadeOut = 0;
          c.transition = { kind: 'none', dur: 0 };
        }
        keep.push(c);
      }
      tr.clips = keep;
      normalizeTrack(tr);
      layoutTrack(tr);
    }
  });
}

function shift(host, delta) {
  if (!host.kf) return;
  for (const [k, arr] of Object.entries(host.kf)) host.kf[k] = arr.map((x) => ({ ...x, t: x.t + delta }));
  if (host.masks) for (const m of host.masks) shift(m, delta);
}
