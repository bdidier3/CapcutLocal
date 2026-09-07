'use strict';
/*
 * Import depuis un lien (TikTok / Instagram / YouTube / ...).
 *
 * On ne reimplemente PAS l'extraction : elle change sans arret et depend des
 * protections des plateformes. On delegue a yt-dlp, l'outil de reference, s'il
 * est present sur la machine. Sinon on l'explique clairement a l'utilisateur.
 *
 * Aucun ffmpeg requis : on demande a yt-dlp un format deja pret en un seul
 * fichier (MP4 progressif pour la video, M4A/MP3 pour le son).
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// candidats, dans l'ordre de preference
const CANDIDATES = [
  { cmd: 'yt-dlp', args: [] },
  { cmd: 'yt-dlp.exe', args: [] },
  { cmd: 'python', args: ['-m', 'yt_dlp'] },
  { cmd: 'py', args: ['-m', 'yt_dlp'] },
];

let cached = null;   // { available, cmd, args, version }
let ffmpegOk = null; // ffmpeg present ? (necessaire pour fusionner deux flux)

/**
 * ffmpeg est-il disponible ?
 *
 * Sur YouTube, la meilleure definition n'existe qu'en flux SEPARES (video d'un
 * cote, audio de l'autre) : sans ffmpeg pour les recoller, on est limite aux
 * versions « tout-en-un », souvent plafonnees a 720p.
 */
async function hasFfmpeg() {
  if (ffmpegOk !== null) return ffmpegOk;
  ffmpegOk = await new Promise((resolve) => {
    let fini = false;
    // Meme precaution qu'ailleurs : un executable refuse par Windows fait
    // echouer le lancement sur place, sans passer par l'evenement d'erreur.
    let p2;
    try { p2 = spawn('ffmpeg', ['-version'], { windowsHide: true }); }
    catch (_) { resolve(false); return; }
    const t = setTimeout(() => { if (!fini) { fini = true; try { p2.kill(); } catch (_) {} resolve(false); } }, 4000);
    p2.on('error', () => { if (!fini) { fini = true; clearTimeout(t); resolve(false); } });
    p2.on('close', (code) => { if (!fini) { fini = true; clearTimeout(t); resolve(code === 0); } });
  });
  return ffmpegOk;
}

function tryOne(c) {
  return new Promise((res) => {
    // Un lancement peut echouer AVANT meme de demarrer, et l'erreur est alors
    // levee sur place au lieu d'arriver par le rappel : c'est ce qui se passe
    // quand Windows bloque un executable (« strategie de controle
    // d'application »). Sans ce filet, le premier candidat refuse faisait
    // echouer toute la recherche, et les suivants — dont « python -m yt_dlp »,
    // qui lance pourtant le meme outil — n'etaient jamais essayes.
    try {
      execFile(c.cmd, [...c.args, '--version'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return res(null);
        res({ ...c, version: String(stdout).trim().split(/\r?\n/)[0] });
      });
    } catch (_) { res(null); }
  });
}

/** Cherche yt-dlp. Resultat mis en cache (force=true pour re-tester). */
async function detect(force) {
  if (cached && !force) return cached;
  for (const c of CANDIDATES) {
    const found = await tryOne(c);
    if (found) { cached = { available: true, ...found }; return cached; }
  }
  cached = { available: false };
  return cached;
}

// --------------------------------------------------------------------- travaux

const jobs = new Map();

function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  // pas de cible locale
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1'
    || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
  return u.href;
}

/** Formats demandes : un seul fichier, pour ne pas dependre de ffmpeg. */
function formatArgs(mode, ffmpeg) {
  if (mode === 'audio') {
    // meilleure piste son disponible, puis repli sur ce qui existe
    return ['-f', 'ba/b', '-S', 'abr,asr,acodec:aac'];
  }

  // Tri explicite : d'abord la DEFINITION, puis la cadence, puis le debit. On
  // ne demande h264 qu'a definition egale — c'est le codec que l'editeur
  // decode le plus vite, mais jamais au prix de la qualite.
  const tri = ['-S', 'res,fps,hdr:12,br,vcodec:h264,size'];

  if (ffmpeg) {
    // ffmpeg present : on peut recoller video et audio separes, et donc
    // atteindre les definitions les plus hautes.
    return ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4', ...tri];
  }
  // Sans ffmpeg on ne peut prendre qu'un flux deja complet (video + son
  // ensemble) : on choisit le meilleur, en privilegiant le MP4 que l'editeur
  // decode le plus vite.
  return ['-f', [
    'b[ext=mp4][vcodec!=none][acodec!=none]',
    'b[vcodec!=none][acodec!=none]',
    'b',
  ].join('/'), ...tri];
}

