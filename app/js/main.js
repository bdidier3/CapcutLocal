// Point d'entree : assemble l'etat, le rendu, la timeline et les commandes.
import { $, $$, el, clamp, fmtTime, fmtSize, toast, uid, debounce, modKey, drag } from './util.js';
import {
  Store, newProject, newTextClip, newClip, newTrack, projectDuration,
  normalizeTrack, mediaOf, newMask, MASK_SHAPES,
  layoutTrack, relayoutAll, migrateProject, findClip,
} from './state.js';
import { Library } from './library.js';
import { Renderer } from './renderer.js';
import { Player } from './playback.js';
import { Timeline, showMenu } from './timeline.js';
import { Inspector } from './inspector.js';
import { MaskOverlay } from './maskoverlay.js';
import { Exporter, RES_PRESETS, FPS_PRESETS, CODECS, suggestBitrate, pickFastDefault } from './exporter.js';
import { invalidateText } from './compose.js';
import { idbSave, idbGet, idbList, idbViderCopies, idbPoignee } from './idb.js';
import { detecterTemps } from './beats.js';
import { Home } from './home.js';
import { Prechauffe } from './prechauffe.js';
import { FichierDistant } from './fichierdistant.js';
import { reverseClip, freezeFrame, trimBefore, trimAfter } from './tools.js';
import { TEXT_STYLES, applyStyle, fontCss } from './fonts.js';

const TK = window.__TK;
const SVGNS = 'http://www.w3.org/2000/svg';

/** Icone du sprite. */
function icon(name, cls = 'i') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', cls);
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}

// ------------------------------------------------------------------- amorcage

const store = new Store(newProject());
const lib = new Library(store);
let renderer, player, timeline, inspector, overlay;

try {
  renderer = new Renderer($('#gl'));
} catch (e) {
  document.body.innerHTML = `<div style="padding:40px;font:14px sans-serif;color:#eee">
    <h2>WebGL2 requis</h2><p>${e.message}</p>
    <p>Utilisez Chrome ou Edge a jour.</p></div>`;
  throw e;
}
player = new Player(store, lib, renderer);
// les vignettes se font discretes pendant la lecture
// (et pendant qu'on coupe ou deplace la tete : l'apercu a besoin du disque)
// (et 1,5 s apres chaque action : pendant qu'on navigue, le disque est a l'apercu)
lib.occupe = () => player.playing || player._attenteVue === true || performance.now() - (player.derniereAction || 0) < 1500;
// Les vignettes de la timeline sont de toutes petites lectures (une image cle) :
// elles n'attendent que la lecture et l'image en cours, pas la fin de la navigation.
lib.occupeVignettes = () => player.playing || player._attenteVue === true || performance.now() - (player.derniereAction || 0) < 300;

// Lecture anticipee des passages utiles des rushes (voir prechauffe.js).
const prechauffe = new Prechauffe(store, lib, player);
prechauffe.surEtat = ({ fait, total }) => {
  const e = $('#prechauffe');
  if (!e) return;
  // inutile de montrer une preparation de quelques secondes
  const visible = total > 48 * 1024 * 1024 && fait < total;
  e.classList.toggle('hidden', !visible);
  if (visible) e.textContent = `Preparation des videos ${Math.floor((fait / total) * 100)} %`;
};
overlay = new MaskOverlay($('#overlay'), store, player);
timeline = new Timeline($('#timeline'), store, lib, player);
timeline.canvas.addEventListener('pointerdown', () => activateZone('timeline'));
$('#overlay').addEventListener('pointerdown', () => activateZone('timeline'));
inspector = new Inspector($('#inspector'), store, player, lib, overlay);

if (typeof VideoEncoder === 'undefined') {
  toast('Ce navigateur ne peut pas encoder de video. Le montage marche, pas l\'export.', 'error', 9000);
}

// ---------------------------------------------- panneaux redimensionnables

// bornes volontairement larges : on peut presque replier chaque zone
const LIMITS = { left: [200, 620], right: [150, 680], tl: [44, 900] };
const CSSVAR = { left: '--left-w', right: '--right-w', tl: '--tl-h' };
const MIN_VIEWER = 150;   // hauteur mini de la zone apercu + transport
const MIN_CENTER = 240;   // largeur mini de la colonne centrale

function getPanel(k) {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(CSSVAR[k])) || 0;
}

/** Bornes reelles, calculees d'apres la taille de la fenetre. */
function limitsFor(k) {
  const [lo, hi] = LIMITS[k];
  if (k === 'tl') {
    // la timeline ne doit jamais ecraser l'apercu
    const avail = window.innerHeight - 56 - 10 - 44 - 10 - MIN_VIEWER;
    return [lo, clamp(Math.min(hi, avail), lo, hi)];
  }
  const other = k === 'left' ? getPanel('right') : getPanel('left');
  const avail = window.innerWidth - 20 - other - 20 - MIN_CENTER;
  return [lo, clamp(Math.min(hi, avail), lo, hi)];
}

function setPanel(k, v) {
  const [lo, hi] = limitsFor(k);
  document.documentElement.style.setProperty(CSSVAR[k], clamp(v, lo, hi) + 'px');
}

/** Re-applique les bornes quand la fenetre change de taille. */
function reclampPanels() {
  for (const k of Object.keys(CSSVAR)) setPanel(k, getPanel(k));
  layoutStage();
}
window.addEventListener('resize', reclampPanels);

function saveLayout() {
  const out = {};
  for (const k of Object.keys(CSSVAR)) out[k] = getPanel(k);
  try { localStorage.setItem('cutlocal.layout', JSON.stringify(out)); } catch (_) {}
}

function initSplitters() {
  try {
    const saved = JSON.parse(localStorage.getItem('cutlocal.layout') || '{}');
    for (const k of Object.keys(CSSVAR)) if (saved[k]) setPanel(k, saved[k]);
  } catch (_) {}

  for (const sp of $$('.split-v, .split-h')) {
    const key = sp.dataset.split;
    sp.addEventListener('pointerdown', (e) => {
      const start = getPanel(key);
      sp.classList.add('act');
      drag(e, {
        cursor: key === 'tl' ? 'row-resize' : 'col-resize',
        onMove: (dx, dy) => {
          const d = key === 'left' ? dx : key === 'right' ? -dx : -dy;
          setPanel(key, start + d);
          layoutStage();
          timeline.draw();
        },
        onEnd: () => { sp.classList.remove('act'); saveLayout(); layoutStage(); },
      });
    });
    // double-clic : ajuster au contenu (timeline) ou revenir au defaut (panneaux)
    sp.addEventListener('dblclick', () => {
      if (key === 'tl') setPanel('tl', timeline.contentHeight() + 6);
      else setPanel(key, { left: 300, right: 320 }[key]);
      saveLayout(); layoutStage(); timeline.draw();
    });
  }
}

// -------------------------------------------------------------- mise en page

const viewer = $('#viewer'), stage = $('#stage');

function layoutStage() {
  const p = store.project;
  const pad = 18;
  const vw = Math.max(40, viewer.clientWidth - pad * 2);
  const vh = Math.max(40, viewer.clientHeight - pad * 2);
  const ar = p.width / p.height;
  let w = vw, h = w / ar;
  if (h > vh) { h = vh; w = h * ar; }
  stage.style.width = Math.round(w) + 'px';
  stage.style.height = Math.round(h) + 'px';
  overlay.setStage(Math.round(w), Math.round(h));
}
new ResizeObserver(layoutStage).observe(viewer);

/** Format lisible : « 9:16 » plutot que « 1080×1920 », la definition en infobulle. */
function ratioDe(w, h) {
  const pgcd = (a, b) => (b ? pgcd(b, a % b) : a);
  const g = pgcd(Math.round(w), Math.round(h)) || 1;
  const a = Math.round(w / g), b = Math.round(h / g);
  if (a <= 32 && b <= 32) return `${a}:${b}`;
  const r = w / h;                                   // definitions non standard
  for (const [x, y] of [[16, 9], [9, 16], [1, 1], [4, 3], [3, 4], [4, 5], [21, 9]]) {
    if (Math.abs(r - x / y) < 0.02) return `${x}:${y}`;
  }
  return `${Math.round(w)}×${Math.round(h)}`;
}

function refreshHeader() {
  const p = store.project;
  $('#projFmt').textContent = ratioDe(p.width, p.height);
  $('#btnFmt').title = `Format du projet : ${p.width}×${p.height}, ${p.fps} i/s — cliquer pour le changer`;
  $('#projName').value = p.name;
  $('#tcTot').textContent = fmtTime(projectDuration(p), p.fps);
  $('#viewerEmpty').classList.toggle('hidden', p.media.length > 0);
}

store.on('change', () => { refreshHeader(); renderBin(); scheduleAutosave(); prechauffe.demander(); etatEnregistrement(false); });

/** Pastille « Enregistre » / « Modifie » de la barre du haut. */
function etatEnregistrement(ok) {
  const b = $('#btnSave');
  if (!b) return;
  b.classList.toggle('dirty', !ok);
  $('#saveState').textContent = ok ? 'Enregistre' : 'Modifie';
}
$('#btnFmt').onclick = () => $('#btnSettings').click();
// tete deplacee a la main : on prechauffe d'abord autour de sa nouvelle position
// tout deplacement de la tete (y compris en glissant sur la regle) compte
// comme une action : les travaux de fond laissent le disque a l'apercu
store.on('seek', () => { if (!player.playing) { player.derniereAction = performance.now(); prechauffe.demander(); signalerOccupe(); } });
player.on('playstate', (on) => { if (on) signalerOccupe(); });

/** Previent le serveur qu'on se sert du disque (au plus deux fois par seconde). */
function signalerOccupe() {
  const t = performance.now();
  if (t - (signalerOccupe.a || 0) < 500) return;
  signalerOccupe.a = t;
  fetch(`/api/occupe?tk=${TK}`).catch(() => {});
}
setInterval(() => { if (player.playing) signalerOccupe(); }, 1000);
store.on('seek', () => { $('#tcCur').textContent = fmtTime(store.playhead, store.project.fps); });
store.on('reload', () => { layoutStage(); refreshHeader(); renderBin(); inspector.render(); });
// L'apercu n'affiche jamais un plan approximatif : quand l'image demandee
// n'est pas encore decodee il ne montre rien, et ce voyant explique l'attente.
let attenteTimer = 0;
player.on('attente', (en) => {
  clearTimeout(attenteTimer);
  if (!en) { $('#stageAttente').classList.add('hidden'); return; }
  // court delai : sans lui le voyant clignoterait a chaque coupe alors que
  // l'image arrive en quelques dizaines de millisecondes
  attenteTimer = setTimeout(() => $('#stageAttente').classList.remove('hidden'), 120);
});

// video introuvable a l'image : un message clair et de quoi la retrouver
player.on('manquant', (m) => $('#stageManquant').classList.toggle('hidden', !m));
$('#btnRetrouverApercu').onclick = () => retrouverVideos();
// fichier retrouve : l'apercu oublie ce qu'il avait tente sans lui
lib.surRelie = (id) => { player.oublierMedia(id); timeline.draw(); };

player.on('stats', (s) => { $('#stats').textContent = `${s.fps} i/s · ${s.ms.toFixed(1)} ms`; });

// -------------------------------------------------------- rail de rubriques

let activeTab = 'media';

function setTab(tab) {
  activeTab = tab;
  for (const b of $$('.rail-btn')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const p of $$('.tabpane')) p.classList.toggle('on', p.dataset.pane === tab);
  if (tab === 'text') buildTextPane();
  if (tab === 'mask') buildMaskPane();
  if (tab === 'trans') buildTransPane();
  if (tab === 'tools') buildToolsPane();
  if (tab === 'audio') renderBin();
}
for (const b of $$('.rail-btn')) b.onclick = () => setTab(b.dataset.tab);

// -------------------------------------------------------------- bibliotheque

const binSel = new Set();
let binAnchor = null;          // point de depart pour Maj+clic
let binFilter = 'all';
let binQuery = '';

for (const c of $$('#mFilters .chip-f')) {
  c.onclick = () => {
    binFilter = c.dataset.f;
    for (const x of $$('#mFilters .chip-f')) x.classList.toggle('on', x === c);
    renderBin();
  };
}
$('#mSearch').oninput = (e) => { binQuery = e.target.value.trim().toLowerCase(); renderBin(); };

function usedInTimeline(mediaId) {
  return store.project.tracks.some((t) => t.clips.some((c) => c.mediaId === mediaId));
}

function mediaCard(m) {
  const missing = !lib.files.has(m.id);
  const th = el('div', { class: 'mthumb' });
  if (m.thumb) th.style.backgroundImage = `url(${m.thumb})`;
  else th.append(icon(m.kind === 'audio' ? 'wave' : m.kind === 'image' ? 'image' : 'film', 'i'));

  if (m.duration) th.append(el('span', { class: 'dur', text: fmtTime(m.duration) }));
  th.append(el('span', { class: 'kindic' }, icon(m.kind === 'audio' ? 'music' : m.kind === 'image' ? 'image' : 'film')));
  if (usedInTimeline(m.id)) th.append(el('span', { class: 'used', title: 'Deja sur la timeline' }, icon('check')));
  th.append(el('button', {
    class: 'add', title: 'Ajouter a la suite sur la timeline',
    onclick: (e) => { e.stopPropagation(); addMediaToTimeline(m.id); },
  }, icon('plus')));
  th.append(el('button', {
    class: 'ovl-btn',
    title: m.kind === 'audio'
      ? 'Ajouter sur une NOUVELLE piste audio (a la tete de lecture) — pour superposer plusieurs sons'
      : 'Superposer sur une nouvelle couche video (a la tete de lecture)',
    onclick: (e) => { e.stopPropagation(); cmdAddOverlay(m.id); },
  }, icon('layers')));
  th.append(el('button', {
    class: 'rm', title: 'Retirer de la bibliotheque',
    onclick: (e) => { e.stopPropagation(); removeMedia(m.id); },
  }, icon('close')));
  if (m.loading) th.append(el('div', { class: 'busy', text: '…' }));

  const card = el('div', {
    class: 'mcard' + (binSel.has(m.id) ? ' on' : '') + (missing ? ' miss' : ''),
    draggable: !missing,
    'data-mid': m.id,
    title: m.name + (missing ? '\n(fichier introuvable — double-clic pour le retrouver)' : '')
      + (m.width ? `\n${m.width}×${m.height}` : '') + (m.codec ? '\n' + m.codec : ''),
    ondblclick: () => (missing ? retrouverVideos() : addMediaToTimeline(m.id)),
    onpointerdown: () => activateZone('bin'),
    onclick: (e) => {
      if (e.shiftKey) selectBinRange(m.id);
      else if (modKey(e)) { binSel.has(m.id) ? binSel.delete(m.id) : binSel.add(m.id); binAnchor = m.id; }
      else { binSel.clear(); binSel.add(m.id); binAnchor = m.id; }
      renderBin();
    },
    oncontextmenu: (e) => {
      e.preventDefault();
      activateZone('bin');
      if (!binSel.has(m.id)) { binSel.clear(); binSel.add(m.id); binAnchor = m.id; renderBin(); }
      const n = binSel.size;
      showMenu(e.clientX, e.clientY, [
        { label: n > 1 ? `Ajouter les ${n} a la suite` : 'Ajouter a la suite',
          fn: () => [...binSel].forEach((id) => addMediaToTimeline(id, { silent: n > 1 })) },
        { label: m.kind === 'audio' ? 'Ajouter sur une nouvelle piste audio' : 'Superposer par-dessus',
          fn: () => cmdAddOverlay(m.id) },
        n > 1 ? { label: `Empiler les ${n} sur des pistes separees`, fn: () => stackOnOwnTracks([...binSel]) } : { sep: true },
        { label: 'Nouvelle vignette', fn: async () => { m.thumb = await lib.grabThumb(m); store.changed('media'); } },
        { sep: true },
        { label: n > 1 ? `Supprimer les ${n} medias  (Suppr)` : 'Supprimer  (Suppr)', fn: removeSelectedMedia },
      ]);
    },
    ondragstart: (e) => {
      e.dataTransfer.setData('text/media-id', m.id);
      e.dataTransfer.setData('text/kind-' + m.kind, '1');   // lisible des le survol
      e.dataTransfer.effectAllowed = 'copy';
    },
  }, th, el('div', { class: 'mname', text: m.name }));
  return card;
}

