'use strict';
/* Boites de dialogue natives Windows via PowerShell (STA). Aucune dependance. */

const { spawn } = require('child_process');

/** Coupe une sortie en lignes, quel que soit le style de fin de ligne. */
const SAUTS_DE_LIGNE = /\r?\n/;
const path = require('path');
const fs = require('fs');

const VIDEO_FILTER = 'Videos|*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.wmv;*.mts;*.m2ts;*.mpg;*.mpeg;*.3gp;*.flv|' +
  'Audio|*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg;*.opus|' +
  'Images|*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif|' +
  'Tous les fichiers|*.*';

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => { out += d.toString('utf8'); });
    ps.stderr.on('data', (d) => { err += d.toString('utf8'); });
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code !== 0 && !out) reject(new Error(err || ('powershell code ' + code)));
      else resolve(out);
    });
  });
}

const PREAMBLE = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
[System.Windows.Forms.Application]::EnableVisualStyles()
`;

async function openFiles(initialDir) {
  const dir = (initialDir || '').replace(/'/g, "''");
  const script = `${PREAMBLE}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Importer des medias'
$d.Multiselect = $true
$d.Filter = '${VIDEO_FILTER}'
${dir ? `if (Test-Path -LiteralPath '${dir}') { $d.InitialDirectory = '${dir}' }` : ''}
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  $d.FileNames | ForEach-Object { [Console]::Out.WriteLine($_) }
}
`;
  const out = await runPowerShell(script);
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** Choix d'un fichier de cookies exporte depuis un navigateur. */
async function pickCookies() {
  // La fenetre doit s'ouvrir DEVANT. Le serveur tourne en arriere-plan : sans
  // proprietaire toujours au premier plan, la boite de dialogue apparait
  // derriere l'application et donne l'impression que le bouton ne fait rien.
  const script = `${PREAMBLE}
$avant = New-Object System.Windows.Forms.Form
$avant.TopMost = $true
$avant.ShowInTaskbar = $false
$avant.Opacity = 0
$avant.Show()
$avant.Activate()
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Choisir le fichier de cookies'
$d.Filter = 'Fichier de cookies|*.txt|Tous les fichiers|*.*'
$d.InitialDirectory = [Environment]::GetFolderPath('UserProfile') + '\Downloads'
if ($d.ShowDialog($avant) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($d.FileName)
}
$avant.Close()
`;
  const out = await runPowerShell(script);
  return out.split(SAUTS_DE_LIGNE).map((x) => x.trim()).filter(Boolean)[0] || null;
}

async function saveFile(defaultName, initialDir) {
  const name = (defaultName || 'export.mp4').replace(/'/g, "''");
  const dir = (initialDir || '').replace(/'/g, "''");
  const script = `${PREAMBLE}
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.Title = 'Exporter la video'
$d.Filter = 'Video MP4|*.mp4|Tous les fichiers|*.*'
$d.FileName = '${name}'
$d.DefaultExt = 'mp4'
$d.AddExtension = $true
$d.OverwritePrompt = $true
${dir
    ? `if (Test-Path -LiteralPath '${dir}') { $d.InitialDirectory = '${dir}' }`
    // par defaut on propose le Bureau (chemin reel, meme s'il est synchronise OneDrive)
    : `$desk = [Environment]::GetFolderPath('Desktop')
if ($desk -and (Test-Path -LiteralPath $desk)) { $d.InitialDirectory = $desk }`}
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($d.FileName)
}
`;
  const out = await runPowerShell(script);
  const line = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return line || null;
}

async function pickFolder() {
  const script = `${PREAMBLE}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choisir un dossier'
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($d.SelectedPath)
}
`;
  const out = await runPowerShell(script);
  const line = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return line || null;
}

/**
 * Chemin reel du Bureau. On passe par les variables d'environnement plutot que
 * par PowerShell : c'est instantane, et l'export ne doit pas attendre.
 */
function desktopDir() {
  const home = process.env.USERPROFILE || require('os').homedir();
  const cands = [
    path.join(home, 'Desktop'),
    path.join(home, 'Bureau'),
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : null,
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Bureau') : null,
  ].filter(Boolean);
  for (const d of cands) { try { if (fs.statSync(d).isDirectory()) return d; } catch (_) {} }
  return home;
}

/** Ouvre un dossier dans l'explorateur. */
/**
 * Ouvre le dossier dans l'Explorateur, et le fait passer devant.
 *
 * Ouvrir ne suffit pas : le serveur tourne en arriere-plan, or Windows n'accorde
 * le premier plan qu'au processus qui a deja le focus. Sans le coup de pouce du
 * script, la fenetre apparait derriere l'application et l'utilisateur ne voit
 * simplement rien se passer.
 */
function auPremierPlan(dir) {
  const script = path.join(__dirname, 'win', 'premier-plan.ps1');
  if (!fs.existsSync(script)) return;
  try {
    spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Dossier', dir],
      // surtout pas detached : sans console, PowerShell rend la main sans avoir
      // execute le script, et la fenetre resterait derriere.
      { windowsHide: true, stdio: 'ignore' }).unref();
  } catch (_) { /* l'essentiel — la fenetre — est deja ouvert */ }
}

function openFolder(dir) {
  spawn('explorer.exe', [dir], { windowsHide: true, detached: true }).unref();
  auPremierPlan(dir);
}

/** Ouvre le dossier d'un fichier avec celui-ci deja selectionne, devant. */
function reveal(target) {
  spawn('explorer.exe', ['/select,', target], { windowsHide: true, detached: true }).unref();
  // /select ouvre le dossier parent : c'est cette fenetre qu'il faut ramener.
  auPremierPlan(path.dirname(target));
}

module.exports = { openFiles, saveFile, pickFolder, pickCookies, reveal, openFolder, desktopDir };