/** Tous les fichiers apparus depuis `since` (mode compte : plusieurs videos). */
// ------------------------------------------------------------- noms de fichier

// Un hashtag : le croisillon, puis des lettres, chiffres ou tirets bas — de
// n'importe quel alphabet, les comptes francais ecrivant « #mamere » comme les
// comptes japonais ecrivent le leur.
const HASHTAG = /#([\p{L}\p{N}_]+)/gu;
// Longueur visee pour le nom complet. Windows refuse les chemins de plus de 260
// caracteres ; en laissant le nom sous 120 on garde de la marge pour le dossier
// de destination, ou qu'il se trouve.
const NOM_MAX = 120;

/**
 * Reduit un texte a ce qu'un nom de fichier accepte partout.
 *
 * Les accents sont decomposes puis leur marque retiree — « mamère » devient
 * « mamere » — plutot que supprimes avec la lettre : le nom reste lisible et
 * se tape au clavier. Les autres alphabets, eux, sont gardes tels quels ; un
 * hashtag japonais ou arabe disparaitrait entierement si on le repliait sur
 * l'alphabet latin. Tout ce qui n'est ni lettre ni chiffre — emoji, ponctuation,
 * espaces, et les caracteres que Windows refuse — devient un tiret bas.
 */
function motSimple(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
}

/** Hashtags d'une publication, dans l'ordre, sans doublon. */
function tagsDe(info) {
  // Le titre d'abord : c'est la que TikTok et Instagram les mettent. Les
  // descriptions YouTube en contiennent parfois des dizaines, tres loin dans le
  // texte — on ne lit que le debut, et jamais plus de huit en tout.
  const source = HASHTAG.test(String(info.title || ''))
    ? String(info.title) : String(info.description || '').slice(0, 400);
  HASHTAG.lastIndex = 0;
  const vus = new Set();
  const out = [];
  for (const m of source.matchAll(HASHTAG)) {
    const t = motSimple(m[1]);
    if (!t) continue;
    const cle = t.toLowerCase();
    if (vus.has(cle)) continue;
    vus.add(cle);
    out.push('#' + t);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Renomme le fichier telecharge pour faire apparaitre ses hashtags.
 *
 * yt-dlp ne sait pas le faire seul : son gabarit de nom n'a pas de champ
 * « hashtags », et l'option qui rend les noms sans surprise efface justement le
 * croisillon. On repart donc des metadonnees ecrites a cote du fichier, et on
 * rebatit le nom nous-memes — ce qui laisse aussi le controle sur la longueur.
 *
 * Le fichier de metadonnees ne sert qu'ici : il est efface aussitot.
 */
function renommerAvecTags(f, avecCompte) {
  const ext = path.extname(f.path);
  const infoJson = f.path.slice(0, f.path.length - ext.length) + '.info.json';
  let info = null;
  try { info = JSON.parse(fs.readFileSync(infoJson, 'utf8')); } catch (_) {}
  try { fs.unlinkSync(infoJson); } catch (_) {}
  if (!info) return f;

  const tags = tagsDe(info);
  if (!tags.length) return f;   // rien a ajouter : le nom de yt-dlp fait l'affaire

  // Le titre est repris sans ses hashtags : les reprendre deux fois, une fois
  // en mots puis une fois avec le croisillon, ne ferait qu'allonger le nom.
  HASHTAG.lastIndex = 0;
  const titre = motSimple(String(info.title || '').replace(HASHTAG, ' ')).slice(0, 40)
    .replace(/_+$/, '') || 'video';
  const compte = avecCompte && info.uploader ? motSimple(info.uploader) + '-' : '';
  const fin = (info.id ? '-' + motSimple(info.id) : '') + ext;

  let nom = compte + titre;
  let reste = NOM_MAX - nom.length - fin.length;
  for (const t of tags) {
    if (reste < t.length + 1) break;   // on s'arrete net plutot que de tronquer un tag
    nom += '_' + t;
    reste -= t.length + 1;
  }
  nom += fin;

  const cible = path.join(path.dirname(f.path), nom);
  if (cible === f.path) return f;
  // On ne remplace jamais un fichier existant : mieux vaut un nom moins parlant
  // qu'une video ecrasee.
  if (fs.existsSync(cible)) return f;
  try { fs.renameSync(f.path, cible); } catch (_) { return f; }
  return { path: cible, name: nom, size: f.size };
}

/** Metadonnees restees en place apres un telechargement interrompu. */
function balayerInfoJson(dir, depuis) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.info\.json$/i.test(f)) continue;
      const plein = path.join(dir, f);
      try {
        if (fs.statSync(plein).mtimeMs >= depuis - 1500) fs.unlinkSync(plein);
      } catch (_) {}
    }
  } catch (_) {}
}