/** Selection d'une plage (Maj+clic) dans l'ordre affiche. */
function selectBinRange(id) {
  const ids = visibleBinIds();
  const a = ids.indexOf(binAnchor), b = ids.indexOf(id);
  if (a < 0 || b < 0) { binSel.clear(); binSel.add(id); binAnchor = id; return; }
  binSel.clear();
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) binSel.add(ids[i]);
}

/** Identifiants des cartes actuellement affichees, dans l'ordre. */
function visibleBinIds() {
  const host = activeTab === 'audio' ? $('#binAudio') : $('#bin');
  return [...host.querySelectorAll('.mcard')].map((c) => c.dataset.mid);
}

/** Met a jour l'etat visuel sans reconstruire (pour le rectangle de selection). */
function paintBinSelection() {
  for (const c of document.querySelectorAll('.mcard')) {
    c.classList.toggle('on', binSel.has(c.dataset.mid));
  }
  updateBinCount();
}

function updateBinCount() {
  const n = binSel.size;
  const b = $('#btnAddSel');
  b.lastChild.textContent = n > 1 ? `Ajouter ${n} medias a la timeline`
    : n === 1 ? 'Ajouter a la timeline' : 'Ajouter tout a la timeline';
  // rien a ajouter tant que la bibliotheque est vide
  b.parentElement.classList.toggle('hidden', !store.project.media.length);
  const badge = $('#binSelInfo');
  if (badge) {
    badge.textContent = n ? `${n} selectionne${n > 1 ? 's' : ''} · Suppr pour supprimer` : '';
    badge.classList.toggle('hidden', !n);
  }
}

/** Supprime tous les medias selectionnes (les fichiers sur le disque sont intacts). */
function removeSelectedMedia() {
  const ids = [...binSel];
  if (!ids.length) return toast('Aucun media selectionne', 'warn', 1600);
  const used = ids.filter((id) => usedInTimeline(id));
  const msg = ids.length === 1
    ? `Retirer « ${(store.project.media.find((m) => m.id === ids[0]) || {}).name } » de la bibliotheque ?`
      + (used.length ? '\n\nIl est utilise dans la timeline : ses clips seront supprimes.' : '')
      + '\n\nLe fichier sur votre disque n\'est pas touche.'
    : `Retirer ${ids.length} medias de la bibliotheque ?`
      + (used.length ? `\n\n${used.length} sont utilises dans la timeline : leurs clips seront supprimes.` : '')
      + '\n\nVos fichiers sur le disque ne sont pas touches.';
  if (!confirm(msg)) return;
  store.edit('supprimer medias', (p) => {
    for (const t of p.tracks) t.clips = t.clips.filter((c) => !ids.includes(c.mediaId));
    p.media = p.media.filter((m) => !ids.includes(m.id));
  });
  for (const id of ids) { lib.remove(id); binSel.delete(id); player.disposeClip(id); }
  binAnchor = null;
  player.invalidate();
  toast(`${ids.length} media(s) retire(s)`, 'ok');
}

// ------------------------------------- rectangle de selection dans les medias

function initBinMarquee(host) {
  host.addEventListener('pointerdown', (e) => {
    activateZone('bin');
    if (e.button !== 0) return;
    if (e.target.closest('.mcard') || e.target.closest('.dropzone') || e.target.closest('button')) return;
    const additive = e.shiftKey || modKey(e);
    const base = additive ? new Set(binSel) : new Set();
    const sx = e.clientX, sy = e.clientY;
    const box = el('div', { class: 'bin-marquee' });
    host.append(box);
    let engaged = false;

    drag(e, {
      cursor: 'crosshair',
      onMove: (dx, dy, ev) => {
        if (!engaged && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        engaged = true;
        const x0 = Math.min(sx, ev.clientX), x1 = Math.max(sx, ev.clientX);
        const y0 = Math.min(sy, ev.clientY), y1 = Math.max(sy, ev.clientY);
        const hr = host.getBoundingClientRect();
        box.style.left = (x0 - hr.left + host.scrollLeft) + 'px';
        box.style.top = (y0 - hr.top + host.scrollTop) + 'px';
        box.style.width = (x1 - x0) + 'px';
        box.style.height = (y1 - y0) + 'px';
        const ids = new Set(base);
        for (const card of host.querySelectorAll('.mcard')) {
          const cr = card.getBoundingClientRect();
          if (cr.left < x1 && cr.right > x0 && cr.top < y1 && cr.bottom > y0) ids.add(card.dataset.mid);
        }
        binSel.clear();
        for (const i of ids) binSel.add(i);
        paintBinSelection();
      },
      onEnd: () => {
        box.remove();
        if (!engaged) {                      // simple clic dans le vide : on vide
          binSel.clear();
          for (const i of base) binSel.add(i);
          if (!additive) binAnchor = null;
        }
        renderBin();
      },
    });
  });
}

// ------------------------------------------------ import depuis un lien

const PLATFORMS = [
  [/tiktok\./i, 'TikTok'],
  [/instagram\./i, 'Instagram'],
  [/(youtube\.|youtu\.be)/i, 'YouTube'],
  [/(twitter\.|x\.com)/i, 'X / Twitter'],
  [/facebook\.|fb\.watch/i, 'Facebook'],
  [/vimeo\./i, 'Vimeo'],
  [/dailymotion\./i, 'Dailymotion'],
  [/soundcloud\./i, 'SoundCloud'],
  [/twitch\./i, 'Twitch'],
  [/reddit\./i, 'Reddit'],
];

let dlMode = 'video';
let dlJob = null;
let dlPoll = 0;

function platformOf(url) {
  for (const [re, name] of PLATFORMS) if (re.test(url)) return name;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; }
}

async function openDownload(mode) {
  dlMode = mode;
  const dlg = $('#dlgDl');
  $('#dlTitle').textContent = mode === 'audio'
    ? 'Telecharger le son depuis un lien' : 'Telecharger la video depuis un lien';
  setDlMode(mode);
  resetDlProgress();
  dlg.showModal();
  const u = $('#dlUrl');
  u.focus();
  // compte TikTok : le dernier utilise, sinon celui par defaut
  $('#dlCompte').value = localStorage.getItem(COMPTE_CLE) || COMPTE_DEFAUT;
  $('#dlCookies').value = localStorage.getItem(COOKIES_CLE) || '';
  majCookies();
  majModeCompte();
  // La detection de yt-dlp et la lecture du dossier ne doivent pas faire
  // attendre le formulaire : elles se font derriere.
  checkTool().catch(() => {});
  chargerDossier().catch(() => {});
  // colle automatiquement un lien deja dans le presse-papiers
  try {
    const txt = (await navigator.clipboard.readText()).trim();
    if (/^https?:\/\//i.test(txt) && !u.value) { u.value = txt; onDlUrl(); }
  } catch (_) {}
}

// ------------------------------------------- dossier des telechargements

const COMPTE_CLE = 'cutlocal.compteTiktok';
const COMPTE_DEFAUT = '@clip2ep.fan';
const COOKIES_CLE = 'cutlocal.cookiesNavigateur';
const dossierSel = new Set();

/** Liste les fichiers deja telecharges, avec de quoi faire le menage. */
/** Ligne d'etat du telechargement, avec roue d'attente quand ca travaille. */
function etatDl(texte, occupe) {
  const n = $('#dlState');
  n.innerHTML = '';
  if (occupe) n.append(el('span', { class: 'spin' }));
  n.append(document.createTextNode(texte));
}

async function chargerDossier() {
  const bloc = $('#dlDossier');
  const liste = $('#dlListe');
  bloc.classList.remove('hidden');
  liste.innerHTML = '';
  liste.append(el('div', { class: 'dl-vide' }, el('span', { class: 'spin' }), ' Lecture du dossier…'));

  const r = await fetch(`/api/dl/folder?tk=${TK}`).then((x) => x.json()).catch(() => null);
  if (!r) {
    liste.innerHTML = '';
    liste.append(el('div', { class: 'dl-vide', text: 'Dossier illisible.' }));
    return;
  }
  $('#dlDossierTitre').textContent = `Telechargements — ${r.items.length} fichier(s)`;
  liste.innerHTML = '';
  dossierSel.clear();
  if (!r.items.length) {
    liste.append(el('div', { class: 'dl-vide', text: 'Aucun fichier telecharge pour le moment.' }));
    return;
  }
  for (const it of r.items) {
    const cb = el('input', { type: 'checkbox' });
    cb.onchange = () => { if (cb.checked) dossierSel.add(it.name); else dossierSel.delete(it.name); };
    // La vignette est tiree par le serveur avec ffmpeg ; tant qu'elle n'est pas
    // la on garde la place, et un fichier sans image (un son) garde son icone.
    const vue = el('div', { class: 'dl-vue' });
    const son = /\.(m4a|mp3|wav|aac|opus|flac)$/i.test(it.name);
    if (son) {
      vue.classList.add('son');
    } else {
      const img = el('img', { loading: 'lazy', alt: '', src: `/api/dl/thumb?tk=${TK}&name=${encodeURIComponent(it.name)}` });
      img.onerror = () => { img.remove(); vue.classList.add('vide'); };
      vue.append(img);
    }
    liste.append(el('div', { class: 'dl-item' }, cb, vue,
      el('span', { class: 'nm', text: it.name, title: it.name }),
      el('span', { class: 'sz', text: fmtSize(it.size) })));
  }
}

async function supprimerSelection() {
  if (!dossierSel.size) return toast("Cochez d'abord les fichiers a supprimer", 'warn');
  const n = dossierSel.size;
  const r = await fetch(`/api/dl/remove?tk=${TK}`, {
    method: 'POST', body: JSON.stringify({ names: [...dossierSel] }),
  }).then((x) => x.json()).catch(() => null);
  if (r && r.ok) toast(`${r.supprimes}/${n} fichier(s) supprime(s)`, 'ok');
  else toast('Suppression impossible', 'error');
  chargerDossier();
}

async function checkTool(force) {
  const r = await fetch(`/api/dl/probe?tk=${TK}${force ? '&force=1' : ''}`).then((x) => x.json()).catch(() => ({ available: false }));
  $('#dlMissing').classList.toggle('hidden', !!r.available);
  $('#dlReady').classList.toggle('hidden', !r.available);
  if (r.available) $('#dlHost').textContent = `Pret — yt-dlp ${r.version}`;
  return r.available;
}

function setDlMode(m) {
  dlMode = m;
  $('#dlModeVideo').classList.toggle('on', m === 'video');
  $('#dlModeAudio').classList.toggle('on', m === 'audio');
}

function resetDlProgress() {
  dlJob = null;
  clearInterval(dlPoll);
  $('#dlProg').classList.add('hidden');
  $('#dlBar').style.width = '0%';
  $('#dlState').textContent = '';
  $('#dlCancel').classList.add('hidden');
  $('#dlGo').classList.remove('hidden');
  $('#dlGo').disabled = false;
}

function onDlUrl() {
  const v = $('#dlUrl').value.trim();
  const p = v ? platformOf(v) : null;
  $('#dlHost').textContent = p ? `Detecte : ${p}` : '';
}

async function startDownload() {
  const parCompte = $('#dlParCompte').checked;
  const url = parCompte ? ($('#dlCompte').value.trim() || COMPTE_DEFAUT) : $('#dlUrl').value.trim();
  if (!parCompte && !/^https?:\/\//i.test(url)) return toast('Collez un lien complet (https://…)', 'warn');
  if (parCompte) localStorage.setItem(COMPTE_CLE, url);
  const nombre = Math.max(1, Math.min(50, +$('#dlCombien').value || 10));
  // Les cookies valent pour un lien seul comme pour un compte : la page de
  // verification anti-robot frappe les deux.
  const choixCookies = $('#dlCookies').value;
  const cookies = choixCookies === 'fichier' ? '' : choixCookies;
  const cookieFichier = choixCookies === 'fichier' ? (cookiesChemin || '') : '';
  if (choixCookies === 'fichier' && !cookieFichier) {
    return toast("Choisissez d'abord le fichier cookies.txt", 'warn');
  }
  localStorage.setItem(COOKIES_CLE, choixCookies);
  $('#dlGo').disabled = true;
  $('#dlGo').classList.add('charge');
  $('#dlBar').style.width = '0%';
  $('#dlProg').classList.remove('hidden');
  $('#dlCancel').classList.remove('hidden');
  etatDl(parCompte ? `Lecture du compte ${url}…` : 'Connexion…', true);
  const r = await fetch(`/api/dl/start?tk=${TK}`, {
    method: 'POST', body: JSON.stringify({ url, mode: dlMode, compte: parCompte, nombre, cookies, cookieFichier }),
  }).then((x) => x.json());
  if (!r.job) {
    $('#dlState').textContent = 'Echec : ' + (r.error || 'inconnu');
    $('#dlGo').disabled = false;
    $('#dlGo').classList.remove('charge');
    return;
  }
  dlJob = r.job;
  dlPoll = setInterval(pollDownload, 400);
}

async function pollDownload() {
  if (!dlJob) return;
  const st = await fetch(`/api/dl/status?tk=${TK}&job=${dlJob}`).then((x) => x.json()).catch(() => null);
  if (!st) return;
  $('#dlBar').style.width = (st.percent || 0) + '%';
  if (st.state === 'running') {
    // Pendant une attente avant nouvelle tentative, le pourcentage est fige a
    // zero et ne veut rien dire : on annonce l'attente elle-meme.
    etatDl(st.etape
      || ((st.title ? st.title + ' — ' : '') + Math.round(st.percent || 0) + ' %'), true);
    return;
  }
  clearInterval(dlPoll);
  $('#dlCancel').classList.add('hidden');
  $('#dlGo').classList.remove('charge');
  if (st.state === 'done' && st.file) {
    // en mode compte il y a plusieurs fichiers : on les importe tous
    const liste = (st.fichiers && st.fichiers.length) ? st.fichiers : [st.file];
    etatDl(liste.length > 1
      ? `Import de ${liste.length} videos dans les medias…` : 'Import dans les medias…', true);
    try {
      const fichiers = [];
      for (const f of liste) {
        fichiers.push(new FichierDistant({ chemin: f.path, name: f.name, size: f.size, tk: TK }));
      }
      const added = await lib.add(fichiers);
      // le fichier est sur le disque : le projet garde son chemin plutot
      // qu'une copie dans le navigateur
      for (const f of liste) {
        const m = added.find((x) => x.name === f.name);
        if (m) m.chemin = f.path;
      }
      $('#dlBar').style.width = '100%';
      // Ce qu'on telecharge, c'est pour s'en servir : on le pose directement
      // sur la timeline, a la suite. Sinon il fallait aller le rechercher dans
      // les medias et le glisser soi-meme.
      for (const m of added) addMediaToTimeline(m.id, { silent: true });
      timeline.draw();
      const total = liste.reduce((n, f) => n + (f.size || 0), 0);
      $('#dlState').textContent = liste.length > 1
        ? `✔ ${liste.length} videos (${fmtSize(total)}) ajoutees au montage`
        : `✔ ${st.file.name} (${fmtSize(st.file.size)}) ajoute au montage`;
      binSel.clear();
      for (const a of added) binSel.add(a.id);
      renderBin();
      if (dlMode === 'audio') setTab('audio');
      toast(`${liste.length} fichier(s) ajoute(s) au montage`, 'ok', 4000);
      chargerDossier();
      preparerApercus(added);
    } catch (e) {
      $('#dlState').textContent = 'Telecharge, mais import impossible : ' + e.message;
    }
    $('#dlGo').disabled = false;
    $('#dlUrl').value = '';
  } else if (st.state === 'cancelled') {
    $('#dlState').textContent = 'Arrete';
    $('#dlGo').disabled = false;
  } else {
    const err = (st.error || '').replace(/^ERROR:\s*/i, '').slice(0, 240);
    $('#dlState').textContent = '✖ ' + (err || 'echec du telechargement');
    $('#dlGo').disabled = false;
  }
}

/** Bascule entre « un lien » et « un compte entier ». */
function majModeCompte() {
  const par = $('#dlParCompte').checked;
  $('#dlCompteBloc').classList.toggle('hidden', !par);
  $('#dlUrl').closest('label').style.opacity = par ? '.45' : '';
  $('#dlUrl').disabled = par;
  $('#dlGo').textContent = par ? 'Prendre les videos du compte' : 'Importer';
}
// Le formulaire est en method="dialog" : c'est lui qui ferme la fenetre quand
// on clique « Fermer ». Il ne faut donc surtout pas bloquer son envoi — mais
// une touche Entree dans un champ le declencherait aussi, et fermerait la
// fenetre au lieu de lancer le telechargement. On intercepte donc Entree.
for (const sel of ['#dlUrl', '#dlCompte', '#dlCombien']) {
  $(sel).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!$('#dlGo').disabled) startDownload();
  });
}
let cookiesChemin = '';

