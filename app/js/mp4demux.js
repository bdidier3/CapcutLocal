// Demuxeur MP4 / MOV / M4V (y compris fragmente) en JavaScript pur.
// Objectif : fournir a WebCodecs des samples exacts, sans ffmpeg.

const txt = (u8, o, n) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]).slice(0, n || 4);

/** Lecteur d'octets sur un Blob/File. */
/**
 * Lecteur d'octets sur un fichier local, avec lecture par blocs.
 *
 * L'export demande des petits paquets successifs. Sur un disque externe, USB ou
 * reseau, chaque aller-retour coute bien plus cher que les octets eux-memes : on
 * lit donc par gros blocs et on ressert la suite depuis la memoire.
 */
// 8 Mo : sur un disque dur, chaque lecture paie un deplacement de la tete
// (~10-20 ms, bien plus quand plusieurs fichiers sont lus a la fois) ; deux fois
// moins de lectures, c'est deux fois moins de deplacements. Un rush iPhone 4K
// a 50-90 Mb/s en consomme 6 a 11 Mo par seconde de video.
const CHUNK = 8 * 1024 * 1024;
// Premier bloc apres un saut. Pour afficher UNE image apres un saut, il faut lire
// de l'image cle a l'image voulue — une demi-GOP en moyenne, 2 a 3 Mo sur un rush
// iPhone. Lire d'emblee 8 Mo coutait 0,8 s sur un disque a 10 Mo/s, dont plus de
// la moitie pour rien. On commence petit, et l'on double tant que la lecture
// continue d'un seul tenant (lecture video, export) jusqu'a 8 Mo.
const PREMIER_BLOC = 1024 * 1024;

export function blobReader(blob) {
  let cache = null, cacheStart = 0, cacheEnd = 0;
  let elan = PREMIER_BLOC;
  const stats = { calls: 0, hits: 0, bytes: 0, ms: 0 };
  return {
    size: blob.size,
    stats,
    /**
     * Lecture EXACTE, sans passer par le bloc en memoire. Pour les petites
     * lectures isolees (en-tetes, une image cle) : charger 8 Mo pour en garder
     * quelques octets faisait lire des giga-octets pour rien a l'import et pour
     * les vignettes — sur un disque dur USB, des dizaines de secondes.
     */
    async readDirect(start, end) {
      const e = Math.min(end, blob.size);
      if (e <= start) return new Uint8Array(0);
      if (cache && start >= cacheStart && e <= cacheEnd) return cache.subarray(start - cacheStart, e - cacheStart);
      const t0 = performance.now();
      const out = new Uint8Array(await blob.slice(start, e).arrayBuffer());
      stats.bytes += out.length; stats.ms += performance.now() - t0;
      return out;
    },
    async read(start, end) {
      const e = Math.min(end, blob.size);
      if (e <= start) return new Uint8Array(0);
      stats.calls++;
      if (cache && start >= cacheStart && e <= cacheEnd) {
        stats.hits++;
        return cache.subarray(start - cacheStart, e - cacheStart);
      }
      const want = e - start;
      const t0 = performance.now();
      if (want > CHUNK) {                       // trop gros pour le cache
        const big = new Uint8Array(await blob.slice(start, e).arrayBuffer());
        stats.bytes += big.length; stats.ms += performance.now() - t0;
        return big;
      }
      // dans la continuite du bloc precedent : on lit plus loin d'avance ;
      // apres un saut : on repart d'un petit bloc
      const suite = cache && start >= cacheStart && start <= cacheEnd + 2 * 1024 * 1024;
      elan = suite ? Math.min(CHUNK, elan * 2) : PREMIER_BLOC;
      const cs = start;
      const ce = Math.min(blob.size, start + Math.max(elan, want));
      cache = new Uint8Array(await blob.slice(cs, ce).arrayBuffer());
      cacheStart = cs; cacheEnd = cs + cache.length;
      stats.bytes += cache.length; stats.ms += performance.now() - t0;
      return cache.subarray(0, e - start);
    },
  };
}

// --------------------------------------------------------------- lecture boites

