// Prechauffage : lire d'avance, a l'arret, les passages des rushes qu'utilise
// la timeline.
//
// Sur un disque dur externe, la lecture est le goulot : mesure sur un disque
// USB, 10 Mo/s en continu, quand un seul rush iPhone 4K 60 HEVC en consomme 6 a
// 11. Trois couches superposees ne peuvent tout simplement pas se lire en temps
// reel la premiere fois. La deuxieme fois, si : Windows garde en memoire vive
// ce qui a deja ete lu (mesure : 10 rendus/s a froid, 165 une fois en cache).
//
// On profite donc des moments ou l'on monte sans lire — couper, deplacer,
// regler — pour lire EXACTEMENT les octets dont l'apercu aura besoin, en
// commencant par ce qui est pres de la tete de lecture. Rien n'est ecrit sur le
// disque : c'est le cache de fichiers du systeme qui les garde. Et tout
// s'arrete des que la lecture demarre, pour ne pas lui disputer le disque.

// 2 Mo : la lecture reste continue (le systeme lit d'avance de lui-meme), et
// le disque est rendu a l'apercu en ~0,2 s des que l'on agit, au lieu de
// ~0,8 s pour un bloc de 8 Mo sur un disque a 10 Mo/s.
const BLOC = 2 * 1024 * 1024;
const MARGE_IMAGES = 30;          // un peu au-dela du point de sortie
const PLAFOND = 2 * 1024 * 1024 * 1024;  // par passe : le cache de Windows tient en memoire vive

export class Prechauffe {
  constructor(store, lib, player) {
    this.store = store;
    this.lib = lib;
    this.player = player;
    this.lus = new Map();         // mediaId -> [[debut, fin], ...] deja lus (fusionnes)
    this.enCours = false;
    this.relancer = false;
    this.etat = { fait: 0, total: 0 };
    this.surEtat = null;
  }

  /** A appeler apres toute modification : la passe repart du debut. */
  demander() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this._passe(), 400);
  }

  /** Lecture en cours, ou l'utilisateur vient d'agir : on laisse le disque a l'apercu. */
  _occupe() {
    return this.player.playing || performance.now() - (this.player.derniereAction || 0) < 350;
  }

  async _attendreLibre() {
    while (this._occupe()) await new Promise((r) => setTimeout(r, 250));
  }

  /** Plages d'octets utiles, du plus proche de la tete de lecture au plus loin. */
  async _plages() {
    const p = this.store.project;
    const t = this.store.playhead;
    const clips = [];
    for (const track of p.tracks) {
      if (track.kind === 'audio' || track.hidden) continue;
      for (const clip of track.clips) {
        if (clip.kind !== 'video') continue;
        const fin = clip.t0 + clip.dur;
        // devant la tete d'abord, puis ce qui est derriere
        const rang = fin < t ? 1e6 + (t - fin) : Math.max(0, clip.t0 - t);
        clips.push({ clip, rang });
      }
    }
    clips.sort((a, b) => a.rang - b.rang);
    const out = [];
    for (const { clip } of clips) {
      const media = p.media.find((m) => m.id === clip.mediaId);
      if (!media || !media.hasVideo || !this.lib.files.has(media.id)) continue;
      if (this.lib.apercus && this.lib.apercus.has(media.id)) continue;   // copie legere sur le disque C
      const mp4 = await this.lib.mp4Of(media.id).catch(() => null);
      const tr = mp4 && mp4.videoTrack;
      if (!tr || !tr.samples.length) continue;
      const off = tr.tOffset || 0;
      const a = Math.max(0, (clip.in || 0) - off);
      const b = Math.max(a, (clip.in || 0) + clip.dur * (clip.speed || 1) - off);
      let ia = mp4.keyBefore(tr, mp4.indexAt(tr, a));
      // meme prudence que le decodeur : une cle affichee apres le debut ne suffit pas
      const demi = tr.timescale / Math.max(1, (tr.fps || 30) * 2);
      while (ia > 0 && tr.samples[ia].cts > a * tr.timescale + demi) ia = mp4.keyBefore(tr, ia - 1);
      const ib = Math.min(tr.samples.length - 1, mp4.indexAt(tr, b) + MARGE_IMAGES);
      let deb = Infinity, fin = 0;
      for (let i = ia; i <= ib; i++) {
        const s = tr.samples[i];
        if (s.offset < deb) deb = s.offset;
        if (s.offset + s.size > fin) fin = s.offset + s.size;
      }
      if (fin > deb) out.push({ media, deb, fin });
    }
    return out;
  }

  /** Morceaux de [deb, fin] pas encore lus. */
  _manque(mediaId, deb, fin) {
    const lus = this.lus.get(mediaId) || [];
    const out = [];
    let x = deb;
    for (const [a, b] of lus) {
      if (b <= x) continue;
      if (a >= fin) break;
      if (a > x) out.push([x, Math.min(a, fin)]);
      x = Math.max(x, b);
      if (x >= fin) break;
    }
    if (x < fin) out.push([x, fin]);
    return out;
  }

  _noter(mediaId, a, b) {
    const lus = (this.lus.get(mediaId) || []).concat([[a, b]]).sort((x, y) => x[0] - y[0]);
    const fusion = [];
    for (const r of lus) {
      const d = fusion[fusion.length - 1];
      if (d && r[0] <= d[1]) d[1] = Math.max(d[1], r[1]); else fusion.push([r[0], r[1]]);
    }
    this.lus.set(mediaId, fusion);
  }

  async _passe() {
    if (this.enCours) { this.relancer = true; return; }
    this.enCours = true;
    try {
      do {
        this.relancer = false;
        const plages = await this._plages();
        const travail = [];
        for (const pl of plages) for (const [a, b] of this._manque(pl.media.id, pl.deb, pl.fin)) travail.push({ media: pl.media, a, b });
        let total = travail.reduce((n, w) => n + (w.b - w.a), 0);
        total = Math.min(total, PLAFOND);
        let fait = 0;
        this._annoncer(fait, total);
        for (const w of travail) {
          for (let x = w.a; x < w.b && fait < PLAFOND; x += BLOC) {
            if (this.relancer) break;                       // la timeline a change : on recalcule
            await this._attendreLibre();
            const f = this.lib.files.get(w.media.id);
            if (!f) break;
            const y = Math.min(w.b, x + BLOC);
            try { await f.slice(x, y).arrayBuffer(); } catch (_) { break; }
            this._noter(w.media.id, x, y);
            fait += y - x;
            this._annoncer(fait, total);
          }
          if (this.relancer) break;
        }
        this._annoncer(total, total);
      } while (this.relancer);
    } finally {
      this.enCours = false;
    }
  }

  _annoncer(fait, total) {
    this.etat = { fait, total };
    if (this.surEtat) this.surEtat(this.etat);
  }

  /** Un fichier rebranche ou retire : ce qu'on en savait ne vaut plus. */
  oublier(mediaId) { this.lus.delete(mediaId); }
}
