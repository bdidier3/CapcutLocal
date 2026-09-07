'use strict';
/*
 * Envoi d'un fichier vers VLC sur iPhone (« Partage via Wi-Fi »).
 *
 * VLC iOS ouvre un petit serveur web sur le telephone et accepte un depot de
 * fichier en multipart. Les versions ne repondent pas toutes sur le meme
 * chemin ni sous le meme nom de champ, alors on essaie les combinaisons
 * connues jusqu'a ce que l'une passe.
 *
 * La cible est volontairement limitee au reseau local : envoyer un fichier
 * ailleurs serait le publier, ce qui n'est jamais ce qu'on veut ici.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHEMINS = ['/upload.json', '/upload', '/requests/upload.json'];
const CHAMPS = ['file', 'files[]', 'files'];

/** N'accepte qu'une adresse du reseau local (ou du telephone en partage). */
function cibleLocale(brut) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(brut) ? brut : 'http://' + brut); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname;
  const prive = /^10\./.test(h)
    || /^192\.168\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /^169\.254\./.test(h)
    || h === 'localhost' || h === '127.0.0.1'
    || /\.local$/i.test(h);
  return prive ? u : null;
}

function poster(cible, champ, nomFichier, octets, timeout) {
  return new Promise((resolve) => {
    const limite = '----CutLocal' + crypto.randomBytes(12).toString('hex');
    const tete = Buffer.from(
      `--${limite}\r\n`
      + `Content-Disposition: form-data; name="${champ}"; filename="${nomFichier}"\r\n`
      + 'Content-Type: video/mp4\r\n\r\n', 'utf8');
    const pied = Buffer.from(`\r\n--${limite}--\r\n`, 'utf8');
    const corps = Buffer.concat([tete, octets, pied]);

    const req = http.request({
      hostname: cible.hostname,
      port: cible.port || 80,
      path: cible.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${limite}`,
        'Content-Length': corps.length,
      },
      timeout,
    }, (res) => {
      let vu = 0;
      res.on('data', (c) => { vu += c.length; });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, code: res.statusCode, vu }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'delai depasse' }); });
    req.on('error', (e) => resolve({ ok: false, err: e.message }));
    req.end(corps);
  });
}

/** VLC repond-il a cette adresse ? */
async function joignable(brut, timeout = 2500) {
  const u = cibleLocale(brut);
  if (!u) return { ok: false, error: 'adresse hors du reseau local' };
  return new Promise((resolve) => {
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: '/', method: 'GET', timeout,
    }, (res) => {
      let txt = '';
      res.on('data', (c) => { if (txt.length < 4000) txt += c.toString('utf8'); });
      res.on('end', () => {
        const vlc = /vlc|upload|wi-?fi/i.test(txt);
        resolve({ ok: true, vlc, code: res.statusCode });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'pas de reponse' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

/** Depose le fichier sur VLC. Renvoie {ok, via} ou {ok:false, error}. */
async function envoyer(fichier, brut, timeout = 600000) {
  const u = cibleLocale(brut);
  if (!u) return { ok: false, error: 'adresse hors du reseau local' };
  let octets;
  try { octets = fs.readFileSync(fichier); } catch (e) { return { ok: false, error: 'fichier illisible : ' + e.message }; }
  const nom = path.basename(fichier);

  // un chemin explicite dans l'adresse est respecte ; sinon on tente les connus
  const chemins = u.pathname && u.pathname !== '/' ? [u.pathname] : CHEMINS;
  const essais = [];
  for (const c of chemins) {
    for (const champ of CHAMPS) {
      const cible = new URL(u.href);
      cible.pathname = c;
      const r = await poster(cible, champ, nom, octets, timeout);
      if (r.ok) return { ok: true, via: `${cible.origin}${c} (champ ${champ})`, taille: octets.length };
      essais.push(`${c}/${champ}: ${r.err || 'HTTP ' + r.code}`);
    }
  }
  return { ok: false, error: essais.slice(0, 4).join(' | ') };
}

module.exports = { envoyer, joignable, cibleLocale };