class Cursor {
  constructor(u8, base = 0) { this.u = u8; this.p = 0; this.base = base; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  get left() { return this.u.length - this.p; }
  u8v() { return this.u[this.p++]; }
  u16() { const v = this.dv.getUint16(this.p); this.p += 2; return v; }
  u24() { const v = (this.u[this.p] << 16) | (this.u[this.p + 1] << 8) | this.u[this.p + 2]; this.p += 3; return v; }
  u32() { const v = this.dv.getUint32(this.p); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p); this.p += 4; return v; }
  u64() { const v = Number(this.dv.getBigUint64(this.p)); this.p += 8; return v; }
  i64() { const v = Number(this.dv.getBigInt64(this.p)); this.p += 8; return v; }
  str(n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u[this.p + i]); this.p += n; return s; }
  skip(n) { this.p += n; }
  sub(n) { const s = this.u.subarray(this.p, this.p + n); this.p += n; return s; }
}

/** Itere les boites contenues dans un buffer. cb(type, cursorSurLePayload, tailleTotale) */
function walk(u8, cb) {
  let p = 0;
  while (p + 8 <= u8.length) {
    const dv = new DataView(u8.buffer, u8.byteOffset + p, Math.min(16, u8.length - p));
    let size = dv.getUint32(0);
    const type = txt(u8, p + 4);
    let head = 8;
    if (size === 1) {
      if (p + 16 > u8.length) break;
      size = Number(dv.getBigUint64(8));
      head = 16;
    } else if (size === 0) {
      size = u8.length - p;
    }
    if (size < head || p + size > u8.length) {
      // boite tronquee : on s'arrete proprement
      break;
    }
    const payload = u8.subarray(p + head, p + size);
    cb(type, payload, size);
    p += size;
  }
}

function findBox(u8, type) {
  let found = null;
  walk(u8, (t, payload) => { if (!found && t === type) found = payload; });
  return found;
}

// ------------------------------------------------------- chaines codec WebCodecs

const hex2 = (n) => n.toString(16).padStart(2, '0');

function avcCodecString(avcC) {
  if (!avcC || avcC.length < 4) return 'avc1.42E01E';
  return 'avc1.' + hex2(avcC[1]) + hex2(avcC[2]) + hex2(avcC[3]);
}

function hevcCodecString(hvcC, fourcc) {
  if (!hvcC || hvcC.length < 13) return 'hvc1.1.6.L93.B0';
  const b1 = hvcC[1];
  const profileSpace = (b1 >> 6) & 3;
  const tierFlag = (b1 >> 5) & 1;
  const profileIdc = b1 & 31;
  let compat = 0;
  for (let i = 0; i < 4; i++) compat = (compat * 256) + hvcC[2 + i];
  // les flags de compatibilite s'ecrivent en hexa, bits inverses
  let rev = 0;
  for (let i = 0; i < 32; i++) if (compat & (1 << i)) rev |= 1 << (31 - i);
  const level = hvcC[12];
  const parts = [
    (fourcc === 'hev1' ? 'hev1' : 'hvc1'),
    (['', 'A', 'B', 'C'][profileSpace] || '') + profileIdc,
    (rev >>> 0).toString(16).toUpperCase(),
    (tierFlag ? 'H' : 'L') + level,
  ];
  // octets de contrainte (on supprime les zeros de fin)
  const cons = [];
  for (let i = 6; i <= 11; i++) cons.push(hvcC[i]);
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  for (const c of cons) parts.push(c.toString(16).toUpperCase().padStart(2, '0'));
  if (cons.length === 0) parts.push('B0');
  return parts.join('.');
}

function av1CodecString(av1C) {
  if (!av1C || av1C.length < 4) return 'av01.0.08M.08';
  const profile = (av1C[1] >> 5) & 7;
  const level = av1C[1] & 31;
  const tier = (av1C[2] >> 7) & 1;
  const high = (av1C[2] >> 6) & 1;
  const twelve = (av1C[2] >> 5) & 1;
  const depth = high ? (twelve ? 12 : 10) : 8;
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
}

function vp9CodecString(vpcC) {
  if (!vpcC || vpcC.length < 5) return 'vp09.00.10.08';
  const profile = vpcC[4];
  const level = vpcC[5];
  const depth = (vpcC[6] >> 4) & 15;
  return `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(depth).padStart(2, '0')}`;
}

