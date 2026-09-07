'use strict';
/*
 * Boites de dialogue natives sous Linux et macOS.
 *
 * Il n'existe pas d'equivalent unique aux fenetres de Windows : on passe par
 * l'assistant du bureau installe. zenity accompagne GNOME et Xfce — donc Kali
 * dans sa configuration courante — et kdialog accompagne KDE. On essaie l'un
 * puis l'autre, et si aucun n'est la on rend la main proprement : l'import par
 * glisser-deposer continue de fonctionner sans aucune de ces fenetres.
 */

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** Premier assistant disponible sur cette machine. */
let _assistant;
function assistant() {
  if (_assistant !== undefined) return _assistant;
  for (const c of ['zenity', 'kdialog']) {
    try {
      execFileSync('which', [c], { stdio: 'ignore' });
      _assistant = c;
      return _assistant;
    } catch (_) { /* pas celui-la */ }
  }
  _assistant = null;
  return null;
}

/** Lance l'assistant et rend ses lignes de sortie. Annuler donne une liste vide. */
function lancer(cmd, args) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args); }
    catch (_) { resolve([]); return; }
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.on('error', () => resolve([]));
    // Un code de sortie non nul veut dire « annule » : ce n'est pas une erreur,
    // et la sortie est alors vide de toute facon.
    p.on('close', () => resolve(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
  });
}

const VIDEOS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mts', 'm2ts', 'mpg', 'mpeg', '3gp', 'flv'];
const AUDIOS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'];
const IMAGES = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

async function openFiles(initialDir) {
  const a = assistant();
  if (!a) return [];
  if (a === 'kdialog') {
    const motifs = [...VIDEOS, ...AUDIOS, ...IMAGES].map((e) => '*.' + e).join(' ');
    return lancer('kdialog', ['--multiple', '--separate-output',
      '--getopenfilename', initialDir || os.homedir(), `${motifs}|Medias`]);
  }
  const filtre = (nom, exts) => `--file-filter=${nom} | ` + exts.map((e) => '*.' + e).join(' ');
  const args = ['--file-selection', '--multiple', '--separator=\n',
    '--title=Importer des medias',
    filtre('Medias', [...VIDEOS, ...AUDIOS, ...IMAGES]),
    filtre('Videos', VIDEOS), filtre('Audio', AUDIOS), filtre('Images', IMAGES),
    '--file-filter=Tous les fichiers | *'];
  if (initialDir && fs.existsSync(initialDir)) args.push('--filename=' + initialDir + path.sep);
  return lancer('zenity', args);
}

async function pickCookies() {
  const a = assistant();
  if (!a) return null;
  const dep = path.join(os.homedir(), 'Downloads');
  if (a === 'kdialog') {
    const r = await lancer('kdialog', ['--getopenfilename', dep, '*.txt|Fichier de cookies']);
    return r[0] || null;
  }
  const r = await lancer('zenity', ['--file-selection', '--title=Choisir le fichier de cookies',
    '--file-filter=Fichier de cookies | *.txt', '--file-filter=Tous les fichiers | *',
    '--filename=' + dep + path.sep]);
  return r[0] || null;
}

async function saveFile(defaultName, initialDir) {
  const a = assistant();
  if (!a) return null;
  const nom = defaultName || 'export.mp4';
  const dir = initialDir && fs.existsSync(initialDir) ? initialDir : desktopDir();
  const propose = path.join(dir, nom);
  if (a === 'kdialog') {
    const r = await lancer('kdialog', ['--getsavefilename', propose, '*.mp4|Video MP4']);
    return r[0] || null;
  }
  const r = await lancer('zenity', ['--file-selection', '--save', '--confirm-overwrite',
    '--title=Exporter la video', '--file-filter=Video MP4 | *.mp4',
    '--filename=' + propose]);
  if (!r[0]) return null;
  // L'assistant n'ajoute pas l'extension : sans elle, le fichier produit ne
  // s'ouvrirait au double-clic dans aucun lecteur.
  return /\.mp4$/i.test(r[0]) ? r[0] : r[0] + '.mp4';
}

async function pickFolder() {
  const a = assistant();
  if (!a) return null;
  const r = a === 'kdialog'
    ? await lancer('kdialog', ['--getexistingdirectory', os.homedir()])
    : await lancer('zenity', ['--file-selection', '--directory', '--title=Choisir un dossier']);
  return r[0] || null;
}

/**
 * Chemin du Bureau.
 *
 * Il est traduit selon la langue de la session — « Bureau » en francais — et
 * l'outil freedesktop est le seul a le savoir. On ne devine que s'il manque.
 */
function desktopDir() {
  try {
    const d = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim();
    if (d && fs.existsSync(d)) return d;
  } catch (_) { /* outil absent : on tente les noms habituels */ }
  for (const n of ['Desktop', 'Bureau']) {
    const d = path.join(os.homedir(), n);
    try { if (fs.statSync(d).isDirectory()) return d; } catch (_) {}
  }
  return os.homedir();
}

module.exports = { openFiles, saveFile, pickFolder, pickCookies, desktopDir, assistant };