/** Affiche le bouton de choix de fichier quand on demande un cookies.txt. */
function majCookies() {
  const f = $('#dlCookies').value === 'fichier';
  $('#dlCookieFichier').classList.toggle('hidden', !f);
  $('#dlCookieChemin').classList.toggle('hidden', !f);
  if (f && $('#dlCookieChemin').value !== cookiesChemin) $('#dlCookieChemin').value = cookiesChemin;
  $('#dlCookieAide').innerHTML = f
    ? 'Exportez vos cookies avec une extension de navigateur, puis indiquez le'
      + ' fichier ici (collez le chemin ou cliquez sur Parcourir). Le navigateur'
      + ' peut rester ouvert.'
    : "A n'utiliser que si le site refuse la video. Le navigateur choisi doit etre"
      + ' <b>completement ferme</b> pendant le telechargement.';
}
$('#dlCookies').onchange = majCookies;
$('#dlCookieFichier').onclick = async () => {
  const r = await fetch(`/api/pick?tk=${TK}&kind=cookies`, { method: 'POST' })
    .then((x) => x.json()).catch(() => null);
  if (r && r.path) { cookiesChemin = r.path; majCookies(); }
};
// On peut aussi coller le chemin : plus rapide quand on l'a deja, et cela
// evite de dependre d'une fenetre systeme.
$('#dlCookieChemin').oninput = () => {
  cookiesChemin = $('#dlCookieChemin').value.trim().replace(/^["']|["']$/g, '');
};

$('#dlParCompte').onchange = majModeCompte;
$('#dlOuvrirDossier').onclick = () => {
  fetch(`/api/dl/open?tk=${TK}`, { method: 'POST' }).catch(() => {});
  chargerDossier();
};
$('#dlSupprSel').onclick = supprimerSelection;

$('#btnDlVideo').onclick = () => openDownload('video');
$('#btnDlAudio').onclick = () => openDownload('audio');
$('#dlModeVideo').onclick = () => setDlMode('video');
$('#dlModeAudio').onclick = () => setDlMode('audio');
$('#dlUrl').oninput = onDlUrl;
$('#dlUrl').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); startDownload(); } };
$('#dlGo').onclick = startDownload;
$('#dlCancel').onclick = async () => {
  if (dlJob) await fetch(`/api/dl/cancel?tk=${TK}&job=${dlJob}`, { method: 'POST' });
};
$('#dlPaste').onclick = async () => {
  try {
    $('#dlUrl').value = (await navigator.clipboard.readText()).trim();
    onDlUrl();
  } catch (_) { toast('Collez le lien avec Ctrl+V', 'warn', 2000); }
};
$('#dlRecheck').onclick = async () => {
  const ok = await checkTool(true);
  toast(ok ? 'yt-dlp detecte' : 'Toujours introuvable', ok ? 'ok' : 'warn');
};
$('#dlCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#dlCmd').value); toast('Commande copiee', 'ok', 1800); }
  catch (_) { $('#dlCmd').select(); }
};
$('#dlgDl').addEventListener('close', () => { clearInterval(dlPoll); });

// --------------------------------------------------- zone active (Suppr)

let activeZone = 'timeline';
function activateZone(z) {
  if (activeZone === z) return;
  activeZone = z;
  $('.panel.left').classList.toggle('zone-on', z === 'bin');
}

function renderBin() {
  const p = store.project;
  const counts = { all: p.media.length, video: 0, audio: 0, image: 0 };
  for (const m of p.media) counts[m.kind] = (counts[m.kind] || 0) + 1;
  $('#cAll').textContent = counts.all || '';
  $('#cVid').textContent = counts.video || '';
  $('#cAud').textContent = counts.audio || '';
  $('#cImg').textContent = counts.image || '';

  const match = (m, kinds) =>
    kinds.includes(m.kind) && (!binQuery || m.name.toLowerCase().includes(binQuery));

  // rubrique Medias
  const host = $('#bin');
  host.innerHTML = '';
  const kinds = binFilter === 'all' ? ['video', 'audio', 'image'] : [binFilter];
  const list = p.media.filter((m) => match(m, kinds));
  // la grande zone de depot n'a de sens que tant que la bibliotheque est vide :
  // ensuite, glisser un fichier n'importe ou dans la fenetre suffit
  if (!p.media.length) {
    host.append(el('button', {
      type: 'button', class: 'dropzone', id: 'dropzone',
      onclick: pickFiles,
    }, icon('upload', 'i xl'), el('b', { text: 'Glissez vos fichiers ici' }),
      el('span', { text: 'videos, audio, images' })));
  }
  if (!list.length && p.media.length) {
    host.append(el('div', { class: 'bin-empty', text: 'Aucun resultat' }));
  }
  for (const m of list) host.append(mediaCard(m));

  // rubrique Son
  const ah = $('#binAudio');
  ah.innerHTML = '';
  const audios = p.media.filter((m) => m.kind === 'audio' && (!binQuery || m.name.toLowerCase().includes(binQuery)));
  if (!audios.length) {
    ah.append(el('div', { class: 'bin-empty', text: 'Aucun fichier audio. Importez un MP3 ou un WAV.' }));
  }
  for (const m of audios) ah.append(mediaCard(m));
  updateBinCount();
}

function removeMedia(id) {
  const used = usedInTimeline(id);
  if (used && !confirm('Ce media est utilise dans la timeline. Le retirer supprimera ses clips. Continuer ?')) return;
  store.edit('retirer media', (p) => {
    for (const t of p.tracks) t.clips = t.clips.filter((c) => c.mediaId !== id);
    p.media = p.media.filter((m) => m.id !== id);
  });
  lib.remove(id);
  binSel.delete(id);
  player.invalidate();
}

async function importFiles(list) {
  if (!list || !list.length) return;
  const t = toast('Import…', 'info', 60000);
  const tous = await lib.add(list);
  t.remove();
  // un media rebranche sur son fichier n'est pas repose sur la timeline
  const relies = tous.filter((m) => m.relie);
  for (const m of relies) delete m.relie;
  const added = tous.filter((m) => !relies.includes(m));
  if (relies.length) {
    store.changed('media'); player.invalidate(); timeline.draw(); renderBin();
    toast(`${relies.length} video(s) retrouvee(s)`, 'ok');
    cheminsEnFond(relies);
  }
  if (!added.length) return;
  // Ce qu'on importe, c'est pour le monter : on le pose a la suite sur la
  // timeline. Avant, seul le tout premier fichier y allait et les suivants
  // s'arretaient dans les medias — il fallait aller les chercher un par un.
  const empty = store.project.tracks.every((tr) => tr.clips.length === 0);
  if (empty) {
    const firstVid = added.find((m) => m.width) || added[0];
    if (firstVid && firstVid.width) applyProjectFormat(firstVid);
  }
  for (const m of added) addMediaToTimeline(m.id, { silent: true });
  if (empty) { timeline.fit(); player.seek(0); } else { timeline.draw(); }
  binSel.clear();
  added.forEach((m) => binSel.add(m.id));
  // bascule sur la bonne rubrique si on a importe seulement du son
  if (added.every((m) => m.kind === 'audio') && activeTab === 'media') setTab('audio');
  renderBin();
  toast(`${added.length} fichier(s) importe(s)`, 'ok');
  cheminsEnFond(added);
  preparerApercus(added);
}

// ------------------------------------------------ copies allegees d'apercu

let apercuToast = null;

/**
 * Fabrique les copies d'apercu des sources trop lourdes.
 *
 * Un rush 4K est fait pour l'archive : le relire dans un element video coute
 * bien plus que ce qu'un montage a coupes rapides peut absorber, et l'image
 * decroche. On prepare donc une version legere une fois pour toutes ; l'export
 * continue de partir des fichiers d'origine, la qualite finale est intacte.
 *
 * Les copies sont faites une par une : en lancer plusieurs a la fois se
 * disputerait le processeur, sans rien accelerer.
 */
async function preparerApercus(medias) {
  const aFaire = (medias || store.project.media)
    .filter((m) => Library.meriteApercu(m) && !lib.apercus.has(m.id));
  if (!aFaire.length) return;
  let fait = 0;
  lib.surApercu = (media, etat, pct) => {
    if (etat === 'indisponible') return;
    const n = `${fait + 1}/${aFaire.length}`;
    const txt = etat === 'envoi' ? `Preparation de l'apercu ${n} — lecture du fichier…`
      : etat === 'encodage' ? `Preparation de l'apercu ${n} — ${Math.round(pct)} %`
      : null;
    if (!txt) return;
    if (apercuToast) apercuToast.remove();
    apercuToast = toast(txt, 'info', 60000);
  };
  // Deux a la fois : pendant qu'une source est encodee, la suivante est deja
  // televersee. Au-dela, les encodages se disputent le processeur sans rien
  // gagner (mesure : 23 s en serie, 17 s a deux, rien de mieux au-dela).
  let ok = 0, indispo = false;
  let suivant = 0;
  const ouvrier = async () => {
    while (suivant < aFaire.length) {
      const m = aFaire[suivant++];
      const r = await lib.assurerApercu(m, TK);
      if (r) ok++; else if (!lib.apercus.has(m.id)) indispo = true;
      fait++;
      player.invalidate();
    }
  };
  await Promise.all([ouvrier(), ouvrier()]);
  lib.surApercu = null;
  if (apercuToast) { apercuToast.remove(); apercuToast = null; }
  if (ok) toast(`Apercu allege pret pour ${ok} source(s) — la lecture sera fluide`, 'ok', 4000);
  else if (indispo) toast("ffmpeg absent : l'apercu reste sur les fichiers d'origine", 'warn', 5000);
}

function applyProjectFormat(media) {
  const p = store.project;
  if (!media.width || !media.height) return;
  p.width = Math.round(media.width / 2) * 2;
  p.height = Math.round(media.height / 2) * 2;
  if (media.fps) {
    const cand = [24, 25, 30, 50, 60, 100, 120];
    p.fps = cand.reduce((a, b) => (Math.abs(b - media.fps) < Math.abs(a - media.fps) ? b : a), 30);
  }
  layoutStage(); refreshHeader();
}

function addMediaToTimeline(mediaId, opts = {}) {
  const p = store.project;
  const m = p.media.find((x) => x.id === mediaId);
  if (!m) return;
  const wantAudio = m.kind === 'audio';
  let track = p.tracks.find((t) => (wantAudio ? t.kind === 'audio' : t.kind === 'video') && !t.locked);
  if (!track) {
    store.edit('piste', () => { p.tracks.push(newTrack(wantAudio ? 'audio' : 'video')); });
    track = p.tracks[p.tracks.length - 1];
  }
  const t = opts.t !== undefined ? opts.t : track.clips.reduce((s, c) => Math.max(s, c.t0 + c.dur), 0);
  const dur = m.kind === 'image' ? 5 : Math.max(0.1, m.duration || 5);
  store.edit('ajouter clip', () => {
    const c = newClip({
      mediaId: m.id, kind: m.kind === 'audio' ? 'audio' : m.kind === 'image' ? 'image' : 'video',
      t0: Math.max(0, t), dur, in: 0,
    });
    track.clips.push(c);
    normalizeTrack(track);
    layoutTrack(track);
    if (!opts.silent) store.select(c.id);
  });
  player.invalidate();
}

store.on('dropMedia', ({ mediaId, t, trackIndex }) => {
  const p = store.project;
  const m = p.media.find((x) => x.id === mediaId);
  if (!m) return;
  // -2 : depot dans la bande du haut => nouvelle couche de superposition
  if (trackIndex === -2) return addOnNewLayer(mediaId, t);
  if (trackIndex === -3) return addOnNewAudioTrack(mediaId, t);
  const tr = trackIndex >= 0 ? p.tracks[trackIndex] : null;
  if (tr && ((tr.kind === 'audio') === (m.kind === 'audio')) && !tr.locked) {
    const dur = m.kind === 'image' ? 5 : Math.max(0.1, m.duration || 5);
    store.edit('ajouter clip', () => {
      const c = newClip({
        mediaId: m.id, kind: m.kind === 'audio' ? 'audio' : m.kind === 'image' ? 'image' : 'video',
        t0: Math.max(0, timeline.applySnap(t, [])), dur, in: 0,
      });
      tr.clips.push(c);
      layoutTrack(tr);
      store.select(c.id);
    });
    player.invalidate();
  } else {
    addMediaToTimeline(mediaId, { t });
  }
});
store.on('dropFiles', (files) => importFiles(files));

/** Depose un media sur une NOUVELLE couche video au-dessus, a l'instant voulu. */
function addOnNewLayer(mediaId, t) {
  const p = store.project;
  const m = p.media.find((x) => x.id === mediaId);
  if (!m) return;
  if (m.kind === 'audio') return addMediaToTimeline(mediaId, { t });
  const dur = m.kind === 'image' ? 5 : Math.max(0.1, m.duration || 5);
  let newId = null;
  store.edit('nouvelle couche video', () => {
    const nVideo = p.tracks.filter((x) => x.kind === 'video').length;
    const tr = newTrack('video', 'Video ' + (nVideo + 1), { magnetic: false, height: 54 });
    let last = 0;
    p.tracks.forEach((x, i) => { if (x.kind === 'video') last = i; });
    p.tracks.splice(last + 1, 0, tr);
    const c = newClip({
      mediaId: m.id, kind: m.kind === 'image' ? 'image' : 'video',
      t0: Math.max(0, t), dur, in: 0, fit: 'contain',
    });
    tr.clips.push(c);
    newId = c.id;
  });
  if (newId) store.select(newId);
  player.invalidate();
  toast('Nouvelle couche video creee', 'ok', 1800);
}

// ------------------------------------------------ rubriques texte / masques

/** Pastille d'apercu d'un style de texte. */
function styleChip(st, onPick) {
  const chip = el('button', { class: 'style-chip', title: st.label, onclick: onPick },
    el('span', { class: 'sp', text: 'Aa' }), el('em', { text: st.label }));
  const c = st.css;
  const sp = chip.querySelector('.sp');
  sp.style.fontFamily = fontCss(c.font || 'classic');
  sp.style.fontWeight = c.weight || 700;
  sp.style.color = c.color || '#fff';
  if (c.bg && c.bg !== 'none') { sp.style.background = c.bg; sp.style.padding = '0 4px'; sp.style.borderRadius = '3px'; }
  if (c.stroke) sp.style.webkitTextStroke = `${Math.max(0.6, c.stroke * 1.6)}px ${c.strokeColor || '#000'}`;
  if (c.glow) sp.style.textShadow = `0 0 7px ${c.glowColor || '#38e1ff'}`;
  else if (c.shadow) sp.style.textShadow = '0 1px 3px rgba(0,0,0,.8)';
  return chip;
}

function buildTextPane() {
  const host = $('#panelText');
  host.innerHTML = '';
  host.append(el('div', { class: 'pane-title', text: 'Cliquez un style pour ajouter le texte' }));
  const grid = el('div', { class: 'style-grid' });
  for (const st of TEXT_STYLES) grid.append(styleChip(st, () => addText(st)));
  host.append(grid);
  host.append(el('p', {
    class: 'hint',
    text: 'Le texte est pose a la tete de lecture. Ensuite : glissez-le sur l\'apercu pour le placer, '
      + 'tirez les coins jaunes pour la taille, et choisissez la police dans le panneau de droite.',
  }));
}

