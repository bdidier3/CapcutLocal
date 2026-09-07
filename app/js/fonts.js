// Polices et styles de texte dans l'esprit TikTok.
// Les polices de TikTok sont propriétaires : on utilise les familles Windows qui
// donnent le meme rendu visuel, avec des replis pour rester lisible partout.

export const FONTS = [
  { id: 'classic', label: 'Classique', css: '"Segoe UI Semibold","Segoe UI",Inter,Arial,sans-serif' },
  { id: 'bold', label: 'Gras', css: '"Arial Black","Segoe UI Black",Arial,sans-serif' },
  { id: 'impact', label: 'Titre', css: 'Impact,Haettenschweiler,"Arial Narrow Bold",sans-serif' },
  { id: 'narrow', label: 'Condense', css: '"Arial Narrow","Franklin Gothic Medium",sans-serif' },
  { id: 'round', label: 'Arrondi', css: 'Verdana,Tahoma,Geneva,sans-serif' },
  { id: 'clean', label: 'Net', css: '"Trebuchet MS","Segoe UI",Tahoma,sans-serif' },
  { id: 'serif', label: 'Serif', css: 'Georgia,"Times New Roman",serif' },
  { id: 'elegant', label: 'Elegant', css: '"Gill Sans MT",Candara,Corbel,Optima,sans-serif' },
  { id: 'slab', label: 'Massif', css: 'Rockwell,"Bookman Old Style",Georgia,serif' },
  { id: 'typewriter', label: 'Machine', css: '"Courier New",Consolas,monospace' },
  { id: 'hand', label: 'Manuscrit', css: '"Ink Free","Segoe Script","Comic Sans MS",cursive' },
  { id: 'comic', label: 'BD', css: '"Comic Sans MS","Segoe Print",cursive' },
  { id: 'mono', label: 'Technique', css: 'Consolas,"Cascadia Mono","Lucida Console",monospace' },
  { id: 'wide', label: 'Large', css: '"Franklin Gothic Medium","Century Gothic",Tahoma,sans-serif' },
];

export function fontCss(id) {
  const f = FONTS.find((x) => x.id === id);
  return f ? f.css : FONTS[0].css;
}

/** Styles prets a l'emploi, comme les presets de texte de TikTok. */
export const TEXT_STYLES = [
  {
    id: 'classic', label: 'Classique', prev: 'Aa',
    css: { color: '#ffffff', bg: 'none', stroke: 0, shadow: 0.45, glow: 0, weight: 700, font: 'classic' },
  },
  {
    id: 'outline', label: 'Contour', prev: 'Aa',
    css: { color: '#ffffff', strokeColor: '#000000', stroke: 0.55, shadow: 0.2, glow: 0, weight: 800, font: 'bold' },
  },
  {
    id: 'boxdark', label: 'Fond noir', prev: 'Aa',
    css: { color: '#ffffff', bg: '#000000', bgPad: 0.016, stroke: 0, shadow: 0, glow: 0, weight: 700, font: 'classic' },
  },
  {
    id: 'boxlight', label: 'Fond blanc', prev: 'Aa',
    css: { color: '#111111', bg: '#ffffff', bgPad: 0.016, stroke: 0, shadow: 0, glow: 0, weight: 700, font: 'classic' },
  },
  {
    id: 'yellow', label: 'Jaune', prev: 'Aa',
    css: { color: '#ffe14d', strokeColor: '#1a1200', stroke: 0.5, shadow: 0.3, glow: 0, weight: 800, font: 'bold' },
  },
  {
    id: 'neon', label: 'Neon', prev: 'Aa',
    css: { color: '#ffffff', glow: 0.9, glowColor: '#38e1ff', stroke: 0, shadow: 0, weight: 700, font: 'clean' },
  },
  {
    id: 'pink', label: 'Rose', prev: 'Aa',
    css: { color: '#ffffff', glow: 0.85, glowColor: '#ff3d8b', stroke: 0.2, strokeColor: '#3a0018', weight: 800, font: 'round' },
  },
  {
    id: 'title', label: 'Gros titre', prev: 'Aa',
    css: { color: '#ffffff', strokeColor: '#000000', stroke: 0.4, shadow: 0.35, glow: 0, weight: 900, font: 'impact', size: 0.12 },
  },
  {
    id: 'sub', label: 'Sous-titre', prev: 'Aa',
    css: { color: '#ffffff', bg: '#000000', bgPad: 0.01, stroke: 0, shadow: 0, glow: 0, weight: 600, font: 'classic', size: 0.042 },
  },
  {
    id: 'typewriter', label: 'Machine', prev: 'Aa',
    css: { color: '#e9fff0', bg: '#0b1a10', bgPad: 0.014, stroke: 0, shadow: 0, glow: 0, weight: 500, font: 'typewriter' },
  },
  {
    id: 'green', label: 'Vert vif', prev: 'Aa',
    css: { color: '#7bff6b', strokeColor: '#062b04', stroke: 0.45, shadow: 0.25, glow: 0, weight: 800, font: 'bold' },
  },
  {
    id: 'soft', label: 'Doux', prev: 'Aa',
    css: { color: '#ffffff', bg: 'none', stroke: 0, shadow: 0.75, glow: 0.3, glowColor: '#000000', weight: 500, font: 'elegant' },
  },
];

/** Applique un style a un objet texte de clip. */
export function applyStyle(text, style) {
  const c = style.css;
  Object.assign(text, {
    color: c.color ?? text.color,
    bg: c.bg ?? 'none',
    bgPad: c.bgPad ?? 0.016,
    stroke: c.stroke ?? 0,
    strokeColor: c.strokeColor ?? '#000000',
    shadow: c.shadow ?? 0,
    glow: c.glow ?? 0,
    glowColor: c.glowColor ?? '#38e1ff',
    weight: c.weight ?? 700,
    font: c.font ?? text.font ?? 'classic',
  });
  if (c.size) text.size = c.size;
  text.style = style.id;
  return text;
}

/** 9 emplacements rapides : [x, y] en fraction de la frame. */
export const ANCHORS = [
  { id: 'tl', label: '↖', x: -0.32, y: -0.36 },
  { id: 'tc', label: '↑', x: 0, y: -0.36 },
  { id: 'tr', label: '↗', x: 0.32, y: -0.36 },
  { id: 'ml', label: '←', x: -0.32, y: 0 },
  { id: 'mc', label: '●', x: 0, y: 0 },
  { id: 'mr', label: '→', x: 0.32, y: 0 },
  { id: 'bl', label: '↙', x: -0.32, y: 0.36 },
  { id: 'bc', label: '↓', x: 0, y: 0.36 },
  { id: 'br', label: '↘', x: 0.32, y: 0.36 },
];
