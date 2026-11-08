// Persistance locale des projets (IndexedDB).
//
// ATTENTION : un objet File range dans IndexedDB n'est PAS une simple
// reference. Chrome en recopie le contenu entier dans son profil — verifie :
// une video de 100 Mo reapparait, octet pour octet, dans le dossier
// IndexedDB du navigateur, sous un nouveau numero a CHAQUE enregistrement.
// L'enregistrement automatique (quelques secondes apres chaque modification)
// reecrivait donc tous les rushes du projet en tache de fond, pendant le
// montage. Depuis la v4, chaque fichier est range UNE fois dans un magasin a
// part, et un projet n'en garde que la cle.
// v2 : les projets sont indexes par identifiant stable (renommer ne cree plus
// de doublon) et portent une vignette.

const DB = 'cutlocal';
const STORE = 'projects2';
const META = 'meta';        // index leger : titre, vignette, dates — SANS les fichiers
const OLD = 'projects';
const FICHIERS = 'fichiers';  // cle -> File, partage par tous les projets
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    // Securite : si la base ne s'ouvre pas (migration bloquee par un autre
    // onglet, profil verrouille...), on echoue au lieu d'attendre sans fin.
    const guard = setTimeout(() => {
      dbp = null;
      rej(new Error('base de projets inaccessible — fermez les autres onglets de CutLocal'));
    }, 6000);
    const done = (fn) => (v) => { clearTimeout(guard); fn(v); };

    const r = indexedDB.open(DB, 4);
    r.onblocked = () => console.warn('IndexedDB : migration en attente (un autre onglet est ouvert)');
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      const tx = r.transaction;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FICHIERS)) db.createObjectStore(FICHIERS);
      // v3 : un index separe. Lister les projets chargeait jusque-la CHAQUE
      // enregistrement en entier — fichiers video compris — juste pour afficher
      // un titre et une vignette. Le menu mettait des secondes a s'ouvrir.
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'id' });
        if (ev.oldVersion >= 2) {
          try {
            const src = tx.objectStore(STORE);
            const dst = tx.objectStore(META);
            src.openCursor().onsuccess = (e) => {
              const cur = e.target.result;
              if (!cur) return;
              const v = cur.value || {};
              dst.put(resume(v));
              cur.continue();
            };
          } catch (_) {}
        }
      }
      // reprise des projets enregistres par l'ancienne version
      if (ev.oldVersion < 2 && db.objectStoreNames.contains(OLD)) {
        try {
          const src = tx.objectStore(OLD);
          const dst = tx.objectStore(STORE);
          src.getAll().onsuccess = (e) => {
            for (const rec of e.target.result || []) {
              const id = 'p' + Math.random().toString(36).slice(2, 10);
              dst.put({
                id,
                title: rec.name || 'Projet',
                project: rec.project,
                files: rec.files || {},
                playhead: rec.playhead || 0,
                thumb: null,
                savedAt: rec.savedAt || Date.now(),
                createdAt: rec.savedAt || Date.now(),
              });
            }
          };
        } catch (_) {}
      }
    };
    r.onsuccess = done(() => {
      const db = r.result;
      // libere la base si un autre onglet demande une migration
      db.onversionchange = () => { db.close(); dbp = null; };
      db.onclose = () => { dbp = null; };
      res(db);
    });
    r.onerror = done(() => rej(r.error || new Error('IndexedDB indisponible')));
  });
  return dbp;
}

function tx(mode, fn, store = STORE) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let req;
    try { req = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction annulee'));
  }));
}

/**
 * Resume d'un projet : tout ce que la liste affiche, et rien de plus.
 * Doit contenir CHAQUE information montree sur une carte — sans quoi la carte
 * affiche des blancs, puisqu'elle n'a plus acces au projet complet.
 */
function resume(rec) {
  const pr = rec.project || {};
  let fin = 0;
  for (const t of pr.tracks || []) {
    for (const c of t.clips || []) fin = Math.max(fin, (c.t0 || 0) + (c.dur || 0));
  }
  return {
    id: rec.id,
    title: rec.title,
    thumb: rec.thumb || null,
    savedAt: rec.savedAt || 0,
    createdAt: rec.createdAt || rec.savedAt || 0,
    clips: (pr.tracks || []).reduce((n, t) => n + (t.clips ? t.clips.length : 0), 0),
    medias: (pr.media || []).length,
    width: pr.width || 0,
    height: pr.height || 0,
    fps: pr.fps || 0,
    duration: fin,
  };
}

/** Identite d'un fichier : meme nom, meme taille, meme date = meme contenu. */
function cleFichier(f) {
  return [f.name || '', f.size || 0, f.lastModified || 0].join('|');
}

// cles deja rangees pendant cette session : evite de le redemander a la base
const ranges = new Set();

