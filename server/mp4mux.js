'use strict';
/*
 * Muxeur MP4 (ISO BMFF) en streaming, sans dependance.
 *
 * Strategie :
 *   ftyp  -> ecrit tout de suite
 *   mdat  -> taille 64 bits, les octets des samples y sont ecrits au fil de l'eau
 *   moov  -> construit a la fin depuis les tables de samples accumulees
 *
 * On ne garde en RAM que ~24 octets de metadonnees par sample : un export
 * 4K60 de 10 min = ~36 000 samples video = moins d'un Mo.
 */

const fs = require('fs');

// ---------------------------------------------------------------- helpers box

function u8(...v) { return Buffer.from(v); }
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v >>> 0, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; }
function i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v | 0, 0); return b; }
function u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; }
function fourcc(s) { return Buffer.from(s, 'latin1'); }

function box(type, ...payload) {
  const body = Buffer.concat(payload.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return Buffer.concat([u32(body.length + 8), fourcc(type), body]);
}
function fullBox(type, version, flags, ...payload) {
  return box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
}

// matrice unite 16.16 (identite)
const UNITY_MATRIX = Buffer.concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

// 1904-01-01 -> 1970-01-01 en secondes
const MAC_EPOCH_OFFSET = 2082844800;

// ------------------------------------------------------------- description AV

/**
 * Ecrit un descripteur ES (esds) minimal pour AAC.
 * On garde uniquement DecoderConfigDescriptor + DecoderSpecificInfo.
 */
function esds(asc, sampleRate, channels) {
  const dsi = asc && asc.length ? asc : defaultAsc(sampleRate, channels);
  const tag = (t, payload) => {
    // longueur en base-128 sur 4 octets (toujours 4 pour rester simple/valide)
    const len = payload.length;
    return Buffer.concat([
      u8(t),
      u8(0x80 | ((len >> 21) & 0x7f), 0x80 | ((len >> 14) & 0x7f), 0x80 | ((len >> 7) & 0x7f), len & 0x7f),
      payload,
    ]);
  };
  const decSpecific = tag(0x05, dsi);
  const decConfig = tag(0x04, Buffer.concat([
    u8(0x40),          // objectTypeIndication = MPEG-4 audio
    u8(0x15),          // streamType audio (0x05<<2) | upstream 0 | reserved 1
    u8(0, 0, 0),       // bufferSizeDB
    u32(0),            // maxBitrate
    u32(0),            // avgBitrate
    decSpecific,
  ]));
  const slConfig = tag(0x06, u8(0x02));
  const es = tag(0x03, Buffer.concat([u16(1), u8(0x00), decConfig, slConfig]));
  return fullBox('esds', 0, 0, es);
}

const ASC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function defaultAsc(sampleRate, channels) {
  // AudioSpecificConfig : AAC-LC (2), index de frequence, config de canaux
  let idx = ASC_RATES.indexOf(sampleRate);
  if (idx < 0) idx = 3;
  const objType = 2;
  const chCfg = Math.min(channels || 2, 7);
  const bits = (objType << 11) | (idx << 7) | (chCfg << 3);
  return Buffer.from([(bits >> 8) & 255, bits & 255]);
}

// -------------------------------------------------------------------- pistes

class Track {
  constructor(id, kind, cfg) {
    this.id = id;
    this.kind = kind;                 // 'video' | 'audio'
    this.cfg = cfg;
    this.timescale = cfg.timescale;
    this.samples = [];                // {offset,size,duration,sync,cto}
    this.chunks = [];                 // {offset, first, count}
    this.duration = 0;
  }

  add(offset, size, duration, sync) {
    const s = this.samples.length;
    // un nouveau chunk demarre si le sample precedent n'est pas contigu
    const last = this.chunks[this.chunks.length - 1];
    if (last && last.offset + last.bytes === offset) {
      last.count++;
      last.bytes += size;
    } else {
      this.chunks.push({ offset, first: s, count: 1, bytes: size });
    }
    this.samples.push({ size, duration, sync });
    this.duration += duration;
  }
}

// -------------------------------------------------------------------- muxeur

class Mp4Muxer {
  /**
   * @param {string} filePath  fichier de sortie
   * @param {object} opts      { video?: {...}, audio?: {...}, creation?: number }
   */
  constructor(filePath, opts) {
    this.path = filePath;
    this.opts = opts || {};
    this.fd = fs.openSync(filePath, 'w');
    this.pos = 0;
    this.mdatStart = 0;
    this.mdatPayloadStart = 0;
    this.tracks = [];
    this.videoTrack = null;
    this.audioTrack = null;
    this.closed = false;

    const v = this.opts.video;
    if (v) {
      this.videoTrack = new Track(1, 'video', v);
      this.tracks.push(this.videoTrack);
    }
    const a = this.opts.audio;
    if (a) {
      this.audioTrack = new Track(this.tracks.length + 1, 'audio', a);
      this.tracks.push(this.audioTrack);
    }

    this._writeHeader();
  }

  _write(buf) {
    fs.writeSync(this.fd, buf, 0, buf.length, this.pos);
    this.pos += buf.length;
  }

  _writeHeader() {
    // mp42 : la marque attendue par les importeurs stricts pour du H.264 + AAC
    // (c'est le cas de Photos sur iPhone).
    const brands = ['isom', 'iso2', 'mp41', 'mp42'];
    const vc = this.opts.video && this.opts.video.codec;
    if (vc === 'avc') brands.push('avc1');
    if (vc === 'hevc') brands.push('hvc1');
    if (vc === 'av1') brands.push('av01');
    this._write(box('ftyp', fourcc('isom'), u32(512), ...brands.map(fourcc)));

    // mdat en taille 64 bits : on pourra ecrire la vraie taille a la fin
    this.mdatStart = this.pos;
    this._write(Buffer.concat([u32(1), fourcc('mdat'), u64(0)]));
    this.mdatPayloadStart = this.pos;
  }

  /** Ajoute un sample video. duration en unites de timescale video. */
  addVideo(data, duration, sync) {
    if (!this.videoTrack) throw new Error('pas de piste video');
    const off = this.pos;
    this._write(data);
    this.videoTrack.add(off, data.length, duration, !!sync);
  }

  /** Ajoute une trame audio (AAC : 1024 samples). */
  addAudio(data, duration) {
    if (!this.audioTrack) throw new Error('pas de piste audio');
    const off = this.pos;
    this._write(data);
    this.audioTrack.add(off, data.length, duration, true);
  }

  get bytesWritten() { return this.pos; }

  /** Ferme le fichier : patch de la taille du mdat + ecriture du moov. */
  finalize() {
    if (this.closed) return { bytes: this.pos };
    this.closed = true;

    const mdatSize = this.pos - this.mdatStart;
    const sizeBuf = u64(mdatSize);
    fs.writeSync(this.fd, sizeBuf, 0, 8, this.mdatStart + 8);

    const moov = this._moov();
    fs.writeSync(this.fd, moov, 0, moov.length, this.pos);
    this.pos += moov.length;
    fs.closeSync(this.fd);
    return { bytes: this.pos, path: this.path };
  }

  abort() {
    if (this.closed) return;
    this.closed = true;
    try { fs.closeSync(this.fd); } catch (_) {}
    try { fs.unlinkSync(this.path); } catch (_) {}
  }

  // ------------------------------------------------------------------ moov

  _moov() {
    const MOVIE_TS = 1000;
    let longest = 0;
    for (const t of this.tracks) longest = Math.max(longest, t.duration / t.timescale);
    const movieDuration = Math.round(longest * MOVIE_TS);
    const created = Math.floor((this.opts.creation || Date.now()) / 1000) + MAC_EPOCH_OFFSET;

    const mvhd = fullBox('mvhd', 0, 0,
      u32(created), u32(created), u32(MOVIE_TS), u32(movieDuration),
      u32(0x00010000), u16(0x0100), u16(0),
      u32(0), u32(0),
      UNITY_MATRIX,
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
      u32(this.tracks.length + 1));

    const traks = this.tracks.map((t) => this._trak(t, MOVIE_TS, created));
    return box('moov', mvhd, ...traks);
  }

  _trak(t, MOVIE_TS, created) {
    const durMovie = Math.round((t.duration / t.timescale) * MOVIE_TS);
    const isVideo = t.kind === 'video';

    // tkhd version 0, dans l'ordre EXACT de la norme :
    //   creation(4) modification(4) trackID(4) RESERVE(4) duree(4) reserve(8)
    //   layer(2) alternate_group(2) volume(2) reserve(2) matrice(36)
    //   largeur(4) hauteur(4)                                  -> 92 octets
    //
    // Le champ reserve apres l'identifiant de piste manquait : la boite faisait
    // 88 octets, la duree tombait dans le mauvais champ et TOUT ce qui suit
    // etait decale de quatre octets — matrice d'affichage invalide, dimensions
    // de piste aberrantes. VLC n'y voyait rien (il lit les tables
    // d'echantillons), mais Photos sur iPhone lit cet en-tete : il refusait
    // d'importer la video.
    const tkhd = fullBox('tkhd', 0, 3,
      u32(created), u32(created), u32(t.id), u32(0), u32(durMovie),
      u32(0), u32(0),
      u16(0), u16(0),
      u16(isVideo ? 0 : 0x0100), u16(0),
      UNITY_MATRIX,
      u32(isVideo ? (t.cfg.width * 65536) : 0),
      u32(isVideo ? (t.cfg.height * 65536) : 0));

    const mdhd = fullBox('mdhd', 0, 0,
      u32(created), u32(created), u32(t.timescale), u32(t.duration),
      u16(0x55c4), u16(0)); // langue "und"

    const hdlr = fullBox('hdlr', 0, 0,
      u32(0), fourcc(isVideo ? 'vide' : 'soun'), u32(0), u32(0), u32(0),
      Buffer.from(isVideo ? 'VideoHandler\0' : 'SoundHandler\0', 'latin1'));

    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const mediaHeader = isVideo
      ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0))
      : fullBox('smhd', 0, 0, u16(0), u16(0));

    const stbl = this._stbl(t);
    const minf = box('minf', mediaHeader, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    return box('trak', tkhd, mdia);
  }

  _stsd(t) {
    if (t.kind === 'video') {
      const cfg = t.cfg;
      let cfgBox;
      if (cfg.codec === 'avc') cfgBox = box('avcC', cfg.description);
      else if (cfg.codec === 'hevc') cfgBox = box('hvcC', cfg.description);
      else if (cfg.codec === 'av1') cfgBox = box('av1C', cfg.description);
      else if (cfg.codec === 'vp9') cfgBox = box('vpcC', cfg.description || Buffer.alloc(0));
      else throw new Error('codec video non gere: ' + cfg.codec);

      const fmt = { avc: 'avc1', hevc: 'hvc1', av1: 'av01', vp9: 'vp09' }[cfg.codec];
      const extras = [cfgBox];
      // pasp : pixels carres
      extras.push(box('pasp', u32(1), u32(1)));

      const entry = box(fmt,
        u8(0, 0, 0, 0, 0, 0), u16(1),                 // reserved + data_reference_index
        u16(0), u16(0), u32(0), u32(0), u32(0),        // pre_defined / reserved
        u16(cfg.width), u16(cfg.height),
        u32(0x00480000), u32(0x00480000),             // 72 dpi
        u32(0), u16(1),
        Buffer.concat([u8(0), Buffer.alloc(31)]),      // compressorname (32o)
        u16(0x0018), u16(0xffff),                     // depth, pre_defined = -1 (16 bits)
        ...extras);
      return fullBox('stsd', 0, 0, u32(1), entry);
    }

    const cfg = t.cfg;
    const entry = box('mp4a',
      u8(0, 0, 0, 0, 0, 0), u16(1),
      u16(0), u16(0), u32(0),
      u16(cfg.channels), u16(16),
      u16(0), u16(0),
      u32(Math.min(cfg.sampleRate, 65535) << 16),
      esds(cfg.description, cfg.sampleRate, cfg.channels));
    return fullBox('stsd', 0, 0, u32(1), entry);
  }

  _stbl(t) {
    const n = t.samples.length;

    // stts : durees compressees en runs
    const stts = [];
    for (let i = 0; i < n; i++) {
      const d = t.samples[i].duration;
      const last = stts[stts.length - 1];
      if (last && last.d === d) last.c++;
      else stts.push({ c: 1, d });
    }
    const sttsBuf = Buffer.alloc(4 + stts.length * 8);
    sttsBuf.writeUInt32BE(stts.length, 0);
    stts.forEach((r, i) => {
      sttsBuf.writeUInt32BE(r.c, 4 + i * 8);
      sttsBuf.writeUInt32BE(r.d, 8 + i * 8);
    });

    // stsz
    let stszBuf;
    const uniform = n > 0 && t.samples.every((s) => s.size === t.samples[0].size);
    if (uniform) {
      stszBuf = Buffer.concat([u32(t.samples[0].size), u32(n)]);
    } else {
      stszBuf = Buffer.alloc(8 + n * 4);
      stszBuf.writeUInt32BE(0, 0);
      stszBuf.writeUInt32BE(n, 4);
      for (let i = 0; i < n; i++) stszBuf.writeUInt32BE(t.samples[i].size, 8 + i * 4);
    }

    // stsc
    const stsc = [];
    t.chunks.forEach((c, i) => {
      const last = stsc[stsc.length - 1];
      if (last && last.spc === c.count) return;
      stsc.push({ first: i + 1, spc: c.count, desc: 1 });
    });
    const stscBuf = Buffer.alloc(4 + stsc.length * 12);
    stscBuf.writeUInt32BE(stsc.length, 0);
    stsc.forEach((r, i) => {
      stscBuf.writeUInt32BE(r.first, 4 + i * 12);
      stscBuf.writeUInt32BE(r.spc, 8 + i * 12);
      stscBuf.writeUInt32BE(r.desc, 12 + i * 12);
    });

    // co64 : offsets absolus 64 bits (fichiers > 4 Go supportes)
    const co64Buf = Buffer.alloc(4 + t.chunks.length * 8);
    co64Buf.writeUInt32BE(t.chunks.length, 0);
    t.chunks.forEach((c, i) => co64Buf.writeBigUInt64BE(BigInt(c.offset), 4 + i * 8));

    const boxes = [
      this._stsd(t),
      fullBox('stts', 0, 0, sttsBuf),
      fullBox('stsc', 0, 0, stscBuf),
      fullBox('stsz', 0, 0, stszBuf),
      fullBox('co64', 0, 0, co64Buf),
    ];

    // stss : uniquement si toutes les images ne sont pas des I-frames
    const syncIdx = [];
    let allSync = true;
    for (let i = 0; i < n; i++) {
      if (t.samples[i].sync) syncIdx.push(i + 1);
      else allSync = false;
    }
    if (!allSync) {
      const stssBuf = Buffer.alloc(4 + syncIdx.length * 4);
      stssBuf.writeUInt32BE(syncIdx.length, 0);
      syncIdx.forEach((v, i) => stssBuf.writeUInt32BE(v, 4 + i * 4));
      boxes.push(fullBox('stss', 0, 0, stssBuf));
    }

    return box('stbl', ...boxes);
  }
}

module.exports = { Mp4Muxer };
