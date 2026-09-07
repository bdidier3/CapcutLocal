// Mixage audio hors ligne + encodage AAC.
import { projectDuration } from './state.js';
import { overlapFade, overlapFadeOut } from './compose.js';
import { clamp, yieldTask, once } from './util.js';

const pcmCache = new Map();   // mediaId -> {data:[Float32Array], sampleRate, channels}
let cacheBytes = 0;
const CACHE_MAX = 600 * 1024 * 1024;

/** Decode la piste audio d'un media en PCM flottant. */
export async function decodeAudio(lib, media) {
  if (pcmCache.has(media.id)) return pcmCache.get(media.id);
  let res = null;
  try {
    res = await decodeViaCodecs(lib, media);
  } catch (e) {
    console.warn('AudioDecoder indisponible pour', media.name, e.message);
  }
  if (!res) {
    try { res = await decodeViaContext(lib, media); } catch (e) { console.warn('decodeAudioData', media.name, e.message); }
  }
  if (!res) {
    // Dernier recours : on fait LIRE le fichier au navigateur et on recupere le
    // son de sa piste. C'est le meme pipeline que l'apercu, il accepte donc tout
    // ce que l'apercu sait jouer — y compris les .MOV dont le son n'est ni AAC
    // ni Opus, qui sortaient jusqu'ici muets.
    try { res = await decodeViaTrack(lib, media); } catch (e) { console.warn('piste audio', media.name, e.message); }
  }
  if (res) {
    const bytes = res.data.reduce((s, a) => s + a.byteLength, 0);
    if (cacheBytes + bytes < CACHE_MAX) { pcmCache.set(media.id, res); cacheBytes += bytes; }
  }
  return res;
}

export function clearAudioCache() { pcmCache.clear(); cacheBytes = 0; }

/**
 * Lit le son via le lecteur du navigateur (MediaStreamTrackProcessor).
 * Fonctionne meme onglet cache, et couvre les formats que WebCodecs refuse.
 */
async function decodeViaTrack(lib, media) {
  if (typeof MediaStreamTrackProcessor === 'undefined') return null;
  const url = lib.url(media.id);
  if (!url) return null;
  const el = document.createElement('video');
  el.preload = 'auto'; el.playsInline = true; el.muted = false; el.volume = 0;
  el.src = url;
  el.style.cssText = 'position:absolute;left:-9999px;width:2px;height:2px;opacity:0';
  document.body.append(el);
  const chunks = [];
  let rate = 48000, chans = 2, total = 0;
  try {
    await once(el, 'loadeddata', 30000);
    const stream = el.captureStream ? el.captureStream() : null;
    const track = stream && stream.getAudioTracks && stream.getAudioTracks()[0];
    if (!track) return null;
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    await el.play().catch(() => {});
    const limite = performance.now() + Math.max(20000, (media.duration || 10) * 1500);
    for (;;) {
      if (performance.now() > limite) break;
      const { value, done } = await reader.read();
      if (done || !value) break;
      rate = value.sampleRate || rate;
      chans = value.numberOfChannels || chans;
      const n = value.numberOfFrames;
      const buf = [];
      for (let c = 0; c < Math.min(2, chans); c++) {
        const a = new Float32Array(n);
        value.copyTo(a, { planeIndex: c, format: 'f32-planar' });
        buf.push(a);
      }
      value.close();
      chunks.push(buf);
      total += n;
      if (total / rate >= (media.duration || 0) - 0.05) break;
    }
    try { reader.cancel(); } catch (_) {}
  } finally {
    try { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); } catch (_) {}
  }
  if (!total) return null;
  const out = [new Float32Array(total), new Float32Array(total)];
  let off = 0;
  for (const buf of chunks) {
    const n = buf[0].length;
    out[0].set(buf[0], off);
    out[1].set(buf[1] || buf[0], off);
    off += n;
  }
  return { data: out, sampleRate: rate };
}