/** Extrait l'AudioSpecificConfig depuis un esds. */
function parseEsds(esdsPayload) {
  const u = esdsPayload;
  let p = 4; // version + flags
  let objType = 0x40;
  let asc = null;

  function readLen() {
    let len = 0, b;
    do { b = u[p++]; len = (len << 7) | (b & 0x7f); } while (b & 0x80);
    return len;
  }
  while (p < u.length) {
    const tag = u[p++];
    const len = readLen();
    if (tag === 0x03) { p += 3; /* ES_ID + flags */ continue; }
    if (tag === 0x04) {
      objType = u[p];
      p += 13;
      continue;
    }
    if (tag === 0x05) { asc = u.subarray(p, p + len); break; }
    p += len;
  }
  return { objType, asc };
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function parseAsc(asc) {
  if (!asc || asc.length < 2) return null;
  let objectType = (asc[0] >> 3) & 31;
  let bitPos = 5;
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = asc[bitPos >> 3] || 0;
      v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };
  if (objectType === 31) { objectType = 32 + readBits(6); }
  const freqIdx = readBits(4);
  let sampleRate = freqIdx === 15 ? readBits(24) : AAC_RATES[freqIdx];
  const chCfg = readBits(4);
  return { objectType, sampleRate, channels: chCfg };
}

// ------------------------------------------------------------------ parse moov

