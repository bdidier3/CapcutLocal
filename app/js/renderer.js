// Compositeur WebGL2. Utilise pour l'apercu ET pour l'export : rendu identique.
import * as S from './shaders.js';

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    console.error(log, src);
    throw new Error('shader: ' + log);
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

class Fbo {
  constructor(gl, w, h) {
    this.gl = gl; this.w = w; this.h = h;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  dispose() { this.gl.deleteTexture(this.tex); this.gl.deleteFramebuffer(this.fb); }
}

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: !!opts.preserve,
      powerPreference: 'high-performance', desynchronized: false,
    });
    if (!gl) throw new Error('WebGL2 indisponible : mettez a jour votre navigateur ou vos pilotes.');
    this.gl = gl;

    this.progLayer = program(gl, S.VS_LAYER, S.FS_LAYER);
    this.progMask = program(gl, S.VS_FULL, S.FS_MASK);
    this.progDown = program(gl, S.VS_FULL, S.FS_DOWN);
    this.progBlur = program(gl, S.VS_FULL, S.FS_BLUR);
    this.progMerge = program(gl, S.VS_FULL, S.FS_MERGE);
    this.progPresent = program(gl, S.VS_FULL, S.FS_PRESENT);
    this.progBlit = program(gl, S.VS_FULL, S.FS_BLIT);

    // quad plein ecran (-1..1) et quad unite (-0.5..0.5) : meme buffer, echelle differente
    this.vaoFull = this._quad(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.vaoUnit = this._quad(new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]));

    this.pool = new Map();      // "wxh" -> Fbo[]
    this.texCache = new Map();  // id -> {tex, w, h}
    this.w = 0; this.h = 0;
    this.stats = { layers: 0, blurPasses: 0, ms: 0 };
  }

  _quad(data) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  setSize(w, h) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    // les FBO du pool ne sont plus a la bonne taille : on repart de zero
    for (const list of this.pool.values()) for (const f of list) f.dispose();
    this.pool.clear();
  }

  // ---------------------------------------------------------------- pool FBO
  _acquire(w, h) {
    const key = w + 'x' + h;
    let list = this.pool.get(key);
    if (!list) this.pool.set(key, (list = []));
    for (const f of list) if (!f.busy) { f.busy = true; return f; }
    const f = new Fbo(this.gl, w, h);
    f.busy = true;
    list.push(f);
    if (list.length > 6) console.warn('beaucoup de FBO ' + key);
    return f;
  }
  _releaseAll() { for (const list of this.pool.values()) for (const f of list) f.busy = false; }

  _bind(fbo) {
    const gl = this.gl;
    if (fbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb); gl.viewport(0, 0, fbo.w, fbo.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.w, this.h); }
  }

  _drawFull() {
    const gl = this.gl;
    gl.bindVertexArray(this.vaoFull);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // -------------------------------------------------------------- textures
  /** Envoie une source (video, VideoFrame, bitmap, canvas) dans une texture. */
  upload(id, src, w, h) {
    const gl = this.gl;
    let e = this.texCache.get(id);
    if (!e) {
      e = { tex: gl.createTexture(), w: 0, h: 0 };
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.texCache.set(id, e);
    }
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch (err) {
      // source pas encore prete : on garde la texture precedente si elle existe
      return e.w ? e : null;
    }
    e.w = w; e.h = h;
    return e;
  }

  /** Texture deja en cache pour cet identifiant (sans rien televerser). */
  cached(id) {
    const e = this.texCache.get(id);
    return e && e.w ? e : null;
  }

  dropTexture(id) {
    const e = this.texCache.get(id);
    if (e) { this.gl.deleteTexture(e.tex); this.texCache.delete(id); }
  }

  // ------------------------------------------------------------------ rendu

  /**
   * @param {object} frame  { bg:[r,g,b], layers:[...] } - voir compose.js
   * @param {boolean} toCanvas  true = presente sur le canvas
   * @returns {Fbo} l'accumulateur (si toCanvas=false)
   */
  render(frame, toCanvas = true) {
    const gl = this.gl;
    const t0 = performance.now();
    this._releaseAll();
    this.stats.layers = frame.layers.length;
    this.stats.blurPasses = 0;

    const acc = this._acquire(this.w, this.h);
    this._bind(acc);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (const layer of frame.layers) {
      if (!layer.tex) continue;
      const hasMasks = layer.maskGroups && layer.maskGroups.length > 0;
      if (!hasMasks) {
        this._bind(acc);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        this._drawLayer(layer);
        continue;
      }
      // couche isolee -> application des masques -> composition
      let iso = this._acquire(this.w, this.h);
      this._bind(iso);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this._drawLayer(layer);

      for (const grp of layer.maskGroups) iso = this._applyMaskGroup(iso, grp);

      this._bind(acc);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.progBlit.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, iso.tex);
      gl.uniform1i(this.progBlit.u.uTex, 0);
      gl.uniform1f(this.progBlit.u.uAlpha, 1);
      this._drawFull();
    }

    if (toCanvas) {
      this._bind(null);
      gl.disable(gl.BLEND);
      gl.useProgram(this.progPresent.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, acc.tex);
      gl.uniform1i(this.progPresent.u.uTex, 0);
      const bg = frame.bg || [0, 0, 0];
      gl.uniform3f(this.progPresent.u.uBg, bg[0], bg[1], bg[2]);
      this._drawFull();
    }
    this.stats.ms = performance.now() - t0;
    return acc;
  }

  _drawLayer(layer) {
    const gl = this.gl;
    const P = this.progLayer;
    gl.useProgram(P.p);
    gl.bindVertexArray(this.vaoUnit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, layer.tex);
    gl.uniform1i(P.u.uTex, 0);
    gl.uniformMatrix3fv(P.u.uM, false, layer.m);
    gl.uniform4fv(P.u.uUV, layer.uv);
    gl.uniform4fv(P.u.uUVClamp, layer.uvClamp);
    gl.uniform2f(P.u.uTexel, 1 / Math.max(1, layer.srcW), 1 / Math.max(1, layer.srcH));
    gl.uniform1f(P.u.uOpacity, layer.opacity);
    const c = layer.color;
    gl.uniform1f(P.u.uExposure, c.exposure || 0);
    gl.uniform1f(P.u.uContrast, c.contrast || 0);
    gl.uniform1f(P.u.uSaturation, c.saturation || 0);
    gl.uniform1f(P.u.uTemp, c.temperature || 0);
    gl.uniform1f(P.u.uTint, c.tint || 0);
    gl.uniform1f(P.u.uHighlights, c.highlights || 0);
    gl.uniform1f(P.u.uShadows, c.shadows || 0);
    gl.uniform1f(P.u.uVignette, c.vignette || 0);
    gl.uniform1f(P.u.uSharpen, c.sharpen || 0);
    const k = layer.chroma;
    gl.uniform1i(P.u.uChroma, k && k.on ? 1 : 0);
    if (k && k.on) {
      gl.uniform3f(P.u.uKey, k.r, k.g, k.b);
      gl.uniform1f(P.u.uTol, k.tol);
      gl.uniform1f(P.u.uSoft, k.soft);
      gl.uniform1f(P.u.uSpill, k.spill);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Rend le masque du groupe puis applique l'effet. Renvoie le nouveau FBO. */
  _applyMaskGroup(src, grp) {
    const gl = this.gl;
    const mw = Math.max(64, Math.round(this.w / 2));
    const mh = Math.max(64, Math.round(this.h / 2));
    const maskFbo = this._acquire(mw, mh);

    this._bind(maskFbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    const M = this.progMask;
    gl.useProgram(M.p);
    for (const m of grp.masks) {
      gl.uniform2f(M.u.uSize, mw, mh);
      gl.uniform1i(M.u.uShape, m.shapeId);
      gl.uniform2f(M.u.uCenter, m.cx, m.cy);
      gl.uniform2f(M.u.uHalf, m.w / 2, m.h / 2);
      gl.uniform1f(M.u.uRot, m.rot * Math.PI / 180);
      gl.uniform1f(M.u.uFeather, m.feather);
      gl.uniform1f(M.u.uRound, m.round || 0);
      gl.uniform1i(M.u.uInvert, m.invert ? 1 : 0);
      gl.uniform1i(M.u.uPtCount, m.ptCount || 0);
      if (m.ptCount) gl.uniform2fv(M.u.uPts, m.pts);
      this._drawFull();
    }
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);

    // --- effet
    let effectTex = null;
    if (grp.effect === 'blur') {
      effectTex = this._blur(src, grp.sigmaPx).tex;
    }

    const dst = this._acquire(this.w, this.h);
    this._bind(dst);
    gl.disable(gl.BLEND);
    const G = this.progMerge;
    gl.useProgram(G.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(G.u.uBase, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, effectTex || src.tex); gl.uniform1i(G.u.uEffect, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskFbo.tex); gl.uniform1i(G.u.uMask, 2);
    const mode = { blur: 0, mosaic: 1, black: 2, reveal: 3, hide: 4 }[grp.effect] ?? 0;
    gl.uniform1i(G.u.uMode, mode);
    const cell = grp.cellPx / Math.max(1, this.w);
    gl.uniform2f(G.u.uCells, cell, cell * this.w / this.h);
    this._drawFull();
    gl.activeTexture(gl.TEXTURE0);

    src.busy = false; // recyclable
    return dst;
  }

  /** Flou gaussien avec sous-echantillonnage progressif. */
  _blur(src, sigmaPx) {
    const gl = this.gl;
    if (sigmaPx < 0.4) return src;

    // reduction par 2 jusqu'a ce que sigma tienne dans ~8 taps
    let cur = src;
    let scale = 1;
    let sigma = sigmaPx;
    let guard = 0;
    while (sigma > 6 && scale < 16 && guard++ < 5) {
      const nw = Math.max(8, Math.round(this.w / (scale * 2)));
      const nh = Math.max(8, Math.round(this.h / (scale * 2)));
      const dst = this._acquire(nw, nh);
      this._bind(dst);
      gl.disable(gl.BLEND);
      gl.useProgram(this.progDown.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cur.tex);
      gl.uniform1i(this.progDown.u.uTex, 0);
      gl.uniform2f(this.progDown.u.uTexel, 1 / cur.w, 1 / cur.h);
      this._drawFull();
      if (cur !== src) cur.busy = false;
      cur = dst;
      scale *= 2;
      sigma /= 2;
      this.stats.blurPasses++;
    }

    const R = Math.min(32, Math.max(1, Math.ceil(sigma * 2.5)));
    const B = this.progBlur;
    for (const dir of [[1, 0], [0, 1]]) {
      const dst = this._acquire(cur.w, cur.h);
      this._bind(dst);
      gl.disable(gl.BLEND);
      gl.useProgram(B.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cur.tex);
      gl.uniform1i(B.u.uTex, 0);
      gl.uniform2f(B.u.uStep, dir[0] / cur.w, dir[1] / cur.h);
      gl.uniform1f(B.u.uSigma, sigma);
      gl.uniform1i(B.u.uR, R);
      this._drawFull();
      if (cur !== src) cur.busy = false;
      cur = dst;
      this.stats.blurPasses++;
    }
    return cur;
  }

  /** Lit le contenu du canvas dans un ImageBitmap (pour les vignettes). */
  snapshot() { return this.canvas; }
}
