// Piste son seule d'une video MP4/MOV, sans copie ni re-encodage.
//
// L'apercu tire son SON d'un element media. Pointe sur la video d'origine, cet
// element decode aussi l'IMAGE — meme un <audio> : mesure sur une source 4K 60,
// le decodeur de l'apercu perd un quart de son debit des qu'un tel element
// joue, et davantage avec plusieurs clips. Or l'image de l'apercu vient deja de
// WebCodecs : ce second decodage ne sert a rien.
//
// On fabrique donc un fichier VIRTUEL qui ne declare que la piste son :
//
//   [ftyp d'origine][moov : mvhd + trak son][mdat { fichier d'origine entier }]
//
// Le fichier d'origine est reference tel quel dans un Blob — aucun octet n'est
// copie, le navigateur le relit sur le disque au besoin. Seule la table des
// positions (stco / co64) est decalee de la taille de l'en-tete ajoute. La piste
// son est reprise a l'identique, liste d'edition comprise : le son sort donc
// exactement au meme instant qu'avec la video d'origine.

const txt = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
const MAX_MOOV = 64 * 1024 * 1024;

/** Enfants d'une boite : [{type, start, end, hlen}] (positions dans `u8`). */
function enfants(u8, from, to) {
  const out = [];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = from;
  while (p + 8 <= to) {
    let size = dv.getUint32(p);
    const type = txt(u8, p + 4);
    let hlen = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hlen = 16; }
    else if (size === 0) size = to - p;
    if (size < hlen || p + size > to) break;
    out.push({ type, start: p, end: p + size, hlen });
    p += size;
  }
  return out;
}

const trouver = (u8, parent, type) => enfants(u8, parent.start + parent.hlen, parent.end).find((b) => b.type === type) || null;

function boite(type, ...parts) {
  const n = 8 + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  new DataView(out.buffer).setUint32(0, n);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * @param {Blob} file  video MP4 / MOV d'origine
 * @returns {Promise<Blob|null>} null si le fichier ne s'y prete pas (fragmente,
 *   sans son, structure inattendue) : l'appelant garde alors l'original.
 */
export async function sonSeul(file) {
  const size = file.size;
  // boites de premier niveau
  let ftyp = null, moov = null, fragmente = false;
  let pos = 0, garde = 0;
  while (pos + 8 <= size && garde++ < 100000) {
    const h = new Uint8Array(await file.slice(pos, pos + 16).arrayBuffer());
    if (h.length < 8) break;
    const dv = new DataView(h.buffer);
    let bs = dv.getUint32(0);
    const type = txt(h, 4);
    let hlen = 8;
    if (bs === 1) { if (h.length < 16) break; bs = Number(dv.getBigUint64(8)); hlen = 16; }
    else if (bs === 0) bs = size - pos;
    if (bs < hlen) break;
    if (type === 'ftyp' && !ftyp && bs < 4096) ftyp = new Uint8Array(await file.slice(pos, pos + bs).arrayBuffer());
    else if (type === 'moov' && !moov) {
      if (bs > MAX_MOOV) return null;
      moov = new Uint8Array(await file.slice(pos, pos + bs).arrayBuffer());
    } else if (type === 'moof') { fragmente = true; break; }
    pos += bs;
  }
  if (!moov || fragmente) return null;

  const racine = { start: 0, end: moov.length, hlen: enfants(moov, 0, moov.length)[0]?.hlen || 8 };
  const top = enfants(moov, racine.hlen, moov.length);
  const mvhd = top.find((b) => b.type === 'mvhd');
  if (!mvhd || top.some((b) => b.type === 'mvex')) return null;

  // premiere piste dont le gestionnaire est « soun »
  let son = null;
  for (const t of top) {
    if (t.type !== 'trak') continue;
    const mdia = trouver(moov, t, 'mdia');
    const hdlr = mdia && trouver(moov, mdia, 'hdlr');
    // hdlr : version/flags (4) + pre_defined (4) + handler_type (4)
    if (hdlr && txt(moov, hdlr.start + hdlr.hlen + 8) === 'soun') { son = t; break; }
  }
  if (!son) return null;

  // Copie de la piste, sans « tref » : elle peut designer des pistes absentes
  // du fichier virtuel (chapitres, code temporel).
  const parts = enfants(moov, son.start + son.hlen, son.end)
    .filter((b) => b.type !== 'tref')
    .map((b) => moov.slice(b.start, b.end));
  let trak = boite('trak', ...parts);

  // table des positions dans la copie
  const tMdia = trouver(trak, { start: 0, end: trak.length, hlen: 8 }, 'mdia');
  const tMinf = tMdia && trouver(trak, tMdia, 'minf');
  const tStbl = tMinf && trouver(trak, tMinf, 'stbl');
  if (!tStbl) return null;
  const stco = trouver(trak, tStbl, 'stco');
  const co64 = trouver(trak, tStbl, 'co64');
  if (!stco && !co64) return null;

  const nvMoov = boite('moov', moov.slice(mvhd.start, mvhd.end), trak);
  const enTeteMdat = new Uint8Array(16);
  const dvM = new DataView(enTeteMdat.buffer);
  dvM.setUint32(0, 1);
  enTeteMdat.set([0x6d, 0x64, 0x61, 0x74], 4);          // 'mdat'
  dvM.setBigUint64(8, BigInt(16 + size));
  const decalage = (ftyp ? ftyp.length : 0) + nvMoov.length + 16;

  // nvMoov contient une copie de `trak` : on corrige les positions dans cette
  // copie-la (le decalage de la piste dans nvMoov est fixe : 8 + taille mvhd).
  const base = 8 + (mvhd.end - mvhd.start);
  const dv = new DataView(nvMoov.buffer);
  const tbl = stco || co64;
  const p0 = base + tbl.start + tbl.hlen;
  const n = dv.getUint32(p0 + 4);
  if (p0 + 8 + n * (stco ? 4 : 8) > nvMoov.length) return null;
  for (let i = 0; i < n; i++) {
    if (stco) {
      const v = dv.getUint32(p0 + 8 + i * 4) + decalage;
      if (v > 0xffffffff) return null;        // ne tient plus sur 32 bits : on renonce
      dv.setUint32(p0 + 8 + i * 4, v);
    } else {
      const o = p0 + 8 + i * 8;
      dv.setBigUint64(o, dv.getBigUint64(o) + BigInt(decalage));
    }
  }
  const morceaux = ftyp ? [ftyp, nvMoov, enTeteMdat, file] : [nvMoov, enTeteMdat, file];
  return new Blob(morceaux, { type: 'audio/mp4' });
}