function filesSince(dir, since, before) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isFile() || st.mtimeMs < since - 1500) continue;
    if (before && before.has(f)) continue;
    if (/\.(part|ytdl|tmp|txt|json)$/i.test(f)) continue;
    out.push({ path: full, name: f, size: st.size, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

function newestFileSince(dir, since, before) {
  let best = null;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isFile() || st.mtimeMs < since - 1500) continue;
    if (before && before.has(f)) continue;
    if (/\.(part|ytdl|tmp|json)$/i.test(f)) continue;
    if (!best || st.mtimeMs > best.mtime) best = { path: full, name: f, mtime: st.mtimeMs, size: st.size };
  }
  return best;
}

/**
 * Lance un telechargement. Renvoie l'identifiant du travail.
 * @param {string} url
 * @param {'video'|'audio'} mode
 * @param {string} outDir
 */
/** `@compte` ou `compte` -> adresse de la page TikTok du compte. */
function urlDeCompte(nom) {
  const n = String(nom || '').trim().replace(/^@+/, '');
  if (!n || !/^[A-Za-z0-9._]{2,30}$/.test(n)) return null;
  return `https://www.tiktok.com/@${n}`;
}

const NAVIGATEURS = ['chrome', 'edge', 'firefox', 'brave', 'chromium', 'opera', 'vivaldi'];

// Processus a chercher pour savoir si un navigateur tourne encore.
const PROCESSUS = {
  chrome: 'chrome.exe', edge: 'msedge.exe', firefox: 'firefox.exe',
  brave: 'brave.exe', chromium: 'chrome.exe', opera: 'opera.exe', vivaldi: 'vivaldi.exe',
};

/**
 * Le navigateur choisi tourne-t-il encore ?
 *
 * Sa base de cookies est verrouillee tant qu'il est ouvert. Le dire tout de
 * suite evite d'attendre un echec de plusieurs secondes pour apprendre qu'il
 * fallait simplement fermer une fenetre.
 */
function navigateurOuvert(nav) {
  const exe = PROCESSUS[nav];
  if (!exe || process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execFile('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH'], { timeout: 5000, windowsHide: true },
        (err, out) => resolve(!err && String(out).toLowerCase().includes(exe.toLowerCase())));
    } catch (_) { resolve(false); }
  });
}

/**
 * TikTok ne livre la liste des publications d'un compte qu'a une session
 * connectee ; sans cookies l'extracteur recoit une reponse vide. Les messages
 * bruts de yt-dlp n'aident pas, alors on dit quoi faire.
 */
/**
 * Un refus de ce genre ne dit rien du lien ni de la machine : le site est
 * momentanement indispose. TikTok en sert un apres une rafale de demandes
 * depuis la meme connexion, et il se leve seul au bout de quelques minutes.
 * Les erreurs qui ne figurent pas ici — lien mort, video privee, format
 * absent — ne s'arrangeront pas en attendant : les rejouer ferait perdre du
 * temps sans rien changer.
 */