function addText(style) {
  const p = store.project;
  store.edit('ajouter texte', () => {
    let tr = p.tracks.filter((t) => t.kind === 'video').pop();
    const busy = tr && tr.clips.some((c) => store.playhead < c.t0 + c.dur && store.playhead + 4 > c.t0);
    if (busy || !tr) {
      tr = newTrack('video', 'Texte');
      p.tracks.splice(p.tracks.filter((t) => t.kind === 'video').length, 0, tr);
    }
    const c = newTextClip('Votre texte');
    if (style && style.css) applyStyle(c.text, style);
    c.t0 = store.playhead;
    tr.clips.push(c);
    normalizeTrack(tr);
    store.select(c.id);
  });
  invalidateText();
  player.invalidate();
}

function buildMaskPane() {
  const host = $('#panelMask');
  host.innerHTML = '';
  host.append(el('button', {
    class: 'big-action', title: 'Cree un rond flou et active le suivi image par image',
    onclick: cmdFaceBlur,
  }, icon('face', 'i xl'),
    el('span', {}, el('b', { text: 'Flouter un visage' }),
      el('em', { text: 'rond flou + suivi du mouvement' }))));
  host.append(el('div', { class: 'pane-title', text: 'Forme du masque' }));
  const grid = el('div', { class: 'tiles' });
  const ICONS = { rect: 'rect', ellipse: 'ellipse', linear: 'linear', mirror: 'mirror', poly: 'poly' };
  for (const s of MASK_SHAPES) {
    grid.append(el('div', {
      class: 'tile', title: s.label,
      onclick: () => cmdAddMask(s.id),
    }, icon(ICONS[s.id] || 'ellipse'), el('span', { text: s.label })));
  }
  host.append(grid);
  host.append(el('div', { class: 'pane-title', text: 'Effet applique' }));
  const g2 = el('div', { class: 'tiles' });
  for (const [eff, label, ic] of [['blur', 'Flou', 'mask'], ['mosaic', 'Mosaique', 'rect'], ['black', 'Noir', 'ellipse'], ['reveal', 'Garder', 'eye'], ['hide', 'Cacher', 'eye-off']]) {
    g2.append(el('div', {
      class: 'tile', title: label,
      onclick: () => {
        const m = store.selectedMask;
        if (!m) return toast('Selectionnez un masque', 'warn');
        store.edit('effet', () => { m.effect = eff; });
        inspector.render(); player.invalidate();
      },
    }, icon(ic), el('span', { text: label })));
  }
  host.append(g2);
  host.append(el('p', { class: 'hint', text: 'Selectionnez un clip, choisissez une forme, puis deplacez le masque directement sur l\'apercu.' }));
}

// ------------------------------------------------------------ rubrique Outils

const TOOLS = [
  { id: 'reverse', icon: 'reverse', label: 'Inverser', hint: 'lit le clip a l\'envers (rendu)' },
  { id: 'freeze', icon: 'freeze', label: 'Figer', hint: 'insere l\'image courante en photo' },
  { id: 'before', icon: 'cut-left', label: 'Couper avant', hint: 'supprime tout avant le curseur' },
  { id: 'after', icon: 'cut-right', label: 'Couper apres', hint: 'supprime tout apres le curseur' },
  { id: 'flipH', icon: 'flip-h', label: 'Miroir H', hint: 'retourne horizontalement' },
  { id: 'flipV', icon: 'flip-v', label: 'Miroir V', hint: 'retourne verticalement' },
  { id: 'rot90', icon: 'rotate', label: 'Tourner 90°', hint: 'un quart de tour' },
  { id: 'slow', icon: 'slow', label: 'Ralenti 0,5×', hint: 'deux fois plus lent' },
  { id: 'fast', icon: 'fast', label: 'Rapide 2×', hint: 'deux fois plus rapide' },
  { id: 'fitFill', icon: 'crop', label: 'Remplir', hint: 'recadre pour remplir l\'ecran' },
  { id: 'fitContain', icon: 'crop', label: 'Contenir', hint: 'tout afficher, bandes noires' },
  { id: 'reset', icon: 'reset', label: 'Reinitialiser', hint: 'annule transformations et effets' },
];

function buildToolsPane() {
  const host = $('#panelTools');
  host.innerHTML = '';
  host.append(el('div', { class: 'pane-title', text: 'Sur le clip selectionne' }));
  const grid = el('div', { class: 'tiles' });
  for (const t of TOOLS) {
    grid.append(el('div', {
      class: 'tile', title: t.label + ' — ' + t.hint,
      onclick: () => runTool(t.id),
    }, icon(t.icon), el('span', { text: t.label })));
  }
  host.append(grid);
  host.append(el('p', {
    class: 'hint',
    text: 'L\'inversion fabrique un nouveau fichier video dans le dossier « cache » : '
      + 'quelques secondes de calcul, puis tout fonctionne normalement, export compris.',
  }));
}

function runTool(id) {
  const sel = store.selectedClips;
  const sole = store.soleClip;
  const need = () => toast('Selectionnez un clip', 'warn', 1600);

  switch (id) {
    case 'reverse':
      if (!sole) return need();
      return doReverse(sole.clip);
    case 'freeze':
      return doFreeze();
    case 'before': case 'after': {
      const tracks = sel.length ? [...new Set(sel.map((s) => s.track))] : store.project.tracks;
      (id === 'before' ? trimBefore : trimAfter)(store, tracks);
      player.invalidate(); timeline.fit(); syncZoomSlider();
      toast(id === 'before' ? 'Tout ce qui precedait a ete supprime' : 'Tout ce qui suivait a ete supprime', 'ok');
      return;
    }
    case 'flipH': case 'flipV': {
      if (!sel.length) return need();
      const k = id;
      store.edit('miroir', () => sel.forEach(({ clip }) => { clip[k] = !clip[k]; }));
      player.invalidate(); inspector.render();
      return;
    }
    case 'rot90': {
      if (!sel.length) return need();
      store.edit('rotation', () => sel.forEach(({ clip }) => {
        clip.rot = ((clip.rot || 0) + 90 + 180) % 360 - 180;
      }));
      player.invalidate(); inspector.render();
      return;
    }
    case 'slow': case 'fast': {
      if (!sel.length) return need();
      const f = id === 'slow' ? 0.5 : 2;
      store.edit('vitesse', () => sel.forEach(({ clip, track }) => {
        const media = mediaOf(store.project, clip);
        const srcLen = clip.dur * (clip.speed || 1);
        clip.speed = clamp((clip.speed || 1) * f, 0.1, 8);
        clip.dur = srcLen / clip.speed;
        if (media && media.duration) clip.dur = Math.min(clip.dur, (media.duration - clip.in) / clip.speed);
        layoutTrack(track);
      }));
      player.invalidate(); inspector.render();
      return;
    }
    case 'fitFill': case 'fitContain': {
      if (!sel.length) return need();
      const v = id === 'fitFill' ? 'cover' : 'contain';
      store.edit('cadrage', () => sel.forEach(({ clip }) => { clip.fit = v; }));
      player.invalidate(); inspector.render();
      return;
    }
    case 'reset': {
      if (!sel.length) return need();
      store.edit('reinitialiser', () => sel.forEach(({ clip }) => {
        Object.assign(clip, { x: 0, y: 0, scale: 1, rot: 0, opacity: 1, flipH: false, flipV: false });
        clip.crop = { l: 0, r: 0, t: 0, b: 0 };
        clip.kf = {};
        clip.masks = [];
        clip.color = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vignette: 0, sharpen: 0 };
      }));
      store.selection.maskId = null;
      player.invalidate(); inspector.render();
      toast('Clip reinitialise', 'ok', 1500);
      return;
    }
  }
}

async function doReverse(clip) {
  player.pause();
  showProgress(true);
  $('#opTitle').textContent = 'Inversion…';
  let cancelled = false;
  $('#opCancel').onclick = () => { cancelled = true; $('#opTitle').textContent = 'Annulation…'; };
  try {
    const r = await reverseClip({
      store, lib, tk: TK, clip,
      onProgress: onExportProgress,
      isCancelled: () => cancelled,
    });
    showProgress(false);
    player.disposeClip(clip.id);
    player.invalidate();
    inspector.render();
    toast(`Clip inverse (${r.frames} images)`, 'ok');
  } catch (e) {
    showProgress(false);
    if (!/annul/i.test(e.message)) { console.error(e); toast('Inversion impossible : ' + e.message, 'error', 7000); }
  } finally {
    $('#opCancel').onclick = () => {
  $('#opTitle').textContent = 'Annulation…';
  $('#opText').textContent = '';
  $('#opSub').textContent = '';
  $('#opCancel').classList.add('hidden');
  exporter.cancel();          // coupe codecs et ecritures : rend la main aussitot
};
  }
}

async function doFreeze() {
  try {
    await freezeFrame({ store, lib, player, tk: TK, seconds: 2 });
    player.invalidate();
    toast('Image figee ajoutee en superposition', 'ok');
  } catch (e) {
    toast('Capture impossible : ' + e.message, 'error');
  }
}

function buildTransPane() {
  const host = $('#panelTrans');
  host.innerHTML = '';
  host.append(el('div', { class: 'pane-title', text: 'Fondu enchaine' }));
  const grid = el('div', { class: 'tiles' });
  for (const d of [0, 0.25, 0.5, 1, 1.5, 2]) {
    grid.append(el('div', {
      class: 'tile', title: d ? `Fondu de ${d} s` : 'Retirer la transition',
      onclick: () => cmdTransition(d),
    }, icon('transition'), el('span', { text: d ? d + ' s' : 'Aucune' })));
  }
  host.append(grid);
  host.append(el('p', { class: 'hint', text: 'Selectionnez le clip de gauche : la transition se fait avec le clip suivant de la meme piste. Vous pouvez aussi glisser la poignee ⇄ sur la timeline.' }));
}

// ------------------------------------------------------------------ commandes

function selectedOrUnderPlayhead() {
  const sel = store.selectedClips;
  if (sel.length) return sel;
  const out = [];
  const t = store.playhead;
  for (const tr of store.project.tracks) {
    if (tr.locked) continue;
    for (const c of tr.clips) if (t > c.t0 + 0.01 && t < c.t0 + c.dur - 0.01) out.push({ clip: c, track: tr });
  }
  return out;
}

function shiftKeys(host, delta) {
  if (!host.kf) return;
  for (const [k, arr] of Object.entries(host.kf)) host.kf[k] = arr.map((x) => ({ ...x, t: x.t + delta }));
}

function cmdSplit() {
  const t = store.playhead;
  const sel = store.selectedClips;
  const targets = selectedOrUnderPlayhead().filter(({ clip }) => t > clip.t0 + 0.02 && t < clip.t0 + clip.dur - 0.02);
  if (!targets.length) {
    return toast(sel.length
      ? 'La tete de lecture n\'est pas dans le clip selectionne'
      : 'Placez la tete de lecture dans un clip', 'warn', 2600);
  }
  store.edit('couper', () => {
    for (const { clip, track } of targets) {
      const local = t - clip.t0;
      const b = JSON.parse(JSON.stringify(clip));
      b.id = uid('c');
      b.masks = (b.masks || []).map((m) => ({ ...m, id: uid('m') }));
      b.t0 = t;
      b.dur = clip.dur - local;
      b.in = clip.in + local * (clip.speed || 1);
      shiftKeys(b, -local);
      for (const m of b.masks) shiftKeys(m, -local);
      b.fadeIn = 0; b.aFadeIn = 0;
      clip.dur = local;
      clip.fadeOut = 0; clip.aFadeOut = 0;
      clip.transition = { kind: 'none', dur: 0 };
      track.clips.push(b);
      normalizeTrack(track);
    }
    relayoutAll(store.project);
  });
  player.invalidate();
  toast(sel.length
    ? `Coupe : ${targets.length} clip(s) selectionne(s)`
    : `Coupe sur ${targets.length} piste(s)`, 'ok', 1800);
}

function cmdDelete(ripple) {
  const sel = store.selectedClips;
  if (!sel.length) return toast('Rien de selectionne', 'warn', 1500);
  store.edit(ripple ? 'supprimer et combler' : 'supprimer', () => {
    for (const { clip, track } of sel) {
      const i = track.clips.indexOf(clip);
      if (i < 0) continue;
      const d = clip.dur;
      track.clips.splice(i, 1);
      // piste collee : le trou se referme toujours (le premier clip revient a 0:00)
      if (ripple && !track.magnetic) {
        for (let j = i; j < track.clips.length; j++) track.clips[j].t0 = Math.max(0, track.clips[j].t0 - d);
      }
    }
    relayoutAll(store.project);
  });
  for (const { clip } of sel) player.disposeClip(clip.id);
  store.select([]);
  player.invalidate();
}

function cmdDuplicate() {
  const sel = store.selectedClips;
  if (!sel.length) return;
  const ids = [];
  store.edit('dupliquer', () => {
    for (const { clip, track } of sel) {
      const b = JSON.parse(JSON.stringify(clip));
      b.id = uid('c');
      b.masks = (b.masks || []).map((m) => ({ ...m, id: uid('m') }));
      b.t0 = clip.t0 + clip.dur;
      track.clips.push(b);
      normalizeTrack(track);
      layoutTrack(track);
      ids.push(b.id);
    }
    relayoutAll(store.project);
  });
  store.select(ids);
  player.invalidate();
}

/** Coupe / remet le son des clips selectionnes (ou de celui sous la tete de lecture). */
function cmdMute() {
  const sel = selectedOrUnderPlayhead().filter(({ clip }) => clip.kind !== 'text');
  if (!sel.length) return toast('Selectionnez un clip', 'warn', 1600);
  const anyOn = sel.some(({ clip }) => !clip.mute);
  store.edit(anyOn ? 'couper le son' : 'remettre le son', () => {
    for (const { clip } of sel) clip.mute = anyOn;
  });
  refreshMuteBtn();
  inspector.sync();
  player.invalidate();
  toast(anyOn ? 'Son coupe' : 'Son reactive', 'ok', 1400);
}

// ------------------------------------------ bandeau des effets du clip choisi

function renderClipChips() {
  const host = $('#clipChips');
  const sel = store.soleClip;
  if (!sel) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  const fx = Timeline.effectsOf(sel.clip);
  if (!fx.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }

  host.classList.remove('hidden');
  host.innerHTML = '';
  host.append(el('span', { class: 'lbl', text: 'Applique' }));
  for (const e of fx) {
    host.append(el('span', { class: 'echip' + (e.info ? ' info' : ''), title: e.label },
      icon(e.icon, 'i sm'),
      el('span', { text: e.label }),
      el('button', {
        class: 'x', title: 'Retirer',
        onclick: () => { timeline.removeEffect(sel.clip, e.kind); toast(e.label + ' retire', 'ok', 1500); },
      }, icon('close'))));
  }
  const removable = fx.filter((e) => !e.info);
  if (removable.length > 1) {
    host.append(el('button', {
      class: 'btn sm', text: 'Tout enlever',
      title: 'Retire tous les effets de ce clip',
      onclick: () => {
        store.snapshot('tout enlever');
        for (const e of removable) timeline.removeEffect(sel.clip, e.kind);
        toast('Effets retires', 'ok');
      },
    }));
  }
}
store.on('selection', renderClipChips);
store.on('change', renderClipChips);
store.on('reload', renderClipChips);

// --------------------------------------------------------------- plein ecran

const fsHost = document.querySelector('.center');
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else fsHost.requestFullscreen().catch((e) => toast('Plein ecran refuse : ' + e.message, 'warn'));
}
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  $('#btnFull').classList.toggle('on', on);
  $('#btnFull').querySelector('use').setAttribute('href', on ? '#i-fit' : '#i-expand');
  setTimeout(() => { layoutStage(); player.invalidate(); }, 60);
});


// ------------------------------------------------------------ points de rythme

