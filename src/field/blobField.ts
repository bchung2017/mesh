import type { Tone } from '../types';
import { COMMUNITIES } from '../data/communities';
import { TONES } from './palette';
import { bakeTexture } from './texture';

interface Dent { angle: number; depth: number; dvel: number; target: number; slow: number; }
interface Reach { angle: number; amt: number; target: number; }

interface FieldBlob {
  id: string;
  name: string;
  involvement: number;
  tone: Tone;
  parse: string;
  r: number;
  x: number; y: number;
  vx: number; vy: number;
  px: number; py: number;
  phase: number;
  dents: Record<string, Dent>;
  reach: Record<string, Reach>;
  wobA: number; wobV: number; wobAng: number;
  tex: WebGLTexture | HTMLCanvasElement;
}

/** The field's view of a community — only what the renderer needs. */
const communities = COMMUNITIES.map((c) => ({
  id: c.id, name: c.name, involvement: c.involvement, tone: c.tone, parse: c.parse,
}));

/**
 * Boot the WebGL (with 2D fallback) soft-body blob field on the given canvas.
 * Each blob is a community, sized by involvement; drag them around, and a clean
 * tap dispatches a `blobclick` CustomEvent on the canvas.
 */
export function initField(canvas: HTMLCanvasElement): void {
  let W: number, H: number, DPR: number;

  const TONE = TONES;

  const blobs: FieldBlob[] = [];
  const R_MIN = 26, R_MAX = 78;

  const SQUISH_K      = 0.13;
  const SQUISH_DAMP   = 0.93;
  const DENT_PER_OVLP = 1.05;
  const DENT_MOMENTUM = 6.0;
  const DENT_MAX_FRAC = 0.55;
  const LOBE_WIDTH    = 0.95;

  const SECTORS = 48, RINGS = 6;   // GPU renders this for free

  function radiusFor(inv: number): number {
    const maxInv = Math.max(...communities.map((c) => c.involvement));
    return R_MIN + (R_MAX - R_MIN) * Math.sqrt(inv / maxInv);
  }

  // ---------------- WebGL setup ----------------
  // probe GL support on a throwaway canvas first: a failed webgl request can leave the
  // real canvas in a state where getContext('2d') returns null (the setTransform crash)
  const glSupported = (() => {
    try {
      const p = document.createElement('canvas');
      return !!(p.getContext('webgl') || p.getContext('experimental-webgl'));
    } catch (e) { return false; }
  })();
  const gl: WebGLRenderingContext | null = glSupported
    ? ((canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false })
       || canvas.getContext('experimental-webgl', { alpha: true, antialias: true, premultipliedAlpha: false })) as WebGLRenderingContext | null)
    : null;
  const c2d: CanvasRenderingContext2D | null = gl ? null : canvas.getContext('2d');

  const VERT = `
    attribute vec2 aPos;
    attribute vec2 aUV;
    uniform vec2 uRes;
    varying vec2 vUV;
    void main(){
      vec2 clip = (aPos / uRes) * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      vUV = aUV;
    }`;
  const FRAG = `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uTex;
    uniform float uUseTex;
    uniform vec4 uColor;
    uniform float uBright;
    void main(){
      vec4 t = texture2D(uTex, vUV);
      vec4 texc = vec4(min(t.rgb + vec3(uBright), 1.0), t.a);
      gl_FragColor = mix(uColor, texc, uUseTex);
    }`;

  function makeProgram(g: WebGLRenderingContext): WebGLProgram {
    function sh(type: number, src: string): WebGLShader {
      const h = g.createShader(type)!;
      g.shaderSource(h, src); g.compileShader(h);
      return h;
    }
    const p = g.createProgram()!;
    g.attachShader(p, sh(g.VERTEX_SHADER, VERT));
    g.attachShader(p, sh(g.FRAGMENT_SHADER, FRAG));
    g.linkProgram(p);
    return p;
  }

  let prog: WebGLProgram;
  const loc: Record<string, any> = {};
  let idxBuf: WebGLBuffer, posBuf: WebGLBuffer, uvBuf: WebGLBuffer, idxCount: number;
  const VCOUNT = 1 + RINGS * (SECTORS + 1);
  const positions = new Float32Array(VCOUNT * 2);
  const uvs = new Float32Array(VCOUNT * 2);

  function initGL(g: WebGLRenderingContext): void {
    prog = makeProgram(g);
    g.useProgram(prog);
    loc.aPos = g.getAttribLocation(prog, 'aPos');
    loc.aUV = g.getAttribLocation(prog, 'aUV');
    loc.uRes = g.getUniformLocation(prog, 'uRes');
    loc.uTex = g.getUniformLocation(prog, 'uTex');
    loc.uUseTex = g.getUniformLocation(prog, 'uUseTex');
    loc.uColor = g.getUniformLocation(prog, 'uColor');
    loc.uBright = g.getUniformLocation(prog, 'uBright');

    // static UVs: polar grid over unit disk
    let vi = 0;
    uvs[vi++] = 0.5; uvs[vi++] = 0.5;
    for (let ri = 1; ri <= RINGS; ri++) {
      const rho = ri / RINGS;
      for (let si = 0; si <= SECTORS; si++) {
        const th = (si / SECTORS) * Math.PI * 2;
        uvs[vi++] = 0.5 + 0.5 * rho * Math.cos(th);
        uvs[vi++] = 0.5 + 0.5 * rho * Math.sin(th);
      }
    }

    // static index topology
    const idx: number[] = [];
    const ring0 = 1;
    for (let si = 0; si < SECTORS; si++) {        // center fan
      idx.push(0, ring0 + si, ring0 + si + 1);
    }
    for (let ri = 0; ri < RINGS - 1; ri++) {      // quads between rings
      const a = 1 + ri * (SECTORS + 1), b = 1 + (ri + 1) * (SECTORS + 1);
      for (let si = 0; si < SECTORS; si++) {
        idx.push(a + si, b + si, a + si + 1, a + si + 1, b + si, b + si + 1);
      }
    }
    idxCount = idx.length;

    posBuf = g.createBuffer()!;
    g.bindBuffer(g.ARRAY_BUFFER, posBuf);
    g.bufferData(g.ARRAY_BUFFER, positions.byteLength, g.DYNAMIC_DRAW);

    uvBuf = g.createBuffer()!;
    g.bindBuffer(g.ARRAY_BUFFER, uvBuf);
    g.bufferData(g.ARRAY_BUFFER, uvs, g.STATIC_DRAW);

    idxBuf = g.createBuffer()!;
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, idxBuf);
    g.bufferData(g.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), g.STATIC_DRAW);

    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);
    g.clearColor(0, 0, 0, 0);
  }

  function makeGLTexture(g: WebGLRenderingContext, srcCanvas: HTMLCanvasElement): WebGLTexture {
    const t = g.createTexture()!;
    g.bindTexture(g.TEXTURE_2D, t);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, srcCanvas);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    return t;
  }

  let grace = 0;   // frames of gentled physics after the field becomes visible again
  function resize(): void {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;      // hidden tab: keep last real dimensions, freeze world
    DPR = window.devicePixelRatio || 1;
    if (w !== W || h !== H) grace = 45;  // dimensions actually changed: settle gently
    W = w; H = h;
    canvas.width = W * DPR; canvas.height = H * DPR;
    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function init(): void {
    resize();
    blobs.length = 0;
    communities.forEach((c, i) => {
      const r = radiusFor(c.involvement);
      const b: FieldBlob = {
        ...c, r,
        x: (W / (communities.length + 1)) * (i + 1),
        y: H / 2 + (i % 2 ? -30 : 30),
        vx: (Math.random() - .5) * 0.04, vy: (Math.random() - .5) * 0.04,
        px: 0, py: 0,
        phase: Math.random() * Math.PI * 2,
        dents: {},
        reach: {},          // proximity lobes: surface leans toward near neighbors pre-contact
        wobA: 0, wobV: 0, wobAng: 0,
        tex: null as any,
      };
      const baked = bakeTexture(b);
      b.tex = gl ? makeGLTexture(gl, baked) : baked;   // GL texture or the raw canvas, per renderer
      blobs.push(b);
    });
  }

  // ---------------- input ----------------
  const ptr = { x: -1e4, y: -1e4, vx: 0, vy: 0, down: false, drag: null as FieldBlob | null, ox: 0, oy: 0, downX: 0, downY: 0, moved: 0 };
  const tooltip = document.createElement('div');
  tooltip.style.cssText = 'position:absolute;pointer-events:none;display:none;background:rgba(27,42,74,0.92);color:#fff;font:600 12px "Helvetica Neue",Helvetica,Arial,sans-serif;padding:5px 10px;border-radius:8px;white-space:nowrap;z-index:5';
  canvas.parentElement!.style.position = 'relative';
  canvas.parentElement!.appendChild(tooltip);

  function toLocal(e: MouseEvent | TouchEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const t = (e as TouchEvent).touches ? (e as TouchEvent).touches[0] : (e as MouseEvent);
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }
  function pick(x: number, y: number): FieldBlob | null {
    for (let i = blobs.length - 1; i >= 0; i--) {
      const b = blobs[i];
      if (Math.hypot(x - b.x, y - b.y) <= b.r) return b;
    }
    return null;
  }
  function onDown(e: MouseEvent | TouchEvent): void {
    const p = toLocal(e);
    ptr.down = true; ptr.x = p.x; ptr.y = p.y;
    ptr.downX = p.x; ptr.downY = p.y; ptr.moved = 0;
    const b = pick(p.x, p.y);
    if (b) { ptr.drag = b; ptr.ox = p.x - b.x; ptr.oy = p.y - b.y; canvas.classList.add('grabbing'); e.preventDefault(); }
  }
  function onMove(e: MouseEvent | TouchEvent): void {
    const p = toLocal(e);
    ptr.vx = ptr.vx * 0.6 + (p.x - ptr.x) * 0.4;
    ptr.vy = ptr.vy * 0.6 + (p.y - ptr.y) * 0.4;
    if (ptr.down) { ptr.moved += Math.hypot(p.x - ptr.x, p.y - ptr.y); }
    ptr.x = p.x; ptr.y = p.y;
    if (ptr.drag) {
      ptr.drag.x = p.x - ptr.ox; ptr.drag.y = p.y - ptr.oy;
      ptr.drag.vx = 0; ptr.drag.vy = 0;
      e.preventDefault();
    }
  }
  function onUp(): void {
    if (ptr.drag) {
      const b = ptr.drag;
      // clean tap (< 6px total travel) = open the blob, not a throw
      if (ptr.moved < 6) {
        canvas.dispatchEvent(new CustomEvent('blobclick', { detail: { id: b.id }, bubbles: true }));
      } else {
        b.vx = Math.max(-3, Math.min(3, ptr.vx * 0.3));
        b.vy = Math.max(-3, Math.min(3, ptr.vy * 0.3));
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > 0.3) { exciteWobble(b, Math.min(8, sp * 1.6), Math.atan2(b.vy, b.vx)); }
      }
    }
    ptr.down = false; ptr.drag = null; canvas.classList.remove('grabbing');
  }

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);
  canvas.addEventListener('mouseleave', () => { ptr.x = -1e4; ptr.y = -1e4; });

  // ---------------- soft-body state ----------------
  function exciteWobble(b: FieldBlob, amp: number, angle: number): void {
    b.wobA += amp; b.wobAng = angle;
    b.wobA = Math.min(b.wobA, b.r * 0.22);
  }
  function setReach(b: FieldBlob, key: string, angle: number, target: number): void {
    let r = b.reach[key];
    if (!r) { r = b.reach[key] = { angle, amt: 0, target: 0 }; }
    r.angle = angle;
    r.target = Math.max(r.target, target);
  }

  function pressDent(b: FieldBlob, key: string, angle: number, target: number): void {
    let d = b.dents[key];
    if (!d) { d = b.dents[key] = { angle, depth: 0, dvel: 0, target: 0, slow: 0 }; }
    d.angle = angle;
    d.target = Math.max(d.target, target);
  }
  function clampDent(b: FieldBlob, v: number): number { return Math.min(v, b.r * DENT_MAX_FRAC); }

  function radiusAt(b: FieldBlob, theta: number, base: number): number {
    let r = base, total = 0;
    if (Math.abs(b.wobA) > 0.05) {
      r += b.wobA * Math.cos(2 * (theta - b.wobAng));
    }
    for (const k in b.reach) {
      const rc = b.reach[k];
      if (rc.amt <= 0.05) continue;
      let da = theta - rc.angle;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const RW = 0.68;   // narrower than dent lobes: a reach, not a swell
      r += rc.amt * Math.exp(-(da * da) / (RW * RW));
    }
    for (const k in b.dents) {
      const d = b.dents[k];
      const eff = d.depth + d.slow * 0.6;
      if (eff === 0) continue;
      let da = theta - d.angle;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      r -= eff * Math.exp(-(da * da) / (LOBE_WIDTH * LOBE_WIDTH));
      const wa = da - Math.PI / 2, wb = da + Math.PI / 2, FW = LOBE_WIDTH * 1.3;
      r += eff * 1.0 * (Math.exp(-(wa * wa) / (FW * FW)) + Math.exp(-(wb * wb) / (FW * FW)));
      total += Math.max(0, eff);
    }
    return r + total * 0.30;
  }

  function squashTotal(b: FieldBlob): number {
    let t = 0; for (const k in b.dents) t += Math.max(0, b.dents[k].depth); return t;
  }

  function step(): void {
    if (canvas.clientWidth === 0) { requestAnimationFrame(step); return; }  // field tab hidden: world sleeps
    const ease = grace > 0 ? (grace--, 1 - grace / 45) : 1;
    const hover = ptr.drag || pick(ptr.x, ptr.y);

    for (const b of blobs) {
      b.px = b.x; b.py = b.y;
      for (const k in b.dents) b.dents[k].target = 0;
      for (const k in b.reach) b.reach[k].target = 0;
    }

    for (const b of blobs) {
      if (b === ptr.drag) continue;
      b.phase += 0.002;
      b.x += b.vx; b.y += b.vy;
      b.vx *= 0.995; b.vy *= 0.995;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 2.6) { b.vx *= 2.6 / sp; b.vy *= 2.6 / sp; }
      b.vx += Math.cos(b.phase) * 0.0008;
      b.vy += Math.sin(b.phase * 0.8) * 0.0008;
      const dx = b.x - ptr.x, dy = b.y - ptr.y, d = Math.hypot(dx, dy);
      if (d < b.r + 60 && d > 0 && !ptr.down) {
        const f = (b.r + 60 - d) * 0.00004;
        b.vx += (dx / d) * f; b.vy += (dy / d) * f;
      }
      if (grace > 0) {
        // settling: ease anything stranded out of bounds back in, no impacts
        b.x = Math.max(b.r, Math.min(W - b.r, b.x + (Math.max(b.r, Math.min(W - b.r, b.x)) - b.x) * 0.2));
        b.y = Math.max(0, Math.min(H, b.y + (Math.max(b.r, Math.min(H - b.r, b.y)) - b.y) * 0.2));
      }
      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * 0.78; pressDent(b, 'wL', Math.PI, clampDent(b, (b.r - b.x + 1) * 0.5)); }
      if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx) * 0.78; pressDent(b, 'wR', 0, clampDent(b, (b.x - (W - b.r) + 1) * 0.5)); }
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * 0.78; pressDent(b, 'wT', -Math.PI / 2, clampDent(b, (b.r - b.y + 1) * 0.5)); }
      if (b.y > H - b.r) { b.y = H - b.r; b.vy = -Math.abs(b.vy) * 0.78; pressDent(b, 'wB', Math.PI / 2, clampDent(b, (b.y - (H - b.r) + 1) * 0.5)); }
    }

    for (let i = 0; i < blobs.length; i++) for (let j = i + 1; j < blobs.length; j++) {
      const a = blobs[i], b = blobs[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01, min = a.r + b.r + 4;
      const NEAR = 48;
      if (d >= min && d < min + NEAR) {
        // proximity band: soft mutual attraction (symmetric, mass-weighted) + surface reach
        const gap = d - min, nx = dx / d, ny = dy / d;
        const closeness = 1 - gap / NEAR;
        const ma = a.r * a.r, mb = b.r * b.r;
        const Fa = closeness * 3.0;              // weak pull; contact spring dominates on touch
        if (a !== ptr.drag) { a.vx += nx * Fa / ma; a.vy += ny * Fa / ma; }
        if (b !== ptr.drag) { b.vx -= nx * Fa / mb; b.vy -= ny * Fa / mb; }
        // reach: each surface leans toward the neighbor, small blob reaches more
        const rAmt = closeness * closeness * 5;  // quadratic: only blooms when genuinely close
        setReach(a, 'b' + b.id, Math.atan2(dy, dx), rAmt * (b.r / (a.r + b.r)) * 2);
        setReach(b, 'b' + a.id, Math.atan2(-dy, -dx), rAmt * (a.r / (a.r + b.r)) * 2);
      }
      if (d < min) {
        const overlap = min - d, nx = dx / d, ny = dy / d;
        const avx = a === ptr.drag ? a.x - a.px : a.vx, avy = a === ptr.drag ? a.y - a.py : a.vy;
        const bvx = b === ptr.drag ? b.x - b.px : b.vx, bvy = b === ptr.drag ? b.y - b.py : b.vy;
        const approach = Math.max(0, (avx - bvx) * nx + (avy - bvy) * ny);

        const ma = a.r * a.r, mb = b.r * b.r, msum = ma + mb;
        const F = (overlap * 30 + approach * 40) * ease;
        const ja = F / ma, jb = F / mb;
        if (a !== ptr.drag) { a.vx -= nx * ja; a.vy -= ny * ja; }
        if (b !== ptr.drag) { b.vx += nx * jb; b.vy += ny * jb; }
        const corr = overlap * 0.02;
        if (a !== ptr.drag) { a.x -= nx * corr * (mb / msum); a.y -= ny * corr * (mb / msum); }
        if (b !== ptr.drag) { b.x += nx * corr * (ma / msum); b.y += ny * corr * (ma / msum); }

        const total = (overlap * DENT_PER_OVLP + approach * DENT_MOMENTUM) * ease;
        const aShare = total * (b.r / (a.r + b.r));
        const bShare = total * (a.r / (a.r + b.r));
        pressDent(a, 'b' + b.id, Math.atan2(dy, dx), clampDent(a, aShare));
        pressDent(b, 'b' + a.id, Math.atan2(-dy, -dx), clampDent(b, bShare));
        if (approach > 0.8) {
          exciteWobble(a, approach * 1.2 * (b.r / (a.r + b.r)), Math.atan2(dy, dx));
          exciteWobble(b, approach * 1.2 * (a.r / (a.r + b.r)), Math.atan2(-dy, -dx));
        }
      }
    }

    for (const b of blobs) {
      for (const k in b.dents) {
        const d = b.dents[k];
        if (d.target > d.depth) {
          const prev = d.depth;
          const want = (d.target - d.depth) * 0.45;
          const maxStep = b.r * 0.055;
          d.depth += Math.min(want, maxStep);
          d.dvel = d.depth - prev;
        } else {
          d.dvel += (d.target - d.depth) * SQUISH_K;
          d.dvel *= SQUISH_DAMP;
          d.depth += d.dvel;
        }
        if (d.dvel < 0 && b !== ptr.drag && k[0] === 'w') {
          b.vx -= Math.cos(d.angle) * (-d.dvel) * 0.04;
          b.vy -= Math.sin(d.angle) * (-d.dvel) * 0.04;
        }
        if (d.depth < -b.r * 0.14) d.depth = -b.r * 0.14;
        d.slow = d.slow * 0.988 + Math.max(0, d.depth) * 0.004;
        if (Math.abs(d.depth) < 0.02 && d.slow < 0.05 && d.target === 0) { delete b.dents[k]; }
      }
      b.wobV += -b.wobA * 0.018;
      b.wobV *= 0.962;
      b.wobA += b.wobV;
      for (const k in b.reach) {
        const r = b.reach[k];
        r.amt += (r.target - r.amt) * 0.12;
        if (r.amt < 0.05 && r.target === 0) { delete b.reach[k]; }
      }
    }

    draw(hover);
    requestAnimationFrame(step);
  }

  // ---------------- GL draw ----------------
  function fillMesh(b: FieldBlob, base: number, offset: number): void {
    let vi = 0;
    positions[vi++] = b.x; positions[vi++] = b.y;
    for (let ri = 1; ri <= RINGS; ri++) {
      const rho = ri / RINGS;
      for (let si = 0; si <= SECTORS; si++) {
        const th = (si / SECTORS) * Math.PI * 2;
        const r = rho * (radiusAt(b, th, base) + offset);
        positions[vi++] = b.x + Math.cos(th) * r;
        positions[vi++] = b.y + Math.sin(th) * r;
      }
    }
  }

  function drawMesh(g: WebGLRenderingContext): void {
    g.bindBuffer(g.ARRAY_BUFFER, posBuf);
    g.bufferSubData(g.ARRAY_BUFFER, 0, positions);
    g.vertexAttribPointer(loc.aPos, 2, g.FLOAT, false, 0, 0);
    g.enableVertexAttribArray(loc.aPos);
    g.bindBuffer(g.ARRAY_BUFFER, uvBuf);
    g.vertexAttribPointer(loc.aUV, 2, g.FLOAT, false, 0, 0);
    g.enableVertexAttribArray(loc.aUV);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, idxBuf);
    g.drawElements(g.TRIANGLES, idxCount, g.UNSIGNED_SHORT, 0);
  }

  function draw(hover: FieldBlob | null): void {
    if (!gl) { draw2D(hover); return; }
    const g = gl;
    g.clear(g.COLOR_BUFFER_BIT);
    g.useProgram(prog);
    g.uniform2f(loc.uRes, W, H);
    g.uniform1i(loc.uTex, 0);
    g.activeTexture(g.TEXTURE0);

    for (const b of blobs) {
      const breathe = 1 + Math.sin(b.phase * 1.2) * 0.015;
      const base = b.r * breathe;
      const tone = TONE[b.tone];

      // halo: same mesh, +10px, flat color
      g.bindTexture(g.TEXTURE_2D, b.tex as WebGLTexture);
      fillMesh(b, base, 10);
      g.uniform1f(loc.uUseTex, 0.0);
      g.uniform4fv(loc.uColor, tone.halo);
      drawMesh(g);

      // body: textured, stress-brightened
      fillMesh(b, base, 0);
      g.uniform1f(loc.uUseTex, 1.0);
      const stress = Math.min(0.20, (squashTotal(b) / base) * 0.40);
      g.uniform1f(loc.uBright, stress);
      drawMesh(g);
      g.uniform1f(loc.uBright, 0.0);

      // hover ring: thin flat-color shell
      if (hover === b) {
        fillMesh(b, base, 5);
        g.uniform1f(loc.uUseTex, 0.0);
        g.uniform4fv(loc.uColor, [tone.halo[0], tone.halo[1], tone.halo[2], 0.85]);
        drawMesh(g);
        fillMesh(b, base, 3);
        g.uniform4fv(loc.uColor, [1, 1, 1, 0.0]);
        // (inner cut skipped — ring reads fine as shell over halo)
        g.uniform1f(loc.uUseTex, 1.0);
        g.uniform1f(loc.uBright, 0.0);
        g.bindTexture(g.TEXTURE_2D, b.tex as WebGLTexture);
        fillMesh(b, base, 0);
        drawMesh(g);
      }
    }

    updateTooltip(hover);
  }

  function updateTooltip(hover: FieldBlob | null): void {
    if (hover && hover.r <= 44) {
      tooltip.textContent = hover.name + ' · ' + hover.parse;
      tooltip.style.display = 'block';
      tooltip.style.left = (canvas.offsetLeft + hover.x) + 'px';
      tooltip.style.top = (canvas.offsetTop + hover.y - hover.r - 34) + 'px';
      tooltip.style.transform = 'translateX(-50%)';
    } else {
      tooltip.style.display = 'none';
    }
  }

  // 2D fallback: full physics, deformed silhouette, texture clipped to the membrane.
  // Print doesn't crowd per-glyph here (uniform fill inside the deformed clip) — the
  // no-GL tier trades that fidelity for a single clip per bubble instead of 640.
  function draw2D(hover: FieldBlob | null): void {
    if (!c2d) return;   // renderer unavailable: skip the frame rather than throw
    c2d.setTransform(DPR, 0, 0, DPR, 0, 0);
    c2d.clearRect(0, 0, W, H);
    for (const b of blobs) {
      const breathe = 1 + Math.sin(b.phase * 1.2) * 0.015;
      const base = b.r * breathe;
      const tone = TONE[b.tone];
      const N = 64;
      let maxR = 0;
      const pts: [number, number][] = [];
      for (let i = 0; i <= N; i++) {
        const th = (i / N) * Math.PI * 2;
        const r = radiusAt(b, th, base);
        if (r > maxR) maxR = r;
        pts.push([b.x + Math.cos(th) * r, b.y + Math.sin(th) * r]);
      }
      // halo
      c2d.beginPath();
      pts.forEach((p, i) => i === 0 ? c2d.moveTo(p[0], p[1]) : c2d.lineTo(p[0], p[1]));
      c2d.closePath();
      c2d.save();
      c2d.lineWidth = 20;
      const h = tone.halo;
      c2d.strokeStyle = 'rgba(' + Math.round(h[0] * 255) + ',' + Math.round(h[1] * 255) + ',' + Math.round(h[2] * 255) + ',' + h[3] + ')';
      c2d.stroke();
      c2d.restore();
      // body: clip to membrane, draw texture scaled to the deformed extent
      c2d.save();
      c2d.clip();
      c2d.drawImage(b.tex as HTMLCanvasElement, b.x - maxR, b.y - maxR, maxR * 2, maxR * 2);
      const stress = Math.min(0.20, (squashTotal(b) / base) * 0.40);
      if (stress > 0.01) {
        c2d.fillStyle = 'rgba(255,255,255,' + stress + ')';
        c2d.fillRect(b.x - maxR, b.y - maxR, maxR * 2, maxR * 2);
      }
      c2d.restore();
      if (hover === b) {
        c2d.beginPath();
        pts.forEach((p, i) => i === 0 ? c2d.moveTo(p[0], p[1]) : c2d.lineTo(p[0], p[1]));
        c2d.closePath();
        c2d.strokeStyle = tone.fill; c2d.lineWidth = 2; c2d.stroke();
      }
    }
    updateTooltip(hover);
  }

  window.addEventListener('resize', resize);
  if (gl) initGL(gl);
  init();
  requestAnimationFrame(step);
}
