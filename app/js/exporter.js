// Pipeline d'export : decodage exact -> rendu GPU -> encodage materiel -> muxage MP4.
import { Renderer } from './renderer.js';
import { buildFrame } from './compose.js';
import { ClipDecoder } from './decode.js';
import { mixdown, encodeAac } from './audiomix.js';
import { activeAt, mediaOf, projectDuration, sourceTime } from './state.js';
import { b64, clamp, yieldTask, whenDrained } from './util.js';

const REC_MAGIC = 0xc0def00d;
const FLUSH_BYTES = 3 * 1024 * 1024;
const MAX_INFLIGHT = 2;          // requetes d'ecriture tolerees en vol
const STALL_MS = 30000;          // au-dela, on declare l'export bloque
const WATCH_AFTER_S = 1.5;       // on juge le decodeur au bout de ce delai
const WATCH_MIN_FPS = 12;        // en dessous, on change de chemin de decodage
const SLOW_FRAME_MS = 400;       // une image plus lente que ca est suspecte
const SLOW_HITS = 4;             // quatre fois : on change de chemin
const WATCH_WARMUP = 4;          // images de mise en route, non comptees
const PARALLEL_MAX = 6;          // tranches simultanees (chacune tient un encodeur 4K)
const MIN_FRAMES_PER_SEG = 40;   // en deca, le decoupage coute plus qu'il ne rapporte

export const CODECS = [
  { id: 'avc', label: 'H.264 (compatible partout)', ext: 'mp4', box: 'avc' },
  { id: 'hevc', label: 'H.265 / HEVC (plus petit)', ext: 'mp4', box: 'hevc' },
  { id: 'av1', label: 'AV1 (le plus petit, lent)', ext: 'mp4', box: 'av1' },
];

export const RES_PRESETS = [
  { label: '4K UHD — 3840×2160', w: 3840, h: 2160 },
  { label: '2K QHD — 2560×1440', w: 2560, h: 1440 },
  { label: 'Full HD — 1920×1080', w: 1920, h: 1080 },
  { label: 'HD — 1280×720', w: 1280, h: 720 },
  { label: 'Vertical 4K — 2160×3840', w: 2160, h: 3840 },
  { label: 'Vertical FHD — 1080×1920', w: 1080, h: 1920 },
  { label: 'Carre — 1080×1080', w: 1080, h: 1080 },
];

export const FPS_PRESETS = [24, 25, 30, 50, 60, 120];

/**
 * Qualite constante (quantizer) plutot qu'un debit cible.
 *
 * Avec un debit cible, l'encodeur depense d'un coup pour reconstruire chaque
 * image cle : la qualite remonte d'un cran puis redescend, et l'oeil percoit un
 * a-coup a intervalle regulier — le « battement d'image cle », tres visible sur
 * un plan peu anime. Mesure sur une source quasi fixe : le saut aux images cles
 * passe de 20,2 (debit variable) a 0,01 (quantizer), pour un fichier PLUS petit.
 */
const QP = { low: 28, medium: 25, high: 21, max: 17 };
export function quantizerFor(quality) { return QP[quality] || QP.high; }

/** Debit conseille (bits/s) selon resolution, cadence et codec. */
export function suggestBitrate(w, h, fps, codec, quality = 'high') {
  const px = w * h;
  const base = px * fps;
  // ~0.10 bit/pixel/frame pour du H.264 de bonne qualite
  const bpp = { low: 0.05, medium: 0.075, high: 0.11, max: 0.17 }[quality] || 0.11;
  let bps = base * bpp;
  if (codec === 'hevc') bps *= 0.62;
  if (codec === 'av1') bps *= 0.55;
  // Pas de plafond serre ici. Un debit trop juste fait « battre » l'image a
  // chaque image cle : l'encodeur depense d'un coup pour la reconstruire
  // entierement, la qualite remonte d'un cran puis redescend, et l'oeil percoit
  // un a-coup a intervalle regulier — une fois par seconde avec des cles
  // chaque seconde. C'est exactement ce qu'un plafond a 40 Mb/s produisait en
  // 4K 60. On garde donc de la marge : le fichier est plus gros, mais l'image
  // est stable.
  return Math.round(clamp(bps, 1.5e6, 400e6));
}

// Table des niveaux H.264 (level_idc, MaxMBPS, MaxFS) — la contrainte est le
// DEBIT de macroblocs, pas seulement la resolution. La 4K a 60 i/s exige le
// niveau 5.2 : l'annoncer en 5.1 (hors-spec) fait refuser le materiel, qui
// retombe en logiciel — c'est ce qui rendait la 4K60 si lente.
const AVC_LEVELS = [
  [0x1e, 40500, 1620], [0x1f, 108000, 3600], [0x20, 216000, 5120],
  [0x28, 245760, 8192], [0x29, 245760, 8192], [0x2a, 522240, 8704],
  [0x32, 589824, 22080], [0x33, 983040, 36864], [0x34, 2073600, 36864],
  [0x3c, 4177920, 139264], [0x3d, 8355840, 139264], [0x3e, 16711680, 139264],
];