async function decodeViaCodecs(lib, media) {
  if (typeof AudioDecoder === 'undefined') return null;
  const mp4 = await lib.mp4Of(media.id);
  const track = mp4 && mp4.audioTrack;
  if (!track || !track.codec) return null;
  if (!/^(mp4a|opus)/.test(track.codec)) return null;

  const cfg = {
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
    description: track.description || undefined,
  };
  const sup = await AudioDecoder.isConfigSupported(cfg).catch(() => null);
  if (!sup || !sup.supported) return null;

  const chunksOut = [];
  let channels = track.channels;
  let sampleRate = track.sampleRate;
  let err = null;
  const dec = new AudioDecoder({
    output: (data) => {
      const n = data.numberOfFrames;
      channels = data.numberOfChannels;
      sampleRate = data.sampleRate;
      const planes = [];
      for (let c = 0; c < channels; c++) {
        const buf = new Float32Array(n);
        try { data.copyTo(buf, { planeIndex: c, format: 'f32-planar' }); }
        catch (_) {
          // certains navigateurs ne donnent que de l'entrelace
          const inter = new Float32Array(n * channels);
          data.copyTo(inter, { planeIndex: 0, format: 'f32' });
          for (let i = 0; i < n; i++) buf[i] = inter[i * channels + c];
        }
        planes.push(buf);
      }
      chunksOut.push({ planes, n });
      data.close();
    },
    error: (e) => { err = e; },
  });
  dec.configure(cfg);

  const total = track.samples.length;
  const STEP = 200;
  for (let i = 0; i < total; i += STEP) {
    const to = Math.min(i + STEP - 1, total - 1);
    const list = await mp4.readSamples(track, i, to);
    for (const c of list) {
      dec.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round((c.sample.cts / track.timescale) * 1e6),
        duration: Math.round((c.sample.dur / track.timescale) * 1e6),
        data: c.data,
      }));
    }
    while (dec.decodeQueueSize > 400) await yieldTask();
    if (err) throw err;
  }
  await dec.flush();
  dec.close();
  if (err) throw err;
  if (!chunksOut.length) return null;

  const len = chunksOut.reduce((s, c) => s + c.n, 0);
  const data = Array.from({ length: channels }, () => new Float32Array(len));
  let off = 0;
  for (const c of chunksOut) {
    for (let ch = 0; ch < channels; ch++) data[ch].set(c.planes[Math.min(ch, c.planes.length - 1)], off);
    off += c.n;
  }
  return { data, sampleRate, channels, offset: track.tOffset || 0 };
}

async function decodeViaContext(lib, media) {
  const f = lib.file(media.id);
  if (!f) return null;
  if (f.size > 400 * 1024 * 1024) throw new Error('fichier trop volumineux pour le repli audio');
  const ac = new OfflineAudioContext(2, 128, 48000);
  const buf = await ac.decodeAudioData(await f.arrayBuffer());
  const data = [];
  for (let c = 0; c < buf.numberOfChannels; c++) data.push(buf.getChannelData(c).slice());
  return { data, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, offset: 0 };
}

/**
 * Melange toutes les pistes audio du projet.
 * @returns {{data:[Float32Array,Float32Array], length:number, sampleRate:number}|null}
 */