/** Repere les temps forts des clips selectionnes (menu contextuel). */
async function cmdDetectBeats() {
  const cibles = selectedOrUnderPlayhead().filter(({ clip }) => clip.kind !== 'text' && clip.mediaId);
  if (!cibles.length) return toast('Selectionnez un clip qui a du son', 'warn');
  toast('Analyse du rythme…', 'info', 1500);
  let total = 0, rates = 0;
  for (const { clip } of cibles) {
    const file = lib.file(clip.mediaId);
    if (!file) { rates++; continue; }
    try {
      const temps = await detecterTemps(file, clip.mediaId, { sensibilite: clip.sensiBeat ?? 0.5 });
      // La selection a pu changer pendant l'analyse : on verifie que le clip
      // existe encore avant de le modifier.
      if (!findClip(store.project, clip.id)) continue;
      store.edit('reperer le rythme', () => { clip.beats = temps; });
      total += temps.length;
    } catch (_) { rates++; }
  }
  if (rates && !total) toast('Analyse impossible sur ce clip', 'error');
  else toast(`${total} point(s) de rythme`, 'ok');
}

function cmdClearBeats() {
  const cibles = selectedOrUnderPlayhead();
  if (!cibles.length) return;
  store.edit('effacer les points de rythme', () => {
    for (const { clip } of cibles) clip.beats = null;
  });
}

// ------------------------------------------------- couper a gauche / a droite

/**
 * Coupe le clip au curseur et jette la partie demandee (comme CapCut).
 * @param {'left'|'right'} side
 */
function cmdTrimSide(side) {
  const t = store.playhead;
  const targets = selectedOrUnderPlayhead()
    .filter(({ clip }) => t > clip.t0 + 0.02 && t < clip.t0 + clip.dur - 0.02);
  if (!targets.length) {
    return toast('Placez la tete de lecture dans le clip a couper', 'warn', 2400);
  }
  store.edit(side === 'left' ? 'couper la partie gauche' : 'couper la partie droite', () => {
    for (const { clip, track } of targets) {
      if (side === 'left') {
        const cut = t - clip.t0;
        clip.in += cut * (clip.speed || 1);
        clip.dur -= cut;
        clip.t0 = t;
        clip.fadeIn = 0; clip.aFadeIn = 0;
        shiftKeys(clip, -cut);
        for (const m of clip.masks || []) shiftKeys(m, -cut);
      } else {
        clip.dur = t - clip.t0;
        clip.fadeOut = 0; clip.aFadeOut = 0;
        clip.transition = { kind: 'none', dur: 0 };
      }
      layoutTrack(track);
    }
    relayoutAll(store.project);
  });
  player.invalidate();
  toast(side === 'left' ? 'Partie gauche coupee' : 'Partie droite coupee', 'ok', 1600);
}

function refreshMuteBtn() {
  const sel = store.selectedClips.filter(({ clip }) => clip.kind !== 'text');
  const muted = sel.length && sel.every(({ clip }) => clip.mute);
  const b = $('#tlMute');
  b.classList.toggle('on', !!muted);
  b.querySelector('use').setAttribute('href', muted ? '#i-vol-off' : '#i-vol');
}
store.on('selection', refreshMuteBtn);
store.on('change', refreshMuteBtn);

/**
 * Ajoute un media EN SUPERPOSITION : nouvelle couche video au-dessus,
 * positionnee a la tete de lecture. Sert aux images (logos, PNG, photos).
 */
function cmdAddOverlay(mediaId, atTime) {
  const p = store.project;
  const m = p.media.find((x) => x.id === mediaId);
  if (!m) return;
  if (m.kind === 'audio') return addOnNewAudioTrack(mediaId, atTime);

  const t0 = atTime !== undefined ? atTime : store.playhead;
  const dur = m.kind === 'image' ? 5 : Math.max(0.1, m.duration || 5);
  let newId = null;
  store.edit('superposer', () => {
    // cherche une couche de superposition libre a cet instant
    const overlays = p.tracks.filter((t) => t.kind === 'video' && !t.magnetic && !t.locked);
    let target = overlays.find((t) => !t.clips.some((c) => t0 < c.t0 + c.dur - 1e-4 && t0 + dur > c.t0 + 1e-4));
    if (!target) {
      target = newTrack('video', 'Superposition ' + (overlays.length + 1), { magnetic: false, height: 54 });
      // insere juste apres la derniere piste video => calque du dessus
      let last = 0;
      p.tracks.forEach((t, i) => { if (t.kind === 'video') last = i; });
      p.tracks.splice(last + 1, 0, target);
    }
    const c = newClip({
      mediaId: m.id, kind: m.kind === 'image' ? 'image' : 'video',
      t0, dur, in: 0, fit: 'contain',
    });
    target.clips.push(c);
    layoutTrack(target);
    newId = c.id;
  });
  if (newId) store.select(newId);
  player.invalidate();
  toast(m.kind === 'image' ? 'Image superposee' : 'Video superposee', 'ok', 1800);
}

/** Ajoute un son sur une piste audio LIBRE a cet instant (sinon en cree une). */
function addOnNewAudioTrack(mediaId, atTime) {
  const p = store.project;
  const m = p.media.find((x) => x.id === mediaId);
  if (!m) return;
  const t0 = atTime !== undefined ? atTime : store.playhead;
  const dur = Math.max(0.1, m.duration || 5);
  let newId = null;
  store.edit('superposer le son', () => {
    const auds = p.tracks.filter((x) => x.kind === 'audio' && !x.locked);
    let target = auds.find((x) => !x.clips.some((c) => t0 < c.t0 + c.dur - 1e-4 && t0 + dur > c.t0 + 1e-4));
    if (!target) {
      target = newTrack('audio', 'Audio ' + (p.tracks.filter((x) => x.kind === 'audio').length + 1));
      p.tracks.push(target);
    }
    const c = newClip({ kind: 'audio', mediaId: m.id, t0, dur, in: 0 });
    target.clips.push(c);
    normalizeTrack(target);
    newId = c.id;
  });
  if (newId) store.select(newId);
  player.invalidate();
  toast('Son ajoute sur « ' + store.project.tracks.filter((x) => x.kind === 'audio').pop().name + ' »', 'ok', 2000);
}

/** Empile plusieurs medias, chacun sur sa propre piste, tous au meme instant. */
function stackOnOwnTracks(ids) {
  const p = store.project;
  const t0 = store.playhead;
  const created = [];
  store.snapshot('empiler sur des pistes');
  for (const id of ids) {
    const m = p.media.find((x) => x.id === id);
    if (!m) continue;
    const dur = m.kind === 'image' ? 5 : Math.max(0.1, m.duration || 5);
    if (m.kind === 'audio') {
      const tr = newTrack('audio', 'Audio ' + (p.tracks.filter((x) => x.kind === 'audio').length + 1));
      p.tracks.push(tr);
      const c = newClip({ kind: 'audio', mediaId: m.id, t0, dur, in: 0 });
      tr.clips.push(c);
      created.push(c.id);
    } else {
      const tr = newTrack('video', 'Video ' + (p.tracks.filter((x) => x.kind === 'video').length + 1),
        { magnetic: false, height: 54 });
      let last = 0;
      p.tracks.forEach((x, i) => { if (x.kind === 'video') last = i; });
      p.tracks.splice(last + 1, 0, tr);
      const c = newClip({
        mediaId: m.id, kind: m.kind === 'image' ? 'image' : 'video',
        t0, dur, in: 0, fit: 'contain',
      });
      tr.clips.push(c);
      created.push(c.id);
    }
  }
  store.changed();
  if (created.length) store.select(created);
  player.invalidate();
  timeline.fit(); syncZoomSlider();
  toast(`${created.length} media(s) empile(s), chacun sur sa piste`, 'ok', 2600);
}

/** Masque rond flou pret pour le suivi d'un visage. */
function cmdFaceBlur() {
  const s = store.soleClip || store.selectedClips[0];
  if (!s) return toast('Selectionnez d\'abord un clip video', 'warn');
  if (s.track.kind === 'audio') return toast('Impossible sur une piste audio', 'warn');
  const tLocal = clamp(store.playhead - s.clip.t0, 0, s.clip.dur);
  store.edit('flouter un visage', () => {
    const m = newMask('ellipse', {
      effect: 'blur', strength: 72,
      w: 0.17, h: 0.17, feather: 0.05,
      cx: 0.5, cy: 0.42,
    });
    // premier point de suivi a la position courante
    m.kf = { cx: [{ t: tLocal, v: 0.5 }], cy: [{ t: tLocal, v: 0.42 }] };
    s.clip.masks.push(m);
    store.selection.maskId = m.id;
  });
  store.select(s.clip.id);
  overlay.autoKey = true;
  inspector.render();
  player.invalidate();
  toast('Placez le rond sur le visage, avancez, puis redeplacez-le', 'ok', 5000);
}

function cmdAddMask(shape = 'ellipse') {
  const s = store.soleClip || store.selectedClips[0];
  if (!s) return toast('Selectionnez d\'abord un clip', 'warn');
  if (s.track.kind === 'audio') return toast('Les masques ne s\'appliquent qu\'a la video', 'warn');
  store.edit('ajouter masque', () => {
    const m = newMask(shape, { effect: 'blur', strength: 60 });
    s.clip.masks.push(m);
    store.selection.maskId = m.id;
  });
  store.select(s.clip.id);
  inspector.render();
  player.invalidate();
  toast('Masque ajoute — deplacez-le sur l\'apercu', 'ok');
}

function cmdDetachAudio() {
  const sel = store.selectedClips.filter(({ clip, track }) => track.kind === 'video' && clip.kind !== 'text');
  if (!sel.length) return toast('Selectionnez un clip video', 'warn');
  store.edit('detacher audio', (p) => {
    let at = p.tracks.find((t) => t.kind === 'audio');
    if (!at) { at = newTrack('audio', 'Audio 1'); p.tracks.push(at); }
    for (const { clip } of sel) {
      const media = mediaOf(p, clip);
      if (!media || !media.hasAudio) continue;
      at.clips.push(newClip({
        kind: 'audio', mediaId: clip.mediaId, t0: clip.t0, dur: clip.dur, in: clip.in,
        speed: clip.speed, volume: clip.volume, aFadeIn: clip.aFadeIn, aFadeOut: clip.aFadeOut,
      }));
      clip.mute = true;
      normalizeTrack(at);
    }
  });
  player.invalidate();
  toast('Audio detache', 'ok');
}

function cmdTransition(dur) {
  const sel = store.selectedClips;
  if (!sel.length) return toast('Selectionnez le clip de gauche', 'warn');
  store.edit('transition', () => {
    for (const { clip, track } of sel) {
      const i = track.clips.indexOf(clip);
      const next = track.clips[i + 1];
      if (!next) continue;
      const cur = Math.max(0, (clip.t0 + clip.dur) - next.t0);
      const want = clamp(dur, 0, Math.min(clip.dur, next.dur) * 0.9);
      const delta = want - cur;
      for (let j = i + 1; j < track.clips.length; j++) track.clips[j].t0 -= delta;
      clip.transition = { kind: want > 0.01 ? 'dissolve' : 'none', dur: want };
      layoutTrack(track);
    }
  });
  player.invalidate();
}

store.on('cmd', (name, arg) => {
  ({
    split: cmdSplit,
    delete: () => cmdDelete(false),
    rippleDelete: () => cmdDelete(true),
    duplicate: cmdDuplicate,
    addBlurMask: () => cmdAddMask('ellipse'),
    faceBlur: cmdFaceBlur,
    detachAudio: cmdDetachAudio,
    detectBeats: cmdDetectBeats,
    clearBeats: cmdClearBeats,
    mute: cmdMute,
    transition: () => cmdTransition(arg || 0),
  }[name] || (() => {}))();
});
store.on('openInspector', () => { $('#inspector').scrollTop = 0; });

// ---------------------------------------------------------------------- barre

$('#btnImport').onclick = pickFiles;
$('#btnImport2').onclick = pickFiles;
$('#btnImportAudio').onclick = pickFiles;
$('#filePicker').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };

async function pickFiles() {
  // La fenetre de Windows (via le serveur) donne le CHEMIN des fichiers : le
  // projet pourra les relire plus tard sans rien demander, sans les copier.
  try {
    const r = await fetch(`/api/import?tk=${TK}`, { method: 'POST' }).then((x) => x.json());
    if (r && Array.isArray(r.files)) {
      if (!r.files.length) return;                         // fenetre fermee
      return importFiles(r.files.map((f) => new FichierDistant({
        chemin: f.path, name: f.name, size: f.size, lastModified: f.mtime, tk: TK,
      })));
    }
  } catch (_) { /* serveur sans fenetre de dialogue : on passe par le navigateur */ }
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{
          description: 'Medias',
          accept: {
            'video/*': ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.wmv', '.mts', '.m2ts', '.mpg', '.mpeg', '.3gp', '.flv'],
            'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'],
            'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'],
          },
        }],
      });
      return importFiles(handles);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  $('#filePicker').click();
}

$('#btnUndo').onclick = () => { store.undo(); player.invalidate(); };
$('#btnRedo').onclick = () => { store.redo(); player.invalidate(); };
$('#projName').onchange = (e) => { store.project.name = e.target.value || 'Projet'; store.changed(); };

$('#btnPlay').onclick = () => player.toggle();
$('#btnPrevF').onclick = () => player.step(-1);
$('#btnNextF').onclick = () => player.step(1);
$('#btnStart').onclick = () => { player.seek(0); timeline.ensureVisible(0); };
$('#btnEnd').onclick = () => {
  const d = projectDuration(store.project);
  player.seek(d); timeline.ensureVisible(d);
};
$('#btnLoop').onclick = (e) => { player.loop = !player.loop; e.currentTarget.classList.toggle('on', player.loop); };
$('#btnMute').onclick = (e) => {
  player.audioOn = !player.audioOn;
  e.currentTarget.querySelector('use').setAttribute('href', player.audioOn ? '#i-vol' : '#i-vol-off');
  e.currentTarget.classList.toggle('on', !player.audioOn);
};
$('#btnSafe').onclick = (e) => { $('#safe').classList.toggle('on'); e.currentTarget.classList.toggle('on'); };
$('#quality').onchange = (e) => player.setQuality(e.target.value === 'auto' ? 'auto' : parseFloat(e.target.value));
player.on('playstate', (p) => { $('#btnPlay').querySelector('use').setAttribute('href', p ? '#i-pause' : '#i-play'); });

$('#tlSplit').onclick = cmdSplit;
$('#tlCutL').onclick = () => cmdTrimSide('left');
$('#tlCutR').onclick = () => cmdTrimSide('right');
$('#btnFull').onclick = toggleFullscreen;
$('#tlDup').onclick = cmdDuplicate;
$('#tlDel').onclick = () => cmdDelete(false);
$('#tlRipple').onclick = () => cmdDelete(true);
$('#tlMute').onclick = cmdMute;
$('#tlMask').onclick = () => cmdAddMask('ellipse');
$('#tlFace').onclick = cmdFaceBlur;
$('#tlOverlay').onclick = () => {
  const id = binSel.size ? [...binSel][0] : null;
  if (!id) return toast('Choisissez un media dans la bibliotheque', 'warn');
  cmdAddOverlay(id);
};
$('#tlDetach').onclick = cmdDetachAudio;
$('#tlTrans').onclick = () => cmdTransition(0.5);
$('#tlSnap').onclick = (e) => { timeline.snap = !timeline.snap; e.currentTarget.classList.toggle('on', timeline.snap); };
$('#tlZoomIn').onclick = () => { timeline.zoom(1.35); syncZoomSlider(); };
$('#tlZoomOut').onclick = () => { timeline.zoom(1 / 1.35); syncZoomSlider(); };
$('#tlFit').onclick = () => { timeline.fit(); syncZoomSlider(); };
$('#tlZoom').oninput = (e) => {
  // 0..1000 -> 1.5..900 px/s (echelle logarithmique), avec recadrage de la vue
  const f = e.target.value / 1000;
  timeline.setZoom(1.5 * Math.pow(600, f));
};
function syncZoomSlider() {
  const f = Math.log(timeline.pps / 1.5) / Math.log(600);
  $('#tlZoom').value = Math.round(clamp(f, 0, 1) * 1000);
}
$('#btnAddSel').onclick = () => {
  const ids = binSel.size ? [...binSel] : visibleBinIds();
  if (!ids.length) return toast('Importez d\'abord des fichiers', 'warn');
  ids.forEach((id) => addMediaToTimeline(id, { silent: true }));
  timeline.fit(); syncZoomSlider();
  toast(ids.length + ' clip(s) ajoute(s)', 'ok');
};