function parseStbl(stbl, trak) {
  const samples = [];
  let stts = null, ctts = null, stsz = null, stsc = null, chunkOffsets = null, stss = null;
  let stsd = null;

  walk(stbl, (t, pl) => {
    if (t === 'stsd') stsd = pl;
    else if (t === 'stts') stts = pl;
    else if (t === 'ctts') ctts = pl;
    else if (t === 'stsz') stsz = pl;
    else if (t === 'stz2') stsz = pl; // approximation : gere plus bas
    else if (t === 'stsc') stsc = pl;
    else if (t === 'stco' || t === 'co64') chunkOffsets = { type: t, pl };
    else if (t === 'stss') stss = pl;
  });

  // --- stsd : format + description
  if (stsd) {
    const c = new Cursor(stsd);
    c.skip(4);
    const n = c.u32();
    for (let i = 0; i < n && c.left > 8; i++) {
      const size = c.u32();
      const fmt = c.str(4);
      const body = c.sub(size - 8);
      trak.format = fmt;
      if (['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp08', 'vp09', 'mp4v'].includes(fmt)) {
        trak.kind = 'video';
        const b = new Cursor(body);
        b.skip(24);
        trak.width = b.u16();
        trak.height = b.u16();
        b.skip(50);
        const extras = body.subarray(78);
        const avcC = findBox(extras, 'avcC');
        const hvcC = findBox(extras, 'hvcC');
        const av1C = findBox(extras, 'av1C');
        const vpcC = findBox(extras, 'vpcC');
        if (avcC) { trak.description = avcC; trak.codec = avcCodecString(avcC); }
        else if (hvcC) { trak.description = hvcC; trak.codec = hevcCodecString(hvcC, fmt); }
        else if (av1C) { trak.description = av1C; trak.codec = av1CodecString(av1C); }
        else if (vpcC) { trak.description = null; trak.codec = vp9CodecString(vpcC); }
        else { trak.codec = fmt === 'vp09' ? 'vp09.00.10.08' : null; }
      } else if (['mp4a', 'Opus', 'opus', 'ac-3', 'ec-3', 'alac', 'sowt', 'twos', 'lpcm', 'ulaw', 'alaw'].includes(fmt)) {
        trak.kind = 'audio';
        const b = new Cursor(body);
        b.skip(6);                       // reserved
        b.skip(2);                       // data_reference_index
        const sver = b.u16();            // version QuickTime de l'entree son
        b.skip(2);                       // revision
        b.skip(4);                       // vendor
        trak.channels = b.u16();
        trak.bitsPerSample = b.u16();
        b.skip(4);                       // compression id + packet size
        trak.sampleRate = b.u32() / 65536;
        // Les .MOV d'iPhone utilisent une entree son en version 1 (et parfois 2),
        // qui glisse des champs supplementaires AVANT les sous-boites. Lire a
        // l'offset de la version 0 fait manquer `esds` : le codec reste inconnu,
        // la piste audio est ignoree, et l'export sort muet.
        const extras = body.subarray(audioExtrasOffset(sver));
        const esdsBox = findBox(extras, 'esds');
        const dOps = findBox(extras, 'dOps');
        if (esdsBox) {
          const { objType, asc } = parseEsds(esdsBox);
          if (objType === 0x40 || objType === 0x67) {
            const info = parseAsc(asc);
            const aot = info ? info.objectType : 2;
            trak.codec = 'mp4a.40.' + (aot === 5 ? 5 : aot === 29 ? 29 : 2);
            trak.description = asc;
            if (info && info.sampleRate) trak.sampleRate = info.sampleRate;
            if (info && info.channels) trak.channels = info.channels;
          } else if (objType === 0x6b || objType === 0x69) {
            trak.codec = 'mp3';
          }
        } else if (fmt === 'Opus' || fmt === 'opus') {
          trak.codec = 'opus';
          trak.description = dOps || null;
        } else if (fmt === 'alac') {
          trak.codec = 'alac';
        } else if (['sowt', 'twos', 'lpcm'].includes(fmt)) {
          trak.codec = 'pcm';
        } else {
          trak.codec = fmt;
        }
      }
      break; // une seule entree suffit
    }
  }

  if (!stts || !stsz || !stsc || !chunkOffsets) return samples;

  // --- tailles
  const zc = new Cursor(stsz);
  zc.skip(4);
  const uniformSize = zc.u32();
  const sampleCount = zc.u32();
  const sizes = new Uint32Array(sampleCount);
  if (uniformSize) sizes.fill(uniformSize);
  else for (let i = 0; i < sampleCount; i++) sizes[i] = zc.u32();

  // --- durees (stts)
  const dts = new Float64Array(sampleCount);
  const durs = new Uint32Array(sampleCount);
  {
    const c = new Cursor(stts);
    c.skip(4);
    const n = c.u32();
    let s = 0, t = 0;
    for (let i = 0; i < n && s < sampleCount; i++) {
      const cnt = c.u32(), d = c.u32();
      for (let j = 0; j < cnt && s < sampleCount; j++) { dts[s] = t; durs[s] = d; t += d; s++; }
    }
    while (s < sampleCount) { dts[s] = t; durs[s] = durs[s - 1] || 0; t += durs[s]; s++; }
  }

  // --- decalages de composition (ctts)
  const cto = new Float64Array(sampleCount);
  if (ctts) {
    const c = new Cursor(ctts);
    const version = c.u8v(); c.u24();
    const n = c.u32();
    let s = 0;
    for (let i = 0; i < n && s < sampleCount; i++) {
      const cnt = c.u32();
      let off = version === 1 ? c.i32() : c.u32();
      // Les fichiers .MOV d'iPhone declarent une table en version 0 — donc non
      // signee d'apres la norme — tout en y ecrivant des decalages NEGATIFS
      // (les images B en ont besoin). Lus tels quels, ils deviennent des
      // nombres colossaux (2^32 moins quelques unites) : les horodatages
      // partent a l'infini, le decodeur ne retrouve plus l'image demandee et
      // renvoie sans cesse la meme — la video exportee se fige.
      //
      // Un decalage legitime vaut quelques dizaines d'unites : tout ce qui
      // frole 2^31 est en realite un negatif deguise.
      if (off >= 0x80000000) off -= 0x100000000;
      for (let j = 0; j < cnt && s < sampleCount; j++) cto[s++] = off;
    }
  }

  // --- offsets de chunks
  const offsets = [];
  {
    const c = new Cursor(chunkOffsets.pl);
    c.skip(4);
    const n = c.u32();
    for (let i = 0; i < n; i++) offsets.push(chunkOffsets.type === 'co64' ? c.u64() : c.u32());
  }

  // --- table sample -> chunk
  const stscEntries = [];
  {
    const c = new Cursor(stsc);
    c.skip(4);
    const n = c.u32();
    for (let i = 0; i < n; i++) stscEntries.push({ first: c.u32(), spc: c.u32(), desc: c.u32() });
  }

  // --- images cles
  let syncSet = null;
  if (stss) {
    syncSet = new Set();
    const c = new Cursor(stss);
    c.skip(4);
    const n = c.u32();
    for (let i = 0; i < n; i++) syncSet.add(c.u32() - 1);
  }

  // reconstruction des offsets absolus
  let sample = 0;
  for (let e = 0; e < stscEntries.length && sample < sampleCount; e++) {
    const cur = stscEntries[e];
    const nextFirst = e + 1 < stscEntries.length ? stscEntries[e + 1].first : offsets.length + 1;
    for (let ch = cur.first; ch < nextFirst && sample < sampleCount; ch++) {
      let off = offsets[ch - 1];
      if (off === undefined) break;
      for (let k = 0; k < cur.spc && sample < sampleCount; k++) {
        samples.push({
          offset: off,
          size: sizes[sample],
          dts: dts[sample],
          cts: dts[sample] + cto[sample],
          dur: durs[sample],
          sync: syncSet ? syncSet.has(sample) : true,
        });
        off += sizes[sample];
        sample++;
      }
    }
  }
  return samples;
}