const PASSAGER = new RegExp([
  'Unexpected response from webpage request',
  'HTTP Error 429',
  'Too Many Requests',
  'HTTP Error 5[0-9][0-9]',
  'Unable to download webpage',
  'The read operation timed out',
  'Connection reset',
  'Remote end closed connection',
].join('|'), 'i');

function passager(t) { return PASSAGER.test(String(t || '')); }
function expliquer(brut, opts) {
  const t = String(brut || '');
  if (/Failed to parse JSON|Unable to extract webpage video data/i.test(t) && opts.compte) {
    return opts.cookies
      ? "TikTok a refuse la liste du compte malgre les cookies de " + opts.cookies
        + ". Verifiez que vous y etes connecte dans ce navigateur."
      : "TikTok ne donne la liste des videos d'un compte qu'a un visiteur connecte."
        + " Choisissez votre navigateur dans « cookies » juste au-dessus, ou collez"
        + " directement le lien d'une video.";
  }
  // TikTok sert une page de verification anti-robot au lieu de la video quand
  // la demande ne vient pas d'une session connectee. yt-dlp ne peut alors rien
  // en tirer, et son message ne dit pas ce qu'il faut faire.
  if (/Unexpected response from webpage request/i.test(t)) {
    // Avec une session valide et un refus quand meme, la cause n'est plus le
    // compte mais le client lui-meme : TikTok reconnait un outil automatise.
    // yt-dlp le dit dans son journal (« impersonation target: None »).
    if (opts.cookies) {
      return 'Vos cookies sont bien pris en compte, mais TikTok refuse tout de'
        + " meme : il ne reconnait pas la requete comme venant d'un vrai"
        + " navigateur. C'est une protection anti-automatisation du site, pas"
        + ' un probleme de session ni de lien.';
    }
    // Ce refus est presque toujours temporaire, et vise la connexion, pas le
    // lien : le site le sert apres une serie de demandes rapprochees, puis le
    // leve seul. Le dire evite de chercher une panne qui n'existe pas — et de
    // relancer sans arret, ce qui ne fait que prolonger le blocage.
    return 'TikTok a renvoye une page de verification au lieu de la video, et'
      + " trois tentatives espacees n’ont rien change. Ce refus vise votre"
      + " connexion, pas le lien : il arrive apres plusieurs telechargements"
      + ' rapproches et se leve tout seul, en general au bout de quelques'
      + " dizaines de minutes. Reessayez plus tard sans rien changer ; insister"
      + ' maintenant ne ferait que prolonger le blocage. Si vous etes presse :'
      + " enregistrez la video depuis le site puis glissez le fichier dans"
      + ' CutLocal, il sera ajoute au montage comme les autres.';
  }
  // Sans ffmpeg on ne peut prendre qu'un fichier deja complet (image + son
  // ensemble). YouTube n'en propose plus : tout y est en flux separes, qu'il
  // faut recoller. Le message brut de yt-dlp — « format non disponible » —
  // laisse croire a un probleme de choix de qualite.
  if (/Requested format is not available/i.test(t) && !opts.ffmpeg) {
    return "Cette video n'existe qu'en flux separes (image d'un cote, son de"
      + " l'autre), et ffmpeg est necessaire pour les recoller. Il est"
      + " introuvable ou bloque sur cette machine.";
  }
  if (/Could not copy (Chrome|Chromium) cookie database/i.test(t)) {
    return 'Les cookies sont verrouilles tant que le navigateur tourne :'
      + ' fermez-le completement puis relancez le telechargement.';
  }
  // Chrome et Edge chiffrent leur base de cookies avec une cle liee a
  // l'application depuis leurs versions recentes. yt-dlp ne sait pas la lire,
  // meme navigateur ferme : inutile d'insister de ce cote-la.
  if (/Failed to decrypt with DPAPI|app-bound|DPAPI/i.test(t)) {
    return "Ce navigateur chiffre ses cookies d'une facon que l'outil ne sait"
      + " pas lire, meme ferme. Utilisez l'option « un fichier cookies.txt » :"
      + " exportez vos cookies avec une extension de navigateur, puis"
      + " choisissez le fichier ici.";
  }
  if (/could not find .* cookies database/i.test(t)) {
    return "Aucun profil trouve pour ce navigateur : choisissez-en un autre.";
  }
  return t;
}