export async function mixdown(project, lib, opts = {}) {
  const sampleRate = opts.sampleRate || project.sampleRate || 48000;
  const t0 = opts.from || 0;
  const t1 = opts.to || projectDuration(project);
  const dur = Math.max(0, t1 - t0);
  if (dur <= 0) return null;
  const length = Math.ceil(dur * sampleRate);
  const onProgress = opts.onProgress || (() => {});

  const jobs = [];
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind === 'text' || clip.mute) continue;
      if (clip.t0 + clip.dur <= t0 || clip.t0 >= t1) continue;
      const media = project.media.find((m) => m.id === clip.mediaId);
      if (!media || !media.hasAudio) continue;
      jobs.push({ clip, track, media });
    }
  }
  if (!jobs.length) return null;

  const out = [new Float32Array(length), new Float32Array(length)];
  let done = 0;
  let any = false;

  for (const { clip, track, media } of jobs) {
    const pcm = await decodeAudio(lib, media);
    done++;
    onProgress(done / jobs.length);
    if (!pcm || !pcm.data.length) continue;
    any = true;

    const speed = clip.speed || 1;
    const srcRate = pcm.sampleRate;
    const nCh = pcm.data.length;
    const srcLen = pcm.data[0].length;
    const trackVol = track.volume ?? 1;

    const nStart = Math.max(0, Math.floor((clip.t0 - t0) * sampleRate));
    const nEnd = Math.min(length, Math.ceil((clip.t0 + clip.dur - t0) * sampleRate));

    for (let n = nStart; n < nEnd; n++) {
      const tTl = t0 + n / sampleRate;
      const tLocal = tTl - clip.t0;
      // gain (fondus + recouvrements)
      let g = (clip.volume ?? 1) * trackVol;
      if (clip.aFadeIn > 0 && tLocal < clip.aFadeIn) g *= tLocal / clip.aFadeIn;
      const rem = clip.dur - tLocal;
      if (clip.aFadeOut > 0 && rem < clip.aFadeOut) g *= Math.max(0, rem / clip.aFadeOut);
      g *= overlapFade(track, clip, tTl) * overlapFadeOut(track, clip, tTl);
      if (g <= 0) continue;

      const srcT = clip.in + tLocal * speed - (pcm.offset || 0);
      const sp = srcT * srcRate;
      if (sp < 0 || sp >= srcLen - 1) continue;
      const i0 = sp | 0;
      const fr = sp - i0;
      for (let ch = 0; ch < 2; ch++) {
        const src = pcm.data[Math.min(ch, nCh - 1)];
        out[ch][n] += (src[i0] + (src[i0 + 1] - src[i0]) * fr) * g;
      }
    }
  }
  if (!any) return null;

  // limitation douce pour eviter l'ecretage brut
  for (const ch of out) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      if (v > 1 || v < -1) ch[i] = Math.tanh(v);
    }
  }
  return { data: out, length, sampleRate };
}

/**
 * Encode un mix PCM en AAC.
 * @returns {{frames:[{data:Uint8Array,duration:number}], description:Uint8Array|null, sampleRate, channels}}
 */
export async function encodeAac(mix, bitrate = 192000) {
  if (typeof AudioEncoder === 'undefined') throw new Error('AudioEncoder indisponible');
  const sampleRate = mix.sampleRate;
  const channels = 2;
  const cfg = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate };
  const sup = await AudioEncoder.isConfigSupported(cfg);
  if (!sup.supported) throw new Error('encodage AAC non supporte par ce navigateur');

  const frames = [];
  let description = null;
  let err = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && meta.decoderConfig.description && !description) {
        description = new Uint8Array(meta.decoderConfig.description);
      }
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      frames.push({ data: b, duration: 1024 });
    },
    error: (e) => { err = e; },
  });
  enc.configure(sup.config || cfg);

  const CH = 1024;
  const inter = new Float32Array(CH * channels);
  for (let off = 0; off < mix.length; off += CH) {
    const n = Math.min(CH, mix.length - off);
    if (n < CH) inter.fill(0);
    for (let i = 0; i < n; i++) {
      inter[i * channels] = mix.data[0][off + i];
      inter[i * channels + 1] = mix.data[1][off + i];
    }
    const ad = new AudioData({
      format: 'f32',
      sampleRate,
      numberOfFrames: CH,
      numberOfChannels: channels,
      timestamp: Math.round((off / sampleRate) * 1e6),
      data: inter,
    });
    enc.encode(ad);
    ad.close();
    if (err) throw err;
    if (enc.encodeQueueSize > 32) await yieldTask();
  }
  await enc.flush();
  enc.close();
  if (err) throw err;
  return { frames, description, sampleRate, channels };
}
