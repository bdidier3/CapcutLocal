'use strict';
/*
 * CutLocal - serveur local (stdlib Node uniquement).
 *
 * Roles :
 *   - servir l'interface (app/)
 *   - servir les fichiers medias du disque avec support des requetes Range
 *     (indispensable pour le seek video et le demuxeur MP4)
 *   - ouvrir les vraies boites de dialogue Windows (import / export)
 *   - recevoir les paquets encodes de l'export et les muxer en MP4 sur disque
 *   - sauvegarder / charger les projets
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Mp4Muxer } = require('./mp4mux');
const dialogs = require('./dialogs');
const vlc = require('./vlc');
const dl = require('./dl');
const proxy = require('./proxy');
const stockage = require('./stockage');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const CACHE_DIR = path.join(ROOT, 'cache');
const PORT = Number(process.env.PORT || 4676);
const TOKEN = process.env.CUTLOCAL_TOKEN || crypto.randomBytes(16).toString('hex');

fs.mkdirSync(PROJECTS_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function mimeFor(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, txt) {
  const body = Buffer.from(String(txt));
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req, limit = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) { reject(new Error('corps trop volumineux')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ------------------------------------------------------------ fichiers static

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.replace(/^\/+/, ''));
  if (rel === '' ) rel = 'index.html';
  const full = path.join(APP_DIR, rel);
  if (!full.startsWith(APP_DIR)) return sendText(res, 403, 'interdit');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'introuvable');
    res.writeHead(200, {
      'Content-Type': mimeFor(full),
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'Last-Modified': st.mtime.toUTCString(),
    });
    fs.createReadStream(full).pipe(res);
  });
}

// ------------------------------------------- media disque avec support Range

function serveMedia(req, res, query) {
  const p = query.get('p');
  if (!p) return sendText(res, 400, 'parametre p manquant');
  let st;
  try { st = fs.statSync(p); } catch (_) { return sendText(res, 404, 'fichier introuvable'); }
  if (!st.isFile()) return sendText(res, 404, 'pas un fichier');

  const type = mimeFor(p);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end = m[2] === '' ? null : parseInt(m[2], 10);
      if (start === null && end !== null) { start = Math.max(0, st.size - end); end = st.size - 1; }
      if (start === null) start = 0;
      if (end === null || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(p, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(p).pipe(res);
}

// ------------------------------------------------------------ sessions export

const REC_MAGIC = 0xc0def00d;
const sessions = new Map();

function exportBegin(cfg) {
  const id = crypto.randomBytes(8).toString('hex');
  const opts = { creation: Date.now() };
  if (cfg.video) {
    opts.video = {
      codec: cfg.video.codec,
      width: cfg.video.width,
      height: cfg.video.height,
      timescale: cfg.video.timescale,
      description: cfg.video.description ? Buffer.from(cfg.video.description, 'base64') : Buffer.alloc(0),
    };
  }
  if (cfg.audio) {
    opts.audio = {
      codec: 'aac',
      sampleRate: cfg.audio.sampleRate,
      channels: cfg.audio.channels,
      timescale: cfg.audio.sampleRate,
      description: cfg.audio.description ? Buffer.from(cfg.audio.description, 'base64') : null,
    };
  }
  const tmp = cfg.path + '.part';
  const mux = new Mp4Muxer(tmp, opts);
  sessions.set(id, { id, mux, tmp, finalPath: cfg.path, leftover: Buffer.alloc(0), samples: 0 });
  return id;
}

function exportAppend(sess, buf) {
  let data = sess.leftover.length ? Buffer.concat([sess.leftover, buf]) : buf;
  let off = 0;
  while (data.length - off >= 16) {
    const magic = data.readUInt32LE(off);
    if (magic !== REC_MAGIC) throw new Error('flux export desynchronise');
    const track = data.readUInt8(off + 4);
    const flags = data.readUInt8(off + 5);
    const duration = data.readUInt32LE(off + 8);
    const len = data.readUInt32LE(off + 12);
    if (data.length - off - 16 < len) break;
    const payload = data.subarray(off + 16, off + 16 + len);
    if (track === 0) sess.mux.addVideo(payload, duration, (flags & 1) !== 0);
    else sess.mux.addAudio(payload, duration);
    sess.samples++;
    off += 16 + len;
  }
  sess.leftover = off < data.length ? Buffer.from(data.subarray(off)) : Buffer.alloc(0);
}

function exportEnd(sess) {
  const r = sess.mux.finalize();
  try {
    if (fs.existsSync(sess.finalPath)) fs.unlinkSync(sess.finalPath);
    fs.renameSync(sess.tmp, sess.finalPath);
  } catch (e) {
    return { bytes: r.bytes, path: sess.tmp, warning: 'renommage impossible: ' + e.message };
  }
  sessions.delete(sess.id);
  return { bytes: r.bytes, path: sess.finalPath, samples: sess.samples };
}

// ------------------------------------------------------------------- routeur

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const q = url.searchParams;

  // Protection basique : seules les requetes locales avec jeton touchent le disque
  const isPrivileged = p.startsWith('/api/') || p === '/media';
  if (isPrivileged && q.get('tk') !== TOKEN) {
    return sendText(res, 403, 'jeton invalide');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    if (p === '/' || p === '/index.html') {
      // injecte le jeton dans la page
      const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8')
        .replace('__TOKEN__', TOKEN);
      const body = Buffer.from(html);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      return res.end(body);
    }

    if (p === '/media') return serveMedia(req, res, q);

    if (p === '/api/ping') {
      return sendJson(res, 200, { ok: true, version: 2, tmp: os.tmpdir(), cacheDir: CACHE_DIR, sep: path.sep });
    }

    // fichiers de rendu intermediaires (inversion, image figee...)
    if (p === '/api/cache' && req.method === 'POST') {
      const name = (q.get('name') || 'cache.bin').replace(/[^\w\-. ]/g, '_');
      return sendJson(res, 200, { path: path.join(CACHE_DIR, name) });
    }
    if (p === '/api/cache/clean' && req.method === 'POST') {
      let n = 0;
      try {
        for (const f of fs.readdirSync(CACHE_DIR)) { fs.unlinkSync(path.join(CACHE_DIR, f)); n++; }
      } catch (_) {}
      return sendJson(res, 200, { removed: n });
    }
    if (p === '/api/cache/write' && req.method === 'POST') {
      const name = (q.get('name') || 'file.bin').replace(/[^\w\-. ]/g, '_');
      const body = await readBody(req, 128 * 1024 * 1024);
      const full = path.join(CACHE_DIR, name);
      fs.writeFileSync(full, body);
      return sendJson(res, 200, { path: full, bytes: body.length });
    }

    if (p === '/api/import' && req.method === 'POST') {
      const files = await dialogs.openFiles(q.get('dir') || '');
      const out = files.map((f) => {
        try {
          const st = fs.statSync(f);
          return { path: f, name: path.basename(f), size: st.size, mtime: st.mtimeMs };
        } catch (_) { return null; }
      }).filter(Boolean);
      return sendJson(res, 200, { files: out });
    }

    // Dossier ou l'on enregistre par defaut (le Bureau, chemin reel meme sous OneDrive)
    // ------------------------------------------------ envoi vers VLC (iPhone)
    if (p === '/api/vlc/probe') {
      return sendJson(res, 200, await vlc.joignable(q.get('url') || ''));
    }

    if (p === '/api/vlc/send' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 64)).toString('utf8') || '{}');
      if (!body.path || !body.url) return sendJson(res, 400, { ok: false, error: 'chemin ou adresse manquant' });
      const r = await vlc.envoyer(body.path, body.url);
      return sendJson(res, r.ok ? 200 : 502, r);
    }

    if (p === '/api/desktop') {
      return sendJson(res, 200, { path: dialogs.desktopDir() });
    }

    if (p === '/api/savedialog' && req.method === 'POST') {
      const target = await dialogs.saveFile(q.get('name') || 'export.mp4', q.get('dir') || '');
      return sendJson(res, 200, { path: target });
    }

    if (p === '/api/folder' && req.method === 'POST') {
      return sendJson(res, 200, { path: await dialogs.pickFolder() });
    }

    if (p === '/api/scan') {
      const dir = q.get('dir');
      let items = [];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && MIME[path.extname(e.name).toLowerCase()])
          .map((e) => {
            const full = path.join(dir, e.name);
            const st = fs.statSync(full);
            return { path: full, name: e.name, size: st.size, mtime: st.mtimeMs };
          });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
      return sendJson(res, 200, { files: items });
    }

    if (p === '/api/stat') {
      try {
        const st = fs.statSync(q.get('p'));
        return sendJson(res, 200, { size: st.size, mtime: st.mtimeMs, exists: true });
      } catch (_) { return sendJson(res, 200, { exists: false }); }
    }

    if (p === '/api/reveal' && req.method === 'POST') {
      dialogs.reveal(q.get('p'));
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/open' && req.method === 'POST') {
      spawn('cmd', ['/c', 'start', '', q.get('p')], { windowsHide: true, detached: true }).unref();
      return sendJson(res, 200, { ok: true });
    }

    // ------- import depuis un lien (delegue a yt-dlp s'il est installe)
    if (p === '/api/dl/probe') {
      const t = await dl.detect(q.get('force') === '1');
      return sendJson(res, 200, {
        available: !!t.available,
        version: t.version || null,
        via: t.available ? [t.cmd, ...(t.args || [])].join(' ') : null,
      });
    }
    // ---------------------------------------- copies d'apercu (proxys)
    // ------------------------------------------------ place occupee / menage
    if (p === '/api/stockage') {
      return sendJson(res, 200, stockage.etat(CACHE_DIR));
    }
    if (p === '/api/stockage/vider' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      const cles = Array.isArray(body.categories) ? body.categories : [];
      const r = stockage.vider(CACHE_DIR, cles);
      return sendJson(res, 200, { ok: true, ...r, apres: stockage.etat(CACHE_DIR) });
    }

    if (p === '/api/pick' && req.method === 'POST') {
      const chemin = await dialogs.pickCookies().catch(() => null);
      return sendJson(res, 200, { path: chemin });
    }

    if (p === '/api/proxy/state') {
      const cle = String(url.searchParams.get('cle') || '');
      if (!/^[0-9a-f]{20}$/.test(cle)) return sendJson(res, 400, { error: 'cle invalide' });
      return sendJson(res, 200, { cle, ...proxy.etat(CACHE_DIR, cle) });
    }
    if (p === '/api/proxy/build' && req.method === 'POST') {
      if (!await dl.hasFfmpeg()) { req.resume(); return sendJson(res, 200, { indisponible: true }); }
      const cle = String(url.searchParams.get('cle') || '');
      const nom = path.basename(String(url.searchParams.get('name') || 'source'));
      if (!/^[0-9a-f]{20}$/.test(cle)) { req.resume(); return sendJson(res, 400, { error: 'cle invalide' }); }
      if (proxy.existe(CACHE_DIR, cle)) { req.resume(); return sendJson(res, 200, { cle, etat: 'pret', pct: 100 }); }
      const dejaLa = proxy.etat(CACHE_DIR, cle);
      if (dejaLa.etat === 'encours') { req.resume(); return sendJson(res, 200, { cle, ...dejaLa }); }

      // Le fichier d'origine n'existe que dans le navigateur : on le recoit en
      // flux vers un fichier temporaire, sans jamais le tenir en memoire — un
      // rush 4K pese couramment 200 Mo.
      try { fs.mkdirSync(proxy.dossier(CACHE_DIR), { recursive: true }); } catch (_) {}
      const tmp = path.join(proxy.dossier(CACHE_DIR), cle + '.src' + path.extname(nom));
      try {
        await new Promise((ok, ko) => {
          const out = fs.createWriteStream(tmp);
          req.pipe(out);
          out.on('finish', ok);
          out.on('error', ko);
          req.on('error', ko);
        });
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        return sendJson(res, 500, { error: 'reception impossible : ' + e.message });
      }
      await proxy.construire(tmp, CACHE_DIR, cle);
      // La source temporaire ne sert plus des que ffmpeg a fini. Sur Windows la
      // suppression echoue tant que le processus garde le fichier ouvert : on
      // reessaie plutot que d'abandonner, sinon un rush de 200 Mo reste sur le
      // disque pour rien.
      let essais = 0;
      const veiller = setInterval(() => {
        if (proxy.etat(CACHE_DIR, cle).etat === 'encours') return;
        try { fs.unlinkSync(tmp); } catch (_) {
          if (++essais < 20 && fs.existsSync(tmp)) return;
        }
        clearInterval(veiller);
      }, 1000);
      return sendJson(res, 200, { cle, ...proxy.etat(CACHE_DIR, cle) });
    }
    if (p === '/api/proxy/file') {
      const cle = String(url.searchParams.get('cle') || '');
      if (!/^[0-9a-f]{20}$/.test(cle)) return sendText(res, 400, 'cle invalide');
      const f = proxy.fichierDe(CACHE_DIR, cle);
      if (!fs.existsSync(f)) return sendText(res, 404, 'apercu introuvable');
      // Une copie qu'on relit ne doit pas etre la premiere effacee quand le
      // cache deborde : on note qu'elle vient de servir.
      stockage.toucher(f);
      return serveMedia(req, res, new URLSearchParams({ p: f }));
    }
    if (p === '/api/proxy/clear' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, supprimes: proxy.vider(CACHE_DIR) });
    }

    if (p === '/api/dl/start' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      try {
        const id = await dl.start(body.url, body.mode === 'audio' ? 'audio' : 'video', CACHE_DIR,
          { compte: !!body.compte, nombre: body.nombre, cookies: body.cookies,
            cookieFichier: body.cookieFichier });
        return sendJson(res, 200, { job: id });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    // dossier des telechargements : le connaitre, l'ouvrir, y faire le menage
    if (p === '/api/dl/folder') {
      let items = [];
      try {
        items = fs.readdirSync(CACHE_DIR)
          .filter((f) => /\.(mp4|mov|mkv|webm|m4a|mp3|wav|jpg|png)$/i.test(f))
          .map((f) => {
            const st = fs.statSync(path.join(CACHE_DIR, f));
            return { name: f, size: st.size, at: st.mtimeMs };
          })
          .sort((a, b) => b.at - a.at);
      } catch (_) {}
      return sendJson(res, 200, { dir: CACHE_DIR, items });
    }

    // vignette d'un fichier telecharge, pour l'apercu de la liste
    if (p === '/api/dl/thumb') {
      const nom = url.searchParams.get('name') || '';
      const cible = path.resolve(CACHE_DIR, nom);
      if (path.basename(nom) !== nom || !cible.startsWith(path.resolve(CACHE_DIR) + path.sep)) {
        return sendJson(res, 400, { error: 'nom invalide' });
      }
      const img = await dl.vignette(cible, CACHE_DIR).catch(() => null);
      if (!img) return sendJson(res, 404, { error: 'pas de vignette' });
      const buf = fs.readFileSync(img);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(buf);
    }

    if (p === '/api/dl/open' && req.method === 'POST') {
      dialogs.openFolder(CACHE_DIR);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/dl/remove' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      const noms = Array.isArray(body.names) ? body.names : [];
      let n = 0;
      for (const nom of noms) {
        // on ne sort JAMAIS du dossier de telechargement
        const cible = path.resolve(CACHE_DIR, path.basename(String(nom)));
        if (path.dirname(cible) !== path.resolve(CACHE_DIR)) continue;
        try { fs.unlinkSync(cible); n++; } catch (_) {}
      }
      return sendJson(res, 200, { ok: true, supprimes: n });
    }

    if (p === '/api/dl/status') {
      const st = dl.status(q.get('job'));
      if (!st) return sendJson(res, 404, { error: 'travail inconnu' });
      return sendJson(res, 200, st);
    }
    if (p === '/api/dl/cancel' && req.method === 'POST') {
      return sendJson(res, 200, { ok: dl.cancel(q.get('job')) });
    }

    // ------- projets
    if (p === '/api/projects') {
      const list = fs.readdirSync(PROJECTS_DIR).filter((f) => f.endsWith('.json')).map((f) => {
        const st = fs.statSync(path.join(PROJECTS_DIR, f));
        return { name: f.replace(/\.json$/, ''), mtime: st.mtimeMs, size: st.size };
      }).sort((a, b) => b.mtime - a.mtime);
      return sendJson(res, 200, { projects: list });
    }

    if (p === '/api/project' && req.method === 'GET') {
      const name = (q.get('name') || '').replace(/[^\w\-. ]/g, '');
      const f = path.join(PROJECTS_DIR, name + '.json');
      if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'projet introuvable' });
      return sendJson(res, 200, JSON.parse(fs.readFileSync(f, 'utf8')));
    }

    if (p === '/api/project' && req.method === 'PUT') {
      const name = (q.get('name') || 'projet').replace(/[^\w\-. ]/g, '') || 'projet';
      const body = await readBody(req, 64 * 1024 * 1024);
      fs.writeFileSync(path.join(PROJECTS_DIR, name + '.json'), body);
      return sendJson(res, 200, { ok: true, name });
    }

    if (p === '/api/project' && req.method === 'DELETE') {
      const name = (q.get('name') || '').replace(/[^\w\-. ]/g, '');
      try { fs.unlinkSync(path.join(PROJECTS_DIR, name + '.json')); } catch (_) {}
      return sendJson(res, 200, { ok: true });
    }

    // ------- export
    if (p === '/api/export/begin' && req.method === 'POST') {
      const cfg = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      if (!cfg.path) return sendJson(res, 400, { error: 'chemin de sortie manquant' });
      try {
        const id = exportBegin(cfg);
        return sendJson(res, 200, { session: id });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    if (p === '/api/export/append' && req.method === 'POST') {
      const sess = sessions.get(q.get('s'));
      if (!sess) return sendJson(res, 404, { error: 'session inconnue' });
      const buf = await readBody(req);
      try {
        exportAppend(sess, buf);
      } catch (e) {
        sess.mux.abort();
        sessions.delete(sess.id);
        return sendJson(res, 500, { error: e.message });
      }
      return sendJson(res, 200, { bytes: sess.mux.bytesWritten, samples: sess.samples });
    }

    if (p === '/api/export/end' && req.method === 'POST') {
      const sess = sessions.get(q.get('s'));
      if (!sess) return sendJson(res, 404, { error: 'session inconnue' });
      try {
        return sendJson(res, 200, exportEnd(sess));
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    if (p === '/api/export/abort' && req.method === 'POST') {
      const sess = sessions.get(q.get('s'));
      if (sess) { sess.mux.abort(); sessions.delete(sess.id); }
      return sendJson(res, 200, { ok: true });
    }

    return serveStatic(req, res, p);
  } catch (e) {
    console.error('[erreur]', e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e && e.message || e) });
    else res.end();
  }
});

server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (_) {} });

// Detection de yt-dlp des le demarrage : elle lance quelques processus, autant
// que ce soit fait avant le premier clic plutot que pendant.
dl.detect().catch(() => {});
// menage des sources temporaires qu'une session precedente aurait laissees
proxy.balayer(CACHE_DIR);
// Le cache ne doit jamais grossir sans fin. On le ramene sous son plafond au
// demarrage, puis toutes les cinq minutes : pendant une longue session, les
// copies fabriquees en cours de route sont ainsi bornees elles aussi.
const bornerCache = () => {
  const r = stockage.borner(CACHE_DIR);
  if (r.nombre) console.log(`  cache : ${r.nombre} fichier(s) ancien(s) efface(s)`);
};
bornerCache();
// unref : ce minuteur ne doit pas empecher le serveur de se fermer.
setInterval(bornerCache, 5 * 60 * 1000).unref();

server.listen(PORT, '127.0.0.1', () => {
  const urlApp = `http://127.0.0.1:${PORT}/?tk=${TOKEN}`;
  console.log('');
  console.log('  \x1b[36m▶ CutLocal\x1b[0m  -  editeur video local');
  console.log('  ' + urlApp);
  console.log('');
  console.log('  Ctrl+C pour arreter.');
  if (!process.env.NO_OPEN) {
    spawn('cmd', ['/c', 'start', '', urlApp.replace(/&/g, '^&')], { windowsHide: true, detached: true }).unref();
  }
});

process.on('SIGINT', () => {
  for (const s of sessions.values()) s.mux.abort();
  process.exit(0);
});