/**
 * @param {string} url       lien direct, ou nom de compte si opts.compte
 * @param {'video'|'audio'} mode
 * @param {string} outDir
 * @param {object} opts      { compte:boolean, nombre:number, cookies:string, cookieFichier:string }
 */
async function start(url, mode, outDir, opts = {}) {
  // on valide la cible d'abord : le message d'erreur reste exact
  const cible = opts.compte ? urlDeCompte(url) : null;
  if (opts.compte && !cible) throw new Error('Nom de compte invalide (lettres, chiffres, point et tiret bas)');
  const clean = cible || safeUrl(url);
  if (!clean) throw new Error('Lien invalide : une adresse http/https publique est attendue');
  const tool = await detect();
  if (!tool.available) throw new Error('yt-dlp introuvable');
  const ffmpeg = await hasFfmpeg();

  const id = crypto.randomBytes(6).toString('hex');
  const before = new Set(fs.readdirSync(outDir));
  const startedAt = Date.now();

  // Sur un compte on prend les publications les plus recentes, en s'arretant a
  // un nombre choisi : parcourir un compte entier prendrait des minutes.
  const combien = Math.max(1, Math.min(50, Number(opts.nombre) || 10));
  const portee = opts.compte
    ? ['--yes-playlist', '--playlist-end', String(combien), '--download-archive',
       path.join(outDir, '.deja-telecharges.txt')]
    : ['--no-playlist'];

  // Lecture des cookies : c'est yt-dlp qui va les chercher dans le profil du
  // navigateur choisi par l'utilisateur. On ne touche jamais nous-memes a ce
  // magasin, et rien n'est lu tant qu'aucun navigateur n'est demande.
  const nav = NAVIGATEURS.includes(String(opts.cookies || '').toLowerCase())
    ? String(opts.cookies).toLowerCase() : '';
  // Un fichier de cookies exporte a la main marche meme navigateur ouvert, et
  // ne depend pas du chiffrement que les navigateurs appliquent a leur base.
  const fich = String(opts.cookieFichier || '').trim();
  const parFichier = fich && fs.existsSync(fich);
  // Chrome, Edge et Brave chiffrent leur base de cookies avec une cle liee a
  // l'application : la lire echoue meme navigateur ferme. Conseiller de le
  // fermer serait une perte de temps — on oriente directement vers le fichier.
  const CHIFFRES = ['chrome', 'edge', 'brave', 'chromium', 'opera', 'vivaldi'];
  if (!parFichier && CHIFFRES.includes(nav)) {
    throw new Error(`${nav.charAt(0).toUpperCase() + nav.slice(1)} chiffre ses cookies :`
      + ' les lire ne fonctionne pas, meme navigateur ferme. Choisissez plutot'
      + ' « un fichier cookies.txt » et indiquez le fichier exporte.');
  }
  if (!parFichier && nav && await navigateurOuvert(nav)) {
    throw new Error(`${nav.charAt(0).toUpperCase() + nav.slice(1)} est encore ouvert :`
      + ' sa base de cookies est verrouillee. Fermez-le completement (toutes les'
      + ' fenetres) puis relancez.');
  }
  const biscuits = parFichier ? ['--cookies', fich]
    : nav ? ['--cookies-from-browser', nav] : [];

  const args = [
    ...tool.args,
    ...portee,
    ...biscuits,
    '--no-warnings',
    '--newline',
    '--restrict-filenames',
    // Les metadonnees, ecrites a cote de chaque video : c'est la seule source
    // ou les hashtags figurent encore avec leur croisillon. On s'en sert pour
    // renommer, puis on les efface.
    '--write-info-json',
    '--no-part',
    // Sans ca, yt-dlp tente de reprendre un fichier homonyme deja present et
    // demande une plage au-dela de sa fin : le serveur repond 416.
    '--no-continue',
    '--retries', '3',
    '--socket-timeout', '20',
    '--concurrent-fragments', '4',   // telechargement plus rapide
    '--ignore-errors',               // une publication illisible n'arrete pas le reste
    ...formatArgs(mode, ffmpeg),
    '-o', path.join(outDir, opts.compte
      ? '%(uploader)s-%(title).50s-%(id)s.%(ext)s'
      : '%(title).70s-%(id)s.%(ext)s'),
    clean,
  ];

  const job = {
    id, url: clean, mode, state: 'running', percent: 0,
    title: null, dest: null, file: null, error: null, log: [],
    compte: !!opts.compte, attendus: opts.compte ? combien : 1, fichiers: [], ffmpeg,
    cookies: nav || (fich ? 'fichier' : ''),
  };
  jobs.set(id, job);

  // Le site peut refuser une demande parfaitement legitime pendant quelques
  // minutes — trop de requetes depuis la meme connexion, ou une verification
  // servie au hasard. Recommencer un peu plus tard suffit presque toujours, et
  // c'est un geste que l'application peut faire seule : obliger l'utilisateur a
  // recliquer sans lui dire quand serait lui faire deviner.
  //
  // Deux nouvelles tentatives, pas plus. Au-dela, le blocage dure, et faire
  // patienter en silence serait pire que de rendre la main avec une explication.
  const ATTENTES = [15000, 40000];

  const lancer = (essai) => {
    job.dest = null;
    job.error = null;
    job.etape = null;

    // spawn sans shell : aucune interpolation possible du lien
    let p;
    try { p = spawn(tool.cmd, args, { windowsHide: true }); }
    catch (e) { job.state = 'error'; job.error = e.message; return; }
    job.proc = p;

    const onLine = (line) => {
      if (!line) return;
      job.log.push(line);
      if (job.log.length > 200) job.log.shift();
      const pc = /(\d+(?:\.\d+)?)%/.exec(line);
      if (pc) job.percent = Math.min(99, parseFloat(pc[1]));
      const dest = /^\[download\]\s+Destination:\s+(.+)$/.exec(line);
      if (dest) job.dest = dest[1].trim();
      const already = /^\[download\]\s+(.+?) has already been downloaded/.exec(line);
      if (already) job.dest = already[1].trim();
      const title = /^\[info\].*?:\s*(.+)$/.exec(line);
      if (title && !job.title) job.title = title[1].trim();
    };

    let buf = '';
    const feed = (d) => {
      buf += d.toString('utf8');
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop();
      for (const l of parts) onLine(l.trim());
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', (d) => {
      feed(d);
      const s = d.toString('utf8');
      if (/ERROR/i.test(s) && !job.error) job.error = s.split('\n').find((l) => /ERROR/i.test(l)) || s;
    });

    p.on('error', (e) => { job.state = 'error'; job.error = e.message; });
    p.on('close', (code) => {
      if (job.state === 'cancelled') return;
      if (buf) onLine(buf.trim());
      let file = null;
      if (job.dest && fs.existsSync(job.dest)) {
        const st = fs.statSync(job.dest);
        file = { path: job.dest, name: path.basename(job.dest), size: st.size };
      } else {
        const found = newestFileSince(outDir, startedAt, before);
        if (found) file = { path: found.path, name: found.name, size: found.size };
      }
      // En mode compte on ramene TOUS les fichiers apparus, pas seulement le
      // dernier : c'est tout l'interet de viser un compte.
      job.fichiers = filesSince(outDir, startedAt, before)
        .map((f) => ({ path: f.path, name: f.name, size: f.size }));
      // Les hashtags de la publication doivent se lire dans le nom du fichier :
      // c'est ce qui permet de retrouver une video des mois plus tard sans avoir
      // a la rouvrir. On renomme avant d'annoncer le travail termine, pour que
      // l'interface ne montre jamais le nom provisoire.
      const renommes = new Map();
      job.fichiers = job.fichiers.map((f) => {
        const n = renommerAvecTags(f, !!opts.compte);
        renommes.set(f.path, n);
        return n;
      });
      if (file) file = renommes.get(file.path) || file;
      // Un telechargement interrompu laisse ses metadonnees derriere lui.
      balayerInfoJson(outDir, startedAt);

      if (job.compte && job.fichiers.length) {
        job.state = 'done';
        job.percent = 100;
        job.file = job.fichiers[job.fichiers.length - 1];
      } else if (code === 0 && file) {
        job.state = 'done';
        job.percent = 100;
        job.file = file;
        if (!job.fichiers.length) job.fichiers = [file];
      } else {
        if (!job.error) {
          job.error = code === 0 ? 'fichier introuvable apres telechargement'
            : 'yt-dlp a echoue (code ' + code + ')';
        }
        // Un refus passager se rejoue tout seul ; le compte a rebours est
        // affiche, pour qu'attendre soit un choix et non une impression de
        // blocage.
        if (essai < ATTENTES.length && passager(job.error)) {
          const dans = ATTENTES[essai];
          job.percent = 0;
          job.etape = 'Le site a refuse ; nouvelle tentative dans '
            + Math.round(dans / 1000) + ' s';
          job.minuteur = setTimeout(() => { job.minuteur = null; lancer(essai + 1); }, dans);
          return;
        }
        job.state = 'error';
        job.error = expliquer(job.error, { compte: job.compte, cookies: job.cookies, ffmpeg });
      }
    });
  };
  lancer(0);

  return id;
}