function avcLevelCodec(w, h, fps) {
  const mb = Math.ceil(w / 16) * Math.ceil(h / 16);
  const mbps = mb * Math.max(1, fps);
  let level = 0x3e;
  for (const [lv, maxMbps, maxFs] of AVC_LEVELS) {
    if (mbps <= maxMbps && mb <= maxFs) { level = lv; break; }
  }
  // profil High (0x64), pas de contrainte (0x00), niveau sur un octet
  return 'avc1.6400' + level.toString(16).padStart(2, '0');
}

/** Cherche une configuration d'encodeur supportee. */
export async function resolveVideoConfig({ codec, width, height, fps, bitrate, quality }) {
  const candidates = [];
  const push = (c) => candidates.push(c);
  if (codec === 'avc') {
    for (const cs of [avcLevelCodec(width, height, fps), 'avc1.640034', 'avc1.640033', 'avc1.4d0033', 'avc1.640028']) {
      push({ codec: cs, avc: { format: 'avc' } });
    }
  } else if (codec === 'hevc') {
    for (const cs of ['hvc1.1.6.L153.B0', 'hvc1.1.6.L156.B0', 'hev1.1.6.L153.B0']) push({ codec: cs, hevc: { format: 'hevc' } });
  } else {
    for (const cs of ['av01.0.09M.08', 'av01.0.12M.08', 'av01.0.08M.08']) push({ codec: cs });
  }
  const errors = [];
  const qp = quantizerFor(quality);
  // Ordre de preference, du plus stable au moins stable :
  //   quantizer — qualite constante, aucun battement (mesure : saut 0,01)
  //   constant  — debit reparti uniformement, battement tres reduit (0,69)
  //   variable  — debit cible classique, battement visible (20,2)
  // « quantizer » n'est pas accepte partout : refuse en 4K sur cette machine,
  // accepte en 1080p. On descend donc les paliers jusqu'a ce que l'encodeur
  // accepte, plutot que de retomber directement sur le mode qui fait battre.
  for (const mode of ['quantizer', 'constant', 'variable']) {
    for (const accel of ['prefer-hardware', 'no-preference', 'prefer-software']) {
      for (const c of candidates) {
        const cfg = {
          ...c, width, height, framerate: fps,
          hardwareAcceleration: accel,
          bitrateMode: mode,
          latencyMode: 'quality',
        };
        if (mode === 'quantizer') delete cfg.bitrate; else cfg.bitrate = bitrate;
        try {
          const r = await VideoEncoder.isConfigSupported(cfg);
          if (r.supported) {
            return {
              config: r.config || cfg, accel, hardware: accel === 'prefer-hardware',
              quantizer: mode === 'quantizer' ? qp : null,
              mode,
            };
          }
        } catch (e) { errors.push(c.codec + ': ' + e.message); }
      }
    }
  }
  throw new Error('Aucune configuration d\'encodage supportee pour ' + codec + ' ' + width + 'x' + height +
    (errors.length ? ' (' + errors[0] + ')' : ''));
}


/**
 * Resume ce que font les decodeurs : nombre de repositionnements par image et
 * part du temps passee a lire le fichier. C'est ce qui distingue « disque lent »
 * de « le decodeur repart d'une image cle a chaque fois ».
 */
function decoderDiag(decoders, frames) {
  let seeks = 0, readMs = 0, bytes = 0, soft = null, mode = null, gaps = 0;
  for (const d of decoders.values()) {
    seeks += d.seekCount || 0; readMs += d.readMs || 0; bytes += d.readBytes || 0;
    if (d.mode === 'codec' && d.accel !== 'prefer-hardware') soft = d.media && d.media.name;
    if (!mode) mode = d.mode;
    if ((d.mode === 'track' || d.mode === 'element') && !soft) soft = d.media && d.media.name;
    if (d.streamGaps) gaps += d.streamGaps;
  }
  return {
    softwareDecode: soft, mode, streamGaps: gaps,
    seeksPerFrame: frames ? seeks / frames : 0,
    readMs,
    readMBps: readMs > 0 ? (bytes / 1e6) / (readMs / 1000) : 0,
  };
}

/** Etape qui consomme le plus de temps, si elle domine nettement. */
function dominant(spent) {
  const tot = spent.decode + spent.render + spent.encode + spent.disk;
  if (tot < 500) return null;
  let key = null, best = 0;
  for (const k of ['decode', 'render', 'encode', 'disk']) {
    if (spent[k] > best) { best = spent[k]; key = k; }
  }
  return best / tot > 0.55 ? key : null;
}

/**
 * Choisit le meilleur reglage d'export ACCELERE PAR LE MATERIEL.
 *
 * Sur beaucoup de cartes, l'encodeur ne monte pas jusqu'a la 4K a 60 i/s : ce
 * cas retombe alors en logiciel, cinq a dix fois plus lent. Plutot que d'imposer
 * un reglage lent, on cherche le plus proche de la source que la carte sait
 * vraiment accelerer, en preservant d'abord la resolution puis la cadence.
 *
 * @returns {{w,h,fps,hardware,reason,ideal}}
 */
