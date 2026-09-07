// Sources GLSL (WebGL2 / GLSL ES 3.0).
// Les memes shaders servent a l'apercu et a l'export : ce qui est vu est ce qui sort.

export const VS_FULL = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const VS_LAYER = `#version 300 es
in vec2 aPos;                 // quad unite -0.5..0.5
uniform mat3 uM;              // transformation vers l'espace ecran (-1..1)
uniform vec4 uUV;             // u0, vTop, u1, vBottom
out vec2 vUv;
out vec2 vPos;                // position normalisee dans la frame (0..1, y vers le bas)
void main(){
  vec3 p = uM * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  // uM travaille dans un repere pixel Y VERS LE BAS : aPos.y = -0.5 est donc le
  // HAUT du calque, et doit recevoir le haut de la texture (uUV.y).
  vUv = vec2(mix(uUV.x, uUV.z, aPos.x + 0.5), mix(uUV.y, uUV.w, aPos.y + 0.5));
  vPos = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
}`;

// ---------------------------------------------------------------- couche video

export const FS_LAYER = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vPos;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uTexel;          // 1/taille de la texture source
uniform float uOpacity;
uniform vec4 uUVClamp;        // limites de recadrage pour eviter les bavures

// etalonnage
uniform float uExposure, uContrast, uSaturation, uTemp, uTint;
uniform float uHighlights, uShadows, uVignette, uSharpen;

// incrustation couleur
uniform int   uChroma;
uniform vec3  uKey;
uniform float uTol, uSoft, uSpill;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 rgb2ycbcr(vec3 c){
  float y  = dot(c, LUMA);
  return vec3(y, (c.b - y) * 0.565, (c.r - y) * 0.713);
}

void main(){
  vec2 uv = clamp(vUv, uUVClamp.xy, uUVClamp.zw);
  vec4 src = texture(uTex, uv);

  // nettete (unsharp leger)
  if (uSharpen > 0.001){
    vec3 blur = (
      texture(uTex, clamp(uv + vec2(uTexel.x, 0.0), uUVClamp.xy, uUVClamp.zw)).rgb +
      texture(uTex, clamp(uv - vec2(uTexel.x, 0.0), uUVClamp.xy, uUVClamp.zw)).rgb +
      texture(uTex, clamp(uv + vec2(0.0, uTexel.y), uUVClamp.xy, uUVClamp.zw)).rgb +
      texture(uTex, clamp(uv - vec2(0.0, uTexel.y), uUVClamp.xy, uUVClamp.zw)).rgb) * 0.25;
    src.rgb += (src.rgb - blur) * uSharpen * 1.6;
  }

  vec3 c = max(src.rgb, 0.0);
  float a = src.a;

  // exposition
  c *= exp2(uExposure);

  // temperature / teinte
  c.r *= 1.0 + uTemp * 0.35;
  c.b *= 1.0 - uTemp * 0.35;
  c.g *= 1.0 + uTint * 0.25;
  c.r *= 1.0 - uTint * 0.12;
  c.b *= 1.0 - uTint * 0.12;

  // hautes lumieres / ombres
  float l = dot(clamp(c, 0.0, 1.0), LUMA);
  if (abs(uHighlights) > 0.001) c += uHighlights * 0.5 * smoothstep(0.5, 1.0, l) * max(c, 0.02);
  if (abs(uShadows) > 0.001)    c += uShadows    * 0.5 * (1.0 - smoothstep(0.0, 0.55, l)) * (1.0 - c) ;

  // contraste (autour de 0.5, courbe douce)
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;

  // saturation
  float y = dot(max(c, 0.0), LUMA);
  c = mix(vec3(y), c, 1.0 + uSaturation);

  // vignettage
  if (uVignette > 0.001){
    vec2 d = (vPos - 0.5) * vec2(1.0, 1.0);
    float r = length(d) * 1.414;
    c *= 1.0 - uVignette * smoothstep(0.35, 1.05, r);
  }

  // incrustation couleur
  if (uChroma == 1){
    vec3 sy = rgb2ycbcr(src.rgb);
    vec3 ky = rgb2ycbcr(uKey);
    float d = distance(sy.yz, ky.yz);
    float m = smoothstep(uTol, uTol + max(uSoft, 0.001), d);
    a *= m;
    if (uSpill > 0.0){
      float g = dot(normalize(ky.yz + 1e-5), sy.yz);
      c = mix(c, vec3(dot(c, LUMA)), clamp(uSpill * (1.0 - m) * max(g, 0.0), 0.0, 1.0));
    }
  }

  outColor = vec4(clamp(c, 0.0, 1.0), clamp(a, 0.0, 1.0) * uOpacity);
}`;

// -------------------------------------------------------------------- masques

export const FS_MASK = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform vec2  uSize;      // taille de la cible en pixels
uniform int   uShape;     // 0 rect, 1 ellipse, 2 lineaire, 3 miroir, 4 polygone
uniform vec2  uCenter;    // 0..1 (fraction de la frame)
uniform vec2  uHalf;      // demi-taille, en fraction de la LARGEUR de la frame
uniform float uRot;       // radians
uniform float uFeather;   // fraction de la largeur
uniform float uRound;     // fraction de la largeur (coins arrondis)
uniform int   uInvert;
uniform int   uPtCount;
uniform vec2  uPts[32];   // polygone, coordonnees 0..1 de la frame

float sdRoundBox(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float sdPolygon(vec2 p, int n){
  float d = 1e9;
  float s = 1.0;
  for (int i = 0; i < 32; i++){
    if (i >= n) break;
    int j = (i == 0) ? n - 1 : i - 1;
    vec2 a = uPts[i], b = uPts[j];
    vec2 e = b - a;
    vec2 w = p - a;
    float t = clamp(dot(w, e) / max(dot(e, e), 1e-9), 0.0, 1.0);
    d = min(d, length(w - e * t));
    // test d'inclusion par nombre de croisements
    bvec3 cond = bvec3(p.y >= a.y, p.y < b.y, e.x * w.y > e.y * w.x);
    if (all(cond) || all(not(cond))) s = -s;
  }
  return s * d;
}

void main(){
  // espace pixel de la frame, y vers le bas
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  float W = uSize.x;
  vec2 ctr = uCenter * uSize;
  vec2 hf = max(uHalf * W, vec2(0.5));
  float feather = max(uFeather * W, 0.75);

  float c = cos(-uRot), s = sin(-uRot);
  vec2 q = px - ctr;
  q = vec2(q.x * c - q.y * s, q.x * s + q.y * c);

  float d;
  if (uShape == 0){
    d = sdRoundBox(q, hf, min(uRound * W, min(hf.x, hf.y)));
  } else if (uShape == 1){
    vec2 k = q / hf;
    d = (length(k) - 1.0) * min(hf.x, hf.y);
  } else if (uShape == 2){
    d = q.y;                                  // demi-plan
  } else if (uShape == 3){
    d = abs(q.y) - hf.y;                      // bande (miroir)
  } else {
    vec2 pn = px / uSize;                     // polygone en coordonnees normalisees
    d = sdPolygon(pn, uPtCount) * uSize.x;
  }

  float a = smoothstep(feather * 0.5, -feather * 0.5, d);
  if (uInvert == 1) a = 1.0 - a;
  outColor = vec4(a, a, a, a);
}`;

