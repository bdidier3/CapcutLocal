// Decodage source pour l'export : images exactes via WebCodecs (chemin rapide)
// avec repli sur l'element <video> pour les conteneurs non geres.
import { once, clamp } from './util.js';
import { blobReader } from './mp4demux.js';

const BATCH = 8;
const MAX_QUEUE = 16;
// Images retenues d'avance. A garder BAS : un decodeur materiel n'a qu'une
// poignee de tampons de sortie, et il se bloque des qu'on les monopolise. Le
// budget est en PIXELS, pas en images : six images de 1080p passent, six images
// de 4K epuisent le pool et chaque image suivante coute alors des secondes.
const FIRST_FRAME_MS = 2500;  // delai avant de declarer WebCodecs inutilisable
const AHEAD_MAX = 6;
const AHEAD_REORDER = 5;     // plancher quand le fichier contient des images B
const AHEAD_PIXELS = 6 * 1920 * 1080;
/**
 * @param {number} w @param {number} h
 * @param {boolean} reordonne  le fichier contient des images B
 *
 * Le budget est en PIXELS : six images de 1080p passent, six images de 4K
 * epuisent les tampons du decodeur materiel. Mais il y a un plancher : quand
 * les images sont REORDONNEES (images B, cas de tous les enregistrements
 * iPhone), elles sortent du decodeur dans le desordre et il en faut plusieurs
 * sous la main pour les remettre en place. En dessous, on attend indefiniment
 * une image deja passee — l'export se fige.
 */
function aheadFor(w, h, reordonne) {
  const px = Math.max(1, (w || 1920) * (h || 1080));
  const plancher = reordonne ? AHEAD_REORDER : 2;
  return Math.max(plancher, Math.min(AHEAD_MAX, Math.floor(AHEAD_PIXELS / px)));
}
// Sonde de vitesse : si WebCodecs n'atteint pas ce debit, on bascule sur le
// pipeline <video> du navigateur, qui est fortement optimise (c'est lui qui fait
// tourner l'apercu sans effort meme sur des sources lourdes).
// Images retenues d'avance en lecture par piste. A garder TRES BAS : elles
// viennent d'un pool limite alimente par le lecteur, et en retenir trop bloque
// ce pool — la lecture ralentit alors au lieu de tenir le temps reel.
const TRACK_QUEUE = 3;

/**
 * Choisit l'acceleration de DECODAGE.
 *
 * Par defaut WebCodecs est en « no-preference », et Chrome peut alors retenir le
 * decodeur logiciel — catastrophique sur du HEVC ou de l'AV1 en 4K, ou une seule
 * image peut couter des secondes. On demande donc explicitement le materiel, et
 * on ne retombe sur autre chose que s'il n'en veut pas.
 */
async function pickDecodeAccel(track) {
  const base = {
    codec: track.codec,
    description: track.description || undefined,
    codedWidth: track.width,
    codedHeight: track.height,
    optimizeForLatency: false,
  };
  for (const accel of ['prefer-hardware', 'no-preference']) {
    try {
      const r = await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration: accel });
      if (r.supported) return accel;
    } catch (_) { /* on essaie le suivant */ }
  }
  return 'no-preference';
}

export class ClipDecoder {
  /** @param {object} opts {forceTrack:boolean, startAt:number} */
  constructor(lib, media, clip, opts = {}) {
    this.opts = opts;
    this.lib = lib;
    this.media = media;
    this.clip = clip;
    this.mode = null;          // 'codec' | 'element' | 'image'
    this.frames = [];          // VideoFrame triees par timestamp
    this.cur = null;
    this.nextIdx = 0;
    this.inputDone = false;    // tous les paquets ont ete donnes au decodeur
    this.eof = false;          // ... et le decodeur a fini de tout sortir
    this.gen = 0;              // increments a chaque saut : invalide le vidage en cours
    this.tOffset = 0;
    this.notify = null;
    this.fatal = null;
    this.decodedCount = 0;
    // compteurs de diagnostic : sans eux, « c'est lent » reste sans explication
    this.seekCount = 0;
    this.readMs = 0;
    this.readBytes = 0;
  }