/** Angle (0, 90, 180, 270) code par la matrice d'affichage d'une piste. */
function matrixRotation(a, b, c, d) {
  const near = (x, y) => Math.abs(x - y) < 0.01;
  if (near(a, 0) && near(b, 1) && near(c, -1) && near(d, 0)) return 90;
  if (near(a, -1) && near(b, 0) && near(c, 0) && near(d, -1)) return 180;
  if (near(a, 0) && near(b, -1) && near(c, 1) && near(d, 0)) return 270;
  return 0;
}

function parseElstOffset(edts, movieTimescale, mediaTimescale) {
  const elst = findBox(edts, 'elst');
  if (!elst) return 0;
  const c = new Cursor(elst);
  const version = c.u8v(); c.u24();
  const n = c.u32();
  let emptyDur = 0, mediaStart = 0, seen = false;
  for (let i = 0; i < n; i++) {
    const segDur = version === 1 ? c.u64() : c.u32();
    const mediaTime = version === 1 ? c.i64() : c.i32();
    c.u16(); c.u16();
    if (mediaTime === -1) emptyDur += segDur / (movieTimescale || 1000);
    else if (!seen) { mediaStart = mediaTime / (mediaTimescale || 1000); seen = true; }
  }
  // temps de presentation = temps media - mediaStart + emptyDur
  return emptyDur - mediaStart;
}

// ------------------------------------------------------------------- fragments

function parseMoof(moof, tracks, defaults) {
  walk(moof, (t, traf) => {
    if (t !== 'traf') return;
    let tfhd = null, tfdt = null;
    const truns = [];
    walk(traf, (tt, pl) => {
      if (tt === 'tfhd') tfhd = pl;
      else if (tt === 'tfdt') tfdt = pl;
      else if (tt === 'trun') truns.push(pl);
    });
    if (!tfhd) return;
    const c = new Cursor(tfhd);
    c.u8v();
    const flags = c.u24();
    const trackId = c.u32();
    let baseOffset = 0, defaultDur = 0, defaultSize = 0, defaultFlags = 0;
    if (flags & 0x01) baseOffset = c.u64();
    if (flags & 0x02) c.u32();
    if (flags & 0x08) defaultDur = c.u32();
    if (flags & 0x10) defaultSize = c.u32();
    if (flags & 0x20) defaultFlags = c.u32();

    const trak = tracks.find((x) => x.id === trackId);
    if (!trak) return;
    const d = defaults[trackId] || {};
    if (!defaultDur) defaultDur = d.dur || 0;
    if (!defaultSize) defaultSize = d.size || 0;
    if (!defaultFlags) defaultFlags = d.flags || 0;

    let baseDts = trak._fragDts || 0;
    if (tfdt) {
      const c2 = new Cursor(tfdt);
      const v = c2.u8v(); c2.u24();
      baseDts = v === 1 ? c2.u64() : c2.u32();
    }

    let dts = baseDts;
    for (const trun of truns) {
      const tc = new Cursor(trun);
      const version = tc.u8v();
      const tflags = tc.u24();
      const count = tc.u32();
      let dataOffset = baseOffset || moof._absStart || 0;
      if (tflags & 0x01) dataOffset = (baseOffset || moof._absStart || 0) + tc.i32();
      let firstFlags = null;
      if (tflags & 0x04) firstFlags = tc.u32();
      let off = dataOffset;
      for (let i = 0; i < count; i++) {
        const dur = (tflags & 0x100) ? tc.u32() : defaultDur;
        const size = (tflags & 0x200) ? tc.u32() : defaultSize;
        const sflags = (tflags & 0x400) ? tc.u32() : (i === 0 && firstFlags !== null ? firstFlags : defaultFlags);
        const cto = (tflags & 0x800) ? (version === 1 ? tc.i32() : tc.u32()) : 0;
        const notSync = (sflags >> 16) & 1;
        trak.samples.push({ offset: off, size, dts, cts: dts + cto, dur, sync: trak.kind === 'audio' ? true : !notSync });
        off += size;
        dts += dur;
      }
    }
    trak._fragDts = dts;
  });
}