// ----------------------------------------------------------------- raccourcis

window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const k = e.key;
  if (modKey(e)) {
    switch (k.toLowerCase()) {
      case 'z': e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); player.invalidate(); return;
      case 'y': e.preventDefault(); store.redo(); player.invalidate(); return;
      case 'd': e.preventDefault(); cmdDuplicate(); return;
      case 'i': e.preventDefault(); pickFiles(); return;
      case 'e': e.preventDefault(); openExport(); return;
      case 's': e.preventDefault(); saveProject(); return;
      case 'm': e.preventDefault(); cmdMute(); return;
      case 'a':
        e.preventDefault();
        if (activeZone === 'bin') {
          binSel.clear();
          for (const id of visibleBinIds()) binSel.add(id);
          renderBin();
        } else {
          store.select(store.project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
        }
        return;
    }
    return;
  }
  switch (k) {
    case ' ': e.preventDefault(); player.toggle(); break;
    case 'ArrowLeft': e.preventDefault(); e.shiftKey ? player.seek(store.playhead - 1) : player.step(-1); timeline.ensureVisible(store.playhead); break;
    case 'ArrowRight': e.preventDefault(); e.shiftKey ? player.seek(store.playhead + 1) : player.step(1); timeline.ensureVisible(store.playhead); break;
    case 'Home': player.seek(0); timeline.ensureVisible(0); break;
    case 'End': { const d = projectDuration(store.project); player.seek(d); timeline.ensureVisible(d); break; }
    case 'Delete': case 'Backspace':
      e.preventDefault();
      if (activeZone === 'bin' && binSel.size) removeSelectedMedia();
      else cmdDelete(e.shiftKey);
      break;
    case 's': case 'S': cmdSplit(); break;
    case 'm': case 'M': cmdAddMask('ellipse'); break;
    case 'f': cmdFaceBlur(); break;
    case 'F': if (e.shiftKey) toggleFullscreen(); else cmdFaceBlur(); break;
    case 'q': case 'Q': cmdTrimSide('left'); break;
    case 'w': case 'W': cmdTrimSide('right'); break;
    case 't': case 'T': addText(null); break;
    case 'l': case 'L': $('#btnLoop').click(); break;
    case '+': case '=': timeline.zoom(1.35); syncZoomSlider(); break;
    case '-': timeline.zoom(1 / 1.35); syncZoomSlider(); break;
    case 'z': case 'Z': if (e.shiftKey) { timeline.fit(); syncZoomSlider(); } break;
    case 'Escape': store.select([]); break;
  }
});

// -------------------------------------------------------- glisser-deposer

let dzTimer = 0;
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  const dz = $('#dropzone');
  if (dz) dz.classList.add('hot');
  clearTimeout(dzTimer);
  dzTimer = setTimeout(() => { const d = $('#dropzone'); if (d) d.classList.remove('hot'); }, 250);
});
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer) return;
  if ($('#timeline').contains(e.target)) return;   // gere par la timeline
  e.preventDefault();
  const dz = $('#dropzone');
  if (dz) dz.classList.remove('hot');
  // TOUT est lu tout de suite, avant la moindre attente : les donnees d'un
  // depot ne vivent que le temps de l'evenement. L'ancienne boucle attendait
  // chaque poignee l'une apres l'autre ; des la premiere attente la liste etait
  // videe, et sur plusieurs fichiers deposes d'un coup seul le premier entrait.
  const items = [...(e.dataTransfer.items || [])].filter((it) => it.kind === 'file');
  const fichiers = items.map((it) => it.getAsFile());
  const poignees = items.map((it) => (it.getAsFileSystemHandle ? it.getAsFileSystemHandle().catch(() => null) : null));
  const secours = [...(e.dataTransfer.files || [])];
  if (!items.length) { importFiles(secours); return; }
  // La poignee permet de rouvrir le projet plus tard ; si elle manque, le
  // fichier lui-meme suffit pour monter tout de suite.
  const hs = await Promise.all(poignees.map((p) => p || Promise.resolve(null)));
  const liste = items.map((_, i) => (hs[i] && hs[i].kind === 'file' ? hs[i] : fichiers[i])).filter(Boolean);
  importFiles(liste.length ? liste : secours);
});

// ------------------------------------------------------------ reglages projet

const dlgSet = $('#dlgSettings');

// ------------------------------------------------- place occupee sur le disque

const stockCoches = new Set();

/**
 * Affiche ce que CutLocal occupe, categorie par categorie.
 *
 * Rien de tout cela n'est visible depuis l'application : les videos rapportees,
 * les copies d'apercu et les vignettes s'accumulent en silence. On les presente
 * separement parce qu'elles ne se valent pas — les deux dernieres se
 * refabriquent, la premiere non.
 */
/**
 * Place prise par CutLocal DANS LE PROFIL DU NAVIGATEUR (disque C).
 *
 * Les anciennes versions y rangeaient une copie complete de chaque video
 * importee — invisible depuis l'explorateur, et facilement des dizaines de Go.
 */
async function poidsNavigateur() {
  try {
    const e = await navigator.storage.estimate();
    return e.usage || 0;
  } catch (_) { return 0; }
}

/** Releve serveur + navigateur, presente comme une seule liste. */
async function releveComplet() {
  const r = await fetch(`/api/stockage?tk=${TK}`).then((x) => x.json()).catch(() => null);
  if (!r) return null;
  const nav = await poidsNavigateur();
  // en dessous de quelques Mo, ce ne sont que les projets eux-memes
  const copies = nav > 8 * 1024 * 1024 ? nav : 0;
  r.categories.unshift({
    cle: 'copies',
    titre: 'Copies des videos dans le navigateur',
    note: 'Laissees par les anciennes versions, sur le disque C. Vos fichiers d’origine ne sont pas touches ; '
      + 'les anciens projets qui en dependent retrouveront leurs videos par un nouvel import.',
    refabricable: false,
    octets: copies,
    nombre: copies ? 1 : 0,
  });
  r.total += copies;
  return r;
}

async function chargerStockage() {
  const liste = $('#stStockListe');
  const r = await releveComplet();
  if (!r) { $('#stStockTotal').textContent = 'indisponible'; return; }
  $('#stStockTotal').textContent = fmtSize(r.total);
  majChiffreStock(r.total);
  liste.innerHTML = '';
  for (const c of r.categories) {
    const vide = c.octets === 0;
    const cb = el('input', { type: 'checkbox' });
    cb.checked = stockCoches.has(c.cle) && !vide;
    cb.disabled = vide;
    cb.onchange = () => { if (cb.checked) stockCoches.add(c.cle); else stockCoches.delete(c.cle); };
    liste.append(el('div', { class: 'stock-item' + (vide ? ' vide' : '') }, cb,
      el('span', { class: 'nm' },
        el('span', { text: c.cle === 'copies' ? c.titre : `${c.titre} — ${c.nombre} fichier(s)` }),
        el('small', { text: c.note })),
      el('span', { class: 'sz', text: fmtSize(c.octets) })));
  }
}

async function nettoyerStockage() {
  const cles = [...stockCoches];
  if (!cles.length) return toast('Cochez ce que vous voulez effacer', 'warn');
  if (cles.includes('medias')
    && !confirm('Effacer les videos telechargees ? Les projets qui s\'en servent ne les retrouveront plus.')) return;
  if (cles.includes('copies')
    && !confirm('Effacer les copies des videos gardees par le navigateur ?\n\n'
      + 'Vos fichiers video d’origine ne sont pas touches. Les anciens projets qui ne '
      + 'tenaient qu’a ces copies afficheront leurs videos comme introuvables : '
      + 'importez a nouveau le meme fichier pour les rebrancher.')) return;
  $('#stStockNettoyer').disabled = true;
  $('#stStockEtat').textContent = 'suppression…';
  let libereNav = 0;
  if (cles.includes('copies')) {
    const avant = await poidsNavigateur();
    await idbViderCopies().catch(() => 0);
    // les fichiers du projet ouvert qui n'etaient que des copies ne sont plus lisibles
    for (const id of [...lib.depuisCopie]) { lib.files.delete(id); lib.urls.delete(id); lib.mp4.delete(id); }
    lib.depuisCopie.clear();
    player.disposeAll(); player.invalidate(); store.changed('media');
    // Le navigateur n'efface ses fichiers qu'une fois relaches — en pratique a
    // sa prochaine ouverture (verifie : 193 Mo -> 0,3 Mo apres redemarrage).
    // On annonce donc ce qui VA etre libere.
    libereNav = avant;
  }
  const pourServeur = cles.filter((c) => c !== 'copies');
  const r = pourServeur.length
    ? await fetch(`/api/stockage/vider?tk=${TK}`, {
      method: 'POST', body: JSON.stringify({ categories: pourServeur }),
    }).then((x) => x.json()).catch(() => null)
    : { ok: true, octets: 0, echecs: 0 };
  if (r && r.ok) r.octets += libereNav;
  $('#stStockNettoyer').disabled = false;
  if (!r || !r.ok) { $('#stStockEtat').textContent = 'echec'; return; }
  $('#stStockEtat').textContent = `${fmtSize(r.octets)} liberes`
    + (r.echecs ? ` (${r.echecs} fichier(s) en cours d'utilisation)` : '')
    + (libereNav ? ' — la place du navigateur est rendue a sa prochaine ouverture' : '');
  stockCoches.clear();
  // les copies effacees ne doivent plus etre montrees comme disponibles
  if (cles.includes('apercus')) { lib.apercus.clear(); player.invalidate(); }
  chargerStockage();
  toast(`${fmtSize(r.octets)} liberes`, 'ok');
}

$('#stStockNettoyer').onclick = nettoyerStockage;

/**
 * Chiffre affiche dans la barre du haut.
 *
 * Il n'est mis en avant qu'a partir d'un demi-giga : en dessous, la place
 * occupee n'interesse personne, et une pastille coloree en permanence
 * reclamerait une attention qu'elle ne merite pas.
 */
function majChiffreStock(octets) {
  const e = $('#stockChiffre');
  if (!e) return;
  // en dessous d'un Mo, le chiffre n'apprend rien : l'icone suffit
  e.textContent = octets >= 1024 * 1024 ? fmtSize(octets) : '';
  $('#btnStock').classList.toggle('gros', octets > 512 * 1024 * 1024);
}

/** Releve discret de la place occupee, sans ouvrir la fenetre. */
async function releverStockage() {
  const r = await releveComplet();
  if (r) majChiffreStock(r.total);
}

const dlgStock = $('#dlgStock');
$('#btnStock').onclick = () => {
  stockCoches.clear();
  $('#stStockEtat').textContent = '';
  $('#stStockTotal').textContent = '…';
  $('#stStockListe').innerHTML = '';
  chargerStockage().catch(() => {});
  dlgStock.showModal();
};

// Au demarrage, puis de loin en loin : le chiffre doit rester juste sans que
// l'application interroge le disque en permanence.
releverStockage();
setInterval(releverStockage, 120000);

$('#btnSettings').onclick = () => {
  const p = store.project;
  const res = $('#stRes'); res.innerHTML = '';
  res.append(el('option', { value: 'custom', text: 'Personnalise' }));
  for (const r of RES_PRESETS) res.append(el('option', { value: r.w + 'x' + r.h, text: r.label }));
  res.value = RES_PRESETS.some((r) => r.w === p.width && r.h === p.height) ? p.width + 'x' + p.height : 'custom';
  const fps = $('#stFps'); fps.innerHTML = '';
  for (const f of FPS_PRESETS) fps.append(el('option', { value: f, text: f }));
  fps.value = FPS_PRESETS.includes(p.fps) ? p.fps : 30;
  $('#stW').value = p.width; $('#stH').value = p.height; $('#stBg').value = p.background;
  res.onchange = () => {
    if (res.value === 'custom') return;
    const [w, h] = res.value.split('x').map(Number);
    $('#stW').value = w; $('#stH').value = h;
  };
  dlgSet.showModal();
};
dlgSet.addEventListener('close', () => {
  if (dlgSet.returnValue !== 'ok') return;
  store.edit('reglages', (p) => {
    p.width = clamp(Math.round(+$('#stW').value / 2) * 2, 16, 7680);
    p.height = clamp(Math.round(+$('#stH').value / 2) * 2, 16, 7680);
    p.fps = clamp(+$('#stFps').value, 1, 240);
    p.background = $('#stBg').value;
  });
  layoutStage(); refreshHeader(); player.invalidate();
});

// -------------------------------------------------------------------- export

const dlgEx = $('#dlgExport');
const exporter = new Exporter(store, lib, TK);

// Prefixe du nom de fichier selon la plateforme visee : on complete la fin a la
// main. Le choix est retenu d'un export a l'autre.
const PREFIXES = { tiktok: 'clip2ep_tiktok_', youtube: 'clip2ep_youtube_' };
let exPlateforme = localStorage.getItem('cutlocal.plateforme') || 'tiktok';
const EXPORT_PREFIX = PREFIXES.tiktok;

/** Applique la plateforme choisie : bouton actif + prefixe, en gardant la fin saisie. */
function setPlateforme(nom, garderFin = true) {
  exPlateforme = PREFIXES[nom] ? nom : 'tiktok';
  localStorage.setItem('cutlocal.plateforme', exPlateforme);
  $('#exPlatTiktok').classList.toggle('on', exPlateforme === 'tiktok');
  $('#exPlatYoutube').classList.toggle('on', exPlateforme === 'youtube');
  const inp = $('#exName');
  if (!inp) return;
  // on ne remplace QUE le prefixe : ce que l'utilisateur a tape reste
  let fin = inp.value;
  for (const p of Object.values(PREFIXES)) if (fin.startsWith(p)) { fin = fin.slice(p.length); break; }
  inp.value = PREFIXES[exPlateforme] + (garderFin ? fin : '');
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
}
let updToken = 0;                   // annule les mesures de vitesse depassees
let fastAlt = { hardware: false };  // reglage rapide propose par le sondage

/**
 * Plus grande definition reellement presente dans les sources du projet.
 * Exporter au-dela ne fait qu'agrandir : cela multiplie le travail sans ajouter
 * le moindre detail, puisque les pixels n'existent pas dans le fichier d'origine.
 */
function biggestSource(p) {
  let best = null;
  for (const m of p.media) {
    if (m.kind === 'audio' || !m.width || !m.height) continue;
    if (!best || m.width * m.height > best.w * best.h) {
      best = { w: Math.round(m.width / 2) * 2, h: Math.round(m.height / 2) * 2 };
    }
  }
  return best;
}
function sourcePixels(p) {
  const b = biggestSource(p);
  return b ? b.w * b.h : 0;
}