export async function pickFastDefault(project, codec = 'avc') {
  const big = biggestSourceSize(project);
  const W = big ? big.w : (project.width || 1920);
  const H = big ? big.h : (project.height || 1080);
  const portrait = H > W;
  const fhd = portrait ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };
  const srcFps = [24, 25, 30, 50, 60].includes(project.fps) ? project.fps : (project.fps > 45 ? 60 : 30);

  const hw = async (w, h, fps) => {
    try {
      const r = await resolveVideoConfig({ codec, width: w, height: h, fps, bitrate: suggestBitrate(w, h, fps, codec, 'high') });
      return r.hardware;
    } catch (_) { return false; }
  };

  const ideal = { w: W, h: H, fps: srcFps };
  // Ordre de preference : exactement la source ; puis on garde la resolution en
  // baissant a 30 ; puis on garde 60 en baissant la resolution ; puis 1080/30.
  const cands = [
    { ...ideal, reason: 'reglage de vos sources' },
    { w: W, h: H, fps: 30, reason: "la 4K a 60 i/s n'est pas acceleree par votre carte — 30 i/s garde la pleine definition, en rapide" },
    { ...fhd, fps: 60, reason: "la 4K a 60 i/s n'est pas acceleree par votre carte — 1080p garde les 60 i/s, en rapide" },
    { ...fhd, fps: 30, reason: "seul le 1080p 30 i/s est accelere par votre carte" },
  ];
  for (const c of cands) {
    if (await hw(c.w, c.h, c.fps)) {
      return { w: c.w, h: c.h, fps: c.fps, hardware: true, reason: c.reason,
        ideal, downgraded: !(c.w === W && c.h === H && c.fps === srcFps) };
    }
  }
  return { w: W, h: H, fps: srcFps, hardware: false, ideal, downgraded: false,
    reason: "aucun reglage accelere trouve — l'export se fera en logiciel (plus lent)" };
}

/** Plus grande definition (paire) parmi les sources video du projet. */
export function biggestSourceSize(project) {
  let best = null;
  for (const m of project.media) {
    if (m.kind === 'audio' || !m.width || !m.height) continue;
    if (!best || m.width * m.height > best.w * best.h) {
      best = { w: Math.round(m.width / 2) * 2, h: Math.round(m.height / 2) * 2 };
    }
  }
  return best;
}

// --------------------------------------------------------------------- sortie

class Sink {
  constructor(tk) {
    this.tk = tk;
    this.parts = [];
    this.bytes = 0;
    this.session = null;
    this.sent = 0;
    this.pending = 0;            // requetes d'ecriture en vol
    this.queue = Promise.resolve();
    this.err = null;
    this.aborted = false;
    this.ac = new AbortController();
  }

  async begin(cfg) {
    const r = await fetch(`/api/export/begin?tk=${this.tk}`, {
      method: 'POST', body: JSON.stringify(cfg), signal: this.ac.signal,
    }).then((x) => x.json());
    if (!r.session) throw new Error('Ouverture du fichier impossible : ' + (r.error || 'inconnu'));
    this.session = r.session;
  }

  push(track, data, duration, key) {
    const head = new ArrayBuffer(16);
    const dv = new DataView(head);
    dv.setUint32(0, REC_MAGIC, true);
    dv.setUint8(4, track);
    dv.setUint8(5, key ? 1 : 0);
    dv.setUint32(8, duration, true);
    dv.setUint32(12, data.byteLength, true);
    this.parts.push(head, data);
    this.bytes += 16 + data.byteLength;
  }

  /**
   * Envoie le paquet accumule SANS attendre la reponse : l'ecriture disque se
   * fait pendant qu'on encode l'image suivante. Les requetes restent chainees,
   * donc le muxeur les recoit toujours dans l'ordre.
   */
  flush(force) {
    if (!this.session || this.aborted || !this.parts.length) return;
    if (!force && this.bytes < FLUSH_BYTES) return;
    const body = new Blob(this.parts);
    this.parts = [];
    this.bytes = 0;
    this.pending++;
    this.queue = this.queue.then(async () => {
      if (this.aborted || this.err) return;
      const res = await fetch(`/api/export/append?tk=${this.tk}&s=${this.session}`,
        { method: 'POST', body, signal: this.ac.signal });
      const j = await res.json();
      if (j.error) throw new Error('Ecriture disque : ' + j.error);
      this.sent = j.bytes || this.sent;
    }).catch((e) => {
      if (!this.aborted && !this.err) this.err = e;
    }).finally(() => { this.pending--; });
  }

  /** Ne laisse pas l'ecriture prendre trop de retard sur l'encodage. */
  async backpressure() {
    if (this.err) throw this.err;
    while (this.pending > MAX_INFLIGHT && !this.aborted) {
      await this.queue.catch(() => {});
      if (this.err) throw this.err;
    }
  }