/** Range les fichiers absents du magasin ; renvoie {mediaId: cle}. */
async function rangerFichiers(files) {
  const cles = {};
  const aRanger = [];
  for (const [id, f] of Object.entries(files || {})) {
    if (!f) continue;
    const k = cleFichier(f);
    cles[id] = k;
    if (!ranges.has(k)) aRanger.push([k, f]);
  }
  if (!aRanger.length) return cles;
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction(FICHIERS, 'readwrite');
    const s = t.objectStore(FICHIERS);
    for (const [k, f] of aRanger) {
      // getKey ne lit pas le contenu : seul un fichier vraiment nouveau est ecrit
      const q = s.getKey(k);
      q.onsuccess = () => { if (q.result === undefined) s.put(f, k); };
    }
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction annulee'));
  });
  for (const [k] of aRanger) ranges.add(k);
  return cles;
}

export async function idbSave(rec) {
  const cles = await rangerFichiers(rec.files);
  const leger = { ...rec, files: {}, fileKeys: cles };
  await tx('readwrite', (s) => s.put(leger));
  // l'index suit, mais son echec ne doit pas faire perdre le projet
  try { await tx('readwrite', (s) => s.put(resume(leger)), META); } catch (_) {}
}

/** Projet complet, fichiers compris (anciens enregistrements acceptes tels quels). */
export async function idbGet(id) {
  const rec = await tx('readonly', (s) => s.get(id));
  if (!rec) return null;
  if (rec.fileKeys && Object.keys(rec.fileKeys).length) {
    const db = await open();
    const files = { ...(rec.files || {}) };
    await new Promise((resolve, reject) => {
      const t = db.transaction(FICHIERS, 'readonly');
      const s = t.objectStore(FICHIERS);
      for (const [mid, k] of Object.entries(rec.fileKeys)) {
        const q = s.get(k);
        q.onsuccess = () => { if (q.result) { files[mid] = q.result; ranges.add(k); } };
      }
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
    rec.files = files;
  }
  return rec;
}

/** Efface du magasin les fichiers qu'aucun projet ne reference plus. */
async function menageFichiers() {
  const tous = await tx('readonly', (s) => s.getAll()).catch(() => null);
  if (!Array.isArray(tous)) return;
  const utiles = new Set();
  for (const r of tous) for (const k of Object.values(r.fileKeys || {})) utiles.add(k);
  const cles = await tx('readonly', (s) => s.getAllKeys(), FICHIERS).catch(() => []);
  // Une cle servie pendant cette session peut appartenir a un projet dont
  // l'enregistrement est en vol : on ne la touche pas, le menage d'une
  // prochaine session s'en chargera.
  const morts = cles.filter((k) => !utiles.has(k) && !ranges.has(k));
  if (!morts.length) return;
  await tx('readwrite', (s) => { for (const k of morts) s.delete(k); }, FICHIERS).catch(() => {});
  for (const k of morts) ranges.delete(k);
}

/**
 * Efface TOUTES les copies de videos gardees dans le navigateur.
 *
 * Les projets restent, mais ceux qui n'ont que ces copies (enregistres avant
 * les poignees de fichier) devront retrouver leurs videos : un nouvel import
 * du meme fichier les rebranche.
 * @returns {Promise<number>} nombre de projets allege
 */
export async function idbViderCopies() {
  const tous = await tx('readonly', (s) => s.getAll()).catch(() => []);
  let n = 0;
  for (const r of tous || []) {
    const avait = Object.keys(r.files || {}).length || Object.keys(r.fileKeys || {}).length;
    if (!avait) continue;
    r.files = {};
    r.fileKeys = {};
    await tx('readwrite', (s) => s.put(r));
    n++;
  }
  await tx('readwrite', (s) => s.clear(), FICHIERS).catch(() => {});
  ranges.clear();
  return n;
}

export async function idbDelete(id) {
  await tx('readwrite', (s) => s.delete(id));
  try { await tx('readwrite', (s) => s.delete(id), META); } catch (_) {}
  menageFichiers().catch(() => {});
}

/**
 * Liste des projets, le plus recent d'abord.
 * On lit l'INDEX, pas les projets : charger chaque enregistrement complet —
 * fichiers video inclus — pour afficher un titre coutait plusieurs secondes.
 */
export async function idbList() {
  let all = await tx('readonly', (s) => s.getAll(), META).catch(() => null);
  // Index absent, vide, ou ecrit par une version qui ne notait pas encore la
  // definition : on le reconstruit une fois a partir des projets complets.
  const incomplet = Array.isArray(all) && all.some((r) => r.width === undefined);
  if (!Array.isArray(all) || !all.length || incomplet) {
    const full = await tx('readonly', (s) => s.getAll()).catch(() => []);
    all = (Array.isArray(full) ? full : []).map(resume);
    for (const r of all) { try { await tx('readwrite', (s) => s.put(r), META); } catch (_) {} }
  }
  menageFichiers().catch(() => {});
  return all.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}