async function openExport() {
  const p = store.project;
  if (!projectDuration(p)) return toast('La timeline est vide', 'warn');
  if (typeof VideoEncoder === 'undefined') return toast('Export impossible : WebCodecs absent', 'error');

  const res = $('#exRes'); res.innerHTML = '';
  res.append(el('option', { value: p.width + 'x' + p.height, text: `Projet — ${p.width}×${p.height}` }));
  for (const r of RES_PRESETS) if (!(r.w === p.width && r.h === p.height)) res.append(el('option', { value: r.w + 'x' + r.h, text: r.label }));
  const fps = $('#exFps'); fps.innerHTML = '';
  for (const f of [...new Set([p.fps, ...FPS_PRESETS])].sort((a, b) => a - b)) fps.append(el('option', { value: f, text: f }));
  const cod = $('#exCodec'); cod.innerHTML = '';
  for (const c of CODECS) cod.append(el('option', { value: c.id, text: c.label }));

  // Par defaut : la definition de la plus grande source, jamais au-dessus.
  // On ne perd donc aucun detail (une source 4K sort en 4K) et on n'agrandit
  // jamais pour rien — agrandir quadruple le travail sans ajouter un pixel.
  const big = biggestSource(p);
  if (big && !RES_PRESETS.some((r) => r.w === big.w && r.h === big.h)
      && !(big.w === p.width && big.h === p.height)) {
    res.append(el('option', { value: big.w + 'x' + big.h, text: `Sources — ${big.w}×${big.h}` }));
  }
  // ------------------------------------------------ reglages TikTok 4K 60 i/s
  // 2160x3840 : la 4K verticale, le format que TikTok accepte en pleine
  //   definition (l'horizontale seulement si le projet l'est).
  // 60 i/s : la fluidite maximale acceptee par la plateforme.
  // H.264 : le seul codec lu partout, y compris a la reception TikTok.
  // Qualite haute : ~55 Mb/s en 4K60, largement au-dessus de ce que TikTok
  //   conserve apres recompression — inutile de monter plus haut, mais il ne
  //   faut pas descendre : un debit serre fait « battre » l'image a chaque
  //   image cle, tres visible sur un plan pose.
  // Image cle toutes les 2 s : deux fois moins d'occasions de battre qu'avec
  //   une cle par seconde, et bien en deca de la limite des plateformes.
  // AAC 192 kb/s : le maximum utile pour de la video sociale.
  const uhd = p.height > p.width ? { w: 2160, h: 3840 } : { w: 3840, h: 2160 };
  res.value = uhd.w + 'x' + uhd.h;
  if (!res.selectedOptions.length) res.value = big ? big.w + 'x' + big.h : res.options[0].value;
  fps.value = FPS_PRESETS.includes(60) ? 60 : p.fps;
  cod.value = 'avc';
  $('#exQual').value = 'max';
  $('#exAudio').value = '192000';
  $('#exRange').value = 'all';
  $('#exGop').value = Math.round((+fps.value || 30) * 2);

  // nom du fichier : le prefixe de la plateforme est pose, le curseur attend la suite
  const nameIn = $('#exName');
  nameIn.value = PREFIXES[exPlateforme] || PREFIXES.tiktok;
  setPlateforme(exPlateforme, false);

  const upd = async () => {
    const [w, h] = res.value.split('x').map(Number);
    const br = suggestBitrate(w, h, +fps.value, cod.value, $('#exQual').value);
    $('#exBitrate').value = (br / 1e6).toFixed(br < 1e7 ? 1 : 0);
    const sel = $('#exRange').value === 'sel' && store.selectedClips.length;
    const d = sel ? selRange().to - selRange().from : projectDuration(p);
    const size = (br + (+$('#exAudio').value || 0)) * d / 8;
    let txt = `${w}×${h} · ${fps.value} i/s · ${fmtTime(d)} → environ ${fmtSize(size)}`;
    const info = $('#exInfo');
    info.classList.remove('warn');
    const token = ++updToken;
    try {
      const { resolveVideoConfig } = await import('./exporter.js');
      const r = await resolveVideoConfig({
        codec: cod.value, width: w, height: h, fps: +fps.value, bitrate: br, quality: $('#exQual').value,
      });
      if (token !== updToken) return;            // un autre reglage est arrive entre-temps
      // Pas d'estimation de duree ici : une mesure courte est dominee par le
      // demarrage de l'encodeur et se trompe d'un facteur 2 a 4. La vraie
      // estimation apparait pendant l'export, calculee sur les images encodees.
      const srcPx = sourcePixels(p);
      if (srcPx && w * h > srcPx * 1.2) {
        const f = (w * h) / srcPx;
        txt += ` · ⚠ agrandissement : ${f.toFixed(1)}× plus de pixels que vos sources, `
          + 'donc un export bien plus long sans gain de qualite';
        info.classList.add('warn');
      } else if (!r.hardware) {
        // proposer concretement le reglage rapide le plus proche
        const alt = fastAlt.hardware ? `${fastAlt.w}×${fastAlt.h} à ${fastAlt.fps} i/s` : null;
        txt += ' · ⚠ NON accéléré par votre carte (encodage logiciel, lent)'
          + (alt ? ` — réglage rapide : ${alt}` : '');
        info.classList.add('warn');
      } else txt += ' · GPU (rapide)';
    } catch (e) { txt += ' · ⚠ ' + e.message; info.classList.add('warn'); }
    if (token === updToken) info.textContent = txt;
  };
  for (const n of ['#exRes', '#exFps', '#exCodec', '#exQual', '#exAudio', '#exRange']) $(n).onchange = upd;
  dlgEx.showModal();
  nameIn.focus();
  nameIn.setSelectionRange(nameIn.value.length, nameIn.value.length);
  $('#exInfo').textContent = 'Recherche du réglage le plus rapide pour votre carte…';

  // Sondage materiel (asynchrone) : on ouvre la boite tout de suite, puis on
  // bascule sur le meilleur reglage ACCELERE des qu'on le connait.
  // On calcule quand meme le reglage rapide, mais seulement pour le PROPOSER
  // dans le message : le choix affiche reste celui demande.
  fastAlt = await pickFastDefault(p, cod.value);
  if (dlgEx.open) upd();
}
$('#btnExport').onclick = openExport;
$('#exPlatTiktok').onclick = () => setPlateforme('tiktok');
$('#exPlatYoutube').onclick = () => setPlateforme('youtube');

function selRange() {
  const sel = store.selectedClips;
  if (!sel.length) return { from: 0, to: projectDuration(store.project) };
  let a = Infinity, b = 0;
  for (const { clip } of sel) { a = Math.min(a, clip.t0); b = Math.max(b, clip.t0 + clip.dur); }
  return { from: a, to: b };
}

