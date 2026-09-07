// Reperage des temps forts d'un son — les « boums ».
//
// L'idee : un coup de grosse caisse, une attaque de basse ou un changement net
// se voient comme un saut brusque d'energie dans le spectre. On decoupe donc le
// son en tranches, on compare chaque tranche a la precedente, et on ne garde
// que les hausses (le « flux spectral positif »). Une baisse d'energie n'est
// pas une attaque : c'est pour cela qu'on ignore les differences negatives.
//
// Le seuil ne peut pas etre fixe : un morceau fort et un morceau discret n'ont
// pas la meme echelle, et un meme morceau change de niveau au fil des couplets.
// On compare donc chaque valeur a la mediane de son voisinage, ce qui suit le
// morceau au lieu de lui imposer un niveau.

import { yieldTask } from './util.js';

const CACHE = new Map();   // mediaId -> {sr, hop, flux:Float32Array, dur}

const FFT_N = 1024;        // ~46 ms a 22050 Hz : assez court pour separer deux coups
const HOP = 256;           // ~11,6 ms de resolution
const SR = 22050;          // le rythme vit en bas du spectre, inutile d'aller plus haut

// ------------------------------------------------------------------ FFT

/** Table des racines de l'unite, calculee une fois pour toutes. */
const TW = (() => {
  const cos = new Float32Array(FFT_N / 2), sin = new Float32Array(FFT_N / 2);
  for (let i = 0; i < FFT_N / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / FFT_N);
    sin[i] = Math.sin((-2 * Math.PI * i) / FFT_N);
  }
  return { cos, sin };
})();

/** Fenetre de Hann : sans elle, les bords de chaque tranche creent de faux aigus. */
const WIN = (() => {
  const w = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
  return w;
})();

const REV = (() => {
  const r = new Uint16Array(FFT_N);
  const bits = Math.log2(FFT_N);
  for (let i = 0; i < FFT_N; i++) {
    let x = i, y = 0;
    for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; }
    r[i] = y;
  }
  return r;
})();

/** FFT en place, radix 2. re/im font FFT_N cases. */
function fft(re, im) {
  for (let i = 0; i < FFT_N; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let taille = 2; taille <= FFT_N; taille <<= 1) {
    const demi = taille >> 1;
    const pas = FFT_N / taille;
    for (let i = 0; i < FFT_N; i += taille) {
      for (let j = 0, k = 0; j < demi; j++, k += pas) {
        const c = TW.cos[k], s = TW.sin[k];
        const a = i + j, b = a + demi;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

// ------------------------------------------------------- courbe de nouveaute

/**
 * Transforme le son en une courbe ou chaque attaque fait un pic.
 *
 * L'analyse est rendue par petits paquets : sur un morceau de trois minutes
 * cela represente des milliers de FFT, et tout enchainer d'un bloc figerait
 * l'interface pendant plusieurs secondes.
 *
 * @param {Float32Array} pcm  mono
 * @param {(part:number)=>void} [avance]  progression 0..1
 * @returns {Promise<Float32Array>} une valeur tous les HOP echantillons
 */
async function fluxSpectral(pcm, avance) {
  const trames = Math.max(0, Math.floor((pcm.length - FFT_N) / HOP) + 1);
  const flux = new Float32Array(trames);
  const re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);
  const bins = FFT_N / 2;
  let prec = new Float32Array(bins);
  let cour = new Float32Array(bins);

  // Les « boums » sont en bas du spectre : on y donne plus de poids, sans pour
  // autant ignorer le reste — une caisse claire doit compter aussi.
  const poids = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    const hz = (k * SR) / FFT_N;
    poids[k] = hz < 160 ? 2.6 : hz < 400 ? 1.7 : hz < 2000 ? 1 : hz < 6000 ? 0.6 : 0.25;
  }

  for (let t = 0; t < trames; t++) {
    const d = t * HOP;
    for (let i = 0; i < FFT_N; i++) { re[i] = pcm[d + i] * WIN[i]; im[i] = 0; }
    fft(re, im);
    let somme = 0;
    for (let k = 0; k < bins; k++) {
      // L'echelle logarithmique rapproche l'oreille : un passage de 0,01 a 0,02
      // s'entend autant qu'un passage de 0,5 a 1.
      const mag = Math.log1p(120 * Math.hypot(re[k], im[k]));
      cour[k] = mag;
      const diff = mag - prec[k];
      if (diff > 0) somme += diff * poids[k];   // seules les hausses sont des attaques
    }
    flux[t] = somme;
    // cour est reecrit entierement a chaque trame : on peut echanger les deux
    // tampons au lieu d'en allouer un nouveau a chaque fois.
    const tmp = prec; prec = cour; cour = tmp;
    if ((t & 255) === 255) {
      if (avance) avance(t / trames);
      await yieldTask();
    }
  }
  if (avance) avance(1);
  return flux;
}

/** Mediane d'une fenetre glissante — le seuil suit le morceau. */
function seuilAdaptatif(flux, demiFenetre) {
  const n = flux.length;
  const out = new Float32Array(n);
  const tampon = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - demiFenetre), b = Math.min(n, i + demiFenetre + 1);
    tampon.length = 0;
    for (let j = a; j < b; j++) tampon.push(flux[j]);
    tampon.sort((x, y) => x - y);
    out[i] = tampon[tampon.length >> 1];
  }
  return out;
}

