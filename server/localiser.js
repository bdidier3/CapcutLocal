'use strict';
/*
 * Retrouver une video sur le disque par son NOM et sa TAILLE.
 *
 * Le navigateur ne donne jamais le chemin d'un fichier glisse : pour qu'un
 * projet se rouvre tout seul, sans demander d'autorisation, le serveur cherche
 * lui-meme ou se trouve le fichier. On ne lit que les listes de dossiers, jamais
 * le contenu des fichiers ; et un fichier n'est retenu que si son nom ET sa
 * taille correspondent — jamais un simple homonyme.
 *
 * Ou chercher, dans l'ordre :
 *   1. les dossiers ou l'on a deja trouve des videos (memorises) ;
 *   2. les dossiers personnels (Bureau, Videos, Telechargements, Images...) ;
 *   3. les autres disques (D:, E:... : disques externes compris), en surface.
 * Les listes de dossiers sont gardees en memoire le temps de la session : la
 * deuxieme recherche est instantanee.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const EXT = /\.(mp4|mov|m4v|mkv|webm|avi|wmv|mts|m2ts|ts|mpg|mpeg|3gp|flv|ogv|mp3|wav|m4a|aac|flac|ogg|opus|wma|png|jpe?g|webp|bmp|gif|avif)$/i;
const IGNORER = /^(\$recycle\.bin|system volume information|windows|program files( \(x86\))?|programdata|appdata|node_modules|\.git|\.cache|cache|\.apercus|\.vignettes)$/i;
const MAX_DOSSIERS = 60000;      // garde-fou : on ne parcourt pas un disque entier sans fin

let fichierRacines = null;
// Derniere fois que l'editeur a signale qu'il avait besoin du disque (on
// navigue dans l'apercu) : le parcours s'efface tant que c'est recent, pour ne
// pas lui disputer la tete de lecture d'un disque dur.
let occupeA = 0;
function signalerOccupe() { occupeA = Date.now(); }
let racines = [];
// nom (en minuscules) -> chemins. On n'indexe que des NOMS : demander la
// taille de chaque video de chaque dossier, c'est des milliers d'acces sur un
// disque dur USB, au moment meme ou l'apercu en a besoin. La taille n'est
// demandee que pour les fichiers qui portent le bon nom.
const index = new Map();
const parcourus = new Set();      // dossiers deja indexes

function charger(cacheDir) {
  fichierRacines = path.join(cacheDir, 'racines.json');
  try { racines = JSON.parse(fs.readFileSync(fichierRacines, 'utf8')).filter((r) => typeof r === 'string'); }
  catch (_) { racines = []; }
}

function memoriser(dossier) {
  if (!dossier || !fichierRacines) return;
  const d = path.resolve(dossier);
  // inutile de garder un sous-dossier d'une racine deja connue
  if (racines.some((r) => d.toLowerCase().startsWith(r.toLowerCase() + path.sep) || d.toLowerCase() === r.toLowerCase())) return;
  racines = racines.filter((r) => !r.toLowerCase().startsWith(d.toLowerCase() + path.sep));
  racines.unshift(d);
  racines = racines.slice(0, 40);
  try { fs.writeFileSync(fichierRacines, JSON.stringify(racines, null, 1)); } catch (_) {}
}

/** Dossiers personnels, et racines des autres disques. */
function emplacementsParDefaut() {
  const h = os.homedir();
  const perso = ['Desktop', 'Bureau', 'Videos', 'Vidéos', 'Downloads', 'Téléchargements', 'Pictures', 'Images', 'Documents', 'Music', 'OneDrive']
    .map((d) => path.join(h, d)).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
  const disques = [];
  if (process.platform === 'win32') {
    for (const l of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const r = l + ':\\';
      try { fs.readdirSync(r); disques.push(r); } catch (_) {}
    }
  } else {
    for (const base of ['/media', '/mnt', '/run/media']) {
      try { for (const e of fs.readdirSync(base)) disques.push(path.join(base, e)); } catch (_) {}
    }
  }
  return { perso, disques };
}

/** Indexe un dossier et ses sous-dossiers (parcours en largeur, borne). */
async function indexer(racine, profondeurMax, budget) {
  const file = [[racine, 0]];
  while (file.length && budget.n < MAX_DOSSIERS) {
    const [dir, prof] = file.shift();
    if (parcourus.has(dir)) continue;
    while (Date.now() - occupeA < 1500) await new Promise((r) => setTimeout(r, 250));
    budget.n++;
    let entrees;
    // un dossier illisible (disque pas encore branche) n'est PAS retenu comme
    // parcouru : on le relira quand il sera la
    try { entrees = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    parcourus.add(dir);
    for (const e of entrees) {
      const plein = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (prof < profondeurMax && !IGNORER.test(e.name) && !e.name.startsWith('.')) file.push([plein, prof + 1]);
      } else if (e.isFile() && EXT.test(e.name)) {
        const k = e.name.toLowerCase();
        const l = index.get(k);
        if (!l) index.set(k, [plein]);
        else if (!l.includes(plein)) l.push(plein);
      }
    }
    // laisse respirer le serveur pendant un long parcours
    if (budget.n % 200 === 0) await new Promise((r) => setImmediate(r));
  }
}

/**
 * @param {{name:string,size:number}[]} voulus
 * @param {string[]} [enPlus] dossiers a explorer en premier (choisis par l'utilisateur)
 * @returns {Promise<Object<string,string>>} "nom|taille" -> chemin, pour ce qui a ete trouve
 */
async function localiser(voulus, enPlus = []) {
  const out = {};
  const reste = () => voulus.filter((f) => !out[f.name + '|' + f.size]);
  const vus = new Set();               // candidats deja verifies
  const relever = () => {
    for (const f of voulus) {
      if (out[f.name + '|' + f.size]) continue;
      for (const p of index.get(String(f.name).toLowerCase()) || []) {
        if (vus.has(p)) continue;
        vus.add(p);
        try { if (fs.statSync(p).size === Number(f.size)) { out[f.name + '|' + f.size] = p; break; } } catch (_) {}
      }
    }
  };
  // un dossier choisi a la main est toujours relu : son contenu a pu changer
  for (const d of enPlus) {
    const pre = path.resolve(d).toLowerCase();
    for (const p of [...parcourus]) if (p.toLowerCase().startsWith(pre)) parcourus.delete(p);
  }
  relever();
  if (!reste().length) return out;
  const budget = { n: 0 };
  const { perso, disques } = emplacementsParDefaut();
  const etapes = [
    ...enPlus.map((d) => [d, 8]),
    ...racines.map((d) => [d, 8]),
    ...perso.map((d) => [d, 6]),
    ...disques.map((d) => [d, 5]),
  ];
  for (const [d, prof] of etapes) {
    await indexer(d, prof, budget);
    relever();
    if (!reste().length) break;
  }
  // on retient les dossiers ou l'on a trouve : la prochaine fois, c'est direct
  for (const p of Object.values(out)) memoriser(path.dirname(path.dirname(p)));
  return out;
}

module.exports = { charger, localiser, memoriser, signalerOccupe };
