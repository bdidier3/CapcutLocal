// Bibliotheque de medias : import instantane (aucune copie), sondage, vignettes.
import { uid, once, toast } from './util.js';
import { Mp4File, blobReader, isIsoBmff } from './mp4demux.js';

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', '3gp', 'flv', 'ogv'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'];

export function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }

export function kindOf(name) {
  const e = extOf(name);
  if (VIDEO_EXT.includes(e)) return 'video';
  if (AUDIO_EXT.includes(e)) return 'audio';
  if (IMAGE_EXT.includes(e)) return 'image';
  return null;
}

export const ACCEPT = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT].map((e) => '.' + e).join(',');

/**
 * Cle d'une copie d'apercu : nom + taille, hachees comme cote serveur.
 * Deux fichiers identiques partagent ainsi la meme copie.
 */
async function cleApercu(file) {
  const data = new TextEncoder().encode(file.name + '|' + file.size);
  const h = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

export class Library {
  constructor(store) {
    this.store = store;
    this.files = new Map();      // mediaId -> File
    this.handles = new Map();    // mediaId -> FileSystemFileHandle
    this.urls = new Map();       // mediaId -> objectURL
    this.mp4 = new Map();        // mediaId -> Mp4File (lazy)
    this.strips = new Map();     // mediaId -> {count, bitmaps:[]}
    this.waves = new Map();      // mediaId -> Float32Array (enveloppe)
    this.apercus = new Map();    // mediaId -> url de la copie allegee
    this._blobsApercu = new Map();
    this._mp4Apercu = new Map();
    this._apercuEnCours = new Set();
    this.surApercu = null;       // rappel (mediaId, etat) pour l'interface
    this._probeVideo = null;
    this._stripQueue = [];
    this._stripBusy = false;
  }

  // ------------------------------------------------------------------ acces
  file(mediaId) { return this.files.get(mediaId) || null; }

  url(mediaId) {
    let u = this.urls.get(mediaId);
    if (u) return u;
    const f = this.files.get(mediaId);
    if (!f) return null;
    u = URL.createObjectURL(f);
    this.urls.set(mediaId, u);
    return u;
  }

  /**
   * Adresse a utiliser pour REGARDER ce media.
   *
   * Si une copie allegee existe, c'est elle : lire un rush 4K 60 i/s dans un
   * element video coute bien plus que ce qu'un montage a coupes rapides peut
   * absorber. L'export, lui, part toujours du fichier d'origine.
   */
  urlApercu(mediaId) {
    return this.apercus.get(mediaId) || this.url(mediaId);
  }

  /**
   * Abandonne la copie d'apercu d'un media et revient au fichier d'origine.
   *
   * Appele quand la copie s'avere illisible — fichier efface, serveur relance,
   * encodage rate. Sans ce repli, l'element video reste vide : l'image se fige
   * pendant que le son, lui, continue.
   */
  oublierApercu(mediaId) {
    if (!this.apercus.has(mediaId)) return false;
    this.apercus.delete(mediaId);
    this._blobsApercu.delete(mediaId);
    this._mp4Apercu.delete(mediaId);
    this.store.changed('media');
    return true;
  }

  /** Ce media est-il assez lourd pour meriter une copie d'apercu ? */
  static meriteApercu(media) {
    if (!media || !media.hasVideo || media.kind === 'image') return false;
    return (media.width || 0) * (media.height || 0) > 2304000;   // au-dela de ~1080p
  }

  /**
   * S'assure qu'une copie allegee existe pour ce media, et la branche.
   *
   * La copie est gardee sur le disque : on ne la refabrique pas d'une session a
   * l'autre. La cle ne depend que du nom et de la taille du fichier, donc le
   * meme rush reutilise la meme copie dans tous les projets.
   */
  async assurerApercu(media, tk) {
    if (!Library.meriteApercu(media)) return false;
    if (this.apercus.has(media.id) || this._apercuEnCours.has(media.id)) return false;
    const file = this.files.get(media.id);
    if (!file) return false;
    this._apercuEnCours.add(media.id);
    const dire = (etat, pct) => { if (this.surApercu) this.surApercu(media, etat, pct); };

    try {
      const cle = await cleApercu(file);
      const lire = () => fetch(`/api/proxy/state?tk=${tk}&cle=${cle}`).then((r) => r.json());
      let st = await lire();

      if (st.etat !== 'pret') {
        dire('envoi', 0);
        // On televerse le fichier d'origine : le serveur ne peut pas le trouver
        // tout seul, le navigateur ne lui donne jamais son chemin.
        const r = await fetch(
          `/api/proxy/build?tk=${tk}&cle=${cle}&name=${encodeURIComponent(file.name)}`,
          // le corps est le fichier lui-meme : le navigateur l'envoie en flux,
          // rien n'est charge en memoire de part ni d'autre
          { method: 'POST', body: file },
        ).then((x) => x.json()).catch((e) => ({ error: e.message }));
        if (r && r.indisponible) { dire('indisponible', 0); return false; }
        if (r && r.error) throw new Error(r.error);
        st = r;
        while (st.etat === 'encours') {
          dire('encodage', st.pct || 0);
          await new Promise((res) => setTimeout(res, 500));
          st = await lire();
        }
      }
      if (st.etat !== 'pret') throw new Error(st.err || 'copie non produite');
      this.apercus.set(media.id, `/api/proxy/file?tk=${tk}&cle=${cle}`);
      this.store.changed('media');
      dire('pret', 100);
      return true;
    } catch (e) {
      console.warn("copie d'apercu", media.name, e.message);
      dire('erreur', 0);
      return false;
    } finally {
      this._apercuEnCours.delete(media.id);
    }
  }

  /**
   * Contenu de la copie d'apercu, sous forme de fichier local.
   *
   * L'apercu decode la copie plutot que l'original : les instants des images y
   * sont repris a l'identique, mais elle est en 1080p avec des images cles
   * rapprochees, si bien qu'un saut coute quelques millisecondes au lieu de
   * plusieurs secondes sur un rush 4K.
   */
  async blobApercu(mediaId) {
    if (!this.apercus.has(mediaId)) return null;
    if (this._blobsApercu.has(mediaId)) return this._blobsApercu.get(mediaId);
    const p = fetch(this.apercus.get(mediaId))
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? new File([b], 'apercu.mp4', { type: 'video/mp4' }) : null))
      .catch(() => null);
    this._blobsApercu.set(mediaId, p);
    return p;
  }

  /** Index MP4 de la copie d'apercu. */
  async mp4Apercu(mediaId) {
    if (this._mp4Apercu.has(mediaId)) return this._mp4Apercu.get(mediaId);
    const p = (async () => {
      const f = await this.blobApercu(mediaId);
      if (!f) return null;
      try { return await Mp4File.open(blobReader(f)); } catch (_) { return null; }
    })();
    this._mp4Apercu.set(mediaId, p);
    return p;
  }

  /** Charge (et met en cache) l'index MP4, ou null si le conteneur n'est pas ISO BMFF. */
  async mp4Of(mediaId) {
    if (this.mp4.has(mediaId)) return this.mp4.get(mediaId);
    const f = this.files.get(mediaId);
    if (!f) return null;
    let res = null;
    try {
      if (await isIsoBmff(f)) res = await Mp4File.open(blobReader(f));
    } catch (e) {
      console.warn('demux MP4 impossible pour', f.name, e.message);
    }
    this.mp4.set(mediaId, res);
    return res;
  }

  // ------------------------------------------------------------------ import

  /** files : FileList | File[] | FileSystemFileHandle[] */
  async add(input) {
    const items = [];
    for (const it of Array.from(input || [])) {
      if (it && typeof it.getFile === 'function') {
        const f = await it.getFile();
        items.push({ file: f, handle: it });
      } else if (it instanceof File) {
        items.push({ file: it, handle: null });
      }
    }
    const added = [];
    for (const { file, handle } of items) {
      const kind = kindOf(file.name);
      if (!kind) { toast(`Format non reconnu : ${file.name}`, 'warn'); continue; }
      // deja importe ? (meme nom + meme taille)
      const dup = this.store.project.media.find((m) => m.name === file.name && m.size === file.size);
      if (dup) { added.push(dup); continue; }

      const id = uid('md');
      this.files.set(id, file);
      if (handle) this.handles.set(id, handle);
      const media = {
        id, name: file.name, size: file.size, kind,
        duration: 0, width: 0, height: 0, fps: 0,
        hasAudio: false, hasVideo: kind !== 'audio',
        codec: null, thumb: null, loading: true,
      };
      this.store.project.media.push(media);
      added.push(media);
    }
    this.store.changed('media');

    // sondage en parallele mais borne
    const queue = added.filter((m) => m.loading);
    const CONC = 3;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, async () => {
      while (i < queue.length) {
        const m = queue[i++];
        try { await this.probe(m); } catch (e) { console.warn('sondage', m.name, e); m.error = e.message; }
        m.loading = false;
        this.store.changed('media');
      }
    }));
    return added;
  }

  // ------------------------------------------------------------------ sondage

  async probe(media) {
    const file = this.files.get(media.id);
    if (!file) throw new Error('fichier absent');

    if (media.kind === 'image') {
      const bmp = await createImageBitmap(file);
      media.width = bmp.width; media.height = bmp.height;
      media.duration = 5; media.hasAudio = false; media.fps = 0;
      media.thumb = await bitmapToThumb(bmp);
      bmp.close();
      return media;
    }

    // 1) infos exactes via le demuxeur si possible
    const mp4 = await this.mp4Of(media.id);
    if (mp4) {
      const v = mp4.videoTrack, a = mp4.audioTrack;
      media.duration = mp4.duration || (v ? v.duration : a ? a.duration : 0);
      if (v) {
        media.rotation = v.rotation || 0;
        const couche = media.rotation === 90 || media.rotation === 270;
        media.width = couche ? v.height : v.width;
        media.height = couche ? v.width : v.height;
        media.fps = v.fps ? Math.round(v.fps * 1000) / 1000 : 0;
        media.codec = v.codec;
        media.hasVideo = true;
        media.frameCount = v.samples.length;
      } else media.hasVideo = false;
      if (a) {
        media.hasAudio = true;
        media.audioCodec = a.codec;
        media.sampleRate = a.sampleRate;
        media.channels = a.channels;
      } else if (mp4.tracks && mp4.tracks.some((t) => t.kind === 'audio')) {
        // Le fichier CONTIENT une piste son, mais son codec n'a pas ete
        // identifie (formats QuickTime exotiques). Ne pas la declarer serait la
        // condamner : le mixage ignore les medias « sans audio », et l'export
        // sortirait muet sans que personne n'essaie meme de la lire. On la
        // signale, les chemins de decodage de secours feront le reste.
        media.hasAudio = true;
        media.audioCodec = 'inconnu';
      }
      media.demuxable = !!(v && v.codec);
    }

    // 2) complement / secours via l'element video
    if (!media.duration || (!media.width && media.hasVideo)) {
      const v = this._video();
      const url = URL.createObjectURL(file);
      try {
        v.src = url;
        await once(v, 'loadedmetadata', 20000);
        media.duration = media.duration || (isFinite(v.duration) ? v.duration : 0);
        media.width = media.width || v.videoWidth;
        media.height = media.height || v.videoHeight;
        if (!media.width) media.hasVideo = false;
        if (!mp4) media.hasAudio = media.kind === 'audio' ? true : true; // suppose present
        if (!media.fps) media.fps = 30;
      } finally {
        v.removeAttribute('src'); v.load();
        URL.revokeObjectURL(url);
      }
    }
    if (media.kind === 'audio') { media.hasVideo = false; media.hasAudio = true; }
    if (!media.duration) media.duration = 5;

    // 3) vignette
    if (media.hasVideo && !media.thumb) {
      try { media.thumb = await this.grabThumb(media); } catch (_) {}
    }
    if (media.kind === 'audio') {
      this.waveform(media.id).catch(() => {});
    }
    return media;
  }

  _video() {
    if (!this._probeVideo) {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.playsInline = true;
      v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px';
      document.body.append(v);
      this._probeVideo = v;
    }
    return this._probeVideo;
  }

  async grabThumb(media, at) {
    const file = this.files.get(media.id);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    const url = URL.createObjectURL(file);
    try {
      v.src = url;
      await once(v, 'loadeddata', 20000);
      const t = at ?? Math.min(Math.max(0.1, media.duration * 0.1), Math.max(0, media.duration - 0.05));
      v.currentTime = t;
      await once(v, 'seeked', 20000);
      const W = 192, H = Math.max(1, Math.round(W * (v.videoHeight || 9) / (v.videoWidth || 16)));
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      cv.getContext('2d').drawImage(v, 0, 0, W, H);
      return cv.toDataURL('image/jpeg', 0.72);
    } finally {
      v.removeAttribute('src'); v.load();
      URL.revokeObjectURL(url);
    }
  }

  // ----------------------------------------------------- pellicule (timeline)

  /** Demande une pellicule (bitmaps) pour un media. Non bloquant. */
  requestStrip(mediaId, count, onReady) {
    count = Math.min(count, 24);
    const cur = this.strips.get(mediaId);
    // deja assez de vignettes, ou generation deja demandee a ce niveau de detail
    if (cur && (cur.count >= count || cur.requested >= count)) return cur;
    const entry = cur || { count: 0, bitmaps: [], pending: true, requested: 0 };
    entry.pending = true;
    entry.requested = count;
    this.strips.set(mediaId, entry);
    this._stripQueue.push({ mediaId, count, onReady });
    this._pumpStrips();
    return entry;
  }

  async _pumpStrips() {
    if (this._stripBusy) return;
    this._stripBusy = true;
    while (this._stripQueue.length) {
      const job = this._stripQueue.shift();
      try { await this._buildStrip(job); } catch (e) { /* silencieux */ }
    }
    this._stripBusy = false;
  }

  async _buildStrip({ mediaId, count, onReady }) {
    const media = this.store.project.media.find((m) => m.id === mediaId);
    const file = this.files.get(mediaId);
    if (!media || !file || !media.hasVideo) return;
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    const url = URL.createObjectURL(file);
    const bitmaps = [];
    try {
      v.src = url;
      await once(v, 'loadeddata', 20000);
      const H = 44;
      const W = Math.max(2, Math.round(H * (v.videoWidth || 16) / (v.videoHeight || 9)));
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      for (let i = 0; i < count; i++) {
        const t = (media.duration * (i + 0.5)) / count;
        v.currentTime = Math.min(t, Math.max(0, media.duration - 0.03));
        await once(v, 'seeked', 8000).catch(() => {});
        ctx.drawImage(v, 0, 0, W, H);
        bitmaps.push(await createImageBitmap(cv));
      }
    } finally {
      v.removeAttribute('src'); v.load();
      URL.revokeObjectURL(url);
    }
    const old = this.strips.get(mediaId);
    const entry = { count: bitmaps.length, bitmaps, pending: false, requested: Math.max(count, (old && old.requested) || 0) };
    if (old && old.bitmaps) for (const b of old.bitmaps) b.close && b.close();
    this.strips.set(mediaId, entry);
    onReady && onReady(entry);
  }

  // ------------------------------------------------------------- forme d'onde

  async waveform(mediaId) {
    if (this.waves.has(mediaId)) return this.waves.get(mediaId);
    const file = this.files.get(mediaId);
    if (!file) return null;
    if (file.size > 200 * 1024 * 1024) { this.waves.set(mediaId, null); return null; }
    try {
      const ac = new OfflineAudioContext(1, 128, 22050);
      const buf = await ac.decodeAudioData(await file.arrayBuffer());
      const N = 1200;
      const ch = buf.getChannelData(0);
      const step = Math.max(1, Math.floor(ch.length / N));
      const env = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        let peak = 0;
        const a = i * step, b = Math.min(ch.length, a + step);
        for (let j = a; j < b; j += 2) { const x = Math.abs(ch[j]); if (x > peak) peak = x; }
        env[i] = peak;
      }
      this.waves.set(mediaId, env);
      this.store.changed('media');
      return env;
    } catch (e) {
      this.waves.set(mediaId, null);
      return null;
    }
  }

  remove(mediaId) {
    const u = this.urls.get(mediaId);
    if (u) URL.revokeObjectURL(u);
    this.urls.delete(mediaId);
    this.files.delete(mediaId);
    this.handles.delete(mediaId);
    this.mp4.delete(mediaId);
    const s = this.strips.get(mediaId);
    if (s && s.bitmaps) for (const b of s.bitmaps) b.close && b.close();
    this.strips.delete(mediaId);
    this.waves.delete(mediaId);
  }

  /** Medias du projet dont le fichier n'est pas (re)lie. */
  missing() {
    return this.store.project.media.filter((m) => !this.files.has(m.id));
  }
}

async function bitmapToThumb(bmp) {
  const W = 192, H = Math.max(1, Math.round(W * bmp.height / bmp.width));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.getContext('2d').drawImage(bmp, 0, 0, W, H);
  return cv.toDataURL('image/jpeg', 0.72);
}
