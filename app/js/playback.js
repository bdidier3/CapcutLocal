// Moteur d'apercu : pool d'elements video, synchro A/V, boucle de rendu.
import { buildFrame, audioStateAt } from './compose.js';
import { sourceTime, mediaOf, projectDuration, activeAt } from './state.js';
import { ClipDecoder } from './decode.js';
import { Renderer } from './renderer.js';
import { clamp, Emitter } from './util.js';

const DRIFT_PLAY = 0.22;   // tolerance de derive en lecture (s)
const DRIFT_SEEK = 0.012;  // tolerance a l'arret
const POOL_MAX = 24;       // assez pour un montage a coupes rapides
// Combien de temps a l'avance on prepare un clip.
//
// Sur des sources legeres, preparer tot evite le temps d'arret au moment de la
// coupe. Sur des rushes 4K c'est l'inverse : amener un second decodeur a son
// point d'entree vole du temps a celui qui joue, et l'image en cours saccade.
// Mesure sur un montage 4K60 a coupes d'une demi-seconde : 57 images/s avec un
// delai court, 55 avec un delai long. On adapte donc a la source.
const LEAD_LEGER = 1.5;
const LEAD_LOURD = 0.35;

// Budget de decodage, en pixels d'image tenus simultanement.
//
// Un element video garde un decodeur ouvert tant qu'il vit. Le materiel n'en
// accepte qu'un nombre limite, et un rush iPhone en 4K coute quatre fois une
// source 1080p : compter les elements ne veut donc rien dire, il faut compter
// les pixels. Au-dela du budget, le navigateur bascule en decodage logiciel et
// abandonne la quasi-totalite des images — c'est ce qui donne un apercu en
// diaporama sur un montage a coupes rapides.
const BUDGET_PX = 26 * 1920 * 1080;

// Lancer un clip en avance lui fait decoder deux fois plus longtemps. Ca vaut
// le coup sur des sources legeres, ou le decodeur a de la marge ; sur du 4K
// c'est l'inverse — deux flux concurrents suffisent a tout faire tomber.
const ELAN_PX_MAX = 2304000;   // ~1080p

// Pixels que l'on s'autorise a preparer en avance, en plus du plan a l'image.
// Preparer un clip veut dire ouvrir son decodeur et l'amener a son point
// d'entree : c'est du travail reel, et en preparer quatre a la fois sur des
// rushes 4K revient a demander cinq decodages simultanes. On prepare donc
// toujours le prochain plan — celui qui compte — puis les suivants seulement
// s'il reste de la marge.
const PREP_PX = 4 * 1920 * 1080;

// Definition de la copie d'apercu : son cout de decodage remplace celui de
// l'original des qu'elle est en service.
const PX_APERCU = 1280 * 720;

/** Delai de preparation adapte au poids de ce qu'on va REELLEMENT decoder. */
function leadPour(px) {
  return px > ELAN_PX_MAX ? LEAD_LOURD : LEAD_LEGER;
}

export class Player extends Emitter {
  constructor(store, library, renderer) {
    super();
    this.store = store;
    this.lib = library;
    this.renderer = renderer;
    this.playing = false;
    this.loop = false;
    this.quality = 'auto';       // 'auto' | 1 | 0.5 | 0.25
    this.els = new Map();        // clipId -> {el, clipId, mediaId, lastUse, ready}
    this.bitmaps = new Map();    // mediaId -> ImageBitmap
    this.decs = new Map();       // clipId -> decodeur exact (apercu a l'arret)
    this.dirty = true;
    this.lastTick = 0;
    this.fpsMeter = { frames: 0, t0: 0, value: 0 };
    this._raf = 0;
    this._loopFn = this._tick.bind(this);
    this.audioOn = true;
    requestAnimationFrame(this._loopFn);
  }

  invalidate() { this.dirty = true; }

  // -------------------------------------------------------------- transport