dlgEx.addEventListener('close', async () => {
  if (dlgEx.returnValue !== 'go') return;
  const p = store.project;
  const [w, h] = $('#exRes').value.split('x').map(Number);
  const fps = +$('#exFps').value;
  const codec = $('#exCodec').value;
  const bitrate = Math.round(parseFloat($('#exBitrate').value) * 1e6);
  const audioBitrate = +$('#exAudio').value;
  const gop = clamp(+$('#exGop').value || fps, 1, 600);
  const range = $('#exRange').value === 'sel' ? selRange() : { from: 0, to: projectDuration(p) };

  // nom choisi dans la boite d'export : le prefixe est deja pose, l'utilisateur
  // n'a eu qu'a taper la fin
  let base = ($('#exName').value || PREFIXES[exPlateforme] || EXPORT_PREFIX).trim()
    .replace(/[\\/:*?"<>|]/g, '_').replace(/\.mp4$/i, '');
  if (!base) base = (PREFIXES[exPlateforme] || EXPORT_PREFIX) + h + 'p';
  const suggested = base + '.mp4';
  // Enregistrement direct sur le Bureau : le nom a deja ete saisi dans la boite,
  // ouvrir une seconde fenetre pour le redemander n'apporte rien.
  let outPath = null;
  try {
    const d = await fetch(`/api/desktop?tk=${TK}`).then((x) => x.json());
    if (d && d.path) outPath = d.path.replace(/[\\\\/]+$/, '') + '\\' + suggested;
  } catch (_) { /* on retombe sur la boite native */ }
  if (!outPath) {
    const r = await fetch(`/api/savedialog?tk=${TK}&name=${encodeURIComponent(suggested)}`, { method: 'POST' }).then((x) => x.json());
    if (!r.path) return;
    outPath = r.path;
  }
  const r = { path: outPath };

  player.pause();
  showProgress(true);
  const t0 = performance.now();
  try {
    const out = await exporter.run({
      path: r.path, width: w, height: h, fps, codec, bitrate,
      audioBitrate: audioBitrate || 0, withAudio: audioBitrate > 0,
      quality: $('#exQual').value,
      sampleRate: p.sampleRate || 48000, gop,
      from: range.from, to: range.to,
      // Le decoupage en tranches est ce qui rend l'export rapide, mais c'est
      // aussi ce qui sollicite le plus la machine : autant de decodeurs et
      // d'encodeurs ouverts en meme temps qu'il y a de tranches. Sur certaines
      // configurations cela suffit a faire decrocher le materiel.
      monocoeur: $('#exSeul').checked,
    }, onExportProgress);
    const secs = (performance.now() - t0) / 1000;
    $('#opTitle').textContent = '✔ Export termine';
    $('#opText').textContent = out.path;
    $('#opSub').textContent = `${fmtSize(out.bytes)} · ${out.frames} images · ${secs.toFixed(1)} s (${(out.frames / secs).toFixed(1)} i/s)`;
    $('#opBar').style.width = '100%';
    $('#opCancel').classList.add('hidden');
    $('#opClose').classList.remove('hidden');
    $('#opReveal').classList.remove('hidden');
    $('#opReveal').onclick = () => fetch(`/api/reveal?tk=${TK}&p=${encodeURIComponent(out.path)}`, { method: 'POST' });
    proposerVlc(out.path);
  } catch (e) {
    const cancel = /annul/i.test(e.message);
    $('#opTitle').textContent = cancel ? 'Export annule' : '✖ Echec de l\'export';
    $('#opText').textContent = cancel ? '' : e.message;
    $('#opSub').textContent = '';
    $('#opCancel').classList.add('hidden');
    $('#opClose').classList.remove('hidden');
    if (!cancel) console.error(e);
  }
});

function onExportProgress(s) {
  $('#opBar').style.width = (s.ratio * 100).toFixed(1) + '%';
  $('#opTitle').textContent = s.phase + '…';
  if (s.frame) {
    $('#opText').textContent = `Image ${s.frame} / ${s.total} — ${(s.fps || 0).toFixed(1)} img/s`;
    const bits = [`Reste environ ${fmtTime(s.eta || 0)}`];
    if (s.bytes) bits.push(fmtSize(s.bytes));
    bits.push(s.hardware ? 'GPU' : 'encodage logiciel');
    const FREIN = {
      decode: 'le frein est la LECTURE de vos videos sources',
      render: 'le frein est le rendu des effets',
      encode: "le frein est l'encodage",
      disk: "le frein est l'ecriture sur le disque",
    };
    // en dessous du temps reel, on explique ce qui coince plutot que de laisser
    // l'utilisateur devant un compteur qui rampe sans raison apparente
    if (s.slowSource) bits.push(`« ${s.slowSource} » n'est pas lisible par le GPU`);
    else if (s.bottleneck && (s.fps || 0) < 12) bits.push(FREIN[s.bottleneck]);
    $('#opSub').textContent = bits.join(' · ');

    // Quand la lecture freine, on precise LAQUELLE des deux causes : un disque
    // qui ne suit pas, ou un decodeur qui repart d'une image cle a chaque image.
    const dg = s.diag;
    let extra = '';
    // Un basculement ou un repli se voit TOUJOURS : c'est lui qui fait perdre
    // des images, et le masquer derriere un seuil de debit revenait a livrer une
    // video qui saccade sans jamais dire pourquoi.
    if (dg && (dg.switched || dg.softwareDecode || dg.mode === 'track' || dg.mode === 'element'
        || (s.bottleneck === 'decode' && (s.fps || 0) < 12))) {
      if (dg.switched) {
        extra = `« ${dg.switched.name} » decodait a ${dg.switched.fps.toFixed(1)} img/s : `
          + 'bascule automatique sur le lecteur du navigateur, bien plus rapide sur ce format.';
      } else if (dg.streamGaps > 3) {
        extra = `${dg.streamGaps} images n'ont pas pu etre lues au vol : le resultat `
          + 'peut saccader. Reencodez la source en MP4 H.264 pour un export net et rapide.';
      } else if (dg.softwareDecode) {
        extra = `« ${dg.softwareDecode} » est decodee par le processeur, pas par le GPU `
          + "(codec non accelere sur cette machine). C'est la cause. "
          + 'Reencodez-la en MP4 H.264 pour un export rapide.';
      } else if (dg.mode === 'track' || dg.mode === 'element') {
        extra = "Cette video n'est pas lisible par le decodeur rapide : elle passe par "
          + 'le lecteur du navigateur, qui ne rend pas toutes les images — le resultat '
          + 'peut saccader. Reencodez-la en MP4 H.264 pour un export net.';
      } else if (dg.seeksPerFrame > 0.5) {
        extra = `Le decodeur se repositionne ${dg.seeksPerFrame.toFixed(1)} fois par image : `
          + "cette video oblige a repartir d'une image cle sans arret.";
      } else if (dg.readMBps > 0 && dg.readMBps < 25) {
        extra = `Lecture du fichier a ${dg.readMBps.toFixed(0)} Mo/s : le disque qui contient la video est lent. `
          + 'Copiez-la sur le disque systeme pour aller beaucoup plus vite.';
      } else {
        extra = `Decodage lent (${dg.readMBps.toFixed(0)} Mo/s de lecture, `
          + `${dg.seeksPerFrame.toFixed(2)} repositionnement/image) : la video source est difficile a decoder.`;
      }
    }
    $('#opDiag').textContent = extra;
    $('#opDiag').classList.toggle('hidden', !extra);
  } else $('#opText').textContent = '';
}

// ------------------------------------------------------- envoi vers VLC iPhone

const VLC_ADR = 'cutlocal.vlcUrl';

/** Propose l'envoi de la video qui vient d'etre exportee. Rien n'est envoye
 *  sans un clic explicite : deposer un fichier sur un telephone, c'est le
 *  sortir de cette machine. */
function proposerVlc(chemin) {
  const bloc = $('#opVlc');
  const etat = $('#opVlcEtat');
  const url = $('#opVlcUrl');
  url.value = localStorage.getItem(VLC_ADR) || '192.168.1.26';
  etat.textContent = '';
  etat.className = 'op-vlc-etat';
  bloc.classList.remove('hidden');
  $('#opVlcOui').disabled = false;

  $('#opVlcNon').onclick = () => bloc.classList.add('hidden');
  $('#opVlcOui').onclick = async () => {
    const adr = url.value.trim();
    if (!adr) { etat.textContent = "Indiquez l'adresse affichee par VLC sur l'iPhone."; etat.className = 'op-vlc-etat no'; return; }
    localStorage.setItem(VLC_ADR, adr);
    $('#opVlcOui').disabled = true;
    etat.className = 'op-vlc-etat';
    etat.textContent = 'Verification de VLC…';
    const j = await fetch(`/api/vlc/probe?tk=${TK}&url=${encodeURIComponent(adr)}`).then((x) => x.json()).catch(() => ({ ok: false }));
    if (!j.ok) {
      etat.className = 'op-vlc-etat no';
      etat.textContent = `VLC ne repond pas a cette adresse (${j.error || 'injoignable'}). `
        + "Sur l'iPhone : VLC → Reseau → « Partage via Wi-Fi », puis recopiez l'adresse affichee.";
      $('#opVlcOui').disabled = false;
      return;
    }
    etat.textContent = 'Envoi en cours…';
    const r = await fetch(`/api/vlc/send?tk=${TK}`, {
      method: 'POST', body: JSON.stringify({ path: chemin, url: adr }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) {
      etat.className = 'op-vlc-etat ok';
      etat.textContent = `Envoye (${fmtSize(r.taille || 0)}). Sur l'iPhone : ouvrez VLC, appuyez longuement `
        + 'sur la video, puis « Enregistrer dans Photos ».';
      toast('Video envoyee sur VLC', 'ok', 4000);
    } else {
      etat.className = 'op-vlc-etat no';
      etat.textContent = 'Echec : ' + (r.error || 'inconnu');
      $('#opVlcOui').disabled = false;
    }
  };
}

function showProgress(on) {
  $('#exportOverlay').classList.toggle('hidden', !on);
  $('#opBar').style.width = '0%';
  $('#opCancel').classList.remove('hidden');
  $('#opClose').classList.add('hidden');
  $('#opReveal').classList.add('hidden');
  $('#opTitle').textContent = 'Preparation…';
  $('#opText').textContent = '';
  $('#opSub').textContent = '';
  $('#opVlc').classList.add('hidden');
  $('#opDiag').classList.add('hidden');
}
$('#opCancel').onclick = () => {
  $('#opTitle').textContent = 'Annulation…';
  $('#opText').textContent = '';
  $('#opSub').textContent = '';
  $('#opCancel').classList.add('hidden');
  exporter.cancel();          // coupe codecs et ecritures : rend la main aussitot
};
$('#opClose').onclick = () => showProgress(false);

// -------------------------------------------------------------------- projets

let projectId = null;                       // identifiant du projet en cours
const scheduleAutosave = debounce(() => saveProject(true), 4000);

async function saveProject(silent) {
  try {
    if (!projectId) projectId = 'p' + Math.random().toString(36).slice(2, 10);
    // On ne range PAS les videos dans le navigateur : il en garderait une copie
    // complete dans son profil (verifie : des dizaines de Go sur le disque C).
    // On garde une POIGNEE vers le fichier d'origine — quelques octets — et le
    // navigateur redemande l'autorisation de le lire a la reouverture.
    // Seuls les medias d'anciens projets, qui n'existent plus que sous forme de
    // copie, y restent tant qu'ils ne sont pas rebranches sur leur fichier.
    const files = {};
    const handles = {};
    for (const m of store.project.media) {
      const h = lib.handles.get(m.id);
      if (h) { handles[m.id] = h; continue; }
      if (m.chemin) continue;                      // video telechargee : on connait son chemin
      const f = lib.files.get(m.id);
      if (f && lib.depuisCopie.has(m.id)) files[m.id] = f;
    }
    // Vignette du projet : la refaire a CHAQUE enregistrement automatique
    // (quelques secondes apres chaque coupe) ouvrait un decodeur 4K et relisait
    // le disque juste pendant le montage. Une par minute suffit largement pour
    // l'ecran d'accueil ; un enregistrement demande a la main la refait.
    const prev = await idbGet(projectId).catch(() => null);
    let thumb = null;
    const ilYa = Date.now() - (saveProject.vignetteA || 0);
    if (!silent || !(prev && prev.thumb) || ilYa > 60000) {
      try { thumb = await player.thumbnail(320); } catch (_) {}
      if (thumb) saveProject.vignetteA = Date.now();
    }
    await idbSave({
      id: projectId,
      title: store.project.name || 'Projet sans titre',
      project: JSON.parse(JSON.stringify(store.project)),
      files,
      handles,
      playhead: store.playhead,
      thumb: thumb || (prev && prev.thumb) || null,
      savedAt: Date.now(),
      createdAt: (prev && prev.createdAt) || Date.now(),
    });
    etatEnregistrement(true);
    if (!silent) toast('Projet enregistre', 'ok');
  } catch (e) {
    if (!silent) toast('Enregistrement impossible : ' + e.message, 'error');
  }
}

async function loadProject(id) {
  const rec = await idbGet(id);
  if (!rec) return toast('Projet introuvable', 'error');
  player.pause();
  player.disposeAll();
  lib.files.clear(); lib.urls.clear(); lib.mp4.clear(); lib.strips.clear(); lib.waves.clear();
  if (lib._sons) lib._sons.clear();
  lib.apercus.clear();
  projectId = rec.id;
  store.project = migrateProject(rec.project);
  if (rec.title) store.project.name = rec.title;
  relayoutAll(store.project);   // referme les trous eventuels des pistes collees
  store.selection = { clipIds: [], maskId: null };
  store.undoStack.length = 0; store.redoStack.length = 0;
  lib.handles.clear(); lib.depuisCopie.clear();
  for (const [id2, f] of Object.entries(rec.files || {})) {
    if (f) { lib.files.set(id2, f); lib.depuisCopie.add(id2); }
  }
  const { recherche } = await rebrancherFichiers(rec.handles || {});
  store.seek(rec.playhead || 0);
  store.emit('reload');
  store.changed();
  timeline.fit(); syncZoomSlider();
  // tout juste rouvert : rien n'a ete modifie
  etatEnregistrement(true);
  // Le projet est deja a l'ecran ; ce que le serveur retrouve sur le disque
  // arrive juste apres, sans rien bloquer.
  const projetCherche = projectId;
  recherche.then((n) => {
    if (projectId !== projetCherche) return;
    if (n) {
      store.changed('media'); player.invalidate(); timeline.draw(); renderBin();
      toast(`${n} video(s) retrouvee(s) automatiquement`, 'ok', 3500);
      saveProject(true);                       // le projet retient les chemins
    }
    if (lib.missing().length) { signalerManquants(); retrouverEnFond(projetCherche); }
  });
  // Les copies d'apercu survivent aux sessions : on les rebranche, et on
  // fabrique celles qui manquent.
  preparerApercus(store.project.media);
}

/** Fichier lu par le serveur, a partir d'un chemin et de ce qu'on en sait. */
function distant(chemin, m, st) {
  return new FichierDistant({ chemin, name: m.name, size: st ? st.size : m.size, lastModified: st ? st.mtime : 0, tk: TK });
}

/**
 * Demande au serveur ou se trouvent ces medias (nom + taille), et les rebranche.
 * Le serveur cherche dans les dossiers deja connus, les dossiers personnels et
 * les autres disques ; il ne lit que des listes de dossiers.
 * @returns {Promise<number>} nombre de medias rebranches
 */
async function localiserMedias(medias, dossiers = []) {
  if (!medias.length && !dossiers.length) return 0;
  let trouves = {};
  try {
    const r = await fetch(`/api/localiser?tk=${TK}`, {
      method: 'POST',
      body: JSON.stringify({ fichiers: medias.map((m) => ({ name: m.name, size: m.size })), dossiers }),
    }).then((x) => x.json());
    trouves = r.trouves || {};
  } catch (_) { return 0; }
  let n = 0;
  for (const m of medias) {
    const chemin = trouves[m.name + '|' + m.size];
    if (!chemin) continue;
    lib.relier(m.id, distant(chemin, m), null);
    n++;
  }
  return n;
}

/**
 * Rouvre les videos d'un projet, SANS RIEN DEMANDER.
 *
 * 1. Les medias dont on connait le chemin sont relus par le serveur, sur
 *    place : instantane, aucune autorisation.
 * 2. Une poignee de fichier n'est utilisee que si le navigateur l'autorise
 *    deja ; on ne declenche jamais sa fenetre d'autorisation.
 * 3. Pour le reste, le serveur cherche le fichier sur le disque (nom + taille),
 *    et le projet retient son chemin pour la prochaine fois.
 */
async function rebrancherFichiers(handles) {
  const media = store.project.media;
  // 1. chemins connus, verifies d'un seul appel
  const avecChemin = media.filter((m) => m.chemin && !lib.files.has(m.id));
  if (avecChemin.length) {
    try {
      const st = await fetch(`/api/stats?tk=${TK}`, {
        method: 'POST', body: JSON.stringify({ chemins: avecChemin.map((m) => m.chemin) }),
      }).then((x) => x.json());
      for (const m of avecChemin) {
        const s2 = st[m.chemin];
        if (s2 && (!m.size || s2.size === m.size)) lib.relier(m.id, distant(m.chemin, m, s2), null);
      }
    } catch (_) {}
  }
  // 2. poignees deja autorisees (sans jamais ouvrir de fenetre)
  const candidats = { ...handles };
  for (const m of media) {
    if (candidats[m.id] || lib.files.has(m.id)) continue;
    const h = await idbPoignee(m.name, m.size);
    if (h) candidats[m.id] = h;
  }
  for (const [mid, h] of Object.entries(candidats)) {
    if (!h || typeof h.getFile !== 'function' || lib.files.has(mid)) continue;
    try {
      if ((await h.queryPermission({ mode: 'read' })) !== 'granted') continue;
      const f = await h.getFile();
      const m = media.find((x) => x.id === mid);
      if (m && m.size && f.size !== m.size) continue;
      lib.relier(mid, f, h);
    } catch (_) { /* fichier deplace ou efface */ }
  }
  // 3. le serveur cherche le reste sur le disque, en arriere-plan
  const reste = media.filter((m) => !lib.files.has(m.id) && m.kind !== 'text');
  // (renvoye dans un objet : une promesse renvoyee telle quelle serait
  // attendue par l'appelant, et l'ouverture du projet attendrait la recherche)
  if (!reste.length) return { recherche: Promise.resolve(0) };
  const t = toast(`Recherche de ${reste.length} video(s) sur le disque…`, 'info', 120000);
  return { recherche: localiserMedias(reste).finally(() => t.remove()) };
}

/**
 * Tant que des videos manquent, on les recherche de temps en temps, sans rien
 * demander : le cas typique est le disque externe branche APRES l'ouverture du
 * projet. Des qu'il est la, les videos reviennent toutes seules.
 */
function retrouverEnFond(id) {
  if (retrouverEnFond.actif === id) return;
  retrouverEnFond.actif = id;
  const tour = async () => {
    if (projectId !== id || retrouverEnFond.actif !== id) return;
    const manquants = lib.missing().filter((m) => m.kind !== 'text');
    if (!manquants.length) { retrouverEnFond.actif = null; return; }
    let n = 0;
    // chemins deja connus : le disque est peut-etre revenu
    const connus = manquants.filter((m) => m.chemin);
    if (connus.length) {
      try {
        const st = await fetch(`/api/stats?tk=${TK}`, {
          method: 'POST', body: JSON.stringify({ chemins: connus.map((m) => m.chemin) }),
        }).then((x) => x.json());
        for (const m of connus) {
          const s2 = st[m.chemin];
          if (s2 && (!m.size || s2.size === m.size)) { lib.relier(m.id, distant(m.chemin, m, s2), null); n++; }
        }
      } catch (_) {}
    }
    const reste = lib.missing().filter((m) => m.kind !== 'text');
    if (reste.length) n += await localiserMedias(reste);
    if (projectId !== id) return;
    if (n) {
      store.changed('media'); player.invalidate(); timeline.draw(); renderBin();
      toast(`${n} video(s) retrouvee(s) automatiquement`, 'ok', 3500);
      saveProject(true);
    }
    if (lib.missing().length) setTimeout(tour, 15000);
    else retrouverEnFond.actif = null;
  };
  setTimeout(tour, 15000);
}

/**
 * Apres un glisser-deposer, le navigateur ne donne pas le chemin du fichier.
 * On le fait retrouver par le serveur, en arriere-plan : le projet le retient
 * et se rouvrira plus tard sans rien demander.
 */
async function cheminsEnFond(medias) {
  const sansChemin = medias.filter((m) => m && !m.chemin && lib.files.has(m.id) && !lib.files.get(m.id).distant);
  if (!sansChemin.length) return;
  // rien ne presse : on attend que l'apercu laisse le disque libre
  for (let i = 0; i < 240 && lib.occupe(); i++) await new Promise((r) => setTimeout(r, 500));
  try {
    const r = await fetch(`/api/localiser?tk=${TK}`, {
      method: 'POST', body: JSON.stringify({ fichiers: sansChemin.map((m) => ({ name: m.name, size: m.size })) }),
    }).then((x) => x.json());
    let n = 0;
    for (const m of sansChemin) {
      const chemin = (r.trouves || {})[m.name + '|' + m.size];
      if (chemin) { m.chemin = chemin; n++; }
    }
    if (n) scheduleAutosave();
  } catch (_) {}
}

/** Annonce les videos introuvables, avec de quoi les retrouver d'un clic. */
function signalerManquants() {
  const n = lib.missing().length;
  if (!n) return;
  const t = toast(`${n} video(s) introuvable(s) dans ce projet`, 'warn', 30000);
  t.append(' ', el('button', {
    class: 'btn sm', text: 'Retrouver mes videos…',
    onclick: () => { t.remove(); retrouverVideos(); },
  }));
}

/**
 * Retrouve les videos manquantes dans un dossier choisi par l'utilisateur.
 *
 * C'est le serveur qui cherche (fenetre de choix de dossier de Windows, puis
 * parcours du dossier et de ses sous-dossiers) : aucune autorisation a donner,
 * rien n'est copie. Un fichier correspond s'il porte le meme nom ET la meme
 * taille. Le dossier est retenu : les prochains projets s'y retrouvent seuls.
 */
async function retrouverVideos() {
  const manquants = lib.missing();
  if (!manquants.length) return toast('Aucune video manquante', 'ok');
  let dossier = null;
  try { dossier = (await fetch(`/api/folder?tk=${TK}`, { method: 'POST' }).then((x) => x.json())).path; } catch (_) {}
  if (!dossier) return;                                   // fenetre fermee
  const t = toast('Recherche des videos…', 'info', 120000);
  const trouves = await localiserMedias(manquants, [dossier]);
  t.remove();
  store.changed('media'); player.invalidate(); timeline.draw(); renderBin();
  const reste = lib.missing().length;
  if (trouves) {
    toast(`${trouves} video(s) retrouvee(s)` + (reste ? ` — ${reste} toujours introuvable(s)` : ''), reste ? 'warn' : 'ok', 6000);
    saveProject(true);                       // le projet retient les chemins
  } else {
    toast('Aucune video correspondante dans ce dossier (meme nom et meme taille)', 'warn', 6000);
  }
}

function newBlankProject(name) {
  player.pause(); player.disposeAll();
  lib.handles.clear(); lib.depuisCopie.clear();
  lib.files.clear(); lib.urls.clear(); lib.mp4.clear(); lib.strips.clear(); lib.waves.clear();
  if (lib._sons) lib._sons.clear();
  lib.apercus.clear();
  if (lib.cles) lib.cles.clear();
  binSel.clear();
  projectId = 'p' + Math.random().toString(36).slice(2, 10);
  store.project = newProject({ name: name || nextProjectName() });
  store.selection = { clipIds: [], maskId: null };
  store.undoStack.length = 0; store.redoStack.length = 0;
  store.seek(0);
  store.emit('reload'); store.changed();
  timeline.fit(); syncZoomSlider();
  setTab('media');
  // l'apercu montrait encore la derniere image du projet precedent
  player.invalidate();
  etatEnregistrement(true);                  // rien a enregistrer encore
}

function nextProjectName() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `Projet ${p2(d.getDate())}-${p2(d.getMonth() + 1)} ${p2(d.getHours())}h${p2(d.getMinutes())}`;
}

// ------------------------------------------------------------ ecran d'accueil

const home = new Home({
  currentId: () => projectId,
  onOpen: (id) => loadProject(id),
  onNew: (alsoImport) => {
    newBlankProject();
    if (alsoImport) setTimeout(pickFiles, 120);
  },
  onRenamed: (id, title) => {
    if (id === projectId) { store.project.name = title; refreshHeader(); }
  },
});

$('#btnSave').onclick = () => saveProject(false);
$('#btnHome').onclick = () => {
  // Le menu s'ouvre TOUT DE SUITE ; l'enregistrement du projet en cours se fait
  // derriere. Attendre la sauvegarde — vignette comprise — avant d'afficher
  // donnait l'impression que le bouton ne repondait pas.
  home.show(false);
  saveProject(true).catch(() => {});
};

initBinMarquee($('#bin'));
initBinMarquee($('#binAudio'));

(async () => {
  initSplitters();
  layoutStage(); refreshHeader(); renderBin(); inspector.render();
  refreshMuteBtn(); syncZoomSlider(); renderClipChips();
  const list = await idbList().catch(() => []);
  if (list.length) {
    home.show(true);                        // page d'accueil, comme CapCut
  } else {
    projectId = 'p' + Math.random().toString(36).slice(2, 10);
    store.project.name = nextProjectName();
    refreshHeader();
  }
})();

window.addEventListener('beforeunload', () => { if (store.project.media.length) saveProject(true); });

window.CutLocal = {
  store, lib, player, renderer, timeline, inspector, overlay, exporter, home,
  setTab, cmdMute, cmdFaceBlur, cmdAddOverlay, runTool, addText, cmdTrimSide, toggleFullscreen,
  removeSelectedMedia, binSel, activateZone, get activeZone() { return activeZone; },
  stackOnOwnTracks, addOnNewAudioTrack,
  loadProject, newBlankProject, saveProject,
  get projectId() { return projectId; },
  prechauffe,
};
