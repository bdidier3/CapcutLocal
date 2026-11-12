// Un fichier du disque lu PAR LE SERVEUR LOCAL, a son chemin.
//
// Le navigateur ne donne jamais le chemin d'un fichier, et pour relire plus
// tard un fichier glisse il exige une autorisation, fichier par fichier, a
// chaque reouverture. Le serveur local, lui, lit le disque directement : un
// projet qui garde des CHEMINS se rouvre instantanement, sans rien demander,
// et rien n'est jamais copie.
//
// Cet objet imite ce que le reste de l'application utilise d'un File : nom,
// taille, date, `slice(a, b).arrayBuffer()` (lectures par plages HTTP, comme
// un lecteur video) et `arrayBuffer()`. Pour une balise <audio> / <video>, on
// donne l'adresse du serveur (`urlDe`), qui gere les plages lui aussi.

const TK = (typeof window !== 'undefined' && window.__TK) || (typeof self !== 'undefined' && self.__TK) || '';

function mimeDe(nom) {
  const e = (nom.split('.').pop() || '').toLowerCase();
  return ({
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
  })[e] || '';
}

/** Morceau [debut, fin[ d'un fichier distant (ce que rend `slice`). */
class Morceau {
  constructor(source, debut, fin) { this.source = source; this.debut = debut; this.fin = fin; }
  get size() { return Math.max(0, this.fin - this.debut); }
  slice(a = 0, b = this.size) {
    const n = this.size;
    const A = Math.min(n, Math.max(0, a < 0 ? n + a : a));
    const B = Math.min(n, Math.max(A, b < 0 ? n + b : b));
    return new Morceau(this.source, this.debut + A, this.debut + B);
  }
  async arrayBuffer() {
    if (this.fin <= this.debut) return new ArrayBuffer(0);
    const r = await fetch(this.source.url, { headers: { Range: `bytes=${this.debut}-${this.fin - 1}` } });
    if (!r.ok) throw new Error('lecture impossible (' + r.status + ') : ' + this.source.name);
    return r.arrayBuffer();
  }
}

export class FichierDistant {
  /** @param {{chemin:string, name?:string, size:number, lastModified?:number, tk?:string}} o */
  constructor(o) {
    this.chemin = o.chemin;
    this.name = o.name || o.chemin.split(/[\\/]/).pop();
    this.size = o.size || 0;
    this.lastModified = o.lastModified || 0;
    this.type = mimeDe(this.name);
    this.tk = o.tk || TK;
    this.distant = true;
  }
  get url() { return `/media?tk=${this.tk}&p=${encodeURIComponent(this.chemin)}`; }
  slice(a, b) { return new Morceau(this, 0, this.size).slice(a, b); }
  arrayBuffer() { return new Morceau(this, 0, this.size).arrayBuffer(); }
  /** Le fichier entier en Blob (images, petits fichiers son). */
  async blob() {
    const r = await fetch(this.url);
    if (!r.ok) throw new Error('lecture impossible : ' + this.name);
    return r.blob();
  }
  /** Ce qu'un Worker recoit : de quoi reconstruire l'objet de l'autre cote. */
  toJSON() { return { chemin: this.chemin, name: this.name, size: this.size, lastModified: this.lastModified, tk: this.tk, distant: true }; }
}

/** Reconstruit un fichier distant recu par clonage (Worker). */
export function revivre(f) {
  return f && f.distant && !(f instanceof FichierDistant) && !(typeof Blob !== 'undefined' && f instanceof Blob)
    ? new FichierDistant(f) : f;
}

/** Adresse utilisable par une balise media, pour un File comme pour un fichier distant. */
export function urlDe(f) {
  return f && f.distant ? f.url : URL.createObjectURL(f);
}

/** Version Blob (pour createImageBitmap & co). */
export async function enBlob(f) {
  return f && f.distant ? f.blob() : f;
}
