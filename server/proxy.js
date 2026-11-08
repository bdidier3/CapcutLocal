'use strict';
/*
 * Copies allegees pour l'apercu (« proxys »).
 *
 * Un rush iPhone en 4K 60 i/s est fait pour etre archive, pas pour etre relu
 * huit fois par seconde dans un navigateur. A chaque coupe il faut ouvrir un
 * decodeur, l'amener au bon endroit et le laisser tourner ; sur un montage a
 * coupes rapides plusieurs de ces decodeurs se marchent dessus et l'image
 * decroche. Aucun reglage ne rattrape cela : c'est la matiere qui est trop
 * lourde.
 *
 * On fabrique donc une fois pour toutes une version legere de chaque source —
 * petite definition, images cles rapprochees, H.264 que toutes les machines
 * decodent en materiel — et l'apercu lit celle-la. L'export, lui, continue de
 * partir des fichiers d'origine : la copie ne sert qu'a regarder.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Cote le plus long de la copie.
//
// 1280 plutot que 1920 : la copie ne sert plus qu'aux formats que WebCodecs ne
// sait pas lire (WebM, MKV...), pour un apercu, et elle pese plus de deux fois
// moins sur le disque. L'export repart toujours du fichier d'origine.
const COTE_MAX = 1280;
// Une image cle chaque demi-seconde : c'est ce qui rend les sauts instantanes,
// et c'est exactement ce dont un montage a coupes rapides a besoin.
const GOP = 30;

const jobs = new Map();     // cle -> {etat, pct, err, proc}

function dossier(cacheDir) { return path.join(cacheDir, '.apercus'); }

/** Identifiant stable d'une source : son nom et sa taille suffisent ici. */
function cleDe(nom, taille) {
  return crypto.createHash('sha1')
    .update(String(nom || '') + '|' + String(taille || 0))
    .digest('hex').slice(0, 20);
}

function fichierDe(cacheDir, cle) { return path.join(dossier(cacheDir), cle + '.mp4'); }

function existe(cacheDir, cle) {
  try { return fs.statSync(fichierDe(cacheDir, cle)).size > 1024; } catch (_) { return false; }
}

/** Duree d'une video, pour transformer la progression de ffmpeg en pourcentage. */
function dureeDe(fichier) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1', fichier], { windowsHide: true });
    } catch (_) { resolve(0); return; }
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(0));
    p.on('close', () => resolve(parseFloat(out) || 0));
  });
}

/**
 * Fabrique la copie d'apercu. Renvoie tout de suite ; l'avancement se lit
 * avec etat().
 */
