// Ecran d'accueil : tous les projets enregistres, comme la page d'accueil de CapCut.
import { el, $, fmtTime, fmtSize, toast } from './util.js';
import { idbList, idbGet, idbSave, idbDelete } from './idb.js';
import { projectDuration } from './state.js';

const SVGNS = 'http://www.w3.org/2000/svg';
function icon(name, cls = 'i') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', cls);
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}

function ago(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 90) return 'a l\'instant';
  if (d < 3600) return 'il y a ' + Math.round(d / 60) + ' min';
  if (d < 86400) return 'il y a ' + Math.round(d / 3600) + ' h';
  if (d < 86400 * 7) return 'il y a ' + Math.round(d / 86400) + ' j';
  return new Date(ts).toLocaleDateString('fr-FR');
}

export class Home {
  /**
   * @param {object} deps { onOpen(id), onNew(), currentId() }
   */
  constructor(deps) {
    this.deps = deps;
    this.root = $('#home');
    this.grid = $('#homeGrid');
    this.query = '';
    $('#homeNew').onclick = () => { this.hide(); this.deps.onNew(); };
    $('#homeClose').onclick = () => this.hide();
    $('#homeImport').onclick = () => { this.hide(); this.deps.onNew(true); };
    $('#homeSearch').oninput = (e) => { this.query = e.target.value.trim().toLowerCase(); this.render(); };
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root && !this.forced) this.hide();
    });
  }

  async show(forced = false) {
    this.forced = forced;
    // On AFFICHE d'abord, on remplit ensuite : attendre la base avant de montrer
    // quoi que ce soit donnait l'impression que le bouton ne repondait pas.
    // Les projets deja lus restent affiches pendant le rafraichissement.
    this.root.classList.remove('hidden');
    $('#homeClose').classList.toggle('hidden', forced);
    if (this.items) this.render();
    else $('#homeCount').textContent = 'chargement…';
    setTimeout(() => $('#homeSearch').focus(), 0);
    this.items = await idbList().catch(() => []);
    if (this.visible) this.render();
  }

  hide() { this.root.classList.add('hidden'); }
  get visible() { return !this.root.classList.contains('hidden'); }

  render() {
    const g = this.grid;
    g.innerHTML = '';
    const list = (this.items || []).filter((p) => !this.query || (p.title || '').toLowerCase().includes(this.query));
    $('#homeCount').textContent = this.items ? `${this.items.length} projet${this.items.length > 1 ? 's' : ''}` : '';

    if (!list.length) {
      g.append(el('div', { class: 'home-empty' },
        icon('film', 'i xl'),
        el('p', { text: this.query ? 'Aucun projet a ce nom.' : 'Aucun projet enregistre pour le moment.' }),
        el('p', { class: 'faint tiny', text: 'Creez-en un et il apparaitra ici automatiquement.' })));
      return;
    }

    for (const p of list) {
      // La liste vient de l'index leger : les infos y sont deja resumees. On
      // retombe sur le projet complet pour les enregistrements d'avant l'index.
      const proj = p.project || {};
      const dur = p.duration !== undefined ? p.duration
        : (proj.tracks ? projectDuration(proj) : 0);
      const nClips = p.clips !== undefined ? p.clips
        : (proj.tracks || []).reduce((s, t) => s + (t.clips || []).length, 0);
      const larg = p.width || proj.width || 0;
      const haut = p.height || proj.height || 0;
      const cad = p.fps || proj.fps || 0;
      const isCur = this.deps.currentId && this.deps.currentId() === p.id;

      const th = el('div', { class: 'home-thumb' });
      if (p.thumb) th.style.backgroundImage = `url(${p.thumb})`;
      else th.append(icon('film', 'i'));
      if (dur) th.append(el('span', { class: 'dur', text: fmtTime(dur) }));
      if (isCur) th.append(el('span', { class: 'cur', text: 'ouvert' }));

      const card = el('div', {
        class: 'home-card' + (isCur ? ' on' : ''),
        title: `${p.title}\n${larg}×${haut} · ${cad} i/s\n${nClips} clip(s)`,
        onclick: () => { this.hide(); this.deps.onOpen(p.id); },
        oncontextmenu: (e) => { e.preventDefault(); this.menu(e, p); },
      }, th,
        el('div', { class: 'home-meta' },
          el('div', { class: 'nm', text: p.title || 'Sans titre' }),
          el('div', { class: 'sub', text: `${ago(p.savedAt)} · ${larg || '?'}×${haut || '?'} · ${nClips} clip(s)` })),
        el('button', {
          class: 'home-more', title: 'Options',
          onclick: (e) => { e.stopPropagation(); this.menu(e, p); },
        }, icon('more')));
      g.append(card);
    }
  }

  menu(e, p) {
    import('./timeline.js').then(({ showMenu }) => {
      showMenu(e.clientX, e.clientY, [
        { label: 'Ouvrir', fn: () => { this.hide(); this.deps.onOpen(p.id); } },
        { label: 'Renommer', fn: async () => {
          const n = prompt('Nom du projet', p.title || '');
          if (!n) return;
          const rec = await idbGet(p.id);
          if (!rec) return;
          rec.title = n;
          if (rec.project) rec.project.name = n;
          await idbSave(rec);
          if (this.deps.onRenamed) this.deps.onRenamed(p.id, n);
          this.show(this.forced);
        } },
        { label: 'Dupliquer', fn: async () => {
          const rec = await idbGet(p.id);
          if (!rec) return;
          const copy = { ...rec, id: 'p' + Math.random().toString(36).slice(2, 10), title: (rec.title || 'Projet') + ' (copie)', savedAt: Date.now() };
          if (copy.project) copy.project = JSON.parse(JSON.stringify(copy.project));
          await idbSave(copy);
          toast('Projet duplique', 'ok');
          this.show(this.forced);
        } },
        { sep: true },
        { label: 'Supprimer', fn: async () => {
          if (!confirm(`Supprimer definitivement « ${p.title} » ?\n\nVos fichiers video ne sont pas touches.`)) return;
          await idbDelete(p.id);
          toast('Projet supprime', 'ok');
          this.show(this.forced);
        } },
      ]);
    });
  }
}