/**
 * Extrait une vignette (premiere image nette) d'une video, mise en cache sur
 * disque : refaire tourner ffmpeg a chaque affichage de la liste couterait
 * bien plus cher que de garder un JPEG de quelques kilo-octets.
 */
async function vignette(fichier, dossierCache) {
  if (!await hasFfmpeg()) return null;
  const dir = path.join(dossierCache, '.vignettes');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  let st;
  try { st = fs.statSync(fichier); } catch (_) { return null; }
  const cle = crypto.createHash('sha1')
    .update(fichier + '|' + st.size + '|' + Math.round(st.mtimeMs)).digest('hex').slice(0, 16);
  const dest = path.join(dir, cle + '.jpg');
  if (fs.existsSync(dest)) return dest;

  const ok = await new Promise((resolve) => {
    // -ss avant -i : ffmpeg saute directement, sans decoder tout le debut
    const p2 = spawn('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', fichier,
      '-frames:v', '1', '-vf', 'scale=-2:96', '-q:v', '5', '-y', dest], { windowsHide: true });
    const t = setTimeout(() => { try { p2.kill(); } catch (_) {} resolve(false); }, 15000);
    p2.on('error', () => { clearTimeout(t); resolve(false); });
    p2.on('close', (c) => { clearTimeout(t); resolve(c === 0); });
  });
  // Une video plus courte que la demi-seconde visee ne rend rien : on reessaie
  // sur la toute premiere image.
  if (!ok || !fs.existsSync(dest)) {
    const ok2 = await new Promise((resolve) => {
      const p3 = spawn('ffmpeg', ['-v', 'error', '-i', fichier,
        '-frames:v', '1', '-vf', 'scale=-2:96', '-q:v', '5', '-y', dest], { windowsHide: true });
      const t = setTimeout(() => { try { p3.kill(); } catch (_) {} resolve(false); }, 15000);
      p3.on('error', () => { clearTimeout(t); resolve(false); });
      p3.on('close', (c) => { clearTimeout(t); resolve(c === 0); });
    });
    if (!ok2 || !fs.existsSync(dest)) return null;
  }
  return dest;
}

function status(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return {
    id: j.id, state: j.state, percent: j.percent, title: j.title,
    etape: j.etape || null,
    error: j.error, file: j.file,
    compte: j.compte, attendus: j.attendus, fichiers: j.fichiers || [],
    cookies: j.cookies || '',
    ffmpeg: j.ffmpeg,
    log: j.log.slice(-6),
  };
}

function cancel(id) {
  const j = jobs.get(id);
  if (!j) return false;
  j.state = 'cancelled';
  // Une nouvelle tentative programmee doit mourir avec le travail, sinon elle
  // relancerait un telechargement que l'utilisateur vient d'annuler.
  if (j.minuteur) { clearTimeout(j.minuteur); j.minuteur = null; }
  try { j.proc.kill(); } catch (_) {}
  return true;
}

function forget(id) { jobs.delete(id); }

module.exports = {
  hasFfmpeg, urlDeCompte, detect, start, status, cancel, forget, NAVIGATEURS, vignette };