  async play() {
    if (this.playing) return;
    const dur = projectDuration(this.store.project);
    if (this.store.playhead >= dur - 1e-3) this.store.seek(0);
    this.playing = true;
    this.lastTick = performance.now();
    this._wallLast = this.lastTick;
    this._clockEl = null;
    // Pre-chargement : on positionne les sources et on attend qu'elles puissent
    // vraiment jouer AVANT de lancer quoi que ce soit. Sinon, apres un retour en
    // arriere, l'image est deja la mais le son doit encore remplir son tampon :
    // on entend le son en retard.
    this._priming = performance.now();
    this.dirty = true;
    this.emit('playstate', true);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const e of this.els.values()) { try { e.el.pause(); } catch (_) {} }
    this.emit('playstate', false);
    this.dirty = true;
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    const jump = Math.abs(t - this.store.playhead) > 0.25;
    this.store.seek(t);
    this.dirty = true;
    // saut manuel pendant la lecture : on re-prepare les sources pour que le son
    // reprenne tout de suite au bon endroit
    if (this.playing && jump) { this._priming = performance.now(); this._clockEl = null; }
  }

  step(frames) {
    this.pause();
    this.seek(this.store.playhead + frames / this.store.project.fps);
  }

  setQuality(q) { this.quality = q; this.dirty = true; }

  // ---------------------------------------------------------- pool d'elements

  _elFor(clip, media) {
    let e = this.els.get(clip.id);
    if (e && e.mediaId !== media.id) { this._dispose(clip.id); e = null; }
    // L'element ne sert qu'au SON (l'image vient du decodeur exact) : une
    // source muette n'en a pas besoin, et en creer un ferait decoder sa video
    // pour rien.
    if (!media.hasAudio) {
      if (e) this._dispose(clip.id);
      return null;
    }
    if (!e) {
      // Piste son seule : l'element ne decode alors aucune image. Tant qu'elle
      // se prepare (quelques ms), on attend plutot que d'ouvrir l'original.
      const url = this.lib.urlSon ? this.lib.urlSon(media.id) : this.lib.url(media.id);
      if (!url) { this.dirty = true; return null; }
      const sonSeul = !!(this.lib.sonSeulPret && this.lib.sonSeulPret(media.id));
      // On libere de la place tant que le budget est depasse — un seul renvoi
      // ne suffit pas quand les sources sont lourdes. On n'evince JAMAIS un
      // element servant a l'image en cours : il serait recree aussitot, et
      // l'apercu clignoterait avec des plans qui n'ont rien a voir.
      // Une piste son seule ne coute aucun decodage d'image.
      const cout = sonSeul ? 0 : this._pxDe(media);
      for (let garde = 0; garde < POOL_MAX; garde++) {
        if (this.els.size < POOL_MAX && this._poidsPool() + cout <= BUDGET_PX) break;
        let oldest = null;
        for (const x of this.els.values()) {
          if (x.tick === this._tickId) continue;
          if (!oldest || x.lastUse < oldest.lastUse) oldest = x;
        }
        if (!oldest) break;
        this._dispose(oldest.clipId);
      }
      // <audio> et non <video> : on n'en veut que le son.
      const el = document.createElement('audio');
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.muted = false;
      el.volume = 0;
      el.style.cssText = 'position:absolute;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
      el.src = url;
      document.body.append(el);
      e = { el, clipId: clip.id, mediaId: media.id, lastUse: performance.now(), ready: false, pendingSeek: -1,
        px: cout, src: url, sonSeul };
      el.addEventListener('loadeddata', () => { e.ready = true; this.dirty = true; });
      // Piste son seule illisible (structure de fichier inattendue) : on
      // revient au fichier d'origine, l'element sera recree au tour suivant.
      el.addEventListener('error', () => {
        if (e.sonSeul && this.lib.oublierSon && this.lib.oublierSon(media.id)) {
          this._dispose(clip.id);
          this.dirty = true;
        }
      });
      el.addEventListener('seeked', () => { e.seekPending = false; this.dirty = true; });
      el.addEventListener('canplay', () => { this.dirty = true; });
      // Une image n'est utilisable qu'une fois REELLEMENT presentee : entre la fin
      // du seek et ce moment, l'element affiche encore l'image precedente. On se
      // fait donc reveiller a chaque nouvelle image pour redessiner aussitot.
      if ('requestVideoFrameCallback' in el) {
        const onFrame = (_now, meta) => {
          if (!this.els.has(clip.id)) return;
          e.framesSeen = (e.framesSeen || 0) + 1;
          // Instant de l'image REELLEMENT peinte. currentTime, lui, indique ou
          // l'on a demande d'aller : juste apres un saut il annonce deja la
          // cible alors que l'ecran montre encore l'image cle precedente.
          // Se fier a currentTime faisait afficher un plan a cote.
          if (meta && typeof meta.mediaTime === 'number') e.mediaTime = meta.mediaTime;
          this.dirty = true;
          e.rvfc = el.requestVideoFrameCallback(onFrame);
        };
        e.rvfc = el.requestVideoFrameCallback(onFrame);
      }
      this.els.set(clip.id, e);
    }
    e.lastUse = performance.now();
    e.tick = this._tickId;
    return e;
  }

  /**
   * Pixels reellement decodes pour ce media.
   *
   * Ce n'est pas forcement la definition du fichier : des qu'une copie allegee
   * est en service, c'est elle que le decodeur traite, et tous les budgets
   * doivent compter ce cout-la.
   */
  _pxDe(media) {
    if (!media) return 1920 * 1080;
    if (this.lib.apercus && this.lib.apercus.has(media.id)) return PX_APERCU;
    return (media.width || 1920) * (media.height || 1080);
  }

  /** Pixels d'image tenus par les elements vivants. */
  _poidsPool() {
    let n = 0;
    for (const x of this.els.values()) n += x.px || 1920 * 1080;
    return n;
  }

  _dispose(clipId) {
    const e = this.els.get(clipId);
    if (!e) return;
    this.els.delete(clipId);          // coupe la boucle rVFC
    try { if (e.rvfc && e.el.cancelVideoFrameCallback) e.el.cancelVideoFrameCallback(e.rvfc); } catch (_) {}
    try { e.el.pause(); e.el.removeAttribute('src'); e.el.load(); e.el.remove(); } catch (_) {}
    this.renderer.dropTexture(clipId);
  }

  disposeClip(clipId) { this._dispose(clipId); }

  disposeAll() {
    for (const d of this.decs.values()) {
      try { d.dec.close(); } catch (_) {}
    }
    this.decs.clear();
    for (const id of [...this.els.keys()]) this._dispose(id);
    for (const b of this.bitmaps.values()) b.close && b.close();
    this.bitmaps.clear();
  }

  async _bitmap(media) {
    if (this.bitmaps.has(media.id)) return this.bitmaps.get(media.id);
    const f = this.lib.file(media.id);
    if (!f) return null;
    this.bitmaps.set(media.id, null); // evite les demandes concurrentes
    try {
      const b = await createImageBitmap(f, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      this.bitmaps.set(media.id, b);
      this.dirty = true;
      return b;
    } catch (_) { return null; }
  }

  // ------------------------------------------------------------ taille rendu

  renderSize() {
    const p = this.store.project;
    let scale = this.quality;
    if (scale === 'auto') {
      const px = p.width * p.height;
      scale = px > 3840 * 2160 * 0.9 ? 0.5 : px > 1920 * 1080 * 1.1 ? 0.6666 : 1;
    }
    const w = Math.max(16, Math.round(p.width * scale / 2) * 2);
    const h = Math.max(16, Math.round(p.height * scale / 2) * 2);
    return [w, h];
  }

  // -------------------------------------------------------------------- boucle

  _tick(now) {
    this._raf = requestAnimationFrame(this._loopFn);
    const store = this.store;
    const dur = projectDuration(store.project);

    if (this.playing && this._priming) {
      // on tient la tete de lecture le temps que les sources soient pretes
      this._syncMedia();
      if (this._primed(now)) {
        this._priming = 0;
        this._wallLast = now;
        this._syncMedia();          // demarre toutes les sources ensemble
      }
      if (this.dirty) { this.dirty = false; this.render(); }
      return;
    }

    if (this.playing) {
      this.lastTick = now;
      let t = this._advance(now);
      if (t >= dur) {
        if (this.loop && dur > 0) { t = 0; this._clockEl = null; this._priming = now; }
        else { t = dur; this.pause(); }
      }
      store.seek(t);
      this.dirty = true;
    }

    this._syncMedia();
    if (!this.dirty) return;
    this.dirty = false;
    // L'image vient TOUJOURS du decodeur, a l'arret comme en lecture.
    //
    // Les elements video ne servent plus qu'au son. Sur un montage a plans
    // courts ils n'ont pas le temps de se placer : chacun n'affichait que sa
    // premiere image, et l'apercu ressemblait a un diaporama. Le decodeur, lui,
    // rend l'image que la timeline demande, quelle que soit la duree du plan.
    this.renderExact().catch(() => this.render());
    if (this.playing) this._preparerSuivants();

    // compteur d'images
    const m = this.fpsMeter;
    m.frames++;
    if (!m.t0) m.t0 = now;
    if (now - m.t0 > 500) {
      m.value = Math.round((m.frames * 1000) / (now - m.t0));
      m.frames = 0; m.t0 = now;
      this.emit('stats', { fps: m.value, ms: this.renderer.stats.ms, layers: this.renderer.stats.layers });
    }
  }

  /**
   * Les sources actives sont-elles pretes a jouer sans a-coup ?
   * readyState >= 3 (HAVE_FUTURE_DATA) veut dire que le decodeur a de quoi
   * enchainer — c'est la condition pour que le son sorte immediatement.
   */
  _primed(now) {
    if (!this._priming) return true;
    if (now - this._priming > 900) return true;      // securite : on n'attend pas indefiniment
    for (const id of this._visibleIds || []) {
      const e = this.els.get(id);
      if (!e) continue;
      if (e.seekPending || e.el.seeking) return false;   // repositionnement en cours
      if (e.el.readyState < 3) return false;             // pas assez de son/image en tampon
      if (e.wantTime !== undefined && Math.abs(e.el.currentTime - e.wantTime) > 0.06) return false;
    }
    return true;
  }

  /**
   * Avance la tete de lecture.
   *
   * Quand un SEUL clip video joue a vitesse normale, on prend l'horloge de son
   * element : l'image et le son viennent alors de la meme source, il n'y a plus
   * aucune derive possible entre les deux. Sinon on retombe sur l'horloge murale.
   */
  _advance(now) {
    const store = this.store;
    const p = store.project;
    const t = store.playhead;

    // clips video actifs a cet instant
    let only = null, count = 0;
    for (const track of p.tracks) {
      if (track.kind === 'audio') continue;
      for (const clip of track.clips) {
        if (t < clip.t0 || t >= clip.t0 + clip.dur) continue;
        if (clip.kind === 'text') continue;
        count++;
        only = clip;
      }
    }
    // temps mural ecoule depuis le tour precedent, quel que soit le chemin
    const dtMur = Math.min(0.25, (now - (this._wallLast || now)) / 1000);
    this._wallLast = now;
    const e = count === 1 && only ? this.els.get(only.id) : null;
    const usable = e && e.el.readyState >= 2 && !e.el.paused && !e.el.seeking
      && Math.abs((only.speed || 1) - 1) < 1e-6;

    if (usable) {
      // L'horloge d'un element ne bouge qu'a chaque image decodee — une fois
      // toutes les 16 ms pour du 60 i/s, alors que l'ecran demande une position
      // jusqu'a 144 fois par seconde. S'y caler telle quelle immobilise la tete
      // de lecture entre deux images, et un element qui vient d'etre lance la
      // fige carrement : c'est ce qui donnait un hoquet a CHAQUE coupe.
      //
      // On garde donc l'horloge du media comme reference — c'est elle qui
      // empeche l'image et le son de diverger — mais on prolonge entre deux
      // mises a jour avec l'horloge murale.
      const ct = e.el.currentTime;
      const rate = only.speed || 1;
      if (this._clockEl !== only.id) {
        this._clockEl = only.id;
        this._clockRef = null;
        this._clockSeen = ct;
      } else if (ct !== this._clockSeen) {
        this._clockSeen = ct;
        this._clockRef = { ct, at: now };
      }
      if (this._clockRef) {
        const depuis = Math.max(0, (now - this._clockRef.at) / 1000);
        // Au-dela de deux images sans nouvelle du decodeur, la reference n'est
        // plus fiable : on repasse a l'horloge murale plutot que d'inventer.
        if (depuis <= 2 / 30) {
          const tl = only.t0 + (this._clockRef.ct - only.in) + depuis * rate;
          // jamais en arriere : un retour de quelques images se voit a l'ecran.
          // Jamais de bond en avant non plus : juste apres une coupe, l'element
          // lance en avance peut deja etre un peu au-dela de son point
          // d'entree. S'y caler d'un coup sautait des images a CHAQUE coupe —
          // la lecture d'un montage a coupes rapides filait 4 a 8 % trop vite.
          // On rattrape donc en douceur (au plus 25 % plus vite que le temps).
          if (Math.abs(tl - t) < 0.5 && tl >= t - 1e-4) {
            return Math.min(tl, t + dtMur * 1.25 * rate + 0.001);
          }
        }
      }
    } else {
      this._clockEl = null;
      this._clockRef = null;
    }
    return t + dtMur;
  }

  /** Aligne les elements video et les volumes sur la tete de lecture. */
  _syncMedia() {
    this._tickId = (this._tickId || 0) + 1;
    const store = this.store;
    const t = store.playhead;
    const p = store.project;
    const audio = this.audioOn ? audioStateAt(p, t) : [];
    const gains = new Map(audio.map((a) => [a.clip.id, a.gain]));
    const activeIds = new Set();     // elements a garder en vie (image + elan)
    const visibleIds = new Set();    // clips reellement a l'image maintenant

    // Quels plans a venir prepare-t-on ? Les plus proches d'abord, dans la
    // limite du budget : sur du 4K cela revient au seul prochain plan, sur du
    // 1080p a quatre — exactement ce que la machine peut absorber.
    const prepares = new Set();
    const aVenir = [];
    for (const track of p.tracks) {
      for (const clip of track.clips) {
        if (clip.t0 <= t) continue;
        const m = mediaOf(p, clip);
        if (!m) continue;
        const lead = leadPour(this._pxDe(m));
        if (clip.t0 - t <= lead) aVenir.push(clip);
      }
    }
    aVenir.sort((a, b) => a.t0 - b.t0);
    let budget = 0;
    for (const clip of aVenir) {
      const m = mediaOf(p, clip);
      if (!m || m.kind === 'image' || clip.kind === 'text') continue;
      const px = (m.width || 1920) * (m.height || 1080);
      if (prepares.size && budget + px > PREP_PX) break;
      budget += px;
      prepares.add(clip.id);
    }

    for (const track of p.tracks) {
      for (const clip of track.clips) {
        // On prepare un clip avant son entree : creer l'element, le charger et
        // le positionner prend du temps, et si ce travail tombe pile sur la
        // coupe, l'apercu marque un temps d'arret. Mais seulement ceux que le
        // budget autorise — sinon la preparation coute plus qu'elle ne rapporte.
        if (t >= clip.t0 + clip.dur) continue;
        if (t < clip.t0 && !prepares.has(clip.id)) continue;
        const media = mediaOf(p, clip);
        if (!media || media.kind === 'image' || clip.kind === 'text') continue;
        const visible = !track.hidden && t >= clip.t0 && t < clip.t0 + clip.dur;
        const e = this._elFor(clip, media);
        if (!e) continue;
        activeIds.add(clip.id);
        if (visible) visibleIds.add(clip.id);
        const rate = clamp(clip.speed || 1, 0.0625, 16);
        // Elan : tant que le clip n'est pas entre, on le fait tourner en avance
        // sur la matiere qui precede son point d'entree, muet. Quand la coupe
        // arrive, son decodeur est deja lance et l'image tombe au bon moment.
        const avance = clip.t0 - t;
        const lourd = !e.sonSeul && this._pxDe(media) > ELAN_PX_MAX;
        const elan = !visible && this.playing && !this._priming && avance > 0
          && !lourd && clip.in >= avance * rate + 0.05;
        // pre-chargement : on ne demande jamais un temps AVANT le point d'entree
        const local = Math.max(0, t - clip.t0);
        const want = elan
          ? clamp(clip.in - avance * rate, 0, Math.max(0, (media.duration || 0) - 0.001))
          : clamp(sourceTime(clip, local), 0, Math.max(0, (media.duration || 0) - 0.001));
        e.wantTime = want;
        const el = e.el;
        const g = gains.get(clip.id) ?? 0;
        el.volume = clamp(g, 0, 1);
        el.muted = !this.audioOn || g <= 0.0005;
        // pendant le pre-chargement on positionne mais on ne lance pas encore :
        // ainsi image et son demarrent exactement ensemble
        if (this.playing && (visible || elan) && !this._priming) {
          if (el.playbackRate !== rate) el.playbackRate = rate;
          if (el.paused && e.ready) el.play().catch(() => {});
          if (el.readyState >= 2 && Math.abs(el.currentTime - want) > DRIFT_PLAY) {
            e.seekPending = true; e.mediaTime = undefined; el.currentTime = want;
          }
        } else {
          if (!el.paused) el.pause();
          if (el.readyState >= 1 && Math.abs(el.currentTime - want) > DRIFT_SEEK && !el.seeking) {
            e.seekPending = true; e.mediaTime = undefined; el.currentTime = want;
          }
        }
      }
    }

    this._activeIds = activeIds;
    // Au demarrage on n'attend que les clips a l'image : faire patienter le
    // lecteur pour un clip qui n'entre que dans une seconde retarderait tout.
    this._visibleIds = visibleIds;

    // Ce qui n'est plus actif doit etre COMPLETEMENT silencieux : pause seule ne
    // suffit pas, un play() encore en vol pourrait le relancer a plein volume.
    for (const [clipId, e] of this.els) {
      if (activeIds.has(clipId)) continue;
      if (!e.el.paused) e.el.pause();
      if (!e.el.muted) e.el.muted = true;
      if (e.el.volume !== 0) e.el.volume = 0;
      if (performance.now() - e.lastUse > 20000) this._dispose(clipId);
    }
  }

  /** Fournisseur de sources pour compose(). */
  _source = (clip, media, srcTime) => {
    if (media.kind === 'image') {
      const b = this.bitmaps.get(media.id);
      if (b === undefined) { this._bitmap(media); return null; }
      if (!b) return null;
      return { src: b, w: b.width, h: b.height, id: 'img:' + media.id };
    }
    const e = this.els.get(clip.id);
    if (!e || !e.el.videoWidth) { this._attente = true; return null; }

    // Est-on sur la BONNE image ?
    //
    // Comparer des durees ne suffit pas : l'ancienne tolerance laissait passer
    // une image et demie d'ecart, si bien qu'un plan court pouvait montrer
    // l'image d'avant — l'apercu ne correspondait alors pas au montage. On
    // compare donc des numeros d'image, ce qui est la question reellement
    // posee : l'element affiche-t-il l'image que la timeline demande ?
    const fps = media.fps > 0 ? media.fps : 30;
    const voulu = Math.floor(srcTime * fps + 1e-6);
    // On se fie a l'image peinte quand le navigateur sait nous la donner.
    const vu = e.mediaTime !== undefined ? e.mediaTime : e.el.currentTime;
    // L'instant d'une image est un multiple de la cadence, a l'erreur de calcul
    // pres : on arrondit, alors que pour l'instant DEMANDE on prend l'image qui
    // le contient. Tronquer les deux ferait rater une image sur deux a cause
    // d'un millioniemme de seconde.
    const affiche = Math.round(vu * fps);
    const exact = voulu === affiche;

    if (!this.playing) {
      // A l'arret, mieux vaut ne rien montrer qu'un plan qui n'est pas celui
      // demande : l'utilisateur cale ses coupes sur ce qu'il voit.
      if (!exact) { this._attente = true; return null; }
      return { src: e.el, w: e.el.videoWidth, h: e.el.videoHeight, id: clip.id, stale: false };
    }

    // En LECTURE, c'est l'element qui donne le tempo : ce qu'il affiche est,
    // par construction, l'image du moment. Exiger la coincidence exacte n'a pas
    // de sens ici — l'ecran et le decodeur ne battent pas ensemble, et l'ecart
    // d'une image est permanent. L'exiger quand meme faisait declarer l'image
    // « perimee » a chaque tour : le rendu gardait alors la texture precedente
    // et le plan restait bloque sur sa premiere image.
    //
    // On ne signale « perime » que si l'element est REELLEMENT ailleurs : un
    // saut en cours, ou un plan qui n'a pas encore rejoint sa position.
    const ecart = Math.abs(affiche - voulu);
    return {
      src: e.el, w: e.el.videoWidth, h: e.el.videoHeight, id: clip.id,
      stale: ecart > 3 || e.el.seeking,
    };
  };

  /** Lit le contenu du canvas WebGL dans un canvas 2D (retourne verticalement). */
  _readToCanvas(maxW) {
    const gl = this.renderer.gl;
    const w = this.renderer.w, h = this.renderer.h;
    if (!w || !h) return null;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const full = document.createElement('canvas');
    full.width = w; full.height = h;
    const id = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      id.data.set(px.subarray(src, src + w * 4), y * w * 4);
    }
    for (let i = 3; i < id.data.length; i += 4) id.data[i] = 255;
    full.getContext('2d').putImageData(id, 0, 0);
    if (!maxW || maxW >= w) return full;
    const out = document.createElement('canvas');
    out.width = maxW;
    out.height = Math.max(1, Math.round((maxW * h) / w));
    out.getContext('2d').drawImage(full, 0, 0, out.width, out.height);
    return out;
  }

  /** Vignette du projet (data URL JPEG) prise a un moment representatif. */
  /**
   * Vignette du projet, rendue A COTE de l'apercu.
   *
   * L'ancienne version deplacait la tete de lecture vers l'image voulue, puis
   * la remettait en place. Appelee par l'enregistrement automatique — quelques
   * secondes apres chaque modification, y compris apres un import — elle
   * faisait sauter l'apercu en pleine lecture : un aller-retour d'une seconde,
   * avec re-decodage d'une GOP au retour. On la fabrique desormais sur un
   * canvas a part, avec ses propres decodeurs, sans toucher a la tete.
   */
  async thumbnail(maxW = 320) {
    const p = this.store.project;
    const dur = projectDuration(p);
    if (!dur) return null;
    // en lecture, on ne vole pas le decodeur : l'appelant garde l'ancienne
    if (this.playing) return null;
    const t = Math.min(dur * 0.25, Math.max(0.1, dur - 0.05));
    const w = Math.max(2, Math.round(maxW / 2) * 2);
    const h = Math.max(2, Math.round((maxW * (p.height || 1080)) / (p.width || 1920) / 2) * 2);
    if (!this._vignette) this._vignette = new Renderer(new OffscreenCanvas(w, h), { preserve: true });
    const r = this._vignette;
    r.setSize(w, h);
    const decs = [];
    const sources = new Map();
    try {
      for (const a of activeAt(p, t)) {
        if (a.track.kind === 'audio' || a.clip.kind === 'audio' || a.clip.kind === 'text') continue;
        const media = mediaOf(p, a.clip);
        if (!media || !media.hasVideo) continue;
        try {
          const dec = new ClipDecoder(await this._libExacte(media), media, a.clip,
            { wantFps: p.fps, exact: true });
          decs.push(dec);
          await dec.init();
          const got = await dec.frameAt(sourceTime(a.clip, a.tLocal));
          if (got) sources.set(a.clip.id, got);
        } catch (_) { /* couche absente de la vignette, rien de grave */ }
      }
      const frame = buildFrame(p, t, (clip) => sources.get(clip.id) || null, w, h);
      for (const L of frame.layers) {
        const e = r.upload(L.texId, L.source, L.srcW, L.srcH);
        L.tex = e ? e.tex : null;
      }
      r.render(frame, true);
      const blob = await r.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
      return await new Promise((ok) => {
        const fr = new FileReader();
        fr.onload = () => ok(fr.result);
        fr.onerror = () => ok(null);
        fr.readAsDataURL(blob);
      });
    } finally {
      for (const g of sources.values()) if (g && g.owned && g.src) { try { g.src.close(); } catch (_) {} }
      for (const d of decs) { try { d.close(); } catch (_) {} }
    }
  }

  /** Capture PNG de l'image courante, a la taille demandee (image figee). */
  async snapshotBlob(w, h) {
    // L'image vient du decodeur exact (les elements media ne portent que le son).
    for (let i = 0; i < 400 && this._exactEnCours; i++) await new Promise((r) => setTimeout(r, 5));
    await this.renderExact();
    const cv = this._readToCanvas(0);
    if (!cv) return null;
    let src = cv;
    if (w && h && (cv.width !== w || cv.height !== h)) {
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      out.getContext('2d').drawImage(cv, 0, 0, w, h);
      src = out;
    }
    return new Promise((res) => src.toBlob(res, 'image/png'));
  }

  /**
   * Rendu EXACT, utilise a l'arret et au deplacement de la tete de lecture.
   *
   * Un element video ne sait pas se poser sur une image precise : apres un saut
   * il annonce la position demandee alors qu'il montre encore l'image cle qui
   * precede. Pour caler une coupe, c'est inutilisable. On passe donc par le
   * meme decodeur que l'export — celui qui rend l'image dont le numero est
   * demande, et rien d'autre. Tant qu'elle n'est pas la, on n'affiche rien
   * plutot qu'un plan qui n'est pas celui du montage.
   */
  async renderExact() {
    // Un seul rendu a la fois. Si la tete bouge pendant ce temps, on se
    // contente de redemander un rendu : le tour suivant s'en chargera. Une
    // boucle de reprise interne, elle, ne se terminait jamais en lecture — la
    // tete bouge a chaque image — et privait l'ecran de rafraichissement.
    if (this._exactEnCours) { this.dirty = true; return null; }
    this._exactEnCours = true;
    try {
      {
        const p = this.store.project;
        // On se cale sur la grille d'images du projet, exactement comme
        // l'export. Interroger entre deux images renverrait parfois la
        // precedente : l'apercu et le fichier final ne montreraient alors pas
        // la meme chose, ce qui est precisement ce qu'on veut eviter.
        const fpsProjet = p.fps > 0 ? p.fps : 30;
        const t = Math.floor(this.store.playhead * fpsProjet + 1e-6) / fpsProjet;
        const [w, h] = this.renderSize();
        this.renderer.setSize(w, h);

        const sources = new Map();
        let attente = false;
        for (const a of activeAt(p, t)) {
          if (a.track.kind === 'audio' || a.clip.kind === 'audio' || a.clip.kind === 'text') continue;
          const media = mediaOf(p, a.clip);
          if (!media || !media.hasVideo) continue;
          try {
            const d = await this._entreeDe(a.clip, media);
            if (!d) { attente = true; continue; }
            const got = await this._frameDe(d, sourceTime(a.clip, a.tLocal));
            // On ne garde AUCUNE image en reserve ici : chaque image retenue
            // occupe un tampon de decodage, et le decodeur materiel s'arrete
            // net quand ils manquent. Si l'image n'est pas prete, on l'attend.
            if (got) {
              const avant = sources.get(a.clip.id);
              if (avant && avant.owned && avant.src) { try { avant.src.close(); } catch (_) {} }
              sources.set(a.clip.id, got);
            } else attente = true;
          } catch (_) { attente = true; }
        }

        let frame;
        try {
          frame = buildFrame(p, t, (clip) => sources.get(clip.id) || null, w, h);
          for (const L of frame.layers) {
            // On televerse toujours : « meme image » ne garantit pas que la
            // texture en reserve corresponde a ce qu'on veut montrer.
            const e = this.renderer.upload(L.texId, L.source, L.srcW, L.srcH);
            L.tex = e ? e.tex : null;
          }
          this.renderer.render(frame, true);
        } finally {
          // Une image non liberee immobilise un tampon du decodeur, et le
          // decodeur finit par s'arreter. On les rend donc quoi qu'il arrive,
          // y compris si le rendu a echoue.
          for (const g of sources.values()) {
            if (g && g.owned && g.src) { try { g.src.close(); } catch (_) {} }
          }
          sources.clear();
        }

        if (attente !== this._attenteVue) { this._attenteVue = attente; this.emit('attente', attente); }
        this.emit('rendered', frame);
        return frame;
      }
    } finally {
      this._exactEnCours = false;
    }
  }

  /**
   * Bibliotheque vue par le decodeur exact.
   *
   * Quand une copie d'apercu existe, on la lui donne a la place de l'original :
   * les instants des images y sont identiques, mais reculer d'une image y coute
   * quelques millisecondes au lieu de plusieurs secondes sur un rush 4K. Si la
   * copie manque, on retombe sur l'original — plus lent, jamais faux.
   */
  async _libExacte(media) {
    if (!this.lib.apercus || !this.lib.apercus.has(media.id)) return this.lib;
    if (!this._libsExactes) this._libsExactes = new Map();
    const dejaLa = this._libsExactes.get(media.id);
    if (dejaLa) return dejaLa;
    const f = await this.lib.blobApercu(media.id).catch(() => null);
    const m = f ? await this.lib.mp4Apercu(media.id).catch(() => null) : null;
    if (!f || !m) return this.lib;
    const url = this.lib.apercus.get(media.id);
    const vue = {
      files: new Map([[media.id, f]]),
      file: (id) => (id === media.id ? f : this.lib.file(id)),
      url: (id) => (id === media.id ? url : this.lib.url(id)),
      mp4Of: async (id) => (id === media.id ? m : this.lib.mp4Of(id)),
    };
    this._libsExactes.set(media.id, vue);
    return vue;
  }

  /**
   * Une image du decodeur exact, une demande a la fois.
   *
   * Un decodeur n'est pas reentrant : deux demandes simultanees se
   * marcheraient dessus (sauts croises, images fermees sous les pieds). Or la
   * preparation du plan suivant et le rendu peuvent viser le meme decodeur :
   * on les met donc en file.
   */
  _frameDe(d, t) {
    const p = (d.file || Promise.resolve()).then(() => d.dec.frameAt(t));
    d.file = p.then(() => {}, () => {});
    return p;
  }

  /**
   * Prepare les plans qui arrivent : decodeur ouvert, cale sur son point
   * d'entree, AVANT la coupe.
   *
   * Sans ca, chaque coupe paie au moment ou elle s'affiche l'ouverture d'un
   * decodeur et le decodage de toute la GOP qui precede le point d'entree :
   * jusqu'a un quart de seconde d'image figee sur un rush 4K (mesure sur un
   * montage a coupes d'une demi-seconde). Le decodeur a largement de quoi
   * faire les deux : un flux 4K 60 n'occupe qu'une fraction de son debit.
   */
  _preparerSuivants() {
    const p = this.store.project;
    const t = this.store.playhead;
    const LEAD = 1.2;
    if (!this._prepares) this._prepares = new Map();     // clipId -> point d'entree prepare
    let n = 0;
    const aVenir = [];
    for (const track of p.tracks) {
      if (track.kind === 'audio' || track.hidden) continue;
      for (const clip of track.clips) {
        if (clip.kind === 'text' || clip.kind === 'audio') continue;
        const avance = clip.t0 - t;
        if (avance > 0 && avance <= LEAD) aVenir.push(clip);
      }
    }
    aVenir.sort((a, b) => a.t0 - b.t0);
    for (const clip of aVenir) {
      if (n >= 2) break;                       // le plan suivant, et celui d'apres
      const media = mediaOf(p, clip);
      if (!media || !media.hasVideo || media.kind === 'image') continue;
      n++;
      const cle = clip.in + '|' + (clip.speed || 1) + '|' + media.id;
      if (this._prepares.get(clip.id) === cle) continue;
      this._prepares.set(clip.id, cle);
      (async () => {
        const d = await this._entreeDe(clip, media);
        if (!d) return;
        const got = await this._frameDe(d, sourceTime(clip, 0));
        if (got && got.owned && got.src) { try { got.src.close(); } catch (_) {} }
      })().catch(() => { this._prepares.delete(clip.id); });
    }
  }

  /** Decodeur exact d'un clip, cree a la demande et garde en reserve. */
  async _entreeDe(clip, media) {
    let d = this.decs.get(clip.id);
    if (d && (d.mediaId !== media.id || d.clipIn !== clip.in || d.speed !== (clip.speed || 1))) {
      try { d.dec.close(); } catch (_) {}
      this.decs.delete(clip.id);
      d = null;
    }
    if (!d) {
      // On borne la reserve : chaque decodeur garde des images en memoire.
      if (this.decs.size >= 6) {
        let vieux = null;
        for (const [id, x] of this.decs) if (!vieux || x.vu < vieux[1].vu) vieux = [id, x];
        if (vieux) {
          try { vieux[1].dec.close(); } catch (_) {}
          this.decs.delete(vieux[0]);
        }
      }
      // L'entree est inscrite AVANT toute attente : la preparation du plan
      // suivant et le rendu peuvent demander le meme clip au meme moment, et
      // chacun creerait sinon son propre decodeur.
      d = { dec: null, mediaId: media.id, clipIn: clip.in, speed: clip.speed || 1, vu: 0 };
      this.decs.set(clip.id, d);
      const entree = d;
      d.pret = (async () => {
        // « exact » : l'apercu doit rendre l'image demandee, meme en reculant.
        const source = await this._libExacte(media);
        const dec = new ClipDecoder(source, media, clip,
          { wantFps: this.store.project.fps, exact: true });
        entree.dec = dec;
        await dec.init();
        // evince pendant sa preparation : personne ne le fermera, on le fait
        if (this.decs.get(clip.id) !== entree) { try { dec.close(); } catch (_) {} entree.dec = null; }
      })();
      d.pret.catch(() => { if (this.decs.get(clip.id) === entree) this.decs.delete(clip.id); });
    }
    await d.pret;
    if (!d.dec) return null;
    d.vu = performance.now();
    return d;
  }

  render() {
    this._attente = false;
    const [w, h] = this.renderSize();
    this.renderer.setSize(w, h);
    const frame = buildFrame(this.store.project, this.store.playhead, this._source, w, h);
    // televerse les textures ; une source perimee conserve son image precedente
    for (const L of frame.layers) {
      const e = L.stale
        ? (this.renderer.cached(L.texId) || this.renderer.upload(L.texId, L.source, L.srcW, L.srcH))
        : this.renderer.upload(L.texId, L.source, L.srcW, L.srcH);
      L.tex = e ? e.tex : null;
    }
    this.renderer.render(frame, true);
    // « en attente » : au moins une source n'est pas encore sur la bonne image.
    // L'interface peut alors montrer un chargement plutot qu'un ecran vide.
    if (this._attente !== this._attenteVue) {
      this._attenteVue = this._attente;
      this.emit('attente', this._attente);
    }
    this.emit('rendered', frame);
    return frame;
  }
}