  async end() {
    this.flush(true);
    await this.queue.catch(() => {});
    if (this.err) throw this.err;
    const j = await fetch(`/api/export/end?tk=${this.tk}&s=${this.session}`, { method: 'POST' }).then((x) => x.json());
    if (j.error) throw new Error(j.error);
    return j;
  }

  /** Annulation : on coupe les requetes en vol tout de suite, sans les attendre. */
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.parts.length = 0;
    try { this.ac.abort(); } catch (_) {}
    if (!this.session) return;
    // pose-toi la question du fichier temporaire en tache de fond : l'interface
    // n'a pas a attendre le reseau pour repondre a un clic sur « Annuler »
    fetch(`/api/export/abort?tk=${this.tk}&s=${this.session}`, { method: 'POST' }).catch(() => {});
  }
}

// ------------------------------------------------------------------- exporteur

export class Exporter {
  constructor(store, lib, tk) {
    this.store = store;
    this.lib = lib;
    this.tk = tk;
    this.cancelled = false;
  }

  /**
   * Annulation immediate : on ne se contente pas de lever un drapeau qui ne
   * serait lu qu'a la prochaine image. On coupe les requetes disque en vol et
   * on ferme les codecs, ce qui debloque instantanement toutes les attentes.
   */
  cancel() {
    this.cancelled = true;
    try { if (this._sink) this._sink.abort(); } catch (_) {}
    try { if (this._encoder && this._encoder.state !== 'closed') this._encoder.close(); } catch (_) {}
    for (const d of (this._decoders || new Map()).values()) { try { d.close(); } catch (_) {} }
  }

  /**
   * @param {object} o { path,width,height,fps,codec,bitrate,audioBitrate,gop,from,to,withAudio }
   * @param {function} onProgress ({phase, ratio, frame, total, fps, eta, bytes})
   */

  /**
   * Export reparti sur plusieurs coeurs.
   *
   * La timeline est decoupee en tranches confiees chacune a un Web Worker qui
   * fait tout : decodage, rendu GPU, encodage. Les paquets reviennent puis sont
   * remis dans l'ordre. Chaque tranche demarre sur une image cle, donc les
   * morceaux se recollent sans transition visible.
   *
   * Renvoie null si le parallelisme ne s'applique pas (un clip a besoin d'un
   * repli <video>, indisponible hors du thread principal) : l'appelant reprend
   * alors le chemin classique.
   */
  async _runParallel(o, onProgress, ctx) {
    if (o.monocoeur) return null;          // choix explicite de l'utilisateur
    const { project, from, total, resolved, timescale, audioJob, sink, t0Wall } = ctx;
    const nCores = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
    const nSeg = Math.max(2, Math.min(PARALLEL_MAX, nCores));
    if (total < nSeg * MIN_FRAMES_PER_SEG) return null;      // trop court, inutile

    // Les fichiers sources : un Worker les recoit par clonage structure, sans copie.
    const files = new Map();
    for (const m of project.media) {
      const f = this.lib.files.get(m.id);
      if (f) files.set(m.id, f);
    }
    const plain = JSON.parse(JSON.stringify(project));

    // Decoupage aligne sur le GOP : chaque tranche commence par une image cle.
    const step = Math.ceil(total / nSeg / o.gop) * o.gop;
    const segs = [];
    for (let i = 0, f = 0; f < total; i++, f += step) {
      segs.push({ index: i, first: f, last: Math.min(total, f + step) });
    }

    const done = new Array(segs.length).fill(null);
    const avance = new Array(segs.length).fill(0);
    const workers = [];
    let rejete = null;

    const majProgres = () => {
      const fait = avance.reduce((a, b) => a + b, 0);
      const el = (performance.now() - t0Wall) / 1000;
      const spd = fait / Math.max(0.001, el);
      onProgress({
        phase: 'Encodage', ratio: 0.08 + 0.9 * (fait / total),
        frame: fait, total, fps: spd, eta: (total - fait) / Math.max(0.1, spd),
        bytes: sink.sent, accel: resolved.accel, hardware: resolved.hardware,
        parallele: segs.length,
      });
    };

    try {
      await Promise.all(segs.map((seg) => new Promise((res, rej) => {
        const w = new Worker(new URL('./exportworker.js', import.meta.url), { type: 'module' });
        workers.push(w);
        w.onerror = (e) => rej(new Error('worker : ' + (e.message || 'erreur')));
        w.onmessage = (ev) => {
          const d = ev.data;
          if (d.type === 'progress') { avance[d.index] = d.done; majProgres(); return; }
          if (d.type === 'error') { rejete = d.message; rej(new Error(d.message)); return; }
          done[d.index] = d;
          avance[d.index] = seg.last - seg.first;
          majProgres();
          res();
        };
        w.postMessage({
          project: plain, files, seg,
          o: {
            width: o.width, height: o.height, fps: o.fps, gop: o.gop,
            from, config: resolved.config, quantizer: resolved.quantizer,
          },
        });
      })));
    } catch (e) {
      for (const w of workers) { try { w.terminate(); } catch (_) {} }
      if (rejete && /repli non disponible/.test(rejete)) return null;   // on repasse en classique
      throw e;
    }
    for (const w of workers) { try { w.terminate(); } catch (_) {} }
    if (this.cancelled) throw new Error('annule');

    const perdues = done.reduce((n, d) => n + ((d && d.manquantes) || 0), 0);
    if (perdues) console.warn(`export : ${perdues} image(s) source illisible(s), remplacee(s) par la precedente`);

    const description = (done.find((d) => d && d.description) || {}).description;
    if (!description) throw new Error("L'encodeur n'a pas fourni de description de flux.");

    const audio = await audioJob;
    await sink.begin({
      path: o.path,
      video: {
        codec: resolved.config.codec.startsWith('hvc') || resolved.config.codec.startsWith('hev') ? 'hevc'
          : resolved.config.codec.startsWith('av01') ? 'av1' : 'avc',
        width: o.width, height: o.height, timescale, description: b64(new Uint8Array(description)),
      },
      audio: audio ? { sampleRate: audio.sampleRate, channels: audio.channels, description: audio.description ? b64(audio.description) : null } : null,
    });

    // remise en ordre : les tranches sont ecrites l'une apres l'autre
    let videoCount = 0, audioIdx = 0;
    for (const d of done) {
      if (!d) throw new Error('segment manquant');
      for (const c of d.chunks) {
        sink.push(0, new Uint8Array(c.data), 1000, c.key);
        videoCount++;
        if (audio) {
          const tv = videoCount / o.fps;
          while (audioIdx < audio.frames.length && (audioIdx * 1024) / audio.sampleRate <= tv) {
            sink.push(1, audio.frames[audioIdx].data, 1024, true);
            audioIdx++;
          }
        }
      }
      sink.flush(false);
      await sink.backpressure();
      if (this.cancelled) throw new Error('annule');
    }
    if (audio) while (audioIdx < audio.frames.length) { sink.push(1, audio.frames[audioIdx].data, 1024, true); audioIdx++; }

    if (videoCount !== total) {
      throw new Error(`export incomplet : ${videoCount} images ecrites sur ${total}.`
        + ' Les tranches ne se recollent pas.');
    }

    onProgress({ phase: 'Finalisation', ratio: 0.985, frame: total, total });
    const res = await sink.end();
    return { ...res, frames: videoCount, videoChunks: videoCount, hardware: resolved.hardware,
      accel: resolved.accel, codec: resolved.config.codec, parallele: segs.length };
  }

