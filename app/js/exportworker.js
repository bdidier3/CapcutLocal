// Un segment d'export, du decodage a l'encodage, dans un Web Worker.
//
// L'export a un etage lent : l'encodage. En 4K 60 i/s beaucoup de cartes n'ont
// pas d'encodeur materiel et le travail retombe sur le processeur, ou une seule
// image coute des dizaines de millisecondes. Comme les images d'un segment ne
// dependent pas de celles d'un autre, on decoupe la timeline en tranches et on
// en confie une a chaque coeur : decodage, rendu GPU et encodage y sont menes
// de bout en bout, puis le thread principal remet les paquets dans l'ordre.
//
// Chaque tranche demarre sur une image cle (l'encodeur est neuf), donc les
// morceaux se recollent sans transition visible.
import { Renderer } from './renderer.js';
import { buildFrame } from './compose.js';
import { ClipDecoder } from './decode.js';
import { Mp4File, blobReader } from './mp4demux.js';
import { activeAt, mediaOf, sourceTime } from './state.js';
import { whenDrained } from './util.js';
import { revivre, urlDe } from './fichierdistant.js';

/** Bibliotheque minimale : juste ce dont le decodeur a besoin, sans DOM. */
function makeLib(recus) {
  // un fichier lu par le serveur arrive en simple objet : on le reconstruit
  const files = new Map([...recus].map(([id, f]) => [id, revivre(f)]));
  const urls = new Map();
  const mp4s = new Map();
  return {
    files,
    file: (id) => files.get(id) || null,
    url(id) {
      let u = urls.get(id);
      if (u) return u;
      const f = files.get(id);
      if (!f) return null;
      u = urlDe(f);
      urls.set(id, u);
      return u;
    },
    async mp4Of(id) {
      if (mp4s.has(id)) return mp4s.get(id);
      const f = files.get(id);
      let res = null;
      try { res = await Mp4File.open(blobReader(f)); } catch (_) { res = null; }
      mp4s.set(id, res);
      return res;
    },
  };
}

self.onmessage = async (ev) => {
  const { project, files, seg, o } = ev.data;
  const lib = makeLib(files);
  const W = o.width, H = o.height;
  const chunks = [];
  let description = null;
  let encErr = null;
  let renderer = null;
  let encoder = null;
  const decoders = new Map();
  let manquantes = 0;

  try {
    const canvas = new OffscreenCanvas(W, H);
    renderer = new Renderer(canvas, { preserve: true });
    renderer.setSize(W, H);

    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
          description = new Uint8Array(meta.decoderConfig.description);
        }
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        chunks.push({ data: b, key: chunk.type === 'key' });
      },
      error: (e) => { encErr = e; },
    });
    encoder.configure(o.config);

    const elaguer = (garder) => {
      for (const [id, d] of decoders) {
        if (garder.has(id)) continue;
        try { d.close(); } catch (_) {}
        decoders.delete(id);
      }
    };

    const getDecoder = async (clip, media) => {
      let d = decoders.get(clip.id);
      if (!d) {
        d = new ClipDecoder(lib, media, clip, { wantFps: o.fps });
        decoders.set(clip.id, d);
        await d.init();
        // Sans DOM, les replis <video> sont hors de portee : on rend la main au
        // thread principal plutot que de produire un segment faux.
        if (d.mode !== 'codec' && d.mode !== 'image') throw new Error('repli non disponible en worker');
      }
      return d;
    };

    for (let n = seg.first; n < seg.last; n++) {
      if (encErr) throw encErr;
      const t = o.from + n / o.fps;
      const acts = activeAt(project, t).filter((a) => a.track.kind !== 'audio' && a.clip.kind !== 'audio');
      if ((n & 31) === 0) elaguer(new Set(acts.map((a) => a.clip.id)));
      const sources = new Map();
      for (const a of acts) {
        if (a.clip.kind === 'text') continue;
        const media = mediaOf(project, a.clip);
        if (!media || !media.hasVideo) continue;
        const dec = await getDecoder(a.clip, media);
        try {
          const got = await dec.frameAt(sourceTime(a.clip, a.tLocal));
          if (got) sources.set(a.clip.id, got);
        } catch (e) {
          // Une image perdue laisse la precedente a l ecran ; perdre la
          // tranche entiere serait bien pire.
          manquantes++;
        }
      }

      const frame = buildFrame(project, t, (clip) => sources.get(clip.id) || null, W, H);
      for (const L of frame.layers) {
        const keep = (L.same || L.stale) && renderer.cached(L.texId);
        const e = keep || renderer.upload(L.texId, L.source, L.srcW, L.srcH);
        L.tex = e ? e.tex : null;
      }
      renderer.render(frame, true);
      for (const g of sources.values()) {
        if (g && g.owned && g.src) { try { g.src.close(); } catch (_) {} }
      }

      const vf = new VideoFrame(canvas, {
        timestamp: Math.round(((n - seg.first) * 1e6) / o.fps),
        duration: Math.round(1e6 / o.fps),
      });
      // premiere image du segment = image cle, pour que les tranches se recollent
      const opt = { keyFrame: n === seg.first || (n - seg.first) % o.gop === 0 };
      if (o.quantizer != null) opt.avc = { quantizer: o.quantizer };
      encoder.encode(vf, opt);
      vf.close();

      if (encoder.encodeQueueSize > 6) await whenDrained(encoder, 6);
      if ((n & 15) === 0) self.postMessage({ type: 'progress', index: seg.index, done: n - seg.first + 1 });
    }

    await encoder.flush();
    if (encErr) throw encErr;
    const attendues = seg.last - seg.first;
    if (chunks.length !== attendues) {
      throw new Error(`tranche ${seg.index} : ${chunks.length} images encodees sur `
        + `${attendues} attendues`);
    }
    self.postMessage({ type: 'done', index: seg.index, chunks, description, manquantes },
      chunks.map((c) => c.data.buffer));
  } catch (e) {
    self.postMessage({ type: 'error', index: seg.index, message: String((e && e.message) || e) });
  } finally {
    try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (_) {}
    for (const d of decoders.values()) { try { d.close(); } catch (_) {} }
    if (renderer) {
      try {
        for (const list of renderer.pool.values()) for (const f of list) f.dispose();
        renderer.pool.clear();
        const lose = renderer.gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (_) {}
    }
  }
};
