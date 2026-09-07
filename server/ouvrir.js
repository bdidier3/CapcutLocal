'use strict';
/*
 * Ouvrir un fichier, un dossier ou une adresse avec l'application par defaut.
 *
 * Chaque systeme a sa commande, et aucune n'existe ailleurs : « start » est une
 * commande interne du shell Windows, « open » appartient a macOS, et
 * « xdg-open » vient des specifications freedesktop utilisees par les bureaux
 * Linux. On choisit donc au moment de l'appel plutot que d'en supposer une.
 */

const { spawn } = require('child_process');

/**
 * @param {string} cible  chemin de fichier, de dossier, ou adresse http
 * @returns {boolean} false si le systeme n'est pas reconnu
 */
function ouvrirCible(cible) {
  if (!cible) return false;
  try {
    if (process.platform === 'win32') {
      // « start » n'est pas un programme : il faut passer par le shell. Le
      // premier argument vide est le titre de fenetre, sans quoi une cible
      // entre guillemets serait prise pour un titre et rien ne s'ouvrirait.
      // L'accent circonflexe protege les « & » d'une adresse.
      spawn('cmd', ['/c', 'start', '', String(cible).replace(/&/g, '^&')],
        { windowsHide: true, detached: true }).unref();
      return true;
    }
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    // stdio ignore : sans cela, un bureau bavard remplirait la console de
    // l'application de messages qui ne la concernent pas.
    spawn(cmd, [String(cible)], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (_) {
    return false;   // pas de bureau, session distante... l'appelant s'en remet
  }
}

module.exports = { ouvrirCible };
