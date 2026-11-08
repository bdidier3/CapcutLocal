'use strict';
/*
 * Place occupee sur le disque, et menage.
 *
 * CutLocal accumule trois choses au fil de l'usage : les videos rapportees par
 * « Telecharger », les copies allegees qui rendent l'apercu fluide, et les
 * vignettes du dossier de telechargements. Rien de tout cela n'est visible
 * depuis l'application, et cela finit par peser des giga-octets.
 *
 * On les compte donc separement, parce qu'elles ne se valent pas : les copies
 * et les vignettes se refabriquent toutes seules, alors que les videos
 * telechargees, une fois effacees, sont perdues — et un projet qui s'en sert
 * ne les retrouvera plus.
 */

const fs = require('fs');
const path = require('path');

/** Additionne la taille des fichiers d'un dossier (sans descendre plus bas). */
function pesee(dir, filtre) {
  let octets = 0, nombre = 0;
  let noms = [];
  try { noms = fs.readdirSync(dir); } catch (_) { return { octets, nombre }; }
  for (const f of noms) {
    if (filtre && !filtre(f)) continue;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (!st.isFile()) continue;
      octets += st.size;
      nombre++;
    } catch (_) { /* fichier disparu entre-temps */ }
  }
  return { octets, nombre };
}

/** Detail de ce que l'application occupe, categorie par categorie. */
function etat(cacheDir) {
  const medias = pesee(cacheDir, (f) => /\.(mp4|mov|mkv|webm|m4a|mp3|wav|jpg|png|avi|ts)$/i.test(f));
  const apercus = pesee(path.join(cacheDir, '.apercus'), (f) => /\.mp4$/i.test(f));
  const vignettes = pesee(path.join(cacheDir, '.vignettes'), (f) => /\.jpg$/i.test(f));
  // restes d'un travail interrompu : toujours bons a jeter
  const restes = pesee(path.join(cacheDir, '.apercus'), (f) => /\.src\.|\.part$/i.test(f));

  const cats = [
    {
      cle: 'medias',
      titre: 'Videos telechargees',
      note: 'Vos projets peuvent s\'en servir : les effacer les rendra introuvables.',
      refabricable: false,
      ...medias,
    },
    {
      cle: 'apercus',
      titre: 'Copies d\'apercu',
      note: 'Refabriquees automatiquement au besoin.',
      refabricable: true,
      ...apercus,
    },
    {
      cle: 'vignettes',
      titre: 'Vignettes',
      note: 'Refabriquees automatiquement au besoin.',
      refabricable: true,
      ...vignettes,
    },
    {
      cle: 'restes',
      titre: 'Fichiers temporaires',
      note: 'Restes de travaux interrompus, sans utilite.',
      refabricable: true,
      ...restes,
    },
  ];
  return { dossier: cacheDir, categories: cats, total: cats.reduce((n, c) => n + c.octets, 0) };
}

/** Efface les categories demandees. Renvoie ce qui a ete libere. */
function vider(cacheDir, cles) {
  const voulu = new Set(cles || []);
  const cibles = [];
  if (voulu.has('medias')) {
    cibles.push([cacheDir, (f) => /\.(mp4|mov|mkv|webm|m4a|mp3|wav|jpg|png|avi|ts)$/i.test(f)]);
  }
  if (voulu.has('apercus')) cibles.push([path.join(cacheDir, '.apercus'), (f) => /\.mp4$/i.test(f)]);
  if (voulu.has('vignettes')) cibles.push([path.join(cacheDir, '.vignettes'), (f) => /\.jpg$/i.test(f)]);
  if (voulu.has('restes')) cibles.push([path.join(cacheDir, '.apercus'), (f) => /\.src\.|\.part$/i.test(f)]);

  let octets = 0, nombre = 0, echecs = 0;
  for (const [dir, filtre] of cibles) {
    let noms = [];
    try { noms = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of noms) {
      if (!filtre(f)) continue;
      const plein = path.join(dir, f);
      try {
        const st = fs.statSync(plein);
        if (!st.isFile()) continue;
        fs.unlinkSync(plein);
        octets += st.size;
        nombre++;
      } catch (_) { echecs++; }   // fichier ouvert ailleurs : on n'insiste pas
    }
  }
  return { octets, nombre, echecs };
}

// --------------------------------------------------------------- bornage auto

// Plafond des caches qui se refabriquent. Une copie d'apercu pese environ 5 Mo
// pour vingt secondes de rush : deux giga-octets laissent de quoi travailler sur
// un gros montage sans jamais y penser, tout en garantissant que le disque ne se
// remplit pas en silence pendant des mois d'usage.
//
// Les videos telechargees ne sont JAMAIS comptees ici ni effacees d'office :
// elles ne se refabriquent pas, et un projet qui s'en sert les perdrait.
// Un giga suffit desormais : les copies ne concernent plus que les formats
// que WebCodecs ne lit pas, et elles sont deux fois plus legeres.
const BUDGET = 1 * 1024 * 1024 * 1024;

/** Fichiers d'un cache, du moins recemment utilise au plus recent. */
function parAnciennete(dir, filtre) {
  const out = [];
  let noms = [];
  try { noms = fs.readdirSync(dir); } catch (_) { return out; }
  for (const f of noms) {
    if (!filtre(f)) continue;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (!st.isFile()) continue;
      // atime plutot que mtime : une copie relue tous les jours doit survivre a
      // une copie fabriquee hier et jamais rouverte. Windows ne rafraichit pas
      // toujours atime, d'ou le repli sur mtime quand il est plus recent.
      out.push({ plein: path.join(dir, f), taille: st.size, vu: Math.max(st.atimeMs, st.mtimeMs) });
    } catch (_) {}
  }
  return out.sort((a, b) => a.vu - b.vu);
}

/**
 * Ramene les caches refabricables sous le plafond, en commencant par ce qui n'a
 * pas servi depuis le plus longtemps.
 *
 * Appelee au demarrage puis regulierement : le menage doit se faire tout seul,
 * sans que l'utilisateur ait a y penser. Le bouton reste la pour qui veut
 * liberer la place tout de suite.
 */
function borner(cacheDir, budget) {
  const plafond = budget != null ? budget : BUDGET;
  const fichiers = [
    ...parAnciennete(path.join(cacheDir, '.apercus'), (f) => /\.mp4$/i.test(f)),
    ...parAnciennete(path.join(cacheDir, '.vignettes'), (f) => /\.jpg$/i.test(f)),
  ].sort((a, b) => a.vu - b.vu);

  let total = fichiers.reduce((n, f) => n + f.taille, 0);
  let octets = 0, nombre = 0;
  for (const f of fichiers) {
    if (total <= plafond) break;
    try {
      fs.unlinkSync(f.plein);
      total -= f.taille;
      octets += f.taille;
      nombre++;
    } catch (_) { /* fichier en cours de lecture : on le laisse, il partira plus tard */ }
  }
  return { octets, nombre, restant: total, plafond };
}

/** Marque une copie comme utilisee, pour qu'elle ne soit pas effacee la premiere. */
function toucher(fichier) {
  const t = new Date();
  try { fs.utimesSync(fichier, t, t); } catch (_) {}
}

module.exports = { etat, vider, borner, toucher, BUDGET };