/**
 * Choisit les pics de la courbe.
 * @param {number} sensibilite 0..1 — plus c'est haut, plus on garde de points
 * @param {number} ecartMin    secondes entre deux points
 */
function piquer(flux, sensibilite, ecartMin) {
  const parSec = SR / HOP;
  const med = seuilAdaptatif(flux, Math.round(parSec * 0.35));
  // L'ecart-type donne l'echelle du morceau : la marge exigee au-dessus de la
  // mediane vaut donc quelque chose de comparable d'un son a l'autre.
  let moy = 0;
  for (let i = 0; i < flux.length; i++) moy += flux[i];
  moy /= Math.max(1, flux.length);
  let varsum = 0;
  for (let i = 0; i < flux.length; i++) { const d = flux[i] - moy; varsum += d * d; }
  const ecart = Math.sqrt(varsum / Math.max(1, flux.length));

  // Le curseur doit couvrir toute la plage utile : tout a gauche, seuls les gros
  // coups bien detaches passent ; tout a droite, on descend jusqu'aux attaques
  // discretes. Les deux reglages avancent ensemble — exiger une attaque franche
  // sans exiger aussi qu'elle soit isolee laisserait passer les roulements.
  const marge = (3 - 2.85 * sensibilite) * ecart;
  const ecartEffectif = ecartMin != null ? ecartMin : 0.28 - 0.18 * sensibilite;
  const separation = Math.max(1, Math.round(ecartEffectif * parSec));

  const pics = [];
  for (let i = 1; i < flux.length - 1; i++) {
    const v = flux[i];
    if (v <= flux[i - 1] || v < flux[i + 1]) continue;      // pas un sommet local
    if (v < med[i] + marge) continue;                        // pas assez marque
    if (pics.length && i - pics[pics.length - 1].i < separation) {
      // Deux attaques trop proches : on garde la plus franche.
      if (v > pics[pics.length - 1].v) pics[pics.length - 1] = { i, v };
      continue;
    }
    pics.push({ i, v });
  }
  // Le centre de la trame tombe un demi-FFT apres son debut. S'y arreter place
  // les points une dizaine de millisecondes trop tot : le flux ne culmine pas
  // des que l'attaque entre dans la fenetre, mais quand elle l'a bien remplie.
  // Mesure sur des pistes de test (60 a 900 Hz, 90 a 140 BPM, attaques seches
  // ou longues) : le retard est de 10,7 ms, remarquablement stable.
  const decalage = FFT_N / 2 / SR + 0.0107;
  return pics.map((p) => (p.i * HOP) / SR + decalage);
}

// ------------------------------------------------------------------- entree

/** Ramene le fichier a du mono 22050 Hz, la matiere dont on a besoin. */
async function pcmMono(file) {
  const brut = await file.arrayBuffer();
  // On decode d'abord au format d'origine, puis on reechantillonne : passer
  // directement par un contexte a 22050 Hz laisse certains navigateurs refuser
  // des fichiers qu'ils savent pourtant lire.
  const ac = new OfflineAudioContext(1, 128, 48000);
  const buf = await ac.decodeAudioData(brut);
  const dur = buf.duration;
  if (!dur || !isFinite(dur)) return null;
  const cible = new OfflineAudioContext(1, Math.max(1, Math.ceil(dur * SR)), SR);
  const src = cible.createBufferSource();
  src.buffer = buf;
  src.connect(cible.destination);
  src.start();
  const rendu = await cible.startRendering();
  return { pcm: rendu.getChannelData(0), dur };
}

/**
 * Repere les temps forts d'un media audio.
 *
 * La courbe de nouveaute est mise en cache : changer la sensibilite ne redemande
 * pas l'analyse complete, seulement un nouveau choix de pics — c'est ce qui rend
 * le reglage instantane.
 *
 * @returns {Promise<number[]>} instants en secondes depuis le debut du fichier
 */
export async function detecterTemps(file, mediaId, opts = {}) {
  const sensibilite = Math.min(1, Math.max(0, opts.sensibilite ?? 0.5));
  const ecartMin = opts.ecartMin ?? null;

  let entree = mediaId != null ? CACHE.get(mediaId) : null;
  if (!entree) {
    const m = await pcmMono(file);
    if (!m) return [];
    entree = { flux: await fluxSpectral(m.pcm, opts.avance), dur: m.dur };
    if (mediaId != null) CACHE.set(mediaId, entree);
  }
  return piquer(entree.flux, sensibilite, ecartMin).filter((t) => t < entree.dur);
}

/** Oublie l'analyse d'un media (fichier remplace, ou menage). */
export function oublierTemps(mediaId) {
  if (mediaId == null) CACHE.clear(); else CACHE.delete(mediaId);
}

/** Le media a-t-il deja ete analyse ? (l'analyse suivante sera immediate) */
export function dejaAnalyse(mediaId) { return CACHE.has(mediaId); }

// -------------------------------------------------- correspondance clip/piste

/**
 * Instants de la timeline ou tombent les temps d'un clip.
 *
 * Les temps sont stockes en temps source : ils survivent ainsi au rognage et au
 * changement de vitesse, qui ne font que deplacer la fenetre visible.
 */
export function tempsTimeline(clip) {
  if (!clip || !clip.beats || !clip.beats.length) return [];
  const v = clip.speed || 1;
  const out = [];
  for (const s of clip.beats) {
    const local = (s - clip.in) / v;
    if (local >= -1e-6 && local <= clip.dur + 1e-6) out.push(clip.t0 + local);
  }
  return out;
}