// ------------------------------------------------------------------ API publique

export class Mp4File {
  constructor(reader) { this.reader = reader; this.tracks = []; this.timescale = 1000; this.duration = 0; this.fragmented = false; }

  static async open(reader) {
    const f = new Mp4File(reader);
    await f._parse();
    return f;
  }

  async _parse() {
    const size = this.reader.size;
    const moofStarts = [];
    let moovBuf = null;
    let pos = 0;
    let guard = 0;

    // Balayage des boites de premier niveau (on ne lit que les en-tetes)
    while (pos + 8 <= size && guard++ < 200000) {
      const head = this.reader.readDirect ? await this.reader.readDirect(pos, pos + 16) : await this.reader.read(pos, pos + 16);
      if (head.length < 8) break;
      const dv = new DataView(head.buffer, head.byteOffset, head.length);
      let bs = dv.getUint32(0);
      const type = txt(head, 4);
      let hlen = 8;
      if (bs === 1) { if (head.length < 16) break; bs = Number(dv.getBigUint64(8)); hlen = 16; }
      else if (bs === 0) bs = size - pos;
      if (bs < hlen) break;

      if (type === 'moov') moovBuf = this.reader.readDirect ? await this.reader.readDirect(pos + hlen, pos + bs) : await this.reader.read(pos + hlen, pos + bs);
      else if (type === 'moof') moofStarts.push({ start: pos, size: bs, hlen });
      else if (type === 'sidx' || type === 'styp') { /* ignore */ }

      pos += bs;
    }

    if (!moovBuf) throw new Error('moov introuvable (fichier MP4 invalide ou tronque)');

    const mvhd = findBox(moovBuf, 'mvhd');
    if (mvhd) {
      const c = new Cursor(mvhd);
      const v = c.u8v(); c.u24();
      if (v === 1) { c.u64(); c.u64(); this.timescale = c.u32(); this.duration = c.u64() / this.timescale; }
      else { c.u32(); c.u32(); this.timescale = c.u32(); this.duration = c.u32() / this.timescale; }
    }

    const trexDefaults = {};
    const mvex = findBox(moovBuf, 'mvex');
    if (mvex) {
      this.fragmented = true;
      walk(mvex, (t, pl) => {
        if (t !== 'trex') return;
        const c = new Cursor(pl);
        c.u32();
        const id = c.u32();
        c.u32();
        trexDefaults[id] = { dur: c.u32(), size: c.u32(), flags: c.u32() };
      });
    }

    walk(moovBuf, (t, trak) => {
      if (t !== 'trak') return;
      const info = { id: 0, kind: null, codec: null, description: null, timescale: 1000, duration: 0, samples: [], width: 0, height: 0, sampleRate: 48000, channels: 2, tOffset: 0 };
      const tkhd = findBox(trak, 'tkhd');
      if (tkhd) {
        const c = new Cursor(tkhd);
        const v = c.u8v(); c.u24();
        if (v === 1) { c.u64(); c.u64(); info.id = c.u32(); c.u32(); c.u64(); }
        else { c.u32(); c.u32(); info.id = c.u32(); c.u32(); c.u32(); }
        c.u64();                       // reserved
        c.u16(); c.u16(); c.u16(); c.u16();   // layer, alternate_group, volume, reserved
        // Matrice d'affichage : c'est elle qui porte la ROTATION. Les telephones
        // filment a l'horizontale et notent « tourner de 90° » ici. Le lecteur du
        // navigateur l'applique tout seul ; WebCodecs, lui, rend l'image brute —
        // sans la lire, une video de telephone sort couchee.
        const f16 = () => { const n = c.u32(); return (n | 0) / 65536; };
        const a = f16(), b = f16(); c.u32();
        const cc = f16(), d = f16();
        info.rotation = matrixRotation(a, b, cc, d);
      }
      const mdia = findBox(trak, 'mdia');
      if (!mdia) return;
      const mdhd = findBox(mdia, 'mdhd');
      if (mdhd) {
        const c = new Cursor(mdhd);
        const v = c.u8v(); c.u24();
        if (v === 1) { c.u64(); c.u64(); info.timescale = c.u32(); info.duration = c.u64() / info.timescale; }
        else { c.u32(); c.u32(); info.timescale = c.u32(); info.duration = c.u32() / info.timescale; }
      }
      const hdlr = findBox(mdia, 'hdlr');
      if (hdlr) {
        const h = txt(hdlr, 8);
        info.kind = h === 'vide' ? 'video' : h === 'soun' ? 'audio' : null;
      }
      const minf = findBox(mdia, 'minf');
      const stbl = minf && findBox(minf, 'stbl');
      if (stbl) info.samples = parseStbl(stbl, info);
      const edts = findBox(trak, 'edts');
      if (edts) info.tOffset = parseElstOffset(edts, this.timescale, info.timescale);
      if (info.kind) this.tracks.push(info);
    });

    // fragments
    if (moofStarts.length) {
      this.fragmented = true;
      for (const m of moofStarts) {
        const buf = await this.reader.read(m.start + m.hlen, m.start + m.size);
        buf._absStart = m.start;
        parseMoof(buf, this.tracks, trexDefaults);
      }
    }

    for (const t of this.tracks) {
      t.samples.sort((a, b) => a.dts - b.dts);
      if (!t.duration && t.samples.length) {
        const last = t.samples[t.samples.length - 1];
        t.duration = (last.dts + last.dur) / t.timescale;
      }
      if (t.kind === 'video' && t.samples.length && t.duration > 0) {
        t.fps = t.samples.length / t.duration;
      }
      // index de presentation trie (pour rechercher une image par temps)
      t.byCts = t.samples.map((s, i) => i).sort((a, b) => t.samples[a].cts - t.samples[b].cts);
    }
    if (!this.duration) this.duration = Math.max(0, ...this.tracks.map((t) => t.duration));
  }