  async run(o, onProgress = () => {}) {
    this._stalledAt = -1;
    const store = this.store;
    const project = store.project;
    this.cancelled = false;
    const from = o.from || 0;
    const to = o.to || projectDuration(project);
    const dur = Math.max(1 / o.fps, to - from);
    const total = Math.max(1, Math.round(dur * o.fps));
    const W = o.width, H = o.height;

    const sink = new Sink(this.tk);
    const decoders = new Map();
    let renderer = null;
    let encoder = null;
    this._sink = sink;
    this._decoders = decoders;
    this._abortSignal = sink.ac.signal;
    const stop = () => { if (this.cancelled) throw new Error('annule'); };

    try {
      // ---------------------------------------------------- 1. audio
      // L'audio part EN PARALLELE de la video : c'est un travail independant, et
      // le faire d'abord ajoutait betement son temps a celui de l'image. On ne
      // l'attend qu'au moment d'ouvrir le fichier, ou sa description est
      // indispensable — l'encodeur video a alors deja avale ses premieres images.
      let audio = null;
      let audioReady = !o.withAudio;
      const audioJob = o.withAudio
        ? (async () => {
            const mix = await mixdown(project, this.lib, {
              sampleRate: o.sampleRate || 48000, from, to,
            });
            return mix ? encodeAac(mix, o.audioBitrate || 192000) : null;
          })()
        : Promise.resolve(null);
      audioJob.then(() => { audioReady = true; }, () => { audioReady = true; });
      audioJob.catch(() => {});        // le vrai rejet est traite a l'attente
      if (this.cancelled) throw new Error('annule');

      // ---------------------------------------------------- 2. encodeur video
      const resolved = await resolveVideoConfig({
        codec: o.codec, width: W, height: H, fps: o.fps, bitrate: o.bitrate, quality: o.quality,
      });
      const timescale = o.fps * 1000;

      // D'abord l'export reparti sur plusieurs coeurs. Il rend null quand il ne
      // s'applique pas (clip qui exige un repli <video>, projet trop court) :
      // on enchaine alors sur le chemin classique, a un seul fil.
      if (o.parallel !== false && typeof Worker !== 'undefined') {
        const t0P = performance.now();
        let par = null;
        try {
          par = await this._runParallel(o, onProgress, {
            project, from, total, resolved, timescale, audioJob, sink, t0Wall: t0P,
          });
        } catch (e) {
          if (this.cancelled) throw e;
          console.warn('export parallele indisponible :', e.message);
          par = null;
        }
        // Note : le chemin parallele n'ouvre le fichier qu'une fois toutes ses
        // tranches terminees. Un abandon se produit donc TOUJOURS avant, et le
        // chemin classique repart sur un fichier vierge.
        if (par) return par;
      }

      let description = null;
      let encErr = null;
      const pending = [];      // paquets video en attente de la description
      let videoCount = 0;

      encoder = new VideoEncoder({
        output: (chunk, meta) => {
          if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
            description = new Uint8Array(meta.decoderConfig.description);
          }
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          pending.push({ data: buf, key: chunk.type === 'key' });
          videoCount++;
        },
        error: (e) => { encErr = e; },
      });
      encoder.configure(resolved.config);
      this._encoder = encoder;

      // ---------------------------------------------------- 3. rendu
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : document.createElement('canvas');
      renderer = new Renderer(canvas, { preserve: true });
      renderer.setSize(W, H);

      /** Ferme les decodeurs des clips qu'on a depasses (liberation GPU). */
      const pruneDecoders = (keep) => {
        for (const [id, d] of decoders) {
          if (keep.has(id)) continue;
          d.close();
          decoders.delete(id);
        }
      };

      let slowSource = null;      // media que WebCodecs ne sait pas lire
      let switched = null;        // clip rebascule sur la lecture par piste
      // Temps passe par etape : sans ca, un export lent ne dit pas POURQUOI.
      const spent = { decode: 0, render: 0, encode: 0, disk: 0 };
      const getDecoder = async (clip, media, srcTime) => {
        let d = decoders.get(clip.id);
        if (!d) {
          d = new ClipDecoder(this.lib, media, clip, { wantFps: o.fps });
          decoders.set(clip.id, d);
          await d.init();
          d.tWatch = performance.now();
          d.nWatch = 0;
          if (d.mode === 'element') slowSource = media.name;
        }
        // FILET DE SECURITE : une sonde de depart ne garantit rien sur la duree.
        // Si le decodage s'effondre en cours de route (memoire video saturee,
        // codec qui bascule en logiciel...), on rebascule ce clip sur la lecture
        // par piste media, qui tient le temps reel quoi qu'il arrive.
        //
        // Le declenchement est base sur le TEMPS, pas sur un nombre d'images :
        // attendre 40 images d'un decodeur qui en sort 0,4 par seconde, c'est
        // attendre cent secondes avant de reagir. Autant ne rien faire.
        if (d.mode === 'codec' && !d.noWatch) {
          d.nWatch++;
          // Les toutes premieres images paient la mise en route du decodeur
          // (configuration, premiere image cle) : en 4K cela depasse facilement
          // la demi-seconde. Les compter ferait basculer un decodeur en pleine
          // forme vers le chemin degrade — et donc vers des images dupliquees.
          // Les premieres images paient la mise en route du decodeur : on ne
          // commence a juger qu'apres, sinon un decodeur en pleine forme se
          // ferait declasser sur son seul demarrage.
          if (d.nWatch === WATCH_WARMUP) { d.tWatch = performance.now(); d.slowHit = 0; }
          if (d.nWatch < WATCH_WARMUP) return d;
          const el = (performance.now() - d.tWatch) / 1000;
          // `failed` : le decodeur a rendu les armes sur une image. Inutile
          // d'attendre le verdict du chronometre, on bascule tout de suite.
          // On ne juge le decodeur QUE s'il est reellement le goulot. `nWatch/el`
          // est la cadence de toute la boucle (decodage + rendu + encodage +
          // disque) : en 4K 60 elle tombe sous 12 i/s par le seul fait de
          // l'encodage, et prendre ce chiffre pour le debit du decodeur faisait
          // basculer TOUS les clips sur le chemin degrade au bout d'1,5 s —
          // avec ses images perdues, et un changement d'orientation en cours de
          // route puisque les deux chemins ne traitent pas la rotation pareil.
          const partDecode = spent.decode / Math.max(1, spent.decode + spent.render + spent.encode + spent.disk);
          const decodeCoupable = partDecode > 0.55;
          if (d.failed || (decodeCoupable && (d.slowHit >= SLOW_HITS
              || (el > WATCH_AFTER_S && d.nWatch / el < WATCH_MIN_FPS)))) {
            const fps = d.nWatch / el;
            switched = { name: media.name, fps };
            d.close();
            d = new ClipDecoder(this.lib, media, clip,
              { forceTrack: true, startAt: srcTime, wantFps: o.fps });
            decoders.set(clip.id, d);
            await d.init();
            d.noWatch = true;              // une bascule suffit
          }
        }
        return d;
      };

      const t0Wall = performance.now();
      // chien de garde : si plus rien n'avance pendant 30 s, on arrete et on
      // explique, plutot que de laisser une barre de progression figee
      let alive = performance.now();
      let lastFrameDone = 0;
      const watchdog = setInterval(() => {
        if (performance.now() - alive < STALL_MS) return;
        this._stalledAt = lastFrameDone;
        clearInterval(watchdog);
        this.cancel();
      }, 1000);
      this._watchdog = watchdog;
      let lastReport = 0;
      let audioIdx = 0;
      let flushedHead = false;

      /**
       * Prepare les images sources d'une image de sortie.
       *
       * Appelee UNE IMAGE D'AVANCE : pendant qu'on rend et encode l'image n, le
       * decodeur travaille deja sur la n+1. C'est ce que font les vrais logiciels
       * de montage — sans ca, chaque etage attend le precedent et le decodeur
       * reste au repos pendant l'encodage, et inversement.
       */
      const prepare = async (n) => {
        const t = from + n / o.fps;
        const acts = activeAt(project, t).filter((a) => a.track.kind !== 'audio' && a.clip.kind !== 'audio');
        const sources = new Map();
        for (const a of acts) {
          if (a.clip.kind === 'text') continue;
          const media = mediaOf(project, a.clip);
          if (!media || !media.hasVideo) continue;
          try {
            const st = sourceTime(a.clip, a.tLocal);
            const dec = await getDecoder(a.clip, media, st);
            const tF = performance.now();
            const got = await dec.frameAt(st);
            // Une seule image qui traine suffit a condamner ce chemin : inutile
            // d'attendre une moyenne, elle mettrait des dizaines de secondes a
            // devenir concluante sur un decodeur qui rend une image toutes les
            // secondes.
            if (performance.now() - tF > SLOW_FRAME_MS) dec.slowHit = (dec.slowHit || 0) + 1;
            if (got) sources.set(a.clip.id, got);
          } catch (e) {
            const d0 = decoders.get(a.clip.id);
            if (d0) d0.failed = true;      // provoque la bascule au tour suivant
            console.warn('image manquante', media.name, e.message);
          }
        }
        return { t, acts, sources };
      };

      /** Libere les images clonees une fois televersees au GPU. */
      const release = (sources) => {
        for (const g of sources.values()) {
          if (g && g.owned && g.src) { try { g.src.close(); } catch (_) {} }
        }
      };

      let ahead = prepare(0);

      for (let n = 0; n < total; n++) {
        if (this.cancelled) throw new Error('annule');
        if (encErr) throw encErr;

        // On ne compte que le temps ou la boucle est REELLEMENT bloquee par le
        // decodage. Chronometrer l'interieur de prepare() donnerait du temps de
        // paroi : il englobe le rendu et l'encodage qui tournent pendant ce temps.
        const tWait = performance.now();
        const cur = await ahead;
        spent.decode += performance.now() - tWait;
        // On relance TOUT DE SUITE le decodage suivant : il avancera pendant nos
        // attentes d'encodeur et d'ecriture, qui etaient jusqu'ici du temps mort.
        ahead = n + 1 < total ? prepare(n + 1) : null;
        // en cas d'annulation on n'attendra jamais cette promesse : on neutralise
        // son rejet pour ne pas polluer la console
        if (ahead) ahead.catch(() => {});
        this._ahead = ahead;

        const { t, acts, sources } = cur;
        alive = performance.now();
        lastFrameDone = n;

        if ((n & 31) === 0) pruneDecoders(new Set(acts.map((a) => a.clip.id)));

        const tRen0 = performance.now();
        const frame = buildFrame(project, t, (clip) => sources.get(clip.id) || null, W, H);
        for (const L of frame.layers) {
          // Image inchangee depuis la derniere fois (export plus rapide que la
          // source) : la texture est deja sur le GPU, inutile de renvoyer les
          // pixels. En 4K ca represente plusieurs Mo economises par image.
          const keep = (L.same || L.stale) && renderer.cached(L.texId);
          const e = keep || renderer.upload(L.texId, L.source, L.srcW, L.srcH);
          L.tex = e ? e.tex : null;
        }
        renderer.render(frame, true);
        release(sources);

        spent.render += performance.now() - tRen0;

        // encodage
        const tEnc0 = performance.now();
        const vf = new VideoFrame(canvas, {
          timestamp: Math.round((n * 1e6) / o.fps),
          duration: Math.round(1e6 / o.fps),
        });
        const opt = { keyFrame: n % o.gop === 0 };
        if (resolved.quantizer != null) opt.avc = { quantizer: resolved.quantizer };
        encoder.encode(vf, opt);
        vf.close();
        spent.encode += performance.now() - tEnc0;

        // ouverture du fichier des que la description video est connue ET que
        // l'audio est pret : le conteneur declare ses deux pistes d'un bloc
        if (!flushedHead && description) {
          if (!audioReady) onProgress({ phase: 'Preparation audio', ratio: 0.06 });
          audio = await audioJob;
          stop();
          await sink.begin({
            path: o.path,
            video: { codec: resolved.config.codec.startsWith('hvc') || resolved.config.codec.startsWith('hev') ? 'hevc'
              : resolved.config.codec.startsWith('av01') ? 'av1' : 'avc',
              width: W, height: H, timescale, description: b64(description) },
            audio: audio ? { sampleRate: audio.sampleRate, channels: audio.channels, description: audio.description ? b64(audio.description) : null } : null,
          });
          flushedHead = true;
        }

        // ecriture des paquets prets (video + audio entrelaces)
        if (flushedHead) {
          while (pending.length) {
            const p = pending.shift();
            sink.push(0, p.data, 1000, p.key);
          }
          if (audio) {
            const videoTimeS = (n + 1) / o.fps;
            while (audioIdx < audio.frames.length && (audioIdx * 1024) / audio.sampleRate <= videoTimeS) {
              sink.push(1, audio.frames[audioIdx].data, 1024, true);
              audioIdx++;
            }
          }
          const tDsk0 = performance.now();
          sink.flush(false);            // part en tache de fond
          await sink.backpressure();    // ne bloque que si le disque decroche
          spent.disk += performance.now() - tDsk0;
          stop();
        }

        // Regulation de l'encodeur : on DORT sur son evenement `dequeue`.
        // Une boucle d'attente active occuperait le thread principal, celui-la
        // meme qui livre les images du codec materiel — on se ralentirait soi-meme.
        if (encoder.encodeQueueSize > 6) {
          const tW0 = performance.now();
          await whenDrained(encoder, 6, this._abortSignal);
          spent.encode += performance.now() - tW0;   // attente = temps de l'encodeur
          stop();
          if (encErr) throw encErr;
        }

        // progression : sur le temps, pas sur un compteur d'images, sinon
        // l'affichage semble fige des que quelques images sont lentes
        const nowMs = performance.now();
        if (nowMs - lastReport > 120 || n === total - 1) {
          lastReport = nowMs;
          const el = (nowMs - t0Wall) / 1000;
          // On compte les images REELLEMENT encodees, pas celles qu'on a soumises :
          // la file de l'encodeur avale les premieres d'un coup, ce qui affichait
          // un debit flatteur au demarrage avant de s'effondrer, et une estimation
          // de duree qui ne cessait de grandir.
          const done = Math.max(1, videoCount);
          const spd = done / Math.max(0.001, el);
          onProgress({
            phase: 'Encodage', ratio: 0.08 + 0.9 * (done / total),
            frame: done, total, fps: spd, eta: (total - done) / Math.max(0.1, spd),
            bytes: sink.sent, slowSource, accel: resolved.accel, hardware: resolved.hardware,
            spent: { ...spent }, bottleneck: dominant(spent),
            diag: { ...decoderDiag(decoders, n + 1), switched },
          });
          await yieldTask();            // laisse l'interface se repeindre
          stop();
        }
      }

      onProgress({ phase: 'Finalisation', ratio: 0.985, frame: total, total });
      await encoder.flush();
      stop();
      if (encErr) throw encErr;

      if (!flushedHead) {
        audio = await audioJob;        // export sans aucune image encodee
        if (!description) throw new Error('L\'encodeur n\'a pas fourni de description de flux.');
        await sink.begin({
          path: o.path,
          video: { codec: o.codec, width: W, height: H, timescale, description: b64(description) },
          audio: audio ? { sampleRate: audio.sampleRate, channels: audio.channels, description: audio.description ? b64(audio.description) : null } : null,
        });
      }
      while (pending.length) { const p = pending.shift(); sink.push(0, p.data, 1000, p.key); }
      if (audio) while (audioIdx < audio.frames.length) { sink.push(1, audio.frames[audioIdx].data, 1024, true); audioIdx++; }

      if (ahead) { try { release((await ahead).sources); } catch (_) {} ahead = null; this._ahead = null; }
      clearInterval(watchdog); this._watchdog = null;
      const res = await sink.end();
      onProgress({ phase: 'Termine', ratio: 1, frame: total, total, bytes: res.bytes });
      return { ...res, frames: total, videoChunks: videoCount, hardware: resolved.hardware, accel: resolved.accel, codec: resolved.config.codec };
    } catch (e) {
      sink.abort();
      // fermer les codecs pour annuler fait remonter des erreurs parasites :
      // ce qui compte pour l'utilisateur, c'est que c'est bien lui qui a annule
      if (this._stalledAt >= 0 && this._stalledAt !== undefined) {
        throw new Error(`L'export s'est bloque a l'image ${this._stalledAt + 1} sur ${total}. `
          + 'Essayez une resolution ou une cadence plus basse, ou exportez la timeline par morceaux.');
      }
      throw this.cancelled ? new Error('annule') : e;
    } finally {
      if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
      // une preparation d'image peut encore etre en vol : on rend ses clones
      if (this._ahead) {
        this._ahead.then((c) => { for (const g of c.sources.values()) {
          if (g && g.owned && g.src) { try { g.src.close(); } catch (_) {} }
        } }).catch(() => {});
        this._ahead = null;
      }
      this._sink = null; this._encoder = null; this._decoders = null;
      try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (_) {}
      for (const d of decoders.values()) d.close();
      if (renderer) {
        for (const list of renderer.pool.values()) for (const f of list) f.dispose();
        renderer.pool.clear();
        const lose = renderer.gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    }
  }
}
