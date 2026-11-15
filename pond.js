/*
 * ASCII Koi: a koi pond drawn in character cells.
 *
 * Each koi is a chain of spine nodes that trails its head, plus a travelling
 * body wave. Every character cell is sampled against the nearest point on the
 * spine (with sub-samples for soft edges), classified as body, fin, eye or
 * barbel, coloured by the fish's markings, and shaded by a light from the
 * upper left: light skin gets sparse glyphs, shadowed skin dense ones. Koi cast
 * a shadow on the pond floor and leave a short wake.
 *
 * Left click: a black cat paw reaches in from the nearer edge, dips, hooks the
 * water back in two tugs and flicks out with a spray of drops. The koi scatter;
 * a moment later the curious ones swim back to look.
 * Right click (or a long press): a handful of fish food. The pellets land with
 * small rings and float; the hungry koi rise and race over to eat them.
 *
 * The simulation only moves forward in fixed steps from time, so the same
 * events give the same pond. A page runs it live (start); a film seeks it to
 * any time (seek) and gets the same frame every time.
 *
 * Technique informed by stackedlol/ascii-sharks (MIT) and daoho.dev; the code
 * is written for this project. MIT licence.
 */
(function (global) {
  "use strict";

  /* ── small maths ── */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const sstep = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
  const lerp = (a, b, e) => a + (b - a) * e;
  const h2 = (a, b) => { let x = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1); x = Math.imul(x ^ (x >>> 15), 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
  const noise = (x, y, seed) => {
    const xi = Math.floor(x), yi = Math.floor(y), u = sstep(0, 1, x - xi), v = sstep(0, 1, y - yi);
    const a = h2(xi + seed * 131, yi), b = h2(xi + 1 + seed * 131, yi), c = h2(xi + seed * 131, yi + 1), d = h2(xi + 1 + seed * 131, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
  const rgb = hex => { const m = String(hex).trim().match(/^#?([0-9a-f]{6})$/i); const n = m ? parseInt(m[1], 16) : 0; return [n >> 16, (n >> 8) & 255, n & 255]; };
  const mixC = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const pack = c => (clamp(c[0] | 0, 0, 255) << 16) | (clamp(c[1] | 0, 0, 255) << 8) | clamp(c[2] | 0, 0, 255);
  const css = n => `rgb(${n >> 16},${(n >> 8) & 255},${n & 255})`;
  const MONO = `"Geist Mono", ui-monospace, Menlo, monospace`;

  /*
   * Drawing on the GPU. The pond and the title only ever draw rectangles and single characters, so this
   * stands in for those few canvas calls (fillRect, fillText, clearRect, globalAlpha, fillStyle, font,
   * setTransform): every call becomes one quad in a list, and flush() draws the whole list, in order, in
   * one go. The characters come from an atlas drawn with the real font at the same sub-pixel offset
   * fillText would use, so the picture is the same at a fraction of the cost.
   * Without WebGL 2, or with ?gl=0, the page draws with the plain 2D canvas as before.
   */
  const GL_OK = typeof location === "undefined" || !/[?&]gl=0\b/.test(location.search);
  function glCells(canvas) {
    if (!GL_OK || typeof document === "undefined") return null;
    let gl = null;
    try { gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: "high-performance" }); } catch (e) { gl = null; }
    if (!gl) return null;
    const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, `#version 300 es
layout(location = 0) in vec4 aRect;
layout(location = 1) in vec4 aUV;
layout(location = 2) in vec4 aCol;
uniform vec2 uView;
out vec2 vUV;
out vec4 vCol;
void main() {
  vec2 k = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 p = (aRect.xy + aRect.zw * k) / uView * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  vUV = mix(aUV.xy, aUV.zw, k);
  vCol = aCol;
}`));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vCol;
uniform sampler2D uTex;
out vec4 o;
void main() { float a = texture(uTex, vUV).a * vCol.a; o = vec4(vCol.rgb * a, a); }`));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const uView = gl.getUniformLocation(prog, "uView");
    gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
    const vao = gl.createVertexArray(), buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (let j = 0; j < 3; j++) { gl.enableVertexAttribArray(j); gl.vertexAttribPointer(j, 4, gl.FLOAT, false, 48, j * 16); gl.vertexAttribDivisor(j, 1); }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    /* the atlas: a white corner for the rectangles, then each character as it is first needed */
    const A = (global.devicePixelRatio || 1) > 1.5 ? 2048 : 1024, W = 1.5 / A;
    const atlas = document.createElement("canvas");
    atlas.width = atlas.height = A;
    const actx = atlas.getContext("2d");
    let shelfX, shelfY, shelfH, dirty, fonts;
    const wipe = () => { actx.clearRect(0, 0, A, A); actx.globalAlpha = 1; actx.fillStyle = "#fff"; actx.fillRect(0, 0, 4, 4); shelfX = 4; shelfY = 0; shelfH = 4; dirty = true; fonts = new Map(); };
    wipe();
    const st = { sx: 1, sy: 1, tx: 0, ty: 0, alpha: 1, fill: "#000", col: [0, 0, 0, 1], font: "10px sans-serif", clear: false };
    function place(str, q) {
      const size = parseFloat((/(\d+(?:\.\d+)?)px/.exec(st.font) || [0, 10])[1]) * st.sy;
      const font = st.font.replace(/(\d+(?:\.\d+)?)px/, size + "px");
      actx.font = font;
      const w = 2 * Math.ceil((actx.measureText(str).width + size * 0.6 + 4) / 2), h = 2 * Math.ceil((size * 1.7 + 4) / 2);
      if (shelfX + w > A) { shelfX = 0; shelfY += shelfH; shelfH = 0; }
      if (shelfY + h > A) { wipe(); return null; }
      const x = shelfX, y = shelfY;
      shelfX += w; shelfH = Math.max(shelfH, h);
      actx.font = font; actx.textAlign = "center"; actx.textBaseline = "middle"; actx.fillStyle = "#fff";
      actx.fillText(str, x + w / 2 + (q & 3) / 4, y + h / 2 + (q >> 2) / 4);
      dirty = true;
      return { u0: x / A, v0: y / A, u1: (x + w) / A, v1: (y + h) / A, w, h };
    }
    function glyph(str, q) {
      let byStr = fonts.get(st.font);
      if (!byStr) { byStr = new Map(); fonts.set(st.font, byStr); }
      let slots = byStr.get(str);
      if (!slots) { slots = new Array(16); byStr.set(str, slots); }
      return slots[q] || (slots[q] = place(str, q));
    }
    const colours = new Map();
    function parse(s) {
      let c = colours.get(s);
      if (c) return c;
      if (colours.size > 4096) colours.clear();
      let m, v = [0, 0, 0, 1];
      if ((m = /^#([\da-f])([\da-f])([\da-f])$/i.exec(s))) v = [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16), 1];
      else if ((m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(s))) v = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 1];
      else if ((m = /^rgba?\(([^)]*)\)$/i.exec(s))) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); v = [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
      c = [v[0] / 255, v[1] / 255, v[2] / 255, v[3]];
      colours.set(s, c);
      return c;
    }
    let data = new Float32Array(12 * 8192), n = 0;
    function push(x, y, w, h, u0, v0, u1, v1, a) {
      if ((n + 1) * 12 > data.length) { const d = new Float32Array(data.length * 2); d.set(data); data = d; }
      const o = n++ * 12, c = st.col;
      data[o] = x; data[o + 1] = y; data[o + 2] = w; data[o + 3] = h;
      data[o + 4] = u0; data[o + 5] = v0; data[o + 6] = u1; data[o + 7] = v1;
      data[o + 8] = c[0]; data[o + 9] = c[1]; data[o + 10] = c[2]; data[o + 11] = a;
    }
    return {
      textAlign: "center", textBaseline: "middle", lineCap: "butt", lineWidth: 1, strokeStyle: "#000",
      get globalAlpha() { return st.alpha; },
      /* as on a canvas, a value outside 0 to 1 is ignored */
      set globalAlpha(v) { if (v >= 0 && v <= 1) st.alpha = v; },
      get fillStyle() { return st.fill; },
      set fillStyle(v) { if (v !== st.fill) { st.fill = v; st.col = parse(String(v)); } },
      get font() { return st.font; },
      set font(v) { st.font = v; },
      setTransform(a, b, c, d, e, f) { st.sx = a; st.sy = d; st.tx = e; st.ty = f; },
      clearRect() { n = 0; st.clear = true; },
      fillRect(x, y, w, h) {
        const a = st.alpha * st.col[3];
        if (a > 0) push(x * st.sx + st.tx, y * st.sy + st.ty, w * st.sx, h * st.sy, W, W, W, W, a);
      },
      fillText(str, x, y) {
        const a = st.alpha * st.col[3];
        if (!(a > 0)) return;
        const X = x * st.sx + st.tx, Y = y * st.sy + st.ty;
        let ix = Math.floor(X), iy = Math.floor(Y), qx = Math.round((X - ix) * 4), qy = Math.round((Y - iy) * 4);
        if (qx === 4) { ix++; qx = 0; }
        if (qy === 4) { iy++; qy = 0; }
        const e = glyph(String(str), qx + qy * 4);
        if (e) push(ix - e.w / 2, iy - e.h / 2, e.w, e.h, e.u0, e.v0, e.u1, e.v1, a);
      },
      beginPath() {}, rect() {}, fill() {}, arc() {}, stroke() {}, moveTo() {}, lineTo() {},
      flush() {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (dirty) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas); dirty = false; }
        if (st.clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); st.clear = false; }
        gl.uniform2f(uView, canvas.width, canvas.height);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * 12), gl.STREAM_DRAW);
        if (n) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
        n = 0;
      }
    };
  }

  /* Deterministic randomness, so the pond looks the same on every load. */
  function seeded(str) {
    let h = 2166136261;
    for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
  }

  /* ── koi body, as fractions of length: s runs from snout (0) to tail tip (1) ── */
  const BODY_END = 0.76;
  const halfW = s => s < 0.1 ? 0.118 * Math.pow(Math.sin(s / 0.1 * Math.PI / 2), 0.6)
    : s < 0.3 ? 0.118 + 0.02 * sstep(0.1, 0.3, s)
    : 0.03 + 0.108 * (1 - sstep(0.3, BODY_END, s));
  const tailW = s => 0.028 + 0.165 * Math.pow(sstep(0.72, 1, s), 0.85);
  const hit = { kind: 0, across: 0, rs: 1, ra: 0 };
  /* fin: an ellipse leaning back from a root on the body's edge */
  /* the fin's root width and the cosine and sine of its angle come worked out from classify */
  function fin(s, a, rootS, ra, ca, sa, reach, width) {
    const ds = s - rootS, da = a - ra;
    const along = ds * ca + da * sa - reach, perp = -ds * sa + da * ca;
    if ((along / reach) ** 2 + (perp / width) ** 2 > 1) return false;
    hit.kind = 2; hit.rs = ds; hit.ra = da;
    return true;
  }
  /* 1 body, 2 fin, 3 eye, 4 ridge, 5 barbel */
  function classify(s, a, past, flare, ahead, lateral) {
    hit.kind = 0; hit.across = 1; hit.rs = 1; hit.ra = 0;
    if (ahead > 0) {
      if (ahead < 0.05 && Math.abs(lateral - (0.042 + ahead * 0.75)) < 0.015) { hit.kind = 5; return true; }
      return false;
    }
    const w = halfW(s);
    if (s <= BODY_END && a <= w) {
      hit.across = a / w;
      hit.kind = s > 0.056 && s < 0.084 && hit.across > 0.5 && hit.across < 0.78 ? 3 : s > 0.3 && s < 0.6 && hit.across < 0.13 ? 4 : 1;
      return true;
    }
    if (s > 0.7 && past <= 0) {
      const tw = tailW(s) * flare;
      if (a <= tw && s <= 0.88 + 0.12 * (a / tw)) { hit.kind = 2; hit.rs = 1; hit.ra = (a / tw) * 0.8; return true; }
    }
    /*
     * The fins only reach a short way along the body (pectorals from s 0.17 to 0.40 at the widest flare,
     * the dorsal from 0.46 to 0.54), so elsewhere they are not tested at all. The pectoral fins swing with
     * the flare: their angle's cosine and sine are kept for the last two flares (one a side).
     */
    if (s > 0.16 && s < 0.41) {
      let ca, sa;
      if (flare === finF0) { ca = finC0; sa = finS0; }
      else if (flare === finF1) { ca = finC1; sa = finS1; }
      else {
        const ang = 0.9 + 0.45 * (flare - 1);
        ca = Math.cos(ang); sa = Math.sin(ang);
        if (finTurn) { finF1 = flare; finC1 = ca; finS1 = sa; } else { finF0 = flare; finC0 = ca; finS0 = sa; }
        finTurn = !finTurn;
      }
      if (fin(s, a, 0.2, FIN_RA1, ca, sa, 0.07 * flare, 0.038)) return true;
    }
    return s > 0.45 && s < 0.545 && fin(s, a, 0.47, FIN_RA2, FIN_C2, FIN_S2, 0.038, 0.019);
  }
  const FIN_RA1 = halfW(0.2) * 0.85, FIN_RA2 = halfW(0.47) * 0.85, FIN_C2 = Math.cos(0.75), FIN_S2 = Math.sin(0.75);
  let finF0 = NaN, finC0 = 0, finS0 = 0, finF1 = NaN, finC1 = 0, finS1 = 0, finTurn = false;

  /*
   * Where a koi's shape can be, as maps over (s along the body, a out from the spine), one for each tenth of
   * flare from 0.5 to 1.5 (each also holding its two neighbours, so any flare between is inside): found once
   * by testing the shape itself, grown by a few steps to be safe, with running sums so any box of a map can
   * be checked at once. A cell whose finer samples cannot land anywhere on the map cannot be part of the
   * koi, so they are skipped. The picture is unchanged; the work is not.
   */
  const HS = 100, HA = 115, HSTEP = 0.003, HW = HA + 2, HF = 11;
  const HSUMS = (() => {
    const cells = (HS + 1) * (HA + 1), raw = [];
    for (let k = 0; k < HF; k++) {
      const h = new Uint8Array(cells), fl = 0.5 + 0.1 * k;
      for (let b = 0; b <= HS; b++) for (let j = 0; j <= HA; j++) if (classify(b / HS, j * HSTEP, 0, fl, 0, 0)) h[b * (HA + 1) + j] = 1;
      raw.push(h);
    }
    return raw.map((_, k) => {
      const grown = new Uint8Array(cells), sum = new Int32Array((HS + 2) * HW);
      for (let kk = Math.max(0, k - 1); kk <= Math.min(HF - 1, k + 1); kk++) {
        const h = raw[kk];
        for (let b = 0; b <= HS; b++) for (let j = 0; j <= HA; j++) {
          if (!h[b * (HA + 1) + j]) continue;
          for (let bb = Math.max(0, b - 2); bb <= Math.min(HS, b + 2); bb++) for (let jj = Math.max(0, j - 3); jj <= Math.min(HA, j + 3); jj++) grown[bb * (HA + 1) + jj] = 1;
        }
      }
      for (let b = 0; b <= HS; b++) for (let j = 0; j <= HA; j++)
        sum[(b + 1) * HW + j + 1] = grown[b * (HA + 1) + j] + sum[b * HW + j + 1] + sum[(b + 1) * HW + j] - sum[b * HW + j];
      return sum;
    });
  })();
  const shapeMap = flare => HSUMS[clamp(Math.round((flare - 0.5) * 10), 0, HF - 1)];
  /* can the shape on this map lie between s0 and s1 along the body and a0 to a1 out from the spine? */
  function canHit(sum, s0, s1, a0, a1) {
    if (a0 > HA * HSTEP) return false;
    const b0 = Math.max(0, Math.floor(s0 * HS)), b1 = Math.min(HS, Math.ceil(s1 * HS));
    const j0 = Math.max(0, Math.floor(a0 / HSTEP)), j1 = Math.min(HA, Math.ceil(a1 / HSTEP));
    if (b0 > b1 || j0 > j1) return false;
    return sum[(b1 + 1) * HW + j1 + 1] - sum[b0 * HW + j1 + 1] - sum[(b1 + 1) * HW + j0] + sum[b0 * HW + j0] > 0;
  }

  /* ── markings: kohaku (red saddles), sanke (plus black spots), tancho (red crown) ── */
  function markings(variety, seed) {
    const r = j => h2(seed, j);
    if (variety === "tancho") return { red: [{ s: 0.1, v: 0, rs: 0.052, rv: 0.06 }], black: [] };
    const red = [];
    if (r(1) < 0.85) red.push({ s: 0.09, v: (r(2) - 0.5) * 0.03, rs: 0.05 + r(3) * 0.03, rv: 0.1 });
    /* Saddles of uneven length step from side to side, with white between them and on the flanks, so no koi reads as one solid colour or as stripes. */
    const n = r(4) < 0.25 ? 3 : 2, GAP = 0.05, w = [];
    for (let j = 0; j < n; j++) w.push(0.5 + r(30 + j));
    const unit = (0.45 - GAP * (n - 1)) / w.reduce((a, b) => a + b);
    let at = 0.23;
    for (let j = 0; j < n; j++) {
      const rs = unit * w[j] / 2;
      red.push({ s: at + rs, v: (j % 2 ? 1 : -1) * (0.022 + r(20 + j) * 0.018), rs: rs * 0.95, rv: 0.065 + rs * 0.3 + r(40 + j) * 0.02 });
      at += rs * 2 + GAP;
    }
    const black = [];
    if (variety === "sanke") for (let j = 0; j < 4 + Math.floor(r(50) * 3); j++) black.push({ s: 0.25 + r(60 + j) * 0.42, v: (r(70 + j) - 0.5) * 0.15, rs: 0.021, rv: 0.025 });
    return { red, black };
  }
  const inPatch = (m, s, vn, wob) => ((s - m.s) / m.rs) ** 2 + ((vn - m.v) / m.rv) ** 2 < 1 + wob;
  function skin(f, s, vn, across) {
    if (across > 0.9 || s > 0.74) return 0;
    const wob = (noise(s * 13 + f.seed, vn * 28, f.seed) - 0.5) * 0.65;
    for (const m of f.marks.black) if (inPatch(m, s, vn, wob)) return 2;
    for (const m of f.marks.red) if (inPatch(m, s, vn, wob)) return 1;
    return 0;
  }

  /*
   * Fourteen koi, each in one of four colour schemes taken in turn: orange,
   * vermilion, gold and sakura. All patterned: kohaku and sanke, with one tancho.
   */
  const VARIETY = ["kohaku", "sanke", "kohaku", "sanke", "kohaku", "sanke", "kohaku", "sanke", "kohaku", "tancho", "sanke", "kohaku", "sanke", "kohaku"];
  const COLOURS = ["course", "vermilion", "gold", "sakura"];
  /* the most one joint of a koi turns from the one in front of it, in radians */
  const BEND = 0.42;
  /* More koi in a bigger pond, by width or by area, up to `most` (opts.most; fourteen unless a host asks for more). */
  const room = (w, h, most) => clamp(Math.max(w / 210, w * h / 85000), 3, most);
  /* the i-th koi's variety: the fourteen above, then kohaku and sanke in turn (still one tancho) */
  const varietyOf = i => i < VARIETY.length ? VARIETY[i] : (i % 2 ? "sanke" : "kohaku");

  /*
   * The paw's keyframes [time, value, ease into it]: o eases out, i eases in,
   * l is linear, anything else eases both ways.
   */
  const EASE = { o: u => 1 - (1 - u) ** 2.2, i: u => u ** 2.2, l: u => u };
  function track(a, keys) {
    if (a <= keys[0][0]) return keys[0][1];
    for (let j = 1; j < keys.length; j++) {
      const [t1, v1, e] = keys[j];
      if (a > t1) continue;
      const [t0, v0] = keys[j - 1], u = (a - t0) / (t1 - t0);
      return v0 + (v1 - v0) * (EASE[e] || (x => x * x * (3 - 2 * x)))(u);
    }
    return keys[keys.length - 1][1];
  }
  const DIP = 0.24, PULL = 0.42, FLICK = 0.72, SHAKE = 0.78, END = 1.25, RING_LIFE = 2.6, DROP_LIFE = 1.2;
  /* The whole catch, channel by channel (time in seconds): in a little past the spot, dip, curl, tug, tug, flick, away. */
  const BACK = [[0, 70], [0.17, -4, "o"], [DIP, 0], [PULL, 0, "l"], [0.52, 13], [0.57, 12], [0.68, 27], [FLICK, 29], [END, 84, "i"]];
  const HIGH = [[0, 0.5], [0.17, 0.15, "o"], [DIP, 0, "i"], [FLICK - 0.02, 0, "l"], [0.86, 0.6, "o"], [END, 1.05]];
  const SWAY = [[0, 0.06], [0.17, -0.02, "o"], [0.3, 0], [0.52, 0.03], [0.68, -0.03], [FLICK, 0], [END, 0]];
  const CURL = [[0, 0], [0.27, 0.05], [0.38, 1, "o"], [0.52, 1, "l"], [0.56, 0.75], [0.6, 1], [FLICK, 1, "l"], [0.95, 0.5], [END, 0.3]];
  const SINK = [[0.2, 0], [0.3, 1, "o"], [0.68, 1, "l"], [FLICK + 0.04, 0, "o"]];
  const SQUASH = [[0, -0.12], [0.17, -0.18, "l"], [0.22, 0.2, "o"], [0.3, 0], [0.44, 0.12], [0.52, -0.1], [0.58, 0.1], [0.68, -0.12], [FLICK, -0.2], [0.86, 0.05], [END, 0]];
  const SEEN = [[0, 0], [0.06, 1, "o"], [1.1, 1, "l"], [END, 0]];
  /* the leg's radius, the round hand's radius, and where the four toes sit around its tip (radians) */
  const LEG = 8.4, HAND = 10, TOES = [-1.12, -0.38, 0.38, 1.12];
  /* Fish food: how long a pellet floats before it sinks out of sight, and how long it takes to sink. */
  const FLOAT = 16, SINKING = 2.5;
  const STEP = 1 / 60;

  /*
   * createPond({ canvas, palette, width?, height?, dpr?, dim?, reduce? })
   * palette() returns the colours: { water, ink, accent, koiLight, koiDark, dark }
   * dim() returns the title's box in canvas pixels, or null: the koi fade under it, and the letters take on their colour.
   */
  function createPond(opts) {
    const canvas = opts.canvas, ctx = glCells(canvas) || canvas.getContext("2d");
    const reduce = !!opts.reduce;
    const MOST = Math.max(3, Math.round(opts.most || VARIETY.length));
    const N = 10, RAMP = " .:-=+*#%@", SUB = [0.25, 0.25, 0.75, 0.25, 0.25, 0.75, 0.75, 0.75];
    let vw = 0, vh = 0, dpr = 1, cw = 10, ch = 13, cols = 0, rows = 0, K = 1.85;
    let t = 0, simT = 0, paused = false;
    let P = null;
    let tileRGB, tileA, glyphRGB, glyphA, glyphCode, shade, wake, wakeTmp, tintRGB, tintA;
    const touched = [];
    let fish = [];
    const paws = [], rings = [], drops = [], food = [], bubbles = [];
    /* events for a film: { at, fn } run when the simulation passes them */
    const plan = [];
    let planAt = 0;
    /*
     * The sky over the pond, set from outside with pond.weather({ … }). It is drawn the way the pond draws
     * everything else: in the same cells, with the same dots, rings and shadows.
     *   rain, drizzle   drops land on the water as small rings
     *   snow            flakes come down (* then + then .), their shadow closing in, and melt into a ring
     *   wind            the light net drifts downwind and patches of ripples (~ -) sweep across the water
     *   cloud           cloud shadows drift over the pond and the light net goes out under them
     *   night, fog      darker water and no sun net (stars glint on a clear night); fog greys the water and the koi
     *   storm           the water flashes now and then
     */
    const SKY0 = { rain: 0, drizzle: 0, snow: 0, wind: 0, windFrom: 270, cloud: 0, night: 0, fog: 0, storm: 0 };
    let sky = { ...SKY0 }, skyTo = { ...SKY0 }, skySet = false;
    let windX = 0, windY = 0, windK = 0, flowX = 0, flowY = 0, gustX = 0, gustY = 0, cloudX = 0, cloudY = 0;
    let flakes = [], drips = [], rainDue = 0, snowDue = 0, flash = 0, flashAt = 8, flash2 = -1, wSeed = 0, koiK = 1, sunK = 1, skyFrame = 0;
    let wG = new Uint16Array(0), wA = new Float32Array(0), cloudGrid = new Float32Array(0), cgw = 0, cgh = 0;
    const wTouched = [], CB = 2, rnd = () => h2(++wSeed, 977);
    /* Caustics: two drifting noise fields; where they meet, light gathers in a thin moving net, as on a pool floor. The wind carries it downwind. */
    const caus = (x, y) => { x -= flowX; y -= flowY; return 1 - Math.min(1, Math.abs(noise(x / 46 + t * 0.21, y / 46 - t * 0.13, 7) - noise(x / 39 - t * 0.17, y / 52 + t * 0.19, 11)) * 5.5); };
    const cloudAt = (c, r) => cgw ? cloudGrid[Math.min(cgh - 1, (r / CB) | 0) * cgw + Math.min(cgw - 1, (c / CB) | 0)] : 0;

    function stepSky(dt) {
      const e = 1 - Math.exp(-dt / 3);
      for (const k in SKY0) if (k !== "windFrom") sky[k] += (skyTo[k] - sky[k]) * e;
      const dr = (skyTo.windFrom - sky.windFrom) * Math.PI / 180;
      sky.windFrom += Math.atan2(Math.sin(dr), Math.cos(dr)) * 180 / Math.PI * e;
      /* the wind blows toward windFrom + 180 degrees, with north up the screen */
      const to = (sky.windFrom + 180) * Math.PI / 180, sp = Math.min(48, sky.wind * 1.5);
      windX = Math.sin(to) * sp; windY = -Math.cos(to) * sp; windK = sstep(6, 26, sky.wind);
      flowX += windX * 0.3 * dt; flowY += windY * 0.3 * dt;
      gustX += windX * 2.2 * dt; gustY += windY * 2.2 * dt;
      cloudX += (windX * 0.5 + 3) * dt; cloudY += windY * 0.5 * dt;
      const area = vw * vh / (1440 * 900);
      /* rain: drops land as small rings */
      rainDue += (sky.rain * 46 + sky.drizzle * 30) * area * dt;
      while (rainDue >= 1) { rainDue--; const big = sky.rain >= sky.drizzle; drips.push({ x: rnd() * vw, y: rnd() * vh, born: t, s: big ? 0.75 + rnd() * 0.5 : 0.45 + rnd() * 0.3 }); }
      for (let j = drips.length - 1; j >= 0; j--) if (t - drips[j].born > 0.6) drips.splice(j, 1);
      /* snow: each flake takes a few seconds to come down, drifting with the wind */
      snowDue += sky.snow * 22 * area * dt;
      while (snowDue >= 1) { snowDue--; flakes.push({ x: rnd() * (vw + 120) - 60, y: rnd() * (vh + 80) - 40, born: t, life: 3.5 + rnd() * 3, sway: rnd() * 6.28 }); }
      for (let j = flakes.length - 1; j >= 0; j--) {
        const f = flakes[j], u = (t - f.born) / f.life, hgt = 1 - u;
        if (u >= 1) { if (rnd() < 0.5) drips.push({ x: f.x, y: f.y, born: t, s: 0.4 }); flakes.splice(j, 1); continue; }
        f.x += (windX * (0.4 + 0.6 * hgt) + Math.sin(t * 1.3 + f.sway) * 9) * dt;
        f.y += (windY * (0.4 + 0.6 * hgt) + Math.cos(t * 1.1 + f.sway) * 5) * dt;
      }
      /* storm: a double flash now and then */
      if (sky.storm > 0.5 && t > flashAt) { flash = 1; flash2 = t + 0.16; flashAt = t + 10 + rnd() * 18; }
      if (flash2 > 0 && t > flash2) { flash = Math.max(flash, 0.7); flash2 = -1; }
      flash *= Math.exp(-dt * 7);
    }
    /* how much the koi show and how much sun reaches the pond floor */
    function skyLight() {
      koiK = 1 - 0.16 * sky.night - 0.3 * sky.fog;
      sunK = (1 - 0.9 * sky.night) * (1 - 0.9 * sky.fog) * (1 - 0.5 * Math.max(sky.rain, sky.snow, sky.drizzle));
    }
    /* the water under the sky: darker at night and under heavy cloud or rain, paler in fog, bright for a moment in a flash */
    function skyWater() {
      let w = P.water;
      const dim = (0.34 * sky.night + 0.12 * sky.cloud + 0.06 * Math.max(sky.rain, sky.snow)) * (P.dark ? 1 : 0.4);
      if (dim > 0.002) w = mixC(w, [0, 0, 0], dim);
      if (sky.fog > 0.01) w = mixC(w, P.dark ? P.ink : [250, 250, 247], (P.dark ? 0.08 : 0.3) * sky.fog);
      if (flash > 0.01) w = mixC(w, P.dark ? [205, 218, 236] : [255, 255, 255], 0.2 * flash);
      return w;
    }
    /* The sky into the cell buffers: flakes over everything with their shadows, rain rings on the open water, the cloud field. */
    function rasterSky() {
      for (const i of wTouched) wA[i] = 0;
      wTouched.length = 0;
      if (sky.cloud > 0.03) {
        const gw = Math.ceil(cols / CB), gh = Math.ceil(rows / CB);
        if (gw !== cgw || gh !== cgh) { cgw = gw; cgh = gh; cloudGrid = new Float32Array(gw * gh); skyFrame = 0; }
        /* clouds move slowly: the field is worked out every fourth frame */
        if (skyFrame++ % 4 === 0) {
          const thr = lerp(0.8, 0.2, sky.cloud);
          for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
            const x = (gx + 0.5) * CB * cw - cloudX, y = (gy + 0.5) * CB * ch - cloudY;
            const v = noise(x / 380, y / 270, 31) * 0.7 + noise(x / 130, y / 100, 37) * 0.3;
            cloudGrid[gy * gw + gx] = sstep(thr - 0.11, thr + 0.11, v);
          }
        }
      } else cgw = 0;
      for (const f of flakes) {
        const age = t - f.born, hgt = 1 - age / f.life;
        const c = Math.floor(f.x / cw), r = Math.floor(f.y / ch);
        if (hgt <= 0 || c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const i = r * cols + c;
        if (!tileA[i] && !glyphA[i]) touched.push(i);
        glyphRGB[i] = pack(P.dot); glyphA[i] = (0.3 + 0.45 * hgt) * Math.min(1, age * 2) * Math.min(1, hgt * 6);
        glyphCode[i] = (hgt > 0.62 ? "*" : hgt > 0.28 ? "+" : ".").charCodeAt(0);
        const sc = Math.round(hgt * 3), sr = Math.round(hgt * 2), si = (r + sr) * cols + (c + sc);
        if ((sc || sr) && r + sr < rows && c + sc < cols) shade[si] = Math.max(shade[si], (P.dark ? 0.28 : 0.14) * hgt);
      }
      const kk = K * 0.55;
      for (const d of drips) {
        const age = t - d.born, life = 1 - age / 0.6;
        if (life <= 0 || age < 0) continue;
        const R = (3 + age * 44) * d.s * kk, a0 = life ** 1.5 * 0.42 * Math.min(1, d.s + 0.3);
        const c0 = Math.max(0, Math.floor((d.x - R) / cw) - 1), c1 = Math.min(cols - 1, Math.floor((d.x + R) / cw) + 1);
        const r0 = Math.max(0, Math.floor((d.y - R) / ch) - 1), r1 = Math.min(rows - 1, Math.floor((d.y + R) / ch) + 1);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const dx = c * cw + cw / 2 - d.x, dy = r * ch + ch / 2 - d.y, dd = Math.hypot(dx, dy);
          let a = 0, g = 0;
          if (age < 0.1 && dd < cw * 0.6) { a = 0.5 * (1 - age / 0.1); g = 46; }
          else if (Math.abs(dd - R) <= cw * 0.62) { a = a0; g = lineGlyph(-dy, dx).charCodeAt(0); }
          const i = r * cols + c;
          if (a <= wA[i]) continue;
          if (!(wA[i] > 0)) wTouched.push(i);
          wA[i] = a; wG[i] = g;
        }
      }
    }

    function makeFish() {
      fish = Array.from({ length: MOST }, (_, i) => varietyOf(i)).map((variety, i) => {
        const r = seeded("koi" + i);
        const right = i % 2 === 0, a = right ? (r() - 0.5) * 0.3 : Math.PI + (r() - 0.5) * 0.3;
        const L0 = 128 + r() * 52, seg = L0 / (N - 1);
        const nodes = new Float32Array(N * 2);
        for (let j = 0; j < N; j++) { nodes[j * 2] = -Math.cos(a) * seg * j; nodes[j * 2 + 1] = -Math.sin(a) * seg * j; }
        const seed = i * 97 + 13;
        return {
          variety, colour: COLOURS[i % 4], seen: 1, seed, marks: markings(variety, seed), a, nodes, seg, L0,
          cruise: 24 + r() * 12, nx: (i * 0.38 + 0.15) % 1, ny: 0.22 + r() * 0.56, depth: 0.35 + r() * 0.65, phase: r() * 6.28,
          beat: 0.5, turn: 0, flee: 0, fleeA: 0, seekX: 0, seekY: 0, seekFrom: 0, seekUntil: 0,
          /* feeding: how keen, how far it notices food, when it may eat again, how close to the surface */
          appetite: h2(seed, 5), fullUntil: 0, rise: 0, kick: 0, meal: null
        };
      });
    }

    function size(w, h) {
      dpr = opts.dpr ? opts.dpr() : Math.min(4, global.devicePixelRatio || 1);
      vw = w; vh = h;
      cw = clamp(Math.round(vw / 150), 7, 10); ch = cw + 3; K = 1.85 * clamp(vw / 1000, 0.62, 1);
      canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
      cols = Math.ceil(vw / cw); rows = Math.ceil(vh / ch);
      const n = cols * rows;
      tileRGB = new Uint32Array(n); tileA = new Float32Array(n); glyphRGB = new Uint32Array(n); glyphA = new Float32Array(n);
      glyphCode = new Uint16Array(n); shade = new Float32Array(n); wake = new Float32Array(n); wakeTmp = new Float32Array(n);
      tintRGB = new Uint32Array(n); tintA = new Float32Array(n);
      wG = new Uint16Array(n); wA = new Float32Array(n); wTouched.length = 0; cgw = 0;
      touched.length = 0;
    }
    const count = () => Math.round(room(vw, vh, MOST));
    const headX = f => f.nx * vw, headY = f => f.ny * vh;

    function stamp(x, y, rad, amt) {
      const c = Math.floor(x / cw), r = Math.floor(y / ch);
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
        const cc = c + dc, rr = r + dr, d = Math.hypot(dc, dr * ch / cw);
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows || d > rad) continue;
        wake[rr * cols + cc] = Math.min(1, wake[rr * cols + cc] + amt * (1 - d / (rad + 1)));
      }
    }

    /* The nearest pellet this koi can see; pellets other koi already chose count as farther, so the shoal spreads out over the food. */
    function mealFor(f, list, hx, hy) {
      if (f.appetite < 0.18 || t < f.fullUntil) return null;
      let best = null, bd = (240 + 320 * f.appetite) * K;
      for (const p of list) {
        const d = Math.hypot(p.x - hx, p.y - hy) + p.claim * 60 * K;
        if (d < bd) { bd = d; best = p; }
      }
      if (best) best.claim++;
      return best;
    }

    function eat(p, f) {
      p.eaten = t;
      f.fullUntil = t + 0.3 + 0.5 * h2(f.seed, Math.round(t * 10));
      f.kick = 1;
      rings.push({ x: p.x, y: p.y, born: t, k: K * 0.7, small: true });
      stamp(p.x, p.y, 1, 0.6);
      for (let j = 0; j < 3; j++) bubbles.push({ x: p.x + (h2(p.seed, j) - 0.5) * 14 * K, y: p.y + (h2(p.seed, j + 9) - 0.5) * 10 * K, born: t + j * 0.09 });
    }

    function step(dt) {
      const zw = Math.max(1, vw), zh = Math.max(1, vh), k = K;
      const maxTilt = 1.0, yLo = 0.14, yHi = 1 - yLo;
      const menu = food.filter(p => p.eaten < 0 && t > p.land - 0.25 && t - p.land < FLOAT);
      for (const p of menu) p.claim = 0;
      const n = count();
      fish.forEach((f, i) => {
        /* A koi that comes or goes as the window is resized fades over half a second. */
        const want = i < n ? 1 : 0;
        f.seen = clamp(f.seen + Math.sign(want - f.seen) * dt * 2, Math.min(f.seen, want), Math.max(f.seen, want));
        const right = Math.cos(f.a) > 0, base = right ? 0 : Math.PI;
        f.beat = 0.5 + 0.5 * Math.sin(t * 0.45 + f.seed);
        let turn = Math.sin(t * 0.29 + f.seed) * 0.32 + Math.sin(t * 0.11 + f.seed * 1.7) * 0.22;
        if (f.ny < yLo) turn += right ? 0.7 : -0.7;
        if (f.ny > yHi) turn += right ? -0.7 : 0.7;
        const tilt = Math.atan2(Math.sin(f.a - base), Math.cos(f.a - base));
        if (Math.abs(tilt) > maxTilt) turn -= Math.sign(tilt) * 1.4;
        f.turn = lerp(f.turn, turn, Math.min(1, dt * 2));
        const hx = headX(f), hy = headY(f);
        /* A paw hit the water: dart away from it. Food: rise and race to it. Later the curious ones swim back to look. */
        let hurry = 1;
        f.meal = null;
        if (f.flee > 0.02) {
          const d = Math.atan2(Math.sin(f.fleeA - f.a), Math.cos(f.fleeA - f.a));
          f.turn = lerp(f.turn, clamp(d * 5, -4, 4), Math.min(1, dt * 8 * f.flee));
          hurry = 1 + 2.6 * f.flee;
          f.flee *= Math.exp(-1.3 * dt);
        } else if (menu.length && (f.meal = mealFor(f, menu, hx, hy))) {
          const p = f.meal, dist = Math.hypot(p.x - hx, p.y - hy);
          const d = Math.atan2(Math.sin(Math.atan2(p.y - hy, p.x - hx) - f.a), Math.cos(Math.atan2(p.y - hy, p.x - hx) - f.a));
          f.turn = lerp(f.turn, clamp(d * 3.6, -3.4, 3.4), Math.min(1, dt * 7));
          /* fast from afar, slower close in so it can turn onto the pellet */
          hurry = 1.2 + 1.3 * clamp(dist / (150 * k), 0, 1) * (Math.abs(d) < 1.1 ? 1 : 0.45);
          f.rise = Math.min(1, f.rise + dt * 1.6);
        } else if (t > f.seekFrom && t < f.seekUntil) {
          if (Math.hypot(f.seekX - hx, f.seekY - hy) < 26 * k) f.seekUntil = 0;
          else {
            const d = Math.atan2(Math.sin(Math.atan2(f.seekY - hy, f.seekX - hx) - f.a), Math.cos(Math.atan2(f.seekY - hy, f.seekX - hx) - f.a));
            f.turn = lerp(f.turn, clamp(d * 2.6, -2.4, 2.4), Math.min(1, dt * 3));
            hurry = 1.4;
          }
        }
        if (!f.meal) f.rise = Math.max(0, f.rise - dt * 0.3);
        hurry *= 1 + 0.9 * f.kick;
        f.kick *= Math.exp(-3.5 * dt);
        f.a += f.turn * dt;
        const speed = f.cruise * (0.65 + 0.7 * f.beat) * hurry;
        const dx = Math.cos(f.a) * speed * dt, dy = Math.sin(f.a) * speed * dt;
        f.nx += dx * k / zw;
        f.ny += dy * k / zh;
        /*
         * The head stays at the origin; the rest of the chain trails it. No joint
         * bends further than BEND, so a startled koi curls into a C and the tail
         * swings round after the head instead of folding the body over itself.
         */
        const nd = f.nodes;
        for (let j = 1; j < N; j++) { nd[j * 2] -= dx; nd[j * 2 + 1] -= dy; }
        let bx = -Math.cos(f.a), by = -Math.sin(f.a);
        for (let j = 1; j < N; j++) {
          const px = nd[(j - 1) * 2], py = nd[(j - 1) * 2 + 1];
          let vx = nd[j * 2] - px, vy = nd[j * 2 + 1] - py;
          const d = Math.hypot(vx, vy) || 1; vx /= d; vy /= d;
          const bend = Math.atan2(bx * vy - by * vx, bx * vx + by * vy);
          if (Math.abs(bend) > BEND) { const r = Math.sign(bend) * BEND, c = Math.cos(r), s = Math.sin(r); vx = bx * c - by * s; vy = bx * s + by * c; }
          nd[j * 2] = px + vx * f.seg; nd[j * 2 + 1] = py + vy * f.seg;
          bx = vx; by = vy;
        }
        f.phase += dt * (2.6 + 5 * f.beat) * (1 + 0.6 * f.kick);
        const m = (f.L0 * k * 1.45) / zw;
        if (f.nx > 1 + m) f.nx = -m;
        if (f.nx < -m) f.nx = 1 + m;
        /* the mouth reaches the pellet: one gulp */
        if (f.meal && Math.hypot(f.meal.x - headX(f), f.meal.y - headY(f)) < 14 * k) eat(f.meal, f);
        /* wake from the tail */
        if (f.seen > 0) {
          const tc = Math.floor((headX(f) + nd[(N - 1) * 2] * k) / cw), tr = Math.floor((headY(f) + nd[(N - 1) * 2 + 1] * k) / ch);
          if (tc >= 0 && tr >= 0 && tc < cols && tr < rows) wake[tr * cols + tc] = Math.min(1, wake[tr * cols + tc] + 0.18 * f.beat * dt * 30);
        }
      });
      /* wake: spreads a little and fades, the edge cells too: a neighbour beyond the edge counts as the cell
         itself, so a wake left by a koi passing the edge fades like any other instead of piling up there */
      const fade = Math.exp(-dt * 1.4);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = r * cols + c, w = wake[i];
        const n = (c > 0 ? wake[i - 1] : w) + (c < cols - 1 ? wake[i + 1] : w) + (r > 0 ? wake[i - cols] : w) + (r < rows - 1 ? wake[i + cols] : w);
        wakeTmp[i] = (w * 0.84 + n * 0.04) * fade;
      }
      [wake, wakeTmp] = [wakeTmp, wake];
    }

    /* ── rasterising one koi into the cell buffers ── */
    const spine = new Float32Array(N * 2), arc = new Float32Array(N), cd2 = new Float64Array(N), cu = new Float64Array(N), segLen = new Float64Array(N);
    let arcTotal = 1, S = 0, V = 0, D = 0, TX = 1, TY = 0, SEG = 0;
    function sample(px, py, L, flareL, flareR, from = 0, to = N - 2) {
      let best = Infinity, bs = 0, sign = 1, past = 0, ahead = 0, lateral = 0;
      for (let n = from; n <= to; n++) {
        const ax = spine[n * 2], ay = spine[n * 2 + 1], sx = spine[n * 2 + 2] - ax, sy = spine[n * 2 + 3] - ay;
        const len2 = sx * sx + sy * sy || 1, raw = ((px - ax) * sx + (py - ay) * sy) / len2, u = clamp(raw, 0, 1);
        const d2 = (px - ax - sx * u) ** 2 + (py - ay - sy * u) ** 2;
        cd2[n] = d2; cu[n] = u;
        if (d2 < best) {
          const len = Math.sqrt(len2), cross = sx * (py - ay) - sy * (px - ax);
          best = d2; bs = (arc[n] + u * len) / arcTotal; sign = cross >= 0 ? 1 : -1;
          past = n === N - 2 ? Math.max(0, raw - 1) * len : 0;
          ahead = n === 0 ? Math.max(0, -raw) * len : 0;
          lateral = Math.abs(cross) / len; TX = sx / len; TY = sy / len; SEG = n;
        }
      }
      D = Math.sqrt(best); S = bs; V = D * sign;
      return classify(bs, D / L, past / L, sign > 0 ? flareL : flareR, ahead / L, lateral / L);
    }
    const lineGlyph = (dx, dy) => { const d = Math.hypot(dx, dy) || 1; return Math.abs(dy) < 0.38 * d ? "-" : Math.abs(dx) < 0.38 * d ? "|" : dx * dy > 0 ? "\\" : "/"; };

    function rasterize(f, dimAt) {
      const k = K, hx = headX(f), hy = headY(f), L = f.L0 * k;
      const swim = 0.25 + 0.9 * f.beat;
      for (let n = 0; n < N; n++) {
        const s = n / (N - 1), a = Math.max(0, n - 1), b = Math.min(N - 1, n + 1);
        let tx = f.nodes[a * 2] - f.nodes[b * 2], ty = f.nodes[a * 2 + 1] - f.nodes[b * 2 + 1];
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const off = L * 0.045 * (0.05 + 0.95 * Math.pow(s, 2.2)) * swim * Math.sin(f.phase - s * 4.6);
        spine[n * 2] = hx + f.nodes[n * 2] * k - ty * off;
        spine[n * 2 + 1] = hy + f.nodes[n * 2 + 1] * k + tx * off;
      }
      arc[0] = 0;
      for (let n = 1; n < N; n++) arc[n] = arc[n - 1] + Math.hypot(spine[n * 2] - spine[n * 2 - 2], spine[n * 2 + 1] - spine[n * 2 - 1]);
      arcTotal = arc[N - 1] || 1;
      const bank = clamp(f.turn * 0.5, -0.3, 0.3), scull = 0.15 * (1 - f.beat) * Math.sin(f.phase * 0.5);
      const flareL = 1 + scull - bank, flareR = 1 - scull + bank;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let n = 0; n < N; n++) { x0 = Math.min(x0, spine[n * 2]); x1 = Math.max(x1, spine[n * 2]); y0 = Math.min(y0, spine[n * 2 + 1]); y1 = Math.max(y1, spine[n * 2 + 1]); }
      const reach = L * 0.27;
      const c0 = Math.max(0, Math.floor(Math.max(x0 - reach, 0) / cw)), c1 = Math.min(cols - 1, Math.floor(Math.min(x1 + reach, vw) / cw));
      const r0 = Math.max(0, Math.floor(Math.max(y0 - reach, 0) / ch)), r1 = Math.min(rows - 1, Math.floor(Math.min(y1 + reach, vh) / ch));
      if (c0 > c1 || r0 > r1) return;
      const diag = Math.hypot(cw, ch);
      /* each segment's length, and how far a finer sample sits from its cell's centre (in pixels and along the body) */
      for (let n = 0; n < N - 1; n++) { const sx = spine[n * 2 + 2] - spine[n * 2], sy = spine[n * 2 + 3] - spine[n * 2 + 1]; segLen[n] = Math.sqrt(sx * sx + sy * sy || 1); }
      const dsub = Math.hypot(cw, ch) / 4 + 0.5, ds = dsub / arcTotal + 0.005, mapL = shapeMap(flareL), mapR = shapeMap(flareR);
      /* A koi rising for food comes up toward the surface: brighter, its shadow further below it. */
      const depth = lerp(f.depth, 1, f.rise * 0.85);
      const Kc = P.koi[f.colour], alphaBase = (P.dark ? 0.82 : 0.9) * (0.55 + 0.45 * depth) * f.seen * koiK;
      const sdc = 1 + Math.round(depth * 2), sdr = 1 + Math.round(depth);
      const lx = -0.6, ly = -0.8;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const x = c * cw, y = r * ch;
          const got = sample(x + cw / 2, y + ch / 2, L, flareL, flareR);
          if (!got && D > L * (S > 0.4 && S < 0.62 ? 0.15 : 0.26) + diag) { c += Math.max(0, Math.floor((D - L * 0.26 - diag) / cw)); continue; }
          let kind = hit.kind, across = hit.across, rs = hit.rs, ra = hit.ra, s = S, v = V, tx = TX, ty = TY;
          const from = Math.max(0, SEG - 2), to = Math.min(N - 2, SEG + 2);
          /* a cell that missed, and that no part of the koi near it can reach, needs no finer samples */
          let near = got;
          for (let n = from; !near && n <= to; n++) {
            /* a finer sample's nearest point on this segment is within dsub of the centre's, and so is its distance */
            const d = Math.sqrt(cd2[n]), sm = (arc[n] + cu[n] * segLen[n]) / arcTotal;
            if (n === 0 && sm < 0.03 && d - dsub < 0.115 * L) near = true;
            else near = canHit(mapL, sm - ds, sm + ds, (d - dsub) / L, (d + dsub) / L) || (mapR !== mapL && canHit(mapR, sm - ds, sm + ds, (d - dsub) / L, (d + dsub) / L));
          }
          if (!near) continue;
          let hits = got ? 1 : 0;
          const deep = got && kind === 1 && s > 0.05 && s < 0.7 && halfW(s) * L - D > diag * 0.4;
          if (deep) hits = 5;
          for (let q = 0; !deep && q < SUB.length; q += 2) {
            if (!sample(x + SUB[q] * cw, y + SUB[q + 1] * ch, L, flareL, flareR, from, to)) continue;
            if (hits === 0) { kind = hit.kind; across = hit.across; rs = hit.rs; ra = hit.ra; s = S; v = V; tx = TX; ty = TY; }
            hits++;
          }
          if (!hits) continue;
          const cover = hits / 5, i = r * cols + c, dim = dimAt(x + cw / 2, y + ch / 2);
          const side = v >= 0 ? 1 : -1;
          let tile = null, tA = 0, g = " ", gC = null, gA = 0;
          if (kind === 5) {
            g = lineGlyph(tx, ty); gC = Kc.fin; gA = 0.7 * alphaBase;
          } else if (kind === 2) {
            /* Fins and tail: see-through tiles with a ray glyph */
            const nx = -ty * side, ny = tx * side;
            g = lineGlyph(rs * tx + ra * nx, rs * ty + ra * ny);
            tile = Kc.fin; tA = (P.dark ? 0.26 : 0.42) * cover * alphaBase;
            gC = mul(Kc.fin, P.dark ? 1.1 : 0.8); gA = (P.dark ? 0.55 : 0.6) * alphaBase;
          } else {
            const nz = Math.sqrt(Math.max(0, 1 - across * across));
            const nxs = -ty * side * across, nys = tx * side * across;
            /* where the caustic net crosses a koi's back, its scales glint */
            const gl = sstep(0.62, 0.96, caus(x + cw / 2, y + ch / 2)) * nz;
            const lit = clamp(0.76 + 0.26 * nz + 0.2 * (nxs * lx + nys * ly) + 0.3 * gl, 0.62, 1.34);
            const sk = kind === 3 ? null : skin(f, s, v / L, across);
            const base = kind === 3 ? P.eye : sk === 1 ? Kc.red : sk === 2 ? Kc.black : Kc.white;
            tile = mul(base, lit); tA = (cover >= 0.6 ? 1 : cover * 1.4) * alphaBase;
            /* The koi's back as the title takes it on, before the dimming under the title: the red saddles most, then white or black by the theme. */
            if (kind !== 3) { tintRGB[i] = pack(tile); tintA[i] = tA * (sk === 1 ? 1 : sk === 2 ? (P.dark ? 0.4 : 0.6) : (P.dark ? 0.7 : 0.25)) * (1 + 0.6 * gl); }
            if (kind === 3) { g = "o"; gC = Kc.white; gA = 0.95 * alphaBase; }
            else {
              const idx = clamp(1 + Math.round((1.08 - lit) / 0.46 * 6) + (kind === 4 ? 2 : 0), 1, RAMP.length - 1);
              g = RAMP[idx]; gC = mul(base, P.dark ? (sk === 0 ? 0.55 : 1.35) : 0.5); gA = 0.62 * alphaBase;
              if (gl > 0.5 && kind !== 4) { g = "*"; gC = mixC(base, [255, 255, 255], 0.75); gA = (0.45 + 0.4 * gl) * alphaBase; }
            }
            if (cover >= 0.6) {
              const si = (r + sdr) * cols + (c + sdc);
              if (r + sdr < rows && c + sdc < cols) shade[si] = Math.max(shade[si], (P.dark ? 0.55 : 0.22) * (0.5 + 0.5 * depth) * dim * f.seen);
            }
          }
          if (!tileA[i] && !glyphA[i]) touched.push(i);
          if (tile) { tileRGB[i] = pack(tile); tileA[i] = tA * dim; }
          if (gC) { glyphRGB[i] = pack(gC); glyphA[i] = gA * dim; glyphCode[i] = g.charCodeAt(0); }
        }
      }
    }

    /* ── the cat's paw ── */
    const water = (x, y) => !paused && !reduce && x >= 0 && x <= vw && y >= 0 && y <= vh;
    /* A paw at (x, y): straight in from the nearer edge, top or bottom. */
    function poke(x, y) {
      if (paws.length >= 3 || !water(x, y)) return false;
      const k = K, fromTop = y <= vh - y;
      const ex = x, ey = fromTop ? -46 * k : vh + 46 * k;
      /* which way it sways and shakes is left to chance */
      paws.push({ x, y, k, ex, ey, leg: 30, side: h2(Math.round(x), Math.round(y)) < 0.5 ? -1 : 1, born: t, hit: false, flung: false, drips: 0 });
      return true;
    }
    /* Where a paw is in its catch: how far it is drawn back, how high, how it sways, how curled and how deep its toes are. */
    function pawState(p) {
      const a = t - p.born;
      /* two quick wet shakes as it leaves, turning the paw */
      const u = (a - SHAKE) / 0.3, shake = u > 0 && u < 1 ? 0.14 * Math.sin(u * 4 * Math.PI) * (1 - u) : 0;
      return { back: track(a, BACK), h: track(a, HIGH), swing: (track(a, SWAY) + shake) * p.side, curl: track(a, CURL), sink: track(a, SINK), squash: track(a, SQUASH), seen: track(a, SEEN) };
    }
    /* How far the tip reaches in paw units: curled toes fold under, so the paw gets shorter. */
    const tipOf = s => 5 - 4 * s.curl + HAND * 1.08;
    /* The paw on screen: the leg turns about a shoulder beyond the edge. Centre, axis u toward the toes, v across, size k; high up it looks bigger. */
    function pawPose(p) {
      const s = pawState(p), Kp = p.k * 1.9, arm = 120;
      let ux = p.x - p.ex, uy = p.y - p.ey;
      const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
      const c = Math.cos(s.swing), n = Math.sin(s.swing), dx = ux * c - uy * n, dy = ux * n + uy * c;
      const sx = p.x - ux * arm * Kp, sy = p.y - uy * arm * Kp, r = (arm - s.back) * Kp;
      return { ...s, ux: dx, uy: dy, vx: -dy, vy: dx, cx: sx + dx * r, cy: sy + dy * r, k: Kp * (1 + 0.5 * s.h) };
    }
    function splash(p) {
      p.hit = true;
      const s = pawPose(p), tip = tipOf(s) - 3, x = s.cx + s.ux * tip * s.k, y = s.cy + s.uy * tip * s.k;
      rings.push({ x, y, born: t, k: p.k, small: false });
      stamp(x, y, 4, 0.9);
      const reach = 280 * p.k;
      const near = fish.slice(0, count()).map(f => ({ f, d: Math.hypot(headX(f) - x, headY(f) - y), hx: headX(f), hy: headY(f) })).sort((a, b) => a.d - b.d);
      near.forEach(({ f, d, hx, hy }, i) => {
        if (d < reach) { f.flee = Math.max(f.flee, 1 - d / reach * 0.7); f.fleeA = Math.atan2(hy - y, hx - x); }
        /* the two curious ones come to look from either side, not at the same spot */
        if (i < 2) { const o = (i ? 1 : -1) * 34 * p.k; f.seekX = x - s.vx * o; f.seekY = y - s.vy * o; f.seekFrom = t + 1.3 + i * 0.5; f.seekUntil = f.seekFrom + 3.5; }
      });
    }
    /* The tugs stir the water in front of the curled toes. */
    function stir(p, dt) {
      const s = pawPose(p), tip = tipOf(s) + 2;
      stamp(s.cx + s.ux * tip * s.k, s.cy + s.uy * tip * s.k, 2, 4 * dt);
    }
    /* Flicking out of the water, the paw throws a few drops back toward the cat. */
    function fling(p) {
      p.flung = true;
      const s = pawPose(p), seed = Math.round(p.born * 1000);
      for (let j = 0; j < 5; j++) {
        const side = (j - 2) / 2, d = (30 + 36 * h2(j, seed)) * p.k;
        const x0 = s.cx + (s.ux * tipOf(s) + s.vx * side * 8) * s.k, y0 = s.cy + (s.uy * tipOf(s) + s.vy * side * 8) * s.k;
        drops.push({ x0, y0, x1: x0 - s.ux * d + s.vx * side * 18 * p.k, y1: y0 - s.uy * d + s.vy * side * 18 * p.k, born: t + j * 0.035, dur: 0.34 + 0.14 * h2(j + 7, seed), k: p.k });
      }
    }
    /* Each shake throws a drop off the side of the tip it swings toward. */
    function drip(p, dir) {
      const s = pawPose(p), a0 = tipOf(s) - 4, s0 = dir * 8, seed = Math.round(p.born * 1000) + p.drips;
      const x = s.cx + (s.ux * a0 + s.vx * s0) * s.k, y = s.cy + (s.uy * a0 + s.vy * s0) * s.k, d = (26 + 20 * h2(seed, 3)) * p.k;
      drops.push({ x0: x, y0: y, x1: x + s.vx * dir * d - s.ux * 8 * p.k, y1: y + s.vy * dir * d - s.uy * 8 * p.k, born: t, dur: 0.3, k: p.k });
    }
    /*
     * The paw is drawn the way the cat is: in cells half the pond's size, black
     * fur edged with ':' and a little '#%' texture. In paw units al runs toward
     * the toes and sd across: a round little hand on a round leg, its four toes
     * only drawn as four faint arcs along the tip.
     */
    function drawPaw(p) {
      const pose = pawPose(p), { ux, uy, vx, vy, cx, cy, k, h, sink, curl, squash, seen } = pose;
      /* squashed as it pushes in, stretched as it shoots and flicks: shorter and wider, or longer and narrower */
      const ka = k * (1 - 0.16 * squash), ks = k * (1 + 0.16 * squash);
      /* Curled toes fold under the tip, and their knuckles stand out a little more. */
      const cb = tipOf(pose) - HAND * 1.08, toe = 2.5 + 0.3 * curl, ring = HAND - toe - 1.1;
      const smin = (a, b, m) => { const q = Math.max(m - Math.abs(a - b), 0) / m; return Math.min(a, b) - q * q * m / 4; };
      let dist = 0;
      const part = (al, sd) => {
        /* a round little hand on a round leg, melted together */
        const leg = (al > cb ? Math.hypot(al - cb, sd) : Math.abs(sd)) - LEG, hand = Math.hypot((al - cb) / 1.08, sd) - HAND;
        dist = smin(leg, hand, 6);
        return dist > 0 ? -1 : al < -6 ? 0 : 1;
      };
      const fw = cw / 2, fh = ch / 2;
      /* the box the paw and its foreleg can cover */
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const al of [-p.leg - 1, 16]) for (const sd of [-11.5, 11.5]) {
        const x = cx + ux * al * ka + vx * sd * ks, y = cy + uy * al * ka + vy * sd * ks;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      const i0 = Math.max(0, Math.floor(x0 / fw)), i1 = Math.min(Math.ceil(vw / fw), Math.ceil(x1 / fw));
      const j0 = Math.max(0, Math.floor(y0 / fh)), j1 = Math.min(Math.ceil(vh / fh), Math.ceil(y1 / fh));
      const nc = i1 - i0 + 1, nr = j1 - j0 + 1;
      if (nc <= 0 || nr <= 0) return;
      /* Each cell takes the part under its samples; a cell only partly covered is drawn fainter, so the toes stay round. */
      const g = new Int8Array(nc * nr).fill(-1), A = new Float32Array(nc * nr), C = new Float32Array(nc * nr);
      const reachCell = 0.6 * Math.hypot(fw, fh) / Math.min(ka, ks) + 0.3;
      const alOf = (x, y) => ((x - cx) * ux + (y - cy) * uy) / ka, sdOf = (x, y) => ((x - cx) * vx + (y - cy) * vy) / ks;
      for (let j = 0; j < nr; j++) for (let i = 0; i < nc; i++) {
        const x = (i0 + i) * fw, y = (j0 + j) * fh, ac = alOf(x + fw / 2, y + fh / 2);
        A[j * nc + i] = ac;
        if (ac < -p.leg - 1 || ac > 17 || Math.abs(sdOf(x + fw / 2, y + fh / 2)) > 13) continue;
        /* a cell well inside or outside needs no more samples than its centre */
        const vc = part(ac, sdOf(x + fw / 2, y + fh / 2));
        if (Math.abs(dist) > reachCell) { g[j * nc + i] = vc; C[j * nc + i] = vc >= 0 ? 1 : 0; continue; }
        let n = 0, top = -1;
        for (let q = 1; q < 6; q += 2) for (let r = 1; r < 6; r += 2) {
          const sx = x + q / 6 * fw, sy = y + r / 6 * fh, v = part(alOf(sx, sy), sdOf(sx, sy));
          if (v >= 0) { n++; if (top < 0 || v > 1) top = v; }
        }
        g[j * nc + i] = n >= 5 ? top : n ? -2 : -1;
        C[j * nc + i] = n / 9;
      }
      const at = (i, j) => i < 0 || j < 0 || i >= nc || j >= nr ? -1 : Math.max(-1, g[j * nc + i]);
      const wl = sink > 0 ? tipOf(pose) + 2 - 8 * sink : Infinity, halfU = 0.5 * (Math.abs(ux) * fw + Math.abs(uy) * fh) / ka;
      /* the foreleg fades out toward the bank the cat sits on */
      const fade = al => al < -8 ? Math.max(0, 1 - (-8 - al) / (p.leg - 8)) ** 1.5 : 1;
      /* The shadow falls on the water, offset more while the paw is high. */
      const sx = fw * (2 + Math.round(h * 8)), sy = fh * (2 + Math.round(h * 6));
      ctx.globalAlpha = (P.dark ? 0.5 : 0.24) * (1 - 0.5 * h) * seen;
      ctx.fillStyle = P.dark ? "#000" : css(pack(mul(P.water, 0.55)));
      ctx.beginPath();
      for (let j = 0; j < nr; j++) for (let i = 0; i < nc; i++) {
        const v = g[j * nc + i], al = A[j * nc + i];
        if (v >= 0 && fade(al) > 0.4 && al < wl) ctx.rect((i0 + i) * fw + sx, (j0 + j) * fh + sy, fw, fh);
      }
      ctx.fill();
      const fur = P.dark ? [16, 18, 21] : [16, 15, 14], tex = P.dark ? [44, 49, 54] : [54, 50, 46], rim = P.dark ? [150, 160, 166] : [85, 80, 74];
      /* On dark water the fur catches a little light along its edge, or the paw would vanish. Toes under the surface are seen through the water. */
      const lit = P.dark ? mixC(fur, rim, 0.22) : fur;
      const wet = [fur, rim, lit].map(c => css(pack(mixC(c, P.water, 0.3)))), dry = [fur, rim, lit].map(c => css(pack(c)));
      const texC = css(pack(tex)), dot = css(pack(P.dot));
      /* cell edges on whole device pixels, so faint cells do not overlap into a grid */
      const px = (n, s) => Math.round(n * s * dpr) / dpr;
      ctx.font = `600 ${(fh * 0.8).toFixed(1)}px ${MONO}`;
      /* The plain fur goes down first in one fill; the cells around it and their glyphs follow. */
      const solid = new Path2D(), marks = [];
      for (let j = 0; j < nr; j++) for (let i = 0; i < nc; i++) {
        const v = g[j * nc + i], al = A[j * nc + i], under = al > wl, f = fade(al);
        if (v === -1 || f <= 0) continue;
        const x = px(i0 + i, fw), y = px(j0 + j, fh), w = px(i0 + i + 1, fw) - x, hh = px(j0 + j + 1, fh) - y;
        const [furC, rimC, litC] = under ? wet : dry;
        const ns = [at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)];
        const edge = ns.some(n => n < 0);
        if (v === -2) { ctx.globalAlpha = C[j * nc + i] * 1.3 * f * seen; ctx.fillStyle = furC; ctx.fillRect(x, y, w, hh); continue; }
        if (!under && f === 1 && !edge) solid.rect(x, y, w, hh);
        else { ctx.globalAlpha = (under ? 0.8 : 1) * f * seen; ctx.fillStyle = edge ? litC : furC; ctx.fillRect(x, y, w, hh); }
        const gx = x + fw / 2, gy = y + fh / 2;
        if (sink > 0 && Math.abs(al - wl) < halfU) marks.push(0.7, dot, "~", gx, gy);
        else if (edge) marks.push((P.dark ? 0.9 : 0.55) * f, rimC, ":", gx, gy);
        else if (!under && ((i0 + i) * 7 + (j0 + j) * 13) % 4 === 0) marks.push(0.45 * f, texC, (i0 + i + j0 + j) % 3 ? "#" : "%", gx, gy);
      }
      ctx.globalAlpha = seen; ctx.fillStyle = dry[0]; ctx.fill(solid);
      for (let m = 0; m < marks.length; m += 5) { ctx.globalAlpha = marks[m] * seen; ctx.fillStyle = marks[m + 1]; ctx.fillText(marks[m + 2], marks[m + 3], marks[m + 4]); }
      /* The four toes are only four faint arcs along the tip. */
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(0.8, 0.11 * k);
      ctx.strokeStyle = dry[1];
      for (const th of TOES) {
        const c = Math.cos(th), n = Math.sin(th), al = cb + ring * c * 1.08, sd = ring * n;
        const x = cx + ux * al * ka + vx * sd * ks, y = cy + uy * al * ka + vy * sd * ks, phi = Math.atan2(uy * c + vy * n, ux * c + vx * n);
        ctx.globalAlpha = (al + toe > wl ? 0.3 : 0.5) * seen;
        ctx.beginPath(); ctx.arc(x, y, toe * k, phi - 1.05, phi + 1.05); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    /* Drops in flight: the shadow parts from the drop and closes in again as it lands. */
    function rasterDrops() {
      for (const d of drops) {
        const u = (t - d.born) / d.dur;
        if (u < 0 || u >= 1) continue;
        const x = lerp(d.x0, d.x1, u), y = lerp(d.y0, d.y1, u), hh = 4 * u * (1 - u);
        const c = Math.floor(x / cw), r = Math.floor(y / ch), i = r * cols + c;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        if (!tileA[i] && !glyphA[i]) touched.push(i);
        glyphRGB[i] = pack(P.dot); glyphA[i] = 0.9; glyphCode[i] = (hh > 0.4 ? "o" : ".").charCodeAt(0);
        const sc = Math.round(hh * 3), sr = Math.round(hh * 2), si = (r + sr) * cols + (c + sc);
        if ((sc || sr) && r + sr < rows && c + sc < cols) shade[si] = Math.max(shade[si], P.dark ? 0.35 : 0.18);
      }
    }
    /* Rings spreading from the dip: the first drawn with glyphs along the ring, a fainter second one behind it. A landing drop or pellet makes one small ring. */
    function ringAt(px, py) {
      let best = null;
      for (const g of rings) {
        const age = t - g.born, life = 1 - age / (g.tiny ? 0.7 : g.small ? DROP_LIFE : RING_LIFE);
        if (life <= 0 || age < 0) continue;
        const dx = px - g.x, dy = py - g.y, d = Math.hypot(dx, dy);
        for (let j = 0; j < (g.small ? 1 : 2); j++) {
          const ag = age - j * 0.38;
          if (ag <= 0) continue;
          const R = (g.small ? ag * 34 + 4 : ag * 74 + 26) * g.k;
          if (Math.abs(d - R) > cw * 0.62) continue;
          const a = life ** 1.5 * (j ? 0.32 : g.tiny ? 0.28 : g.small ? 0.45 : 0.62);
          if (!best || a > best.a) best = { a, g: j || g.tiny ? "·" : lineGlyph(-dy, dx) };
        }
      }
      return best;
    }

    /* ── fish food ── */
    /* A handful tossed at (x, y): ten or so pellets spray out from the hand and land around it. */
    function feed(x, y) {
      if (!water(x, y)) return false;
      const k = K, seed = (Math.round(t * 1000) * 7919) ^ (Math.round(x) * 31 + Math.round(y) * 17);
      const n = 10 + Math.floor(h2(seed, 1) * 5);
      for (let j = 0; j < n; j++) {
        const a = h2(seed, j * 3 + 2) * Math.PI * 2, d = (12 + 46 * Math.sqrt(h2(seed, j * 3 + 3))) * k;
        const tx = clamp(x + Math.cos(a) * d, 6, vw - 6), ty = clamp(y + Math.sin(a) * d * 0.8, 6, vh - 6);
        const born = t + j * 0.012, dur = 0.28 + 0.2 * h2(seed, j * 3 + 4);
        food.push({ x0: x, y0: y, x: tx, y: ty, born, land: born + dur, seed: seed + j * 131, landed: false, eaten: -1, claim: 0 });
      }
      while (food.length > 90) food.shift();
      return true;
    }
    function stepFood(dt) {
      for (const p of food) {
        if (!p.landed && t >= p.land) { p.landed = true; rings.push({ x: p.x, y: p.y, born: t, k: K * 0.45, small: true, tiny: true }); stamp(p.x, p.y, 1, 0.25); }
        /* a floating pellet drifts a little on the surface */
        if (p.landed && p.eaten < 0) { p.x += Math.sin(t * 0.6 + p.seed) * 2.4 * K * dt; p.y += Math.cos(t * 0.45 + p.seed * 1.3) * 1.6 * K * dt; }
      }
      for (let j = food.length - 1; j >= 0; j--) {
        const p = food[j];
        if ((p.eaten >= 0 && t - p.eaten > 0.05) || (p.landed && t - p.land > FLOAT + SINKING)) food.splice(j, 1);
      }
      for (let j = bubbles.length - 1; j >= 0; j--) if (t - bubbles[j].born > 0.75) bubbles.splice(j, 1);
    }
    /* A pellet is a small warm-brown block with a lighter top edge and a shadow on the water. In the air it is bigger and its shadow lags behind. */
    function drawFood() {
      if (!food.length && !bubbles.length) return;
      const px = v => Math.round(v * dpr) / dpr;
      const body = css(pack(P.food)), top = css(pack(mixC(P.food, [255, 236, 200], 0.35))), shadow = P.dark ? "#000" : css(pack(mul(P.water, 0.5)));
      const pw = cw * 0.62, ph = ch * 0.48;
      for (const p of food) {
        if (t < p.born || p.eaten >= 0) continue;
        let x = p.x, y = p.y, hh = 0, a = 1, big = 1;
        if (!p.landed) { const u = clamp((t - p.born) / (p.land - p.born), 0, 1); x = lerp(p.x0, p.x, u); y = lerp(p.y0, p.y, u); hh = 4 * u * (1 - u); big = 1 + 0.9 * (1 - u); }
        else {
          const age = t - p.land;
          a = 1 - clamp((age - FLOAT) / SINKING, 0, 1);
          /* bobs as it lands */
          hh = age < 0.3 ? 0.25 * Math.sin(age / 0.3 * Math.PI) : 0;
        }
        const w = pw * big, h = ph * big, X = px(x - w / 2), Y = px(y - h / 2);
        ctx.globalAlpha = a * (P.dark ? 0.55 : 0.28);
        ctx.fillStyle = shadow;
        ctx.fillRect(px(X + pw * (0.7 + hh * 5)), px(Y + ph * (0.8 + hh * 4)), px(w), px(h));
        ctx.globalAlpha = a * (p.landed && t - p.land > FLOAT * 0.6 ? 0.85 : 1);
        ctx.fillStyle = body;
        ctx.fillRect(X, Y, px(w), px(h));
        ctx.fillStyle = top;
        ctx.fillRect(X, Y, px(w), px(Math.max(1, h * 0.34)));
      }
      /* a gulp leaves bubbles: o, then °, then a dot */
      if (bubbles.length) {
        ctx.font = `600 ${Math.round(ch * 0.74)}px ${MONO}`;
        ctx.fillStyle = css(pack(P.dot));
        for (const b of bubbles) {
          const u = (t - b.born) / 0.75;
          if (u < 0 || u >= 1) continue;
          ctx.globalAlpha = 0.85 * (1 - u * u);
          ctx.fillText(u < 0.35 ? "o" : u < 0.7 ? "°" : "·", b.x, b.y - u * ch * 0.8);
        }
      }
      ctx.globalAlpha = 1;
    }

    /* Moves the paws, drops, rings and food on by one step. */
    function stepPaws(dt) {
      for (const p of paws) {
        const a = t - p.born;
        if (!p.hit && a >= DIP) splash(p);
        if (a > PULL && a < FLICK - 0.02) stir(p, dt);
        if (!p.flung && a >= FLICK) fling(p);
        /* each shake throws a drop at its widest swing */
        if (p.drips < 3 && a >= SHAKE + 0.3 * (0.12 + p.drips * 0.25)) drip(p, (p.drips++ % 2 ? -1 : 1) * p.side);
      }
      for (let j = paws.length - 1; j >= 0; j--) if (t - paws[j].born >= END) paws.splice(j, 1);
      for (let j = drops.length - 1; j >= 0; j--) {
        const d = drops[j];
        if (t - d.born < d.dur) continue;
        rings.push({ x: d.x1, y: d.y1, born: t, k: d.k, small: true });
        stamp(d.x1, d.y1, 1, 0.5);
        drops.splice(j, 1);
      }
      for (let j = rings.length - 1; j >= 0; j--) if (t - rings[j].born >= (rings[j].tiny ? 0.7 : rings[j].small ? DROP_LIFE : RING_LIFE)) rings.splice(j, 1);
    }

    /* One fixed step of the whole pond. */
    function advance(dt) {
      t += dt;
      stepSky(dt);
      step(dt);
      stepPaws(dt);
      stepFood(dt);
    }

    /* ── colours ── */
    function colors() {
      const c = opts.palette();
      const dark = !!c.dark, water = rgb(c.water), accent = rgb(c.accent), light = rgb(c.koiLight), black = rgb(c.koiDark), ink = rgb(c.ink);
      P = {
        dark, water, ink,
        white: dark ? light : mixC(light, [255, 255, 255], 0.4),
        red: dark ? mixC(accent, [232, 92, 52], 0.5) : mixC(accent, [214, 72, 34], 0.7),
        black: dark ? mixC(black, [0, 0, 0], 0.2) : black,
        eye: dark ? [16, 15, 14] : [30, 27, 24],
        /* fins read by value, as grey sharks do: lighter than dark water, darker than light water */
        fin: dark ? mixC(light, water, 0.25) : mixC(water, black, 0.34),
        dot: dark ? light : ink,
        food: dark ? [206, 142, 74] : [150, 92, 40]
      };
      const scheme = (red, white, black) => ({ red, white, black, fin: dark ? mixC(white, water, 0.25) : P.fin });
      P.koi = {
        course: scheme(P.red, P.white, P.black),
        vermilion: scheme([214, 58, 36], [246, 242, 234], [24, 22, 20]),
        gold: scheme([230, 164, 52], [222, 228, 232], [98, 74, 42]),
        sakura: scheme([238, 132, 128], [250, 240, 228], [66, 60, 70])
      };
    }

    function render() {
      for (const i of touched) { tileA[i] = 0; glyphA[i] = 0; tintA[i] = 0; }
      touched.length = 0;
      shade.fill(0);
      /* Koi fade under the title and ease back in around it: a clear space for the clock, and the letters take on their colour. */
      const box = opts.dim ? opts.dim() : null, pad = cw * 8;
      const dimAt = box ? (x, y) => {
        const d = Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
        return 0.1 + 0.9 * sstep(0, pad, d);
      } : () => 1;
      const order = fish.filter(f => f.seen > 0).sort((a, b) => a.depth - b.depth);
      skyLight();
      for (const f of order) rasterize(f, dimAt);
      rasterDrops();
      rasterSky();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = css(pack(skyWater()));
      ctx.fillRect(0, 0, vw, vh);
      ctx.font = `600 ${Math.round(ch * 0.74)}px ${MONO}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const dot = css(pack(P.dot)), shadeFill = P.dark ? "#000" : css(pack(mul(P.water, 0.55)));
      /* cell edges land on whole device pixels, so tiles stay crisp at any zoom */
      const snap = v => Math.round(v * dpr) / dpr, gap = cw * 0.05, spark = 0.022;
      /*
       * Every rectangle first, then every glyph. Each glyph stays inside its own cell, so the picture is the
       * same as drawing cell by cell, but the GPU gets a few long runs of one kind instead of thousands of switches.
       */
      /* cloud shadows, in blocks of cells; an overcast sky dims the whole pond instead (skyWater) */
      const broken = cgw ? Math.min(1, sky.cloud * (1 - sstep(0.8, 1, sky.cloud)) * 2.5) : 0;
      if (broken > 0.02) {
        ctx.fillStyle = shadeFill;
        const bw = CB * cw, bh = CB * ch, k = (P.dark ? 0.11 : 0.07) * broken;
        /* a run of blocks with the same shade along a row is one rectangle */
        for (let gy = 0; gy < cgh; gy++) {
          const y0 = snap(gy * bh), y1 = snap((gy + 1) * bh);
          for (let gx = 0; gx < cgw;) {
            const q = Math.round(cloudGrid[gy * cgw + gx] * k * 100);
            let gx1 = gx + 1;
            while (gx1 < cgw && Math.round(cloudGrid[gy * cgw + gx1] * k * 100) === q) gx1++;
            if (q > 0) { ctx.globalAlpha = q / 100; ctx.fillRect(snap(gx * bw), y0, snap(gx1 * bw) - snap(gx * bw), y1 - y0); }
            gx = gx1;
          }
        }
      }
      ctx.fillStyle = shadeFill;
      for (let i = 0; i < shade.length; i++) {
        if (!(shade[i] > 0)) continue;
        const x = (i % cols) * cw, y = ((i / cols) | 0) * ch;
        ctx.globalAlpha = shade[i]; ctx.fillRect(snap(x), snap(y), snap(x + cw) - snap(x), snap(y + ch) - snap(y));
      }
      let fill = -1;
      for (const i of touched) {
        if (!(tileA[i] > 0)) continue;
        const x = (i % cols) * cw, y = ((i / cols) | 0) * ch, x0 = snap(x + gap), y0 = snap(y + gap);
        if (tileRGB[i] !== fill) { fill = tileRGB[i]; ctx.fillStyle = css(fill); }
        ctx.globalAlpha = tileA[i]; ctx.fillRect(x0, y0, snap(x + cw - gap) - x0, snap(y + ch - gap) - y0);
      }
      /* on a clear night the stars glint on the water */
      const starK = sky.night * (1 - sky.cloud) * (1 - sky.fog), sparkN = spark + 0.02 * starK;
      ctx.fillStyle = dot;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c, x = c * cw + cw / 2, y = r * ch + ch / 2;
          if (tileA[i] > 0 || glyphA[i] > 0) continue;
          if (wA[i] > 0) { ctx.globalAlpha = wA[i]; ctx.fillText(String.fromCharCode(wG[i]), x, y); continue; }
          if (rings.length) { const g = ringAt(x, y); if (g) { ctx.globalAlpha = g.a; ctx.fillText(g.g, x, y); continue; } }
          const w = wake[i];
          if (w > 0.03) { ctx.globalAlpha = Math.min(0.5, w * 1.2); ctx.fillText(w > 0.25 ? ":" : "·", x, y); continue; }
          /* the caustic net on open water, as faint strokes that drift and fold */
          const sun = sunK * (1 - 0.92 * cloudAt(c, r));
          if (sun > 0.04) {
            const cl = caus(x, y);
            if (cl > 0.8) { ctx.globalAlpha = (cl - 0.8) * 1.3 * sun; ctx.fillText(cl > 0.94 ? "~" : cl > 0.87 ? "-" : "·", x, y); continue; }
          }
          const h = h2(c, r);
          /* wind: patches of crests sweep downwind over the open water */
          if (windK > 0.02 && h > 0.6 && h < 0.6 + 0.1 * windK) {
            const n = noise((x - gustX) / 150, (y - gustY) / 110, 23), thr = 0.64 - 0.1 * windK;
            if (n > thr) { const g = Math.min(1, (n - thr) / (0.88 - thr)); ctx.globalAlpha = g * 0.3 * (1 - 0.4 * sky.night); ctx.fillText(g > 0.4 ? "~" : "-", x, y); continue; }
          }
          if (h < sparkN) { ctx.globalAlpha = (0.1 + 0.12 * (0.5 + 0.5 * Math.sin(t * 0.9 + h * 900))) * (1 + 0.9 * starK); ctx.fillText("·", x, y); }
        }
      }
      fill = -1;
      for (const i of touched) {
        if (!(glyphA[i] > 0) || glyphCode[i] === 32) continue;
        if (glyphRGB[i] !== fill) { fill = glyphRGB[i]; ctx.fillStyle = css(fill); }
        ctx.globalAlpha = glyphA[i]; ctx.fillText(String.fromCharCode(glyphCode[i]), (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2);
      }
      drawFood();
      for (const p of paws) drawPaw(p);
      ctx.globalAlpha = 1;
      if (ctx.flush) ctx.flush();
    }

    /* From scratch: the shoal, then a few seconds of swimming so it starts in natural curves. */
    function reset() {
      makeFish();
      paws.length = rings.length = drops.length = food.length = bubbles.length = 0;
      flakes.length = drips.length = 0;
      wake.fill(0); wakeTmp.fill(0);
      t = 0;
      const n = count();
      fish.forEach((f, i) => { f.seen = i < n ? 1 : 0; });
      for (let j = 0; j < 90; j++) { t += 1 / 30; step(1 / 30); }
      simT = 0; planAt = 0;
    }

    /* Film mode: the pond at film time T, stepped forward in fixed steps; the same T always gives the same frame. draw = false only steps it. */
    function seek(T, draw = true) {
      if (!fish.length || T < simT - 1e-6) reset();
      while (simT + STEP <= T + 1e-6) {
        simT += STEP;
        while (planAt < plan.length && plan[planAt].at <= simT + 1e-6) plan[planAt++].fn();
        advance(STEP);
      }
      if (draw) render();
    }

    /*
     * Live mode: one animation frame. The pond moves and draws at the display's
     * rate (60, 120, 144 Hz …). Drawing goes through the GPU (glCells), so a frame
     * costs only the pond's own work; if that ever takes more than about 60% of a
     * refresh, the pond draws every other refresh instead, evenly, rather than
     * stuttering.
     */
    let last = 0, drawn = 0, running = false, dirty = true, gapK = 16.7, costK = 0, renders = 0;
    function frame(now) {
      if (!running) return;
      requestAnimationFrame(frame);
      const gap = now - last, dt = Math.min(0.05, gap / 1000 || 0);
      last = now;
      if (gap > 0 && gap < 100) gapK += (gap - gapK) * 0.05;
      const moving = !paused && !reduce;
      if (moving && dt > 0) advance(dt);
      if (!moving && !dirty) return;
      /* every refresh while a frame takes well under one; if the machine can't keep up, every other refresh, evenly */
      if (now - drawn < (costK > gapK * 0.6 ? gapK * 1.5 : 2) && !dirty) return;
      dirty = false;
      drawn = now;
      const c0 = performance.now();
      render();
      costK += (performance.now() - c0 - costK) * 0.05;
      renders++;
    }

    return {
      size(w, h) { size(w, h); colors(); dirty = true; },
      colors() { colors(); dirty = true; },
      reset,
      start() {
        reset();
        running = true;
        requestAnimationFrame(now => { last = now; frame(now); });
      },
      stop() { running = false; },
      seek,
      /* film events: at simulation time `at`, run fn */
      at(at, fn) { plan.push({ at, fn }); plan.sort((a, b) => a.at - b.at); return this; },
      paw: (x, y) => poke(x, y),
      /* A ripple where you touch the water: rings spread, and the koi close by start away, then come back to look. */
      ripple(x, y) {
        if (!water(x, y)) return false;
        rings.push({ x, y, born: t, k: K * 0.8 });
        stamp(x, y, 2, 0.7);
        const reach = 170 * K;
        for (const f of fish) {
          const hx = headX(f), hy = headY(f), d = Math.hypot(hx - x, hy - y);
          if (d < reach) { f.flee = Math.max(f.flee, 0.75 * (1 - d / reach * 0.7)); f.fleeA = Math.atan2(hy - y, hx - x); }
        }
        dirty = true;
        return true;
      },
      feed: (x, y) => feed(x, y),
      pause(v) { paused = v === undefined ? !paused : !!v; dirty = true; return paused; },
      get paused() { return paused; },
      /* for ?fps=1: frames drawn so far, what one costs (ms), and the screen's refresh interval (ms) */
      get stats() { return { renders, cost: costK, refresh: gapK, gpu: !!ctx.flush }; },
      get time() { return t; },
      /* for tests: the koi and the food */
      get fish() { return fish; },
      get food() { return food; },
      render() { render(); },
      /* The colour of the koi under canvas point (x, y), as [r, g, b, weight], or null: the title takes it on. */
      tint(x, y) {
        const c = Math.floor(x / cw), r = Math.floor(y / ch), i = r * cols + c;
        if (c < 0 || r < 0 || c >= cols || r >= rows || !(tintA[i] > 0)) return null;
        const n = tintRGB[i];
        return [n >> 16, (n >> 8) & 255, n & 255, tintA[i]];
      },
      /* The water's light at canvas point (x, y), 0 to 1, from the caustic net: the title catches it as it plays over. */
      light: (x, y) => caus(x, y) * (0.35 + 0.65 * sunK),
      /* The sky: { rain, drizzle, snow, cloud, night, fog, storm (0 to 1), wind (mph), windFrom (degrees) }. The first one is there at once, later ones ease in over a few seconds. */
      weather(s, now) { skyTo = { ...SKY0, ...s }; if (now || reduce || !skySet) { sky = { ...skyTo }; skySet = true; } dirty = true; },
      get sky() { return { ...skyTo }; }
    };
  }

  /*
   * A word drawn in character cells like the koi. The letters are sampled from
   * the real font outline. A cell the outline crosses gets a stroke along it
   * (| / - \, from the coverage gradient), moved a little toward the ink, so
   * the contour reads as one clean line; a cell inside a stroke is a tile with
   * a glyph pressed into it in the water's colour. A koi passing under takes
   * the cell to its colour, and where the caustic net crosses, the cell
   * brightens. A blurred glow canvas behind the letters carries that light.
   * New cells flicker through random glyphs and settle into the word; when the
   * text changes (the clock ticks), only the cells that changed flicker.
   *
   * spec() returns { text, font, cw, ch, maxW, tone, edge, glow }. look.tint(x, y)
   * and look.light(x, y) give the koi colour and the water's light under a cell
   * centre, in viewport pixels (a full-window pond's own). The colours are read from CSS:
   * --title-from, --title-to (left to right), --title-glow and --pond.
   */
  function AsciiMark(canvas, spec, look = {}) {
    const ctx = glCells(canvas) || canvas.getContext("2d");
    const NOISE = "/\\|=+*%#@", EDGE = " |/-\\";
    let cols = 0, rows = 0, cw = 6, ch = 8, cov = null, born = null, edge = null, ex = null, ey = null;
    let tone = 1, glowK = 0, ready = false, dpr = 1, glow = null, gctx = null, gimg = null;
    /* the glyphs of one frame, drawn after the tiles */
    const Q = { g: [], x: [], y: [], a: [], f: [] };
    async function build(now) {
      const o = spec();
      cw = o.cw; ch = o.ch; tone = o.tone || 1; glowK = o.glow || 0;
      try { await document.fonts.load(o.font, o.text); } catch (e) { /* draw with the fallback font */ }
      const m = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      m.font = o.font;
      const met = m.measureText(o.text);
      const asc = Math.ceil(met.actualBoundingBoxAscent), desc = Math.ceil(met.actualBoundingBoxDescent);
      const left = Math.ceil(met.actualBoundingBoxLeft), tw = Math.ceil(met.actualBoundingBoxLeft + met.actualBoundingBoxRight);
      const pad = Math.ceil(asc * 0.05), mw = Math.max(1, tw + pad * 2), mh = Math.max(1, asc + desc + pad * 2);
      m.canvas.width = mw; m.canvas.height = mh;
      m.font = o.font; m.fillStyle = "#000";
      m.fillText(o.text, pad + left, pad + asc);
      const data = m.getImageData(0, 0, mw, mh).data;
      const s = Math.min(1, o.maxW / mw);
      const nc = Math.ceil(mw * s / cw), nr = Math.ceil(mh * s / ch);
      /* a window with no width yet (a hidden or prerendered tab): nothing to draw until it is resized */
      if (!nc || !nr) { ready = false; return; }
      const next = new Float32Array(nc * nr);
      for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
        let a = 0;
        for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
          const px = Math.min(mw - 1, ((c + (i + 0.5) / 3) * cw / s) | 0), py = Math.min(mh - 1, ((r + (j + 0.5) / 3) * ch / s) | 0);
          a += data[(py * mw + px) * 4 + 3];
        }
        next[r * nc + c] = a / (9 * 255);
      }
      /* the same grid: only cells that changed settle again */
      if (cov && nc === cols && nr === rows) for (let i = 0; i < next.length; i++) { if (Math.abs(next[i] - cov[i]) > 0.08) born[i] = now; }
      else born = new Float32Array(nc * nr).fill(now);
      cols = nc; rows = nr; cov = next;
      /* the outline: a stroke by the direction of the coverage gradient; thin serif hairlines keep theirs down to 6 % coverage */
      edge = null;
      if (o.edge) {
        edge = new Uint8Array(cols * rows); ex = new Float32Array(cols * rows); ey = new Float32Array(cols * rows);
        const at = (c, r) => c < 0 || r < 0 || c >= cols || r >= rows ? 0 : cov[r * cols + c];
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const i = r * cols + c, v = cov[i];
          if (v < 0.06 || v >= 0.62) continue;
          const gx = (at(c + 1, r - 1) + 2 * at(c + 1, r) + at(c + 1, r + 1) - at(c - 1, r - 1) - 2 * at(c - 1, r) - at(c - 1, r + 1)) / cw;
          const gy = (at(c - 1, r + 1) + 2 * at(c, r + 1) + at(c + 1, r + 1) - at(c - 1, r - 1) - 2 * at(c, r - 1) - at(c + 1, r - 1)) / ch;
          const n = Math.hypot(gx, gy);
          if (n * Math.min(cw, ch) < 0.4) continue;
          let a = Math.atan2(gy, gx) * 180 / Math.PI;
          if (a < 0) a += 180;
          edge[i] = a < 22.5 || a >= 157.5 ? 1 : a < 67.5 ? 2 : a < 112.5 ? 3 : 4;
          const k = (0.5 - v) * 0.7;
          ex[i] = gx / n * k * cw; ey[i] = gy / n * k * ch;
        }
      }
      dpr = Math.min(4, global.devicePixelRatio || 1);
      canvas.width = Math.round(cols * cw * dpr); canvas.height = Math.round(rows * ch * dpr);
      canvas.style.width = cols * cw + "px"; canvas.style.height = rows * ch + "px";
      /* the glow: one pixel per cell in the light the letters take on; CSS blurs it behind them */
      if (glowK && !glow) {
        glow = document.createElement("canvas");
        glow.className = "mark-glow"; glow.setAttribute("aria-hidden", "true");
        canvas.before(glow);
        gctx = glow.getContext("2d");
      }
      if (glow) {
        glow.width = cols; glow.height = rows; gimg = gctx.createImageData(cols, rows);
        glow.style.width = cols * cw + "px"; glow.style.height = rows * ch + "px";
      }
      ready = true;
    }
    function draw(now) {
      if (!ready) return;
      const cs = getComputedStyle(canvas);
      const from = rgb(cs.getPropertyValue("--title-from")), to = rgb(cs.getPropertyValue("--title-to")), water = cs.getPropertyValue("--pond").trim();
      const gv = parseFloat(cs.getPropertyValue("--title-glow")), gk = glowK * (isNaN(gv) ? 1 : gv);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cols * cw, rows * ch);
      if (glow) { glow.style.left = canvas.offsetLeft + "px"; glow.style.top = canvas.offsetTop + "px"; gimg.data.fill(0); }
      ctx.font = `700 ${(ch * (edge ? 0.95 : 1.1)).toFixed(1)}px ${MONO}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const snap = v => Math.round(v * dpr) / dpr, gap = cw * 0.06, G = gimg ? gimg.data : null, tick = Math.floor(now * 24);
      /* where each cell is on screen, to find the koi under it */
      const box = look.tint || look.light ? canvas.getBoundingClientRect() : null, sx = box ? box.width / (cols * cw) : 1, sy = box ? box.height / (rows * ch) : 1;
      /* the tiles are drawn as they come and the glyphs queued, then drawn in one run (as in the pond) */
      let n = 0;
      const glyph = (g, x, y, a, fill) => { Q.g[n] = g; Q.x[n] = x; Q.y[n] = y; Q.a[n] = a; Q.f[n] = fill; n++; };
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = r * cols + c, v = cov[i], e = edge ? edge[i] : 0;
        if (v < (e ? 0.06 : 0.12)) continue;
        const h = h2(c + 7, r + 3), x = c / cols, age = now - born[i], settle = 0.15 + h * 0.95;
        if (age < 0) continue;
        if (age < settle) {
          glyph(NOISE[(h2(i, tick) * NOISE.length) | 0], c * cw + cw / 2, r * ch + ch / 2, tone * (0.25 + 0.5 * (age / settle)), css(pack(mixC(from, to, x))));
          continue;
        }
        const px = box ? box.left + (c + 0.5) * cw * sx : 0, py = box ? box.top + (r + 0.5) * ch * sy : 0;
        const k = look.tint && look.tint(px, py), w = k ? Math.min(1, k[3] * 1.15) : 0;
        const l = look.light ? clamp((look.light(px, py) - 0.72) / 0.28, 0, 1) : 0, L = l * l * (3 - 2 * l);
        const col = from.map((f, j) => {
          let n = f + (to[j] - f) * x;
          if (k) n += (k[j] - n) * w;
          return n + (255 - n) * 0.45 * L;
        });
        const fill = css(pack(col));
        if (e) glyph(EDGE[e], c * cw + cw / 2 + ex[i], r * ch + ch / 2 + ey[i], tone * Math.min(1, 0.5 + v + 0.3 * L), fill);
        else if (v >= 0.62) {
          /* inside a stroke: a tile like the koi's, with a glyph pressed into it in the water's colour */
          ctx.globalAlpha = tone * (0.68 + 0.27 * Math.min(1, (v - 0.62) / 0.3) + 0.1 * w + 0.12 * L);
          ctx.fillStyle = fill;
          const x0 = snap(c * cw + gap), y0 = snap(r * ch + gap);
          ctx.fillRect(x0, y0, snap((c + 1) * cw - gap) - x0, snap((r + 1) * ch - gap) - y0);
          glyph(v > 0.9 ? (h < 0.5 ? "#" : "@") : "%", c * cw + cw / 2, r * ch + ch / 2, 0.24 * tone, water);
        } else glyph(v > 0.32 ? "+" : ":", c * cw + cw / 2, r * ch + ch / 2, tone * 0.85, fill);
        if (G) {
          const q = i * 4, ga = gk * tone * (v >= 0.62 ? 1 : v) * (0.16 + 0.6 * w + 0.32 * L);
          G[q] = col[0]; G[q + 1] = col[1]; G[q + 2] = col[2]; G[q + 3] = Math.min(255, ga * 255);
        }
      }
      let fill = "";
      for (let j = 0; j < n; j++) {
        if (Q.f[j] !== fill) { fill = Q.f[j]; ctx.fillStyle = fill; }
        ctx.globalAlpha = Q.a[j]; ctx.fillText(Q.g[j], Q.x[j], Q.y[j]);
      }
      ctx.globalAlpha = 1;
      if (ctx.flush) ctx.flush();
      if (glow) gctx.putImageData(gimg, 0, 0);
    }
    return { build, draw, get glow() { return glow; }, get size() { return { w: cols * cw, h: rows * ch }; } };
  }

  global.AsciiKoi = { createPond, AsciiMark, seeded };
})(typeof window !== "undefined" ? window : globalThis);