  async init() {
    const media = this.media;
    if (media.kind === 'image') {
      this.mode = 'image';
      const f = this.lib.file(media.id);
      // alpha NON premultiplie : indispensable pour les PNG transparents superposes
      this.bitmap = await createImageBitmap(f, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      return this;
    }

    const mp4 = this.opts.forceTrack ? null : await this.lib.mp4Of(media.id);
    const track = mp4 && mp4.videoTrack;
    if (track && track.codec && track.samples.length) {
      let supported = false;
      try {
        const r = await VideoDecoder.isConfigSupported({
          codec: track.codec,
          description: track.description || undefined,
          codedWidth: track.width, codedHeight: track.height,
        });
        supported = !!r.supported;
      } catch (_) { supported = false; }
      if (supported) {
        this.mp4 = mp4;
        this.track = track;
        // un lecteur a soi (voir readSamples)
        { const f = this.lib.file && this.lib.file(media.id); this.lecteur = f ? blobReader(f) : null; }
        this.tOffset = track.tOffset || 0;
        this.mode = 'codec';
        this.accel = await pickDecodeAccel(track);
        // Temps de composition different du temps de decodage = images B, donc
        // sortie du decodeur dans le desordre. On ne teste que le debut : si le
        // fichier en contient, c'est visible des les premieres images.
        const reordonne = track.samples.slice(0, 200).some((x) => x.cts !== x.dts);
        this.ahead = aheadFor(track.width, track.height, reordonne);
        this._makeDecoder();
        // On garde WebCodecs : c'est le seul chemin exact a l'image pres, et il
        // convient a la quasi-totalite des fichiers. Aucune sonde de demarrage
        // ici — mesurer un decodeur a froid, en quelques images, donnait un
        // verdict faux qui condamnait des fichiers parfaitement rapides au
        // chemin degrade (et donc a des images dupliquees). C'est le chien de
        // garde de l'export, base sur le debit REEL, qui decide de basculer.
        return this;
      }
    }

    // Repli : on laisse le navigateur lire la video et on cueille les images au
    // vol. Son pipeline media est bien plus rapide que WebCodecs sur les formats
    // qu'il n'accelere pas, et infiniment plus rapide qu'un seek par image.
    const el = document.createElement('video');
    el.muted = true; el.preload = 'auto'; el.playsInline = true;
    el.src = this.lib.url(media.id);
    document.body.append(el);
    el.style.cssText = 'position:absolute;left:-9999px;width:2px;height:2px;opacity:0';
    this.el = el;
    await once(el, 'loadeddata', 30000);
    // On privilegie la lecture par piste media : elle utilise le decodeur du
    // navigateur (celui qui fait tourner l'apercu) et, contrairement a
    // requestVideoFrameCallback, elle ne depend pas de l'affichage de la page.
    this.mode = 'element';
    if (typeof MediaStreamTrackProcessor !== 'undefined' && el.captureStream) {
      try {
        await this._startTrack(Math.max(0, this.opts.startAt ?? (this.clip.in || 0)));
        if (await this._trackAlive(2000)) this.mode = 'track';
        else this._stopTrack();
      } catch (_) { this._stopTrack(); }
    }
    return this;
  }

  /** La piste nous livre-t-elle reellement des images ? */
  async _trackAlive(ms) {
    this._resumeTrack();
    const deadline = performance.now() + ms;
    let ok = false;
    while (performance.now() < deadline) {
      if (this.tq && this.tq.length) { ok = true; break; }
      if (this.tEnded) break;
      await this._waitTrack();
    }
    // on rembobine : la verification ne doit consommer aucune image du montage
    if (ok) await this._rewindTrack();
    return ok;
  }

  /** Configuration commune, pour que le decodeur garde la meme apres un saut. */
  _decoderConfig() {
    const t = this.track;
    return {
      codec: t.codec,
      description: t.description || undefined,
      codedWidth: t.width,
      codedHeight: t.height,
      hardwareAcceleration: this.accel || 'no-preference',
      optimizeForLatency: false,
    };
  }

  _makeDecoder() {
    const t = this.track;
    this.dec = new VideoDecoder({
      output: (frame) => {
        this.frames.push(frame);
        this.decodedCount++;
        if (this.notify) { this.notify(); this.notify = null; }
      },
      error: (e) => { this.fatal = e; if (this.notify) { this.notify(); this.notify = null; } },
    });
    this.dec.configure(this._decoderConfig());
    this.eof = false;
  }

  /**
   * Dort jusqu'a la prochaine image decodee.
   * Surtout PAS une boucle d'attente active : le decodeur materiel livre ses
   * images sur le thread principal, donc l'occuper a tourner en rond revient a
   * ralentir precisement ce qu'on attend.
   */
  _wait() {
    return new Promise((res) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        clearTimeout(tid);
        try { this.dec.removeEventListener('dequeue', fin); } catch (_) {}
        if (this.notify === fin) this.notify = null;
        res();
      };
      this.notify = fin;
      try { this.dec.addEventListener('dequeue', fin); } catch (_) {}
      const tid = setTimeout(fin, 200);   // filet si le navigateur n'a pas 'dequeue'
    });
  }

  async _seek(mediaTime) {
    // une alimentation anticipee peut etre en vol : on la laisse finir, sinon
    // ses paquets arriveraient APRES le reset et decoderaient au mauvais endroit
    if (this._feedPromise) { await this._feedPromise.catch(() => {}); this._feedPromise = null; }
    this.seekCount++;
    const idx = this.mp4.indexAt(this.track, Math.max(0, mediaTime));
    let key = this.mp4.keyBefore(this.track, idx);
    // Images « en avance » (HEVC des iPhone, GOP ouverte) : une image cle peut
    // etre precedee A L'AFFICHAGE d'images qui la suivent au decodage et
    // dependent de la GOP d'avant. Repartir de cette cle ne les produit jamais :
    // le decodeur les saute, et l'on attendait en vain l'image demandee jusqu'au
    // delai de secours — 2,5 s d'image figee a l'apercu, apres un saut ou une
    // coupe. Si la cle s'affiche apres l'instant voulu, on repart de la
    // precedente.
    const t = this.track;
    const demi = (t.timescale || 1) / Math.max(1, (t.fps || 30) * 2);
    const voulu = Math.max(0, mediaTime) * (t.timescale || 1);
    while (key > 0 && t.samples[key].cts > voulu + demi) key = this.mp4.keyBefore(t, key - 1);
    for (const f of this.frames) f.close();
    this.frames.length = 0;
    if (this.cur) { this.cur.close(); this.cur = null; }
    try { this.dec.reset(); } catch (_) {}
    this.dec.configure(this._decoderConfig());
    this.nextIdx = key;
    this.inputDone = false;
    this.eof = false;
    this.gen++;                // le vidage lance avant ce saut ne nous concerne plus
  }

  /**
   * Une seule alimentation a la fois. Si une est deja en vol on ATTEND celle-la :
   * renvoyer tout de suite ferait tourner l'appelant en boucle de micro-taches,
   * ce qui empeche le decodeur de livrer quoi que ce soit (il a besoin du
   * thread pour ses callbacks) — donc blocage garanti.
   */
  _feed() {
    if (this.inputDone) return Promise.resolve(false);
    if (this._feedPromise) return this._feedPromise;
    const pr = this._feedNow().finally(() => { if (this._feedPromise === pr) this._feedPromise = null; });
    this._feedPromise = pr;
    return pr;
  }

  /** Remplit le decodeur sans attendre : le materiel travaille pendant qu'on rend. */
  _prefetch() {
    if (this.inputDone || this.mode !== 'codec' || this._feedPromise) return;
    if (this.dec.decodeQueueSize >= MAX_QUEUE) return;
    if (this.frames.length >= this.ahead) return;
    this._feed().catch(() => {});
  }

  async _feedNow() {
    if (this.inputDone) return false;
    const t = this.track;
    if (this.nextIdx >= t.samples.length) {
      this.inputDone = true;
      // On n'ATTEND PAS flush() : elle ne rend la main que lorsque le decodeur
      // a sorti ses dernieres images, or il ne peut pas tant qu'on retient les
      // precedentes — et on ne les rend qu'apres cet appel. Blocage garanti.
      // On la laisse donc se terminer en tache de fond ; les images continuent
      // d'arriver par `output`, et `eof` ne passe a vrai qu'a la toute fin.
      const gen = this.gen;
      Promise.resolve(this.dec.flush()).catch(() => {}).then(() => {
        if (this.gen !== gen) return;   // un saut est passe par la entre-temps
        this.eof = true;
        if (this.notify) { this.notify(); this.notify = null; }
      });
      return false;
    }
    const to = Math.min(this.nextIdx + BATCH - 1, t.samples.length - 1);
    const tRead = performance.now();
    const chunkList = await this.mp4.readSamples(t, this.nextIdx, to, false, this.lecteur);
    this.readMs += performance.now() - tRead;
    for (const c of chunkList) this.readBytes += c.data.length;
    for (const c of chunkList) {
      const s = c.sample;
      this.dec.decode(new EncodedVideoChunk({
        type: s.sync ? 'key' : 'delta',
        timestamp: Math.round((s.cts / t.timescale) * 1e6),
        duration: Math.round((s.dur / t.timescale) * 1e6),
        data: c.data,
      }));
    }
    this.nextIdx = to + 1;
    return true;
  }

  /**
   * Renvoie la source d'image pour un temps source (secondes).
   *
   * IMPORTANT : quand `owned` vaut true, `src` est un CLONE dont L'APPELANT est
   * proprietaire — il DOIT appeler `src.close()` apres usage. Sans ca les
   * tampons du decodeur materiel s'epuisent et le decodage finit par se bloquer.
   * Ce clone est ce qui permet de decoder l'image suivante pendant qu'on rend la
   * courante, sans se la fermer sous les pieds.
   */
  async frameAt(srcTime) {
    if (this.mode === 'image') {
      // une image fixe ne change jamais : inutile de la re-televerser au GPU
      const seen = !!this._imgSeen;
      this._imgSeen = true;
      return { src: this.bitmap, w: this.bitmap.width, h: this.bitmap.height,
        id: 'img:' + this.media.id, owned: false, same: seen };
    }

    if (this.mode === 'track') {
      const want = clamp(srcTime, 0, Math.max(0, (this.media.duration || 0) - 0.001));
      return this._frameFromTrack(want);
    }

    if (this.mode === 'element') {
      const el = this.el;
      const want = clamp(srcTime, 0, Math.max(0, (this.media.duration || 0) - 0.001));
      const halfFrame = 0.5 / Math.max(1, this.media.fps || 30);
      if (this._forceSeek || Math.abs(el.currentTime - want) > halfFrame) {
        this._forceSeek = false;
        el.currentTime = want;
        // 2,5 s suffisent largement pour un seek qui aboutit. Attendre 15 s par
        // image transformait un export un peu lent en export interminable.
        await once(el, 'seeked', 2500).catch(() => {});
      }
      if (!el.videoWidth) return null;
      return { src: el, w: el.videoWidth, h: el.videoHeight, id: 'el:' + this.clip.id, owned: false, same: false };
    }

    const t = this.track;
    const mediaTime = srcTime - this.tOffset;
    const targetUs = mediaTime * 1e6;
    const frameUs = (t.fps ? 1 / t.fps : 1 / 30) * 1e6;

    // Seuil de « meme image » : 0,6 image. Trop haut (0,9) on duplique des
    // qu'une source a 59,5 i/s est exportee a 60 ; trop bas (0,5) on refuse
    // l'image courante sans que la suivante soit encore disponible, et la
    // boucle attend le delai a chaque image — l'export s'ecroule.
    //
    // Besoin d'un saut ? Les videos iPhone sont a DEBIT VARIABLE : les images ne
    // sont pas espacees regulierement. On tolere donc un large retour arriere
    // (jitter) sans re-sauter — un saut re-decode toute une GOP, ce qui, repete,
    // ecroule le debit. En export on n'avance que vers l'avant : un « retour »
    // n'est jamais qu'une micro-variation, l'image courante reste la bonne.
    const curTs = this.cur ? this.cur.timestamp : null;
    // Retour en arriere tolere sans re-sauter.
    //
    // A l'export on n'avance que vers l'avant : un « retour » n'est qu'une
    // micro-variation de cadence, et garder l'image courante evite de
    // re-decoder toute une GOP a chaque fois. A l'apercu c'est l'inverse : on
    // recule pour de bon, et rendre l'image courante montrerait un instant
    // POSTERIEUR a celui demande. En mode exact on ne tolere donc qu'une
    // demi-image, ce qui revient a exiger la bonne.
    const retour = this.opts.exact ? frameUs * 0.5 : frameUs * 4;
    if (curTs === null || targetUs < curTs - retour || targetUs > curTs + frameUs * 90) {
      await this._seek(mediaTime);
    } else if (targetUs <= curTs) {
      // la cible est derriere l'image courante : c'est deja la bonne
      this._prefetch();
      return this._wrap(this.cur, true);
    }

    // Les VideoFrame decodees occupent des tampons GPU en nombre limite :
    // on en garde le moins possible, sinon le decodeur materiel se bloque.
    const tol = frameUs * 0.45;
    // Tant qu'AUCUNE image n'est encore sortie, on n'accorde qu'un court delai :
    // sur certains fichiers le decodeur accepte la configuration puis ne produit
    // jamais rien. Attendre 25 secondes pour s'en apercevoir, c'est 25 secondes
    // perdues avant de basculer sur le chemin qui, lui, fonctionne.
    // Le delai ne compte pas l'attente du DISQUE : sur un disque dur USB deja
    // occupe, lire quelques Mo peut prendre plusieurs secondes sans que le
    // decodeur y soit pour rien. Le declarer bloque faisait perdre l'image.
    const delai = this.gotAny ? 25000 : FIRST_FRAME_MS;
    const t0Attente = performance.now(), lu0 = this.readMs;
    while (performance.now() - t0Attente - (this.readMs - lu0) < delai) {
      if (this.fatal) throw this.fatal;
      this._sortFrames();
      // libere tout ce qui precede l'image candidate
      while (this.frames.length > 1 && this.frames[1].timestamp <= targetUs + tol) {
        this.frames.shift().close();
      }
      const cand = this.frames[0];
      if (cand && cand.timestamp <= targetUs + tol && (this.frames.length > 1 || this.eof)) {
        if (this.cur) this.cur.close();
        this.cur = this.frames.shift();
        this.gotAny = true;
        this._prefetch();            // le decodeur continue pendant qu'on rend
        return this._wrap(this.cur);
      }
      // La prochaine image de la source est DEVANT l'instant demande : l'image
      // courante est donc bien la bonne, et la redonner est legitime.
      //
      // Ce test remplace un seuil fixe (« meme image si la cible est a moins de
      // 0,6 periode ») qui, ajoute a la tolerance de 0,45, acceptait 1,05
      // periode source au lieu de 1,00. Sur les cadences NTSC — 59,94 exportee
      // en 60, cas de tous les telephones — cela fabriquait une vingtaine de
      // doublons par millier d'images au lieu de deux, en detruisant au passage
      // de vraies images : c'est ce qui donnait cette impression de « pas
      // vraiment 60 i/s ».
      if (cand && this.cur && cand.timestamp > targetUs + tol) {
        this._prefetch();
        return this._wrap(this.cur, true);
      }
      // Filet : juste apres un saut, aucune image anterieure ne viendra plus
      // (la reserve est pleine, ou le fichier est fini). On sert la plus proche
      // plutot que d'attendre le delai de secours, image figee.
      if (cand && !this.cur && cand.timestamp > targetUs + tol
          && (this.frames.length >= this.ahead || this.inputDone)) {
        this.cur = this.frames.shift();
        this.gotAny = true;
        this._prefetch();
        return this._wrap(this.cur);
      }
      if (this.eof) {
        if (this.frames.length) {
          if (this.cur) this.cur.close();
          this.cur = this.frames.shift();
          while (this.frames.length) this.frames.shift().close();
          return this._wrap(this.cur);
        }
        return this.cur ? this._wrap(this.cur) : null;
      }
      // On alimente tant que le decodeur a de la place, sinon on DORT en
      // attendant sa prochaine image (jamais d'attente active).
      if (!this.inputDone && this.dec.decodeQueueSize < MAX_QUEUE && this.frames.length < this.ahead) await this._feed();
      else await this._wait();
    }
    throw new Error('decodage bloque a ' + srcTime.toFixed(3) + ' s');
  }

  /**
   * Lecture par piste media (MediaStreamTrackProcessor).
   *
   * On laisse le navigateur LIRE la video avec son propre pipeline — celui qui
   * fait tourner l'apercu sans effort, meme sur des formats que WebCodecs
   * n'accelere pas — et on recupere les images decodees directement depuis la
   * piste. Contrairement a requestVideoFrameCallback, cette API ne depend pas de
   * l'affichage de la page : elle fonctionne meme onglet cache.
   *
   * Contrainte : la lecture se fait en TEMPS REEL (playbackRate est ignore par
   * captureStream). Une video de 9 s prend donc 9 s a parcourir — sans commune
   * mesure avec les minutes d'un decodage logiciel.
   */
  async _startTrack(startAt) {
    const el = this.el;
    const stream = el.captureStream();
    const track = stream.getVideoTracks && stream.getVideoTracks()[0];
    if (!track) throw new Error('pas de piste video');
    this.tproc = new MediaStreamTrackProcessor({ track });
    this.treader = this.tproc.readable.getReader();
    this.tq = [];
    this.tEnded = false;
    this.tStop = false;
    el.playbackRate = 1;
    this.tStart = startAt;
    this.tCount = 0;
    // pas minimal entre deux images conservees (cadence de sortie demandee)
    this.wantStep = this.opts.wantFps ? 1 / this.opts.wantFps : 1 / 30;
    this.tLastKept = undefined;
    this.tFps = Math.max(1, this.media.fps || 30);
    el.currentTime = startAt;
    await once(el, 'seeked', 5000).catch(() => {});
    this.tStart = el.currentTime;
    // On NE LANCE PAS la lecture ici. Elle avancerait pendant le reste de
    // l'initialisation (verification, sondage) et les premieres images seraient
    // perdues avant meme qu'on les demande — d'ou des images figees au debut.
    this._pumpTrack();
  }

  /** Demarre la lecture au premier besoin reel, pas avant. */
  _resumeTrack() {
    if (this.el && this.el.paused && !this.tStop && !this.tEnded) {
      this.el.play().catch(() => {});
    }
  }

  /** Remet la piste au debut apres la verification, sans rien avoir perdu. */
  async _rewindTrack() {
    const el = this.el;
    if (!el) return;
    try { el.pause(); } catch (_) {}
    if (this.tq) { for (const q of this.tq) { try { q.frame.close(); } catch (_) {} } this.tq.length = 0; }
    if (this.tHeld) { try { this.tHeld.frame.close(); } catch (_) {} this.tHeld = null; }
    el.currentTime = this.tStart;
    await once(el, 'seeked', 3000).catch(() => {});
    this.tSeen = false;
    this.tCount = 0;
    this.tDrop = false;
    this.tLastKept = undefined;
    this.tPrevT = undefined;
  }

  /** Boucle de lecture : remplit la file, se met en pause si on prend de l'avance. */
  _pumpTrack() {
    const step = async () => {
      while (!this.tStop) {
        const { value, done } = await this.treader.read();
        if (done || !value) break;
        // File pleine = l'export a pris du retard sur la lecture. On SUSPEND
        // alors la lecture au lieu de jeter les images en attente : les jeter
        // ferait sauter le montage en avant, et la video finale sortirait
        // ACCELEREE. Mieux vaut un export un peu plus long qu'un rendu faux.
        while (this.tq.length >= TRACK_QUEUE && !this.tStop) {
          if (this.el && !this.el.paused) this.el.pause();
          await new Promise((r) => { this.tWake = r; setTimeout(r, 40); });
        }
        this._resumeTrack();
        // captureStream emet un INSTANTANE de l'image courante des l'ouverture de
        // la piste, avant meme que la lecture n'avance : c'est un doublon. Le
        // garder decalerait toute la video d'une image. On ne le jette que s'il
        // arrive bien avant que le lecteur n'ait bouge, pour ne pas perdre une
        // vraie image sur un navigateur qui ne ferait pas cet instantane.
        const now = this.el ? this.el.currentTime : 0;
        if (!this.tSeen) {
          this.tSeen = true;
          if (now <= this.tStart + 0.6 / this.tFps) { value.close(); continue; }
        }
        // Comment dater l'image ?
        //
        // L'horodatage de la piste est celui de la CAPTURE, pas du media : il ne
        // dit rien de l'instant filme. Numeroter les images est exact tant que le
        // navigateur les livre toutes — mais sur une source lourde (4K 60) il en
        // laisse tomber les deux tiers, et le compteur derive alors sans fin.
        //
        // On date donc par la POSITION REELLE du lecteur, qui reste juste quoi
        // qu'il arrive, et on ne recourt au compteur que tant qu'aucune image
        // n'a ete perdue.
        const counted = this.tStart + this.tCount / this.tFps;
        let t = counted;
        if (this.tDrop || Math.abs(now - counted) > 2.5 / this.tFps) {
          this.tDrop = true;                       // le navigateur saute des images
          t = Math.max(this.tStart, now);
          this.tCount = Math.round((t - this.tStart) * this.tFps);
        }
        this.tCount++;
        // DECIMATION : une source a 60 i/s exportee en 30 livre deux fois plus
        // d'images que necessaire. Les cloner et les mettre en file pour les
        // jeter ensuite occupe le thread principal — celui-la meme dont la
        // boucle d'export a besoin. On ferme tout de suite ce qui ne servira pas.
        if (this.wantStep > 0 && this.tLastKept !== undefined
            && t < this.tLastKept + this.wantStep * 0.85) {
          value.close();
          continue;
        }
        this.tLastKept = t;
        this.tq.push({ t, frame: value });
        if (this.notify) { this.notify(); this.notify = null; }
      }
      this.tEnded = true;
      if (this.notify) { this.notify(); this.notify = null; }
    };
    step().catch(() => {
      this.tEnded = true;
      if (this.notify) { this.notify(); this.notify = null; }
    });
  }

  /** Sert l'image correspondant a `want` depuis la file de la piste. */
  async _frameFromTrack(want) {
    this._resumeTrack();
    const deadline = performance.now() + 30000;
    for (;;) {
      // on jette ce qui est depasse, en gardant toujours un candidat
      while (this.tq.length > 1 && this.tq[1].t <= want + 1e-4) {
        this.tq.shift().frame.close();
      }
      const head = this.tq[0];
      if (head) {
        const enAvance = head.t > want + this.wantStep * 0.75;
        if (enAvance && this.tHeld) {
          // L'image disponible est DEVANT l'instant demande : la servir ferait
          // avancer le montage plus vite que le temps. On redonne la precedente.
          if (this.tWake) { const w = this.tWake; this.tWake = null; w(); }
          return this._wrapTrack(this.tHeld.frame, this.tHeld.t);
        }
        if (!enAvance && (head.t >= want - 1e-4 || this.tq.length > 1 || this.tEnded)) {
          if (this.tHeld && this.tHeld !== head) { try { this.tHeld.frame.close(); } catch (_) {} }
          this.tHeld = head;
          this.tq.shift();                 // on garde la main dessus via tHeld
          if (this.tWake) { const w = this.tWake; this.tWake = null; w(); }
          return this._wrapTrack(head.frame, head.t);
        }
        if (enAvance && !this.tHeld) {
          this.tHeld = head; this.tq.shift();
          return this._wrapTrack(head.frame, head.t);
        }
      }
      if (this.tEnded && !this.tq.length) {
        return this.tHeld ? this._wrapTrack(this.tHeld.frame, this.tHeld.t) : null;
      }
      if (performance.now() > deadline) throw new Error('lecture bloquee a ' + want.toFixed(3) + ' s');
      if (this.tWake) { const w = this.tWake; this.tWake = null; w(); }
      await this._waitTrack();
    }
  }

  _wrapTrack(frame, t) {
    const same = this.tPrevT === t;
    this.tPrevT = t;
    let src = frame, owned = false;
    try { src = frame.clone(); owned = true; } catch (_) {}
    return {
      src, owned, same,
      w: src.displayWidth || src.codedWidth,
      h: src.displayHeight || src.codedHeight,
      id: 'vf:' + this.clip.id,
    };
  }

  _waitTrack() {
    return new Promise((res) => {
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(tid); if (this.notify === fin) this.notify = null; res(); };
      this.notify = fin;
      const tid = setTimeout(fin, 60);
    });
  }

  _stopTrack() {
    this.tStop = true;
    if (this.tWake) { const w = this.tWake; this.tWake = null; w(); }
    if (this.treader) { try { this.treader.cancel(); } catch (_) {} this.treader = null; }
    if (this.tq) { for (const q of this.tq) { try { q.frame.close(); } catch (_) {} } this.tq = null; }
    if (this.tHeld) { try { this.tHeld.frame.close(); } catch (_) {} this.tHeld = null; }
    if (this.el) { try { this.el.pause(); } catch (_) {} }
  }

  _sortFrames() {
    if (this.frames.length > 1) this.frames.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * @param {VideoFrame} frame
   * @param {boolean} same  l'appelant redemande l'image qu'il a deja
   *
   * On renvoie un CLONE (simple compteur de references, pas une copie des
   * pixels) : l'appelant peut ainsi garder son image pendant qu'on decode deja
   * la suivante. Sans ca, impossible de faire travailler decodeur et encodeur
   * en meme temps — on la lui fermerait sous les pieds.
   */
  _wrap(frame, same = false) {
    if (!frame) return null;
    let src = frame, owned = false;
    try { src = frame.clone(); owned = true; } catch (_) { src = frame; }
    return {
      src, owned, same,
      // Images BRUTES du decodeur : la rotation notee dans le conteneur n'est
      // PAS appliquee, c'est au rendu de le faire. Les telephones filment a
      // l'horizontale et notent « tourner de 90° » ; le lecteur du navigateur
      // (donc l'apercu) obeit, WebCodecs non. Sans cette information, un clip
      // de telephone sort couche a l'export alors qu'il est droit a l'apercu.
      rotation: (this.track && this.track.rotation) || 0,
      w: src.displayWidth || src.codedWidth,
      h: src.displayHeight || src.codedHeight,
      // identifiant STABLE : une seule texture GPU par clip, reutilisee
      id: 'vf:' + this.clip.id,
    };
  }

  close() {
    this.inputDone = true;
    this.eof = true;
    this._stopTrack();
    for (const f of this.frames) { try { f.close(); } catch (_) {} }
    this.frames.length = 0;
    if (this.cur) { try { this.cur.close(); } catch (_) {} this.cur = null; }
    if (this.dec) { try { this.dec.close(); } catch (_) {} }
    if (this.el) { try { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); this.el.remove(); } catch (_) {} }
    if (this.bitmap) { try { this.bitmap.close(); } catch (_) {} }
  }
}