// ------------------------------------------------------------- flou separable

export const FS_DOWN = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexel;   // texel de la SOURCE
void main(){
  vec2 o = uTexel * 0.5;
  outColor = 0.25 * (
    texture(uTex, vUv + vec2( o.x,  o.y)) +
    texture(uTex, vUv + vec2(-o.x,  o.y)) +
    texture(uTex, vUv + vec2( o.x, -o.y)) +
    texture(uTex, vUv + vec2(-o.x, -o.y)));
}`;

export const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uStep;      // direction * texel
uniform float uSigma;
uniform int uR;
void main(){
  vec4 acc = texture(uTex, vUv);
  float wsum = 1.0;
  float inv = -0.5 / max(uSigma * uSigma, 1e-4);
  for (int i = 1; i <= 32; i++){
    if (i > uR) break;
    float w = exp(float(i * i) * inv);
    vec2 o = uStep * float(i);
    acc += w * (texture(uTex, vUv + o) + texture(uTex, vUv - o));
    wsum += 2.0 * w;
  }
  outColor = acc / wsum;
}`;

// ------------------------------------------------------------------- fusion

export const FS_MERGE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBase;
uniform sampler2D uEffect;
uniform sampler2D uMask;
uniform int   uMode;      // 0 flou, 1 mosaique, 2 noir, 3 garder interieur, 4 masquer interieur
uniform vec2  uCells;     // taille de cellule pour la mosaique (en uv)
void main(){
  vec4 base = texture(uBase, vUv);
  float m = texture(uMask, vUv).r;
  if (uMode == 0){
    outColor = mix(base, texture(uEffect, vUv), m);
  } else if (uMode == 1){
    vec2 q = (floor(vUv / uCells) + 0.5) * uCells;
    outColor = mix(base, texture(uBase, q), m);
  } else if (uMode == 2){
    outColor = vec4(base.rgb * (1.0 - m), base.a);
  } else if (uMode == 3){
    outColor = vec4(base.rgb, base.a * m);
  } else {
    outColor = vec4(base.rgb, base.a * (1.0 - m));
  }
}`;

// ------------------------------------------------------------------- rendu final

export const FS_PRESENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec3 uBg;
void main(){
  vec4 c = texture(uTex, vUv);
  outColor = vec4(mix(uBg, c.rgb, c.a), 1.0);
}`;

// blit simple (composition d'une couche isolee vers l'accumulateur)
export const FS_BLIT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uAlpha;
void main(){
  vec4 c = texture(uTex, vUv);
  outColor = vec4(c.rgb, c.a * uAlpha);
}`;