async function construire(source, cacheDir, cle) {
  if (jobs.has(cle) && jobs.get(cle).etat === 'encours') return cle;
  const dst = fichierDe(cacheDir, cle);
  try { fs.mkdirSync(dossier(cacheDir), { recursive: true }); } catch (_) {}
  if (existe(cacheDir, cle)) { jobs.set(cle, { etat: 'pret', pct: 100 }); return cle; }

  const job = { etat: 'encours', pct: 0, err: null };
  jobs.set(cle, job);
  const duree = await dureeDe(source);

  const tmp = dst + '.part';
  const args = [
    '-v', 'error', '-y', '-nostdin',
    // Decodage par la carte graphique : sur un rush 4K HEVC c'est l'etape la
    // plus couteuse, et la deleguer divise le temps par deux (23 s → 12 s sur
    // un rush de 26 s). « auto » retombe seul sur le processeur si le materiel
    // ne sait pas lire ce format.
    '-hwaccel', 'auto',
    '-i', source,
    // le cote le plus long descend a COTE_MAX, l'autre suit ; -2 garde des
    // dimensions paires, exigees par le format
    '-vf', `scale=w=${COTE_MAX}:h=${COTE_MAX}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    // Les instants des images doivent etre repris TELS QUELS : l'apercu se cale
    // dessus pour montrer exactement l'image que l'export produira. Une source
    // de telephone est a debit variable ; laisser ffmpeg regulariser la cadence
    // decalerait l'apercu d'une image par endroits.
    '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    // Pas de son : celui de l'apercu vient du fichier d'origine.
    '-an',
    '-movflags', '+faststart',
    // on ecrit dans un fichier temporaire : sans cette indication ffmpeg
    // cherche le format d'apres l'extension « .part » et abandonne
    '-f', 'mp4',
    '-progress', 'pipe:1',
    tmp,
  ];
  // Un executable refuse par Windows fait echouer le lancement sur place, sans
  // passer par l'evenement d'erreur. Sans ce filet, le travail restait
  // « en cours » pour toujours et l'interface annoncait une preparation qui
  // n'avait jamais commence.
  let p;
  try { p = spawn('ffmpeg', args, { windowsHide: true }); }
  catch (e) {
    job.etat = 'erreur';
    job.err = "ffmpeg n'a pas pu demarrer : " + e.message;
    try { fs.unlinkSync(tmp); } catch (_) {}
    return cle;
  }
  job.proc = p;
  // Priorite basse : la preparation ne doit jamais prendre le pas sur
  // l'application. Sans cela, ffmpeg monopolise les coeurs et l'apercu se fige
  // pendant que les copies se fabriquent — exactement ce qu'on cherche a eviter.
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}

  let reste = '';
  p.stdout.on('data', (d) => {
    reste += d.toString('utf8');
    const lignes = reste.split(/\r?\n/);
    reste = lignes.pop();
    for (const l of lignes) {
      const m = /^out_time_ms=(\d+)/.exec(l);
      if (m && duree > 0) job.pct = Math.min(99, (Number(m[1]) / 1e6 / duree) * 100);
    }
  });
  let err = '';
  p.stderr.on('data', (d) => { if (err.length < 2000) err += d.toString('utf8'); });

  p.on('error', (e) => { job.etat = 'erreur'; job.err = e.message; });
  p.on('close', (code) => {
    if (job.etat === 'annule') { try { fs.unlinkSync(tmp); } catch (_) {} return; }
    if (code === 0) {
      try {
        fs.renameSync(tmp, dst);
        job.etat = 'pret'; job.pct = 100;
      } catch (e) { job.etat = 'erreur'; job.err = e.message; }
    } else {
      try { fs.unlinkSync(tmp); } catch (_) {}
      job.etat = 'erreur';
      job.err = (err.split('\n').find((l) => l.trim()) || 'ffmpeg a echoue (code ' + code + ')').slice(0, 300);
    }
  });
  return cle;
}

function etat(cacheDir, cle) {
  if (existe(cacheDir, cle)) return { etat: 'pret', pct: 100 };
  const j = jobs.get(cle);
  if (!j) return { etat: 'absent', pct: 0 };
  // Un travail marque « pret » alors que le fichier n'est plus la veut dire
  // qu'on a fait le menage dans le dossier depuis. Le croire sur parole ferait
  // pointer l'apercu vers un fichier absent : l'image resterait figee pendant
  // que le son continue. On oublie et on refabriquera.
  if (j.etat === 'pret') { jobs.delete(cle); return { etat: 'absent', pct: 0 }; }
  return { etat: j.etat, pct: Math.round(j.pct), err: j.err || null };
}

function annuler(cle) {
  const j = jobs.get(cle);
  if (!j || j.etat !== 'encours') return false;
  j.etat = 'annule';
  try { j.proc.kill(); } catch (_) {}
  return true;
}

/**
 * Efface les sources temporaires oubliees d'une session precedente.
 *
 * Elles ne devraient pas survivre a la fabrication, mais un arret brutal ou un
 * fichier encore ouvert peut en laisser — et ce sont des centaines de Mo.
 */
function balayer(cacheDir) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dossier(cacheDir))) {
      if (!/\.src\.|\.part$/i.test(f)) continue;
      try { fs.unlinkSync(path.join(dossier(cacheDir), f)); n++; } catch (_) {}
    }
  } catch (_) {}
  return n;
}

/** Efface toutes les copies d'apercu (menage manuel). */
function vider(cacheDir) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dossier(cacheDir))) {
      try { fs.unlinkSync(path.join(dossier(cacheDir), f)); n++; } catch (_) {}
    }
  } catch (_) {}
  jobs.clear();
  return n;
}

module.exports = { cleDe, fichierDe, dossier, existe, construire, etat, annuler, vider, balayer, COTE_MAX };