  get videoTrack() { return this.tracks.find((t) => t.kind === 'video' && t.codec) || null; }
  get audioTrack() { return this.tracks.find((t) => t.kind === 'audio' && t.codec) || null; }

  /** Index du sample de presentation contenant tSec (en secondes media). */
  indexAt(track, tSec) {
    const target = tSec * track.timescale;
    const list = track.byCts;
    let lo = 0, hi = list.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (track.samples[list[mid]].cts <= target) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return list[best];
  }

  /** Index (ordre de decodage) de la derniere image cle <= index donne. */
  keyBefore(track, idx) {
    for (let i = Math.min(idx, track.samples.length - 1); i >= 0; i--) if (track.samples[i].sync) return i;
    return 0;
  }

  /** Lit les octets d'une plage de samples en une seule requete quand c'est contigu. */
  /**
   * @param {boolean} [direct] lecture exacte, sans bloc en memoire (lectures isolees)
   * @param {object} [lecteur] lecteur propre a l'appelant : chaque decodeur a
   *   le sien, sinon deux decodeurs de la meme video se volent sans cesse le
   *   bloc en memoire et relisent le disque a chaque paquet.
   */
  async readSamples(track, from, to, direct = false, lecteur = null) {
    const rd = lecteur || this.reader;
    const s = track.samples;
    to = Math.min(to, s.length - 1);
    if (from > to) return [];
    let start = Infinity, end = 0;
    for (let i = from; i <= to; i++) { start = Math.min(start, s[i].offset); end = Math.max(end, s[i].offset + s[i].size); }
    // securite : si la plage est enorme, on decoupe
    const buf = direct && rd.readDirect ? await rd.readDirect(start, end) : await rd.read(start, end);
    const out = [];
    for (let i = from; i <= to; i++) {
      const o = s[i].offset - start;
      out.push({ idx: i, data: buf.subarray(o, o + s[i].size), sample: s[i] });
    }
    return out;
  }
}

/** Detecte si un blob est un conteneur ISO BMFF. */
/**
 * Ou commencent les sous-boites (esds, dOps...) d'une entree son, selon la
 * version QuickTime de l'entree. Les .MOV d'iPhone utilisent la version 1, qui
 * glisse 16 octets supplementaires ; lire a l'offset de la version 0 fait
 * manquer `esds`, le codec reste inconnu et la piste audio disparait.
 */
export function audioExtrasOffset(version) {
  if (version === 1) return 28 + 16;
  if (version === 2) return 28 + 36;
  return 28;
}

export async function isIsoBmff(blob) {
  try {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (head.length < 12) return false;
    const t = txt(head, 4);
    return t === 'ftyp' || t === 'styp' || t === 'moov' || t === 'skip' || t === 'free';
  } catch (_) { return false; }
}
