/* Ported from the team site's homepage hero: voronoiConfig.js + voronoiEngine.js,
   byte-identical engine, module syntax stripped for the concatenated bundle. */
'use strict';

const VORONOI_P = {
  // Defaults below are the tuned preset (high-res, large open cells, thick membranes).
  seed: 911737,
  simH: 480, // internal resolution; higher = smoother upscale (no blur needed)
  sites: 80, // Voronoi cells — fewer = larger/more open cells
  sigma: 2.7, // membrane thickness
  border: 0.0016, // glyph outline width (× device px): paints over the AA fringe at the
  // letter edge for a clean, crisp border (black on the dark theme, white on the light)

  agentDensity: 0.285, // living "swimming" slime agents inside the letters
  highways: 26,
  warp1: 2.6,
  warp2: 2.1,
  speed: 1.15,
  deposit: 2.2,
  sensorDist: 4.4,
  sensorAngle: 0.62,
  turn: 0.43,
  decay: 0.974, // higher = worm trails persist ("keep") instead of fading fast
  blur: 0.3, // slime diffusion (sim physics — not an image blur)
  scaffold: 1.14,
  exposure: 1.15,
  edgeLo: 0.4, // field value where the membrane edge starts (cover = 0)
  edgeHi: 0.74, // field value where the membrane is solid (cover = 1)
  sharpen: 8, // display-resolution contrast that turns the soft ramp back into a crisp edge
  distanceField: true, // threshold the ~linear wall distance (smoother) vs the Gaussian
  lineHalf: 1.3, // wall distance at the visible vein edge — i.e. line weight (finer)
  band: 1.4, // width of the soft AA ramp; the contrast pass re-crisps it
  trailBoost: 0.045, // how much slime density thickens/extends the veins
  bloom: 0,
  rim: 0.2,
  mouseFeed: 1.6, // cursor feeds (thickens veins) + attracts the slime
  invert: true, // light theme: white page, black letter fill, white strands + border
};

/**
 * VoronoiTitle — a Physarum / Voronoi membrane web that is genuinely *bounded by
 * the letters*. The glyph outline is treated as an extra Voronoi feature (a wall):
 * the cells tessellate against it, so the letter shape becomes the outer border of
 * the web. That border line is never drawn — it is invisible — but the interior
 * membranes meet it, and those meetings are the visible "delta". The edge itself is
 * crisp because the field is clipped by the font outline rasterised at full device
 * resolution (vector-accurate).
 *
 * Smoothness comes from distance-field-style anti-aliasing, NOT a blur: renderField
 * emits a smooth scalar ramp (no per-pixel threshold), composite() bicubically upscales
 * it and then snaps the membrane edge with a steep `contrast()` curve applied at *display*
 * resolution. The edge is therefore resolved per device pixel — smooth curves with crisp,
 * ~1px anti-aliased edges and no visible sim grid (the old per-pixel `pow`/crush baked a
 * near-binary image at sim resolution, which is what made the strands look voxelated).
 * No blur filter is used anywhere.
 *
 * Highlights map to neutral #fff.
 */

const SIM_W_MAX = 1280;
const AG_MAX = 30000;
const SPARK_MAX = 800; // temporary "growth" agents spawned at the cursor
const SPARK_LIFE = 80; // frames a spark lives → how long a growth persists
const SPARK_RATE = 6; // sparks spawned per frame at full pointer influence
// Sim steps baked before the hero's first paint.
//
// This used to be 80, which cost ~320ms of blocked main thread — and bought nothing the
// visitor could see happen. generateScaffold() has already written the finished Voronoi
// structure into `trail`; the warm-up only grows the slime trails riding on top of it. Nor
// was 80 a settled state: the trail field is still climbing there (mean ≈ 0.9 → 6.4 → 17.6
// → 23.6 across steps 1 → 10 → 40 → 80, and rising). The render loop advances the sim with
// the very same stepAgents()+diffuse() pair, twice a frame, so it simply keeps walking that
// same curve — leaving the field to develop on screen costs nothing and looks like the web
// coming alive. These few steps just take the bare edge off a pristine field.
const WARM_EAGER = 16;
// Reduced motion paints one frame and then stops, so that frame has to be the developed
// one — there is no loop to carry it forward.
const WARM_FROZEN = 160;
// The letters cover only ~22% of the sim grid, so diffusing the whole rectangle spent most
// of its time averaging zeros. Diffusion is restricted to the glyphs plus this margin (sim
// px), which is wider than the agents' sensor reach — so every value they can sample is
// still simulated. Further out the field is orders of magnitude below anything visible, and
// clipped away by the glyph mask regardless.
const DIFFUSE_MARGIN = 8;
const HPAD = 0.05;
const VPAD = 0.14;
const FONT = '700 100px "Playfair Display", Georgia, serif';
// The exact face the canvas asks for. Nothing in the DOM renders Playfair 700, and
// setting ctx.font never triggers a webfont fetch — so this face has to be requested
// by hand or the browser may never load it at all. See the start-up block below.

// The engine deliberately has no DOM or worker dependencies. Both the main-thread fallback
// and the OffscreenCanvas worker run this exact source, which keeps the seeded simulation,
// paint order, control updates, and pointer response deterministic across both paths.

const mulberry32 = (a) => () => {
  let t = (a += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => {
  x = clamp((x - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};
const smoothstepBounded = (a, b, x) => {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const q = (x - a) / (b - a);
  return q * q * (3 - 2 * q);
};

function createVoronoiEngine({
  canvas,
  createCanvas,
  text = 'CUPI',
  cssWidth,
  dpr,
  reduced,
  params: P,
  onReady,
}) {
    if (!canvas || typeof createCanvas !== 'function' || !P) {
      throw new TypeError('A canvas, canvas factory, and parameter object are required.');
    }
    let layoutCssWidth = cssWidth;
    let layoutDpr = dpr;

    const ctx = canvas.getContext('2d', { alpha: true });
    const buffer = createCanvas();
    const bctx = buffer.getContext('2d', { alpha: false, willReadFrequently: false });
    const maskCanvas = createCanvas();
    const mctx = maskCanvas.getContext('2d');
    // Device-resolution scratch: the smooth ramp is bicubically upscaled into this,
    // then drawn 1:1 onto the visible canvas through a steep contrast() filter so the
    // membrane edge is resolved (anti-aliased) at display resolution, not sim resolution.
    const upCanvas = createCanvas();
    const upctx = upCanvas.getContext('2d', { alpha: true });
    // Scratch holding the clean field (no border) — used to occlude the P's stem underpass.
    const fieldCanvas = createCanvas();
    const fieldCtx = fieldCanvas.getContext('2d', { alpha: true });

    let disposed = false;
    let started = false;
    const frozen = reduced;
    let dirty = false;

    let rand = mulberry32(P.seed);

    let simW = 0;
    let simH = 0;
    let N = 0;
    let trail;
    let next;
    let scaffold;
    let maskSim;
    let ax;
    let ay;
    let aa;
    let AG = 0;
    // temporary "growth" sparks spawned where the cursor goes
    let sx;
    let sy;
    let sga;
    let slife;
    let sparkHead = 0;
    let image;
    let pixels;
    let backgroundOut = Number.NaN;
    // Row-ordered [startIdx, endIdx] index pairs: the pixels diffuse() has to visit.
    let runs = null;
    let runCount = 0;
    // renderField() needs the diffused area plus one pixel for its neighbour-gradient rim.
    let renderRuns = null;
    let renderRunCount = 0;

    const mouse = { x: 0, y: 0, active: false, inf: 0 };

    let dpW = 0;
    let dpH = 0;

    let uw = 0;
    let uAsc = 0.7;
    let uDesc = 0;
    let uh = 0.7;
    let boxAspect = 3.2;

    function measureNatural() {
      const mc = createCanvas().getContext('2d');
      mc.font = FONT;
      const m = mc.measureText(text);
      uw = m.width / 100;
      uAsc = (m.actualBoundingBoxAscent || 70) / 100;
      uDesc = (m.actualBoundingBoxDescent || 0) / 100;
      uh = uAsc + uDesc;
      boxAspect = (uw / uh) * ((1 - 2 * VPAD) / (1 - 2 * HPAD));
    }

    // Rasterise the real font outline (vector-accurate at whatever resolution).
    function drawTitleInto(c, w, h) {
      const fontPx = Math.min((w * (1 - 2 * HPAD)) / uw, (h * (1 - 2 * VPAD)) / uh);
      c.clearRect(0, 0, w, h);
      c.fillStyle = '#fff';
      c.textAlign = 'center';
      c.textBaseline = 'alphabetic';
      c.font = `700 ${fontPx}px "Playfair Display", Georgia, serif`;
      const baselineY = h / 2 + ((uAsc - uDesc) * fontPx) / 2;
      c.fillText(text, w / 2, baselineY);
    }

    // Crisp (un-blurred) stroke of the glyph outline — the thin black border.
    function drawTitleStroke(c, w, h, lineW, style) {
      const fontPx = Math.min((w * (1 - 2 * HPAD)) / uw, (h * (1 - 2 * VPAD)) / uh);
      c.textAlign = 'center';
      c.textBaseline = 'alphabetic';
      c.font = `700 ${fontPx}px "Playfair Display", Georgia, serif`;
      c.lineJoin = 'round';
      c.lineWidth = lineW;
      c.strokeStyle = style;
      const baselineY = h / 2 + ((uAsc - uDesc) * fontPx) / 2;
      c.strokeText(text, w / 2, baselineY);
    }

    function buildSim() {
      simH = Math.round(P.simH);
      simW = Math.min(SIM_W_MAX, Math.round(simH * boxAspect));
      N = simW * simH;

      buffer.width = simW;
      buffer.height = simH;
      image = bctx.createImageData(simW, simH);
      pixels = image.data;
      backgroundOut = Number.NaN;

      trail = new Float32Array(N);
      next = new Float32Array(N);
      scaffold = new Float32Array(N);
      maskSim = new Uint8Array(N);

      const sc = createCanvas();
      sc.width = simW;
      sc.height = simH;
      const sctx = sc.getContext('2d');
      drawTitleInto(sctx, simW, simH);
      const md = sctx.getImageData(0, 0, simW, simH).data;
      for (let i = 0; i < N; i++) maskSim[i] = md[i * 4 + 3] > 128 ? 1 : 0;

      buildDiffuseRuns();

      rand = mulberry32(P.seed >>> 0);
      generateScaffold();

      AG = Math.min(AG_MAX, Math.round(N * P.agentDensity));
      ax = new Float32Array(AG);
      ay = new Float32Array(AG);
      aa = new Float32Array(AG);
      seedAgents();

      sx = new Float32Array(SPARK_MAX);
      sy = new Float32Array(SPARK_MAX);
      sga = new Float32Array(SPARK_MAX);
      slife = new Float32Array(SPARK_MAX); // 0 = dead slot
      sparkHead = 0;

      const warm = frozen ? WARM_FROZEN : WARM_EAGER;
      for (let i = 0; i < warm; i++) {
        stepAgents();
        diffuse();
      }
    }

    // Run-length encode the glyph mask dilated by DIFFUSE_MARGIN, as row-ordered index
    // pairs. Dilating separably — a sliding count along each row, then down the columns —
    // keeps it one linear pass per axis, and emitting runs row by row leaves diffuse()'s
    // inner loop walking memory sequentially exactly as the old full-grid loop did.
    //
    // Safe because every writer of `trail` (generateScaffold, stepAgents, stepSparks,
    // applyMouseFood) gates on maskSim, so no write can land outside these runs. Both field
    // buffers start zeroed, so the pixels the runs skip hold zero and keep holding it across
    // the buffer swap.
    function buildDilatedRuns(m) {
      const win = 2 * m + 1;
      const rowDil = new Uint8Array(N);
      for (let y = 0; y < simH; y++) {
        const row = y * simW;
        let count = 0;
        for (let x = 0; x < simW + m; x++) {
          if (x < simW && maskSim[row + x]) count++;
          const gone = x - win;
          if (gone >= 0 && maskSim[row + gone]) count--;
          const c = x - m;
          if (c >= 0 && c < simW && count > 0) rowDil[row + c] = 1;
        }
      }

      const starts = [];
      const ends = [];
      const colCount = new Int32Array(simW);
      for (let y = 0; y < simH + m; y++) {
        if (y < simH) {
          const row = y * simW;
          for (let x = 0; x < simW; x++) if (rowDil[row + x]) colCount[x]++;
        }
        const gone = y - win;
        if (gone >= 0) {
          const row = gone * simW;
          for (let x = 0; x < simW; x++) if (rowDil[row + x]) colCount[x]--;
        }
        const cy = y - m;
        // diffuse() only ever touched the interior, so the border ring stays out of the runs.
        if (cy < 1 || cy >= simH - 1) continue;
        const row = cy * simW;
        let x = 1;
        while (x < simW - 1) {
          while (x < simW - 1 && colCount[x] === 0) x++;
          if (x >= simW - 1) break;
          const s = x;
          while (x < simW - 1 && colCount[x] > 0) x++;
          starts.push(row + s);
          ends.push(row + x - 1);
        }
      }

      const result = new Int32Array(starts.length * 2);
      for (let r = 0; r < starts.length; r++) {
        result[r * 2] = starts[r];
        result[r * 2 + 1] = ends[r];
      }
      return result;
    }

    function buildDiffuseRuns() {
      runs = buildDilatedRuns(DIFFUSE_MARGIN);
      runCount = runs.length / 2;
      renderRuns = buildDilatedRuns(DIFFUSE_MARGIN + 1);
      renderRunCount = renderRuns.length / 2;
    }

    // Distance (sim px) from each inside pixel to the glyph outline (0 at/outside it).
    // Two-pass chamfer transform — used to mirror sites across the outline.
    function computeBoundaryDist() {
      const D = new Float32Array(N);
      const INF = 1e9;
      for (let i = 0; i < N; i++) D[i] = maskSim[i] === 0 ? 0 : INF;
      const a = 1;
      const b = 1.41421356;
      for (let y = 0; y < simH; y++) {
        for (let x = 0; x < simW; x++) {
          const i = y * simW + x;
          let dd = D[i];
          if (x > 0) { const v = D[i - 1] + a; if (v < dd) dd = v; }
          if (y > 0) { const v = D[i - simW] + a; if (v < dd) dd = v; }
          if (x > 0 && y > 0) { const v = D[i - simW - 1] + b; if (v < dd) dd = v; }
          if (x < simW - 1 && y > 0) { const v = D[i - simW + 1] + b; if (v < dd) dd = v; }
          D[i] = dd;
        }
      }
      for (let y = simH - 1; y >= 0; y--) {
        for (let x = simW - 1; x >= 0; x--) {
          const i = y * simW + x;
          let dd = D[i];
          if (x < simW - 1) { const v = D[i + 1] + a; if (v < dd) dd = v; }
          if (y < simH - 1) { const v = D[i + simW] + a; if (v < dd) dd = v; }
          if (x < simW - 1 && y < simH - 1) { const v = D[i + simW + 1] + b; if (v < dd) dd = v; }
          if (x > 0 && y < simH - 1) { const v = D[i + simW - 1] + b; if (v < dd) dd = v; }
          D[i] = dd;
        }
      }
      return D;
    }

    function generateScaffold() {
      scaffold.fill(0);
      trail.fill(0);
      next.fill(0);

      // sites only inside the letters → the tessellation lives in the glyphs
      const sites = [];
      let placed = 0;
      let guard = 0;
      const target = Math.round(P.sites);
      while (placed < target && guard < target * 90) {
        guard++;
        const x = rand() * simW;
        const y = rand() * simH;
        if (maskSim[(y | 0) * simW + (x | 0)] === 1) {
          sites.push({ x, y, w: 0.7 + rand() * 0.5 });
          placed++;
        }
      }

      // Reflective boundary: mirror each near-edge site across the glyph outline.
      // The Voronoi of sites ∪ mirrors has cell walls lying exactly on the outline,
      // so the border becomes a genuine Voronoi wall — interior walls fan into it at
      // natural junctions instead of being clipped. The mirror direction is the
      // gradient of the distance field (the outline normal).
      const bd = computeBoundaryDist();
      const allSites = sites.slice();
      const MIRROR_MAXBD = simH * 0.22;
      for (const s of sites) {
        const xi = clamp(s.x | 0, 2, simW - 3);
        const yi = clamp(s.y | 0, 2, simH - 3);
        const bA = bd[yi * simW + xi];
        if (bA <= 0.5 || bA > MIRROR_MAXBD) continue;
        const gx = bd[yi * simW + xi + 2] - bd[yi * simW + xi - 2];
        const gy = bd[(yi + 2) * simW + xi] - bd[(yi - 2) * simW + xi];
        const len = Math.hypot(gx, gy);
        if (len < 1e-3) continue;
        const nx = gx / len; // inward normal (toward larger distance)
        const ny = gy / len;
        allSites.push({ x: s.x - 2 * bA * nx, y: s.y - 2 * bA * ny, w: s.w });
      }

      // Flatten the sites for the nearest-two search below. That inner loop runs once per
      // site per masked pixel — order 20M iterations — so its per-step overhead *is* the
      // cost: an indexed walk over three typed arrays replaces an iterator over objects,
      // and each site's w² is hoisted out of the pixel loop. Float64Array, not Float32Array,
      // so the arithmetic stays bit-identical to the object version and the web is unchanged.
      const M = allSites.length;
      const siteX = new Float64Array(M);
      const siteY = new Float64Array(M);
      const siteW2 = new Float64Array(M);
      for (let k = 0; k < M; k++) {
        const s = allSites[k];
        siteX[k] = s.x;
        siteY[k] = s.y;
        siteW2[k] = s.w * s.w;
      }

      const WARP1 = P.warp1;
      const WARP2 = P.warp2;
      const SIGMA = P.sigma;
      const fadeEnd = simH * 0.06;

      for (let y = 0, idx = 0; y < simH; y++) {
        for (let x = 0; x < simW; x++, idx++) {
          if (maskSim[idx] !== 1) continue; // web only inside the letters
          // fade the organic warp to zero at the edge so the boundary wall stays
          // aligned with the crisp clip (and the mirror geometry stays exact there)
          const wf = smoothstep(0, fadeEnd, bd[idx]);
          const wx =
            x + (WARP1 * Math.sin(y * 0.033 + Math.sin(x * 0.011) * 2.0) + WARP2 * Math.sin((x + y) * 0.021)) * wf;
          const wy =
            y + (WARP1 * Math.sin(x * 0.027 + Math.cos(y * 0.015) * 2.0) + WARP2 * Math.sin((x - y) * 0.019)) * wf;
          let d1 = 1e9;
          let d2 = 1e9;
          for (let k = 0; k < M; k++) {
            const dx = wx - siteX[k];
            const dy = wy - siteY[k];
            const d = (dx * dx + dy * dy) / siteW2[k];
            if (d < d1) {
              d2 = d1;
              d1 = d;
            } else if (d < d2) {
              d2 = d;
            }
          }
          // membrane between the two nearest features (real sites OR a site's mirror).
          // A site|mirror wall lies on the outline → the border is part of the math,
          // and interior walls fan into it naturally.
          const gap = Math.sqrt(d2) - Math.sqrt(d1);
          scaffold[idx] = Math.exp(-(gap * gap) / (2 * SIGMA));
          trail[idx] = scaffold[idx] * 1.05;
        }
      }

      // a few drifting slime highways inside the letters → living, not static
      const highways = Math.round(P.highways);
      for (let k = 0; k < highways; k++) {
        let x = rand() * simW;
        let y = rand() * simH;
        let tries = 0;
        while (maskSim[(y | 0) * simW + (x | 0)] !== 1 && tries < 40) {
          x = rand() * simW;
          y = rand() * simH;
          tries++;
        }
        let a = rand() * Math.PI * 2;
        const steps = 70 + rand() * 150;
        for (let j = 0; j < steps; j++) {
          x += Math.cos(a) * 1.7;
          y += Math.sin(a) * 1.7;
          a += (rand() - 0.5) * 0.42 + Math.sin(j * 0.07 + k) * 0.025;
          if (x < 2 || x > simW - 3 || y < 2 || y > simH - 3) break;
          const ix = x | 0;
          const iy = y | 0;
          if (maskSim[iy * simW + ix] !== 1) continue;
          for (let yy = -1; yy <= 1; yy++) {
            for (let xx = -1; xx <= 1; xx++) {
              const d = xx * xx + yy * yy;
              if (d > 2) continue;
              const pix = (iy + yy) * simW + ix + xx;
              if (maskSim[pix] !== 1) continue;
              const add = (1 - d / 3) * 0.16;
              trail[pix] += add;
              scaffold[pix] += add * 0.5;
            }
          }
        }
      }
    }

    function seedAgents() {
      for (let i = 0; i < AG; i++) {
        let x = rand() * simW;
        let y = rand() * simH;
        let tries = 0;
        while (maskSim[(y | 0) * simW + (x | 0)] !== 1 && tries < 24) {
          x = rand() * simW;
          y = rand() * simH;
          tries++;
        }
        ax[i] = clamp(x, 1, simW - 2);
        ay[i] = clamp(y, 1, simH - 2);
        aa[i] = rand() * Math.PI * 2;
      }
    }

    function sample(f, x, y) {
      x = x < 0 ? x + simW : x >= simW ? x - simW : x;
      y = y < 0 ? y + simH : y >= simH ? y - simH : y;
      return f[(y | 0) * simW + (x | 0)];
    }

    function applyMouseFood() {
      if (mouse.inf <= 0.002 || P.mouseFeed <= 0) return;
      const R = Math.max(2, simH * 0.09);
      const R2 = R * R;
      const sig2 = (R * 0.62) * (R * 0.62);
      const F = P.mouseFeed * 1.3 * mouse.inf;
      const x0 = Math.max(1, (mouse.x - R) | 0);
      const x1 = Math.min(simW - 2, (mouse.x + R) | 0);
      const y0 = Math.max(1, (mouse.y - R) | 0);
      const y1 = Math.min(simH - 2, (mouse.y + R) | 0);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - mouse.x;
          const dy = y - mouse.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > R2) continue;
          const idx = y * simW + x;
          if (maskSim[idx] !== 1) continue;
          // feed only the veins (scale by the membrane field) so the cursor
          // strengthens the web near it — no soft glow bleeding into the cells behind
          trail[idx] += F * Math.exp(-d2 / (2 * sig2)) * scaffold[idx];
        }
      }
    }

    // Spawn short-lived "sparks" at the cursor that crawl outward and lay trail —
    // new growth that blooms where the mouse goes and then decays away on its own.
    function spawnSparks() {
      if (mouse.inf <= 0.02) return;
      const count = Math.max(1, Math.round(SPARK_RATE * mouse.inf));
      const spread = simH * 0.02;
      for (let i = 0; i < count; i++) {
        const ang = rand() * Math.PI * 2;
        const px = mouse.x + Math.cos(ang) * rand() * spread;
        const py = mouse.y + Math.sin(ang) * rand() * spread;
        if (px < 1 || px >= simW - 1 || py < 1 || py >= simH - 1) continue;
        if (maskSim[(py | 0) * simW + (px | 0)] !== 1) continue;
        const j = sparkHead;
        sparkHead = (sparkHead + 1) % SPARK_MAX;
        sx[j] = px;
        sy[j] = py;
        sga[j] = ang; // head outward from the cursor → radial growth
        slife[j] = SPARK_LIFE;
      }
    }

    function stepSparks() {
      const sd = P.sensorDist;
      const saa = P.sensorAngle;
      const trn = P.turn;
      const sp = P.speed;
      const dep = P.deposit * 1.6;
      for (let i = 0; i < SPARK_MAX; i++) {
        if (slife[i] <= 0) continue;
        let x = sx[i];
        let y = sy[i];
        let a = sga[i];
        const f = sample(trail, x + Math.cos(a) * sd, y + Math.sin(a) * sd);
        const l = sample(trail, x + Math.cos(a - saa) * sd, y + Math.sin(a - saa) * sd);
        const r = sample(trail, x + Math.cos(a + saa) * sd, y + Math.sin(a + saa) * sd);
        if (f > l && f > r) a += (rand() - 0.5) * 0.05;
        else if (l > r) a -= trn * (0.4 + rand());
        else if (r > l) a += trn * (0.4 + rand());
        else a += (rand() - 0.5) * trn * 2;
        const nx = x + Math.cos(a) * sp;
        const ny = y + Math.sin(a) * sp;
        if (nx >= 1 && nx < simW - 1 && ny >= 1 && ny < simH - 1 && maskSim[(ny | 0) * simW + (nx | 0)] === 1) {
          x = nx;
          y = ny;
        } else {
          a += Math.PI * (0.5 + rand());
        }
        const lifeFrac = slife[i] / SPARK_LIFE;
        trail[(y | 0) * simW + (x | 0)] += dep * (0.35 + 0.65 * lifeFrac); // taper as it ages
        sx[i] = x;
        sy[i] = y;
        sga[i] = a;
        slife[i] -= 1;
      }
    }

    function stepAgents() {
      const sd = P.sensorDist;
      const sa = P.sensorAngle;
      const trn = P.turn;
      const sp = P.speed;
      const dep = P.deposit;
      const mi = P.mouseFeed > 0 ? mouse.inf : 0;
      const RA = simH * 0.22;
      const RA2 = RA * RA;
      for (let i = 0; i < AG; i++) {
        let x = ax[i];
        let y = ay[i];
        let a = aa[i];
        const f = sample(trail, x + Math.cos(a) * sd, y + Math.sin(a) * sd);
        const l = sample(trail, x + Math.cos(a - sa) * sd, y + Math.sin(a - sa) * sd);
        const r = sample(trail, x + Math.cos(a + sa) * sd, y + Math.sin(a + sa) * sd);
        if (f > l && f > r) a += (rand() - 0.5) * 0.035;
        else if (l > r) a -= trn * (0.45 + rand() * 0.95);
        else if (r > l) a += trn * (0.45 + rand() * 0.95);
        else a += (rand() - 0.5) * trn * 1.8;
        if (mi > 0.002) {
          const dxm = mouse.x - x;
          const dym = mouse.y - y;
          const dm2 = dxm * dxm + dym * dym;
          if (dm2 < RA2) {
            let da = Math.atan2(dym, dxm) - a;
            da = Math.atan2(Math.sin(da), Math.cos(da));
            a += da * 0.08 * mi * (1 - Math.sqrt(dm2) / RA);
          }
        }
        const nx = x + Math.cos(a) * sp;
        const ny = y + Math.sin(a) * sp;
        // confine to the letters: the glyph outline is a wall the slime can't cross
        if (nx >= 1 && nx < simW - 1 && ny >= 1 && ny < simH - 1 && maskSim[(ny | 0) * simW + (nx | 0)] === 1) {
          x = nx;
          y = ny;
        } else {
          a += Math.PI * (0.5 + rand());
        }
        const idx = (y | 0) * simW + (x | 0);
        trail[idx] += dep;
        if (idx > simW && idx < N - simW - 1) {
          if (maskSim[idx - 1]) trail[idx - 1] += dep * 0.11;
          if (maskSim[idx + 1]) trail[idx + 1] += dep * 0.11;
          if (maskSim[idx - simW]) trail[idx - simW] += dep * 0.11;
          if (maskSim[idx + simW]) trail[idx + simW] += dep * 0.11;
        }
        ax[i] = x;
        ay[i] = y;
        aa[i] = a;
      }
    }

    function diffuse() {
      const blur = P.blur;
      const keep = 1 - blur;
      const decay = P.decay;
      for (let r = 0; r < runCount; r++) {
        const end = runs[r * 2 + 1];
        for (let i = runs[r * 2]; i <= end; i++) {
          const avg =
            (trail[i - simW - 1] +
              trail[i - simW] +
              trail[i - simW + 1] +
              trail[i - 1] +
              trail[i] +
              trail[i + 1] +
              trail[i + simW - 1] +
              trail[i + simW] +
              trail[i + simW + 1]) *
            (1 / 9);
          next[i] = (trail[i] * keep + avg * blur) * decay + scaffold[i] * 0.0023;
        }
      }
      for (let x = 0; x < simW; x++) {
        next[x] = 0;
        next[(simH - 1) * simW + x] = 0;
      }
      for (let y = 0; y < simH; y++) {
        next[y * simW] = 0;
        next[y * simW + simW - 1] = 0;
      }
      const t = trail;
      trail = next;
      next = t;
    }

    // Reconstructed near-linear distance-to-wall, derived once from the static scaffold.
    let dist = null;

    // Emit a SMOOTH ramp, NOT a thresholded binary. The membrane is written as a soft
    // gradient whose half-coverage point lands near mid-grey, so that after the bicubic
    // upscale the steep display-resolution contrast in composite() snaps it back to a
    // crisp, sub-pixel-accurate, anti-aliased edge (distance-field style AA — no blur,
    // no staircase). Pre-sharpening here (pow/crush) is exactly what caused the voxels,
    // so it is deliberately gone.
    //
    // Distance-field path (P.distanceField): instead of thresholding the Gaussian
    // membrane (curved → its iso-contour wiggles between coarse samples → bumps), we
    // threshold the reconstructed wall distance, which is ~linear in space. Bicubic
    // interpolation of a near-linear field is near-exact, so the edge contour is smooth.
    function renderField() {
      const exposure = P.exposure;
      const scaff = P.scaffold;
      const bloom = P.bloom;
      const edgeLo = P.edgeLo;
      const edgeHi = P.edgeHi;
      const rimAmt = P.rim;
      const useDist = P.distanceField;
      const lineHalf = P.lineHalf;
      const half = P.band * 0.5;
      const trailBoost = P.trailBoost;
      const invert = P.invert;

      // Pixels outside renderRuns are mathematically uniform: scaffold/trail and all four
      // neighbours are zero. Paint that baseline once (and only repaint it when a live
      // tuning change actually changes the value) instead of rewriting the empty rectangle
      // every frame. Assigning through Uint8ClampedArray keeps byte rounding identical.
      let baseCover;
      let baseHalo;
      if (useDist) {
        baseCover = 1 - smoothstep(lineHalf - half, lineHalf + half, 99);
        // The tuned production preset has no bloom. Avoid evaluating a smoothstep whose
        // finite result would only be multiplied by zero; the emitted value remains +0.
        baseHalo =
          bloom === 0 ? 0 : (1 - smoothstep(lineHalf, lineHalf + half * 4, 99)) * bloom;
      } else {
        baseCover = smoothstep(edgeLo, edgeHi, 0);
        baseHalo = bloom === 0 ? 0 : smoothstep(0.03, edgeLo, 0) * bloom;
      }
      const baseC = clamp(baseCover * 255 + baseHalo * 30, 0, 255);
      const nextBackgroundOut = invert ? baseC : 255 - baseC;
      if (!Object.is(backgroundOut, nextBackgroundOut)) {
        for (let k = 0; k < pixels.length; k += 4) {
          pixels[k] = nextBackgroundOut;
          pixels[k + 1] = nextBackgroundOut;
          pixels[k + 2] = nextBackgroundOut;
          pixels[k + 3] = 255;
        }
        backgroundOut = nextBackgroundOut;
      }

      // One-time reconstruction of the wall distance from the static Gaussian membrane:
      // scaffold = exp(-gap²/2σ)  ⟹  gap = √(-2σ·ln scaffold). scaffold never changes
      // after build, so this runs once (and again only if the grid is rebuilt).
      if (useDist && (!dist || dist.length !== N)) {
        dist = new Float32Array(N);
        const TWO_SIG = 2 * P.sigma;
        for (let i = 0; i < N; i++) {
          let sc = scaffold[i];
          if (sc > 1) sc = 1;
          dist[i] = sc > 1e-4 ? Math.sqrt(-TWO_SIG * Math.log(sc)) : 99;
        }
      }

      for (let r = 0; r < renderRunCount; r++) {
        const end = renderRuns[r * 2 + 1];
        const start = renderRuns[r * 2];
        for (let idx = start, k = start * 4; idx <= end; idx++, k += 4) {
          let cover;
          let halo;
          if (useDist) {
            // slime density pulls the effective wall distance down → thicker/longer veins
            const gapEff = dist[idx] - trail[idx] * trailBoost;
            // 1 inside the vein → 0 in the cell; the 50% crossing (the visible edge) sits
            // at lineHalf, and the ramp is over a *linear* field so the contour is smooth
            cover = 1 - smoothstepBounded(lineHalf - half, lineHalf + half, gapEff);
            // soft glow just outside the crisp line (mostly a tone the contrast keeps gentle)
            halo =
              bloom === 0
                ? 0
                : (1 - smoothstep(lineHalf, lineHalf + half * 4, gapEff)) * bloom;
          } else {
            const t = trail[idx] * 0.026 + scaffold[idx] * scaff;
            const e = t * exposure;
            // smooth membrane coverage: 0 in the cells → 1 on the vein, with a wide soft
            // band so the upscale stays smooth (contrast re-crisps it at display res)
            cover = smoothstep(edgeLo, edgeHi, e);
            // gentle outer glow that fades into the line edge (kept subtle, not crushed)
            halo = bloom === 0 ? 0 : smoothstep(0.03, edgeLo, e) * bloom;
          }
          const gx = Math.abs(trail[idx - 1] - trail[idx + 1]) * 0.018;
          const gy = Math.abs(trail[idx - simW] - trail[idx + simW]) * 0.018;
          const rim = smoothstepBounded(0.02, 0.26, gx + gy) * rimAmt;
          // darkness of the web before inversion; cover dominates so the half-coverage
          // crossing sits near 0.5 (128) — the pivot the contrast curve sharpens about
          const c = clamp(cover * 255 + halo * 30 + rim * 46, 0, 255);
          // c is high on the veins/strands, ~0 in the cells. Dark theme inverts → white
          // cells + dark web on a black page. Light theme (P.invert) keeps c → white
          // strands and a black letter fill on the white page — a clean colour inversion.
          const out = invert ? c : 255 - c;
          pixels[k] = out;
          pixels[k + 1] = out;
          pixels[k + 2] = out;
        }
      }
      bctx.putImageData(image, 0, 0);
    }

    // Stem "underpass" geometry. For a letter whose bowl rejoins a vertical stem (the P),
    // we want the stem to read as one continuous vertical line that the bowl tucks UNDER,
    // instead of the bowl's border crossing over it. We find each P's stem right-edge x (in
    // device px) from the rasterised mask; composite() then redraws that edge on top.
    let underpasses = [];
    function computeStemUnderpasses() {
      underpasses = [];
      if (dpW < 2 || dpH < 2 || text.indexOf('P') === -1) return;
      const fontPx = Math.min((dpW * (1 - 2 * HPAD)) / uw, (dpH * (1 - 2 * VPAD)) / uh);
      const meas = createCanvas().getContext('2d');
      meas.font = `700 ${fontPx}px "Playfair Display", Georgia, serif`;
      const total = meas.measureText(text).width;
      const wordStart = dpW / 2 - total / 2;
      const baselineY = dpH / 2 + ((uAsc - uDesc) * fontPx) / 2;
      const top = Math.max(0, Math.floor(baselineY - uAsc * fontPx));
      const bot = Math.min(dpH - 1, Math.ceil(baselineY));
      const md = mctx.getImageData(0, 0, dpW, dpH).data;
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== 'P') continue;
        const left = wordStart + meas.measureText(text.slice(0, i)).width;
        const right = wordStart + meas.measureText(text.slice(0, i + 1)).width;
        const xL = Math.max(0, Math.floor(left));
        const xR = Math.min(dpW - 1, Math.ceil(right));
        // Below the bowl the only ink in the P's column is the stem (trunk). Sample a few
        // rows clear of the bowl and the bottom serif and take the narrowest span → the
        // trunk's left and right edges.
        let stemLeft = -1;
        let stemRight = -1;
        for (const frac of [0.15, 0.22, 0.3]) {
          const y = Math.round(bot - (bot - top) * frac);
          if (y < 0 || y >= dpH) continue;
          let lx = -1;
          for (let x = xL; x <= xR; x++) {
            if (md[(y * dpW + x) * 4 + 3] > 128) { lx = x; break; }
          }
          let rx = -1;
          for (let x = xR; x >= xL; x--) {
            if (md[(y * dpW + x) * 4 + 3] > 128) { rx = x; break; }
          }
          if (lx >= 0 && (stemLeft < 0 || lx > stemLeft)) stemLeft = lx; // innermost left
          if (rx >= 0 && (stemRight < 0 || rx < stemRight)) stemRight = rx; // innermost right
        }
        if (stemLeft >= 0 && stemRight > stemLeft) {
          underpasses.push({ left: stemLeft, right: stemRight, top, bot });
        }
      }
    }

    function layout() {
      const DPR = Math.min(2, layoutDpr || 1);
      const cw = layoutCssWidth || 600;
      const ch = cw / boxAspect;
      dpW = Math.max(2, Math.round(cw * DPR));
      dpH = Math.max(2, Math.round(ch * DPR));
      canvas.width = dpW;
      canvas.height = dpH;
      maskCanvas.width = dpW;
      maskCanvas.height = dpH;
      upCanvas.width = dpW;
      upCanvas.height = dpH;
      fieldCanvas.width = dpW;
      fieldCanvas.height = dpH;
      drawTitleInto(mctx, dpW, dpH); // vector-accurate, full device resolution
      computeStemUnderpasses();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      upctx.imageSmoothingEnabled = true;
      upctx.imageSmoothingQuality = 'high';
    }

    // No blur anywhere. Two passes:
    //  1) bicubically upscale the smooth ramp into a device-resolution scratch canvas
    //     (C¹-smooth → curves reconstruct sub-texel, no staircase);
    //  2) draw that 1:1 onto the visible canvas through a steep contrast() filter, which
    //     resolves the membrane edge at DISPLAY resolution → crisp but anti-aliased
    //     (~1px) edges. The 1:1 draw guarantees the contrast acts in display space.
    // Then the crisp vector mask clips it and the border is stroked on top.
    function composite() {
      // pass 1 — smooth upscale of the soft field
      upctx.imageSmoothingEnabled = true;
      upctx.imageSmoothingQuality = 'high';
      upctx.globalCompositeOperation = 'source-over';
      upctx.clearRect(0, 0, dpW, dpH);
      upctx.drawImage(buffer, 0, 0, dpW, dpH);

      // pass 2 — re-sharpen the ramp into a crisp AA edge at display resolution
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, dpW, dpH);
      ctx.filter = `contrast(${P.sharpen})`;
      ctx.drawImage(upCanvas, 0, 0); // 1:1 → contrast applies per device pixel
      ctx.filter = 'none';

      // crisp vector clip to the glyph
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(maskCanvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';

      // Snapshot the clean field (before the border) so the stem underpass can repaint the
      // trunk interior with it, hiding any bowl border that crossed into the trunk.
      if (underpasses.length) {
        fieldCtx.clearRect(0, 0, dpW, dpH);
        fieldCtx.drawImage(canvas, 0, 0);
      }

      // thin crisp outline on the glyph edge — white on the light theme, black on the dark
      if (P.border > 0) {
        const color = P.invert ? '#fff' : '#000';
        const lw = Math.max(1, dpW * P.border);
        drawTitleStroke(ctx, dpW, dpH, lw, color);
        // Re-clip the stroke to the glyph fill. A centered stroke of a serif outline self-
        // intersects inside tight concavities; clipping to the fill trims the outer half away.
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(maskCanvas, 0, 0);
        ctx.globalCompositeOperation = 'source-over';

        // Stem underpass: make the P's trunk read as one continuous vertical bar that the bowl
        // passes UNDER. Where the bowl loops back into the trunk, the border stroke draws the
        // bowl's edge straight across the trunk's marble; a line on the trunk edge can't fix
        // that because the outline lands INSIDE the trunk. So for each P we repaint the clean
        // field (no border) over the trunk's interior — erasing the intruding bowl outline.
        // The bowl now meets the trunk's right edge and tucks behind it.
        for (let u = 0; u < underpasses.length; u++) {
          const up = underpasses[u];
          const x0 = up.left + lw; // keep the trunk's left-edge border intact
          const w = up.right - x0;
          const h = up.bot - up.top;
          if (w > 0) ctx.drawImage(fieldCanvas, x0, up.top, w, h, x0, up.top, w, h);
        }
      }
    }

    function frame() {
      if (disposed) return;
      mouse.inf += ((mouse.active ? 1 : 0) - mouse.inf) * 0.12;
      if (!mouse.active && mouse.inf < 0.002) mouse.inf = 0;
      const engaged = mouse.active || mouse.inf > 0.002;
      if (!frozen) {
        if (engaged) {
          applyMouseFood();
          spawnSparks();
        }
        // two sim substeps per frame → livelier "swimming" of the organisms
        stepAgents();
        stepSparks();
        diffuse();
        stepAgents();
        diffuse();
        renderField();
        composite();
      } else if (dirty || engaged) {
        renderField();
        composite();
        dirty = false;
      }
    }

    function start() {
      if (started || disposed) return;
      started = true;
      measureNatural();
      buildSim();
      layout();
      renderField();
      composite();
      onReady?.({ aspect: boxAspect, simW, simH });
    }

    // ---- Control-panel hooks ---------------------------------------------------------
    // Structural params (sites/sigma/warp/…): regenerate the web from the current P.
    function rebuild() {
      if (!started || disposed) return;
      buildSim(); // re-seeds rand from P.seed internally
      dist = null; // force the wall-distance field to be reconstructed for the new scaffold
      layout();
      renderField();
      composite();
    }
    // Live params (colour, motion, render): just repaint with the new P right now.
    function poke() {
      if (!started || disposed) return;
      dirty = true;
      renderField();
      composite();
    }
    function reseed() {
      if (!started || disposed) return;
      P.seed = (Math.floor(Math.random() * 0xffffff) + 1) >>> 0;
      rebuild();
    }
    start();

    return {
      tick: frame,
      pointer(x, y, active) {
        if (active) {
          mouse.x = clamp(x, 0, 1) * simW;
          mouse.y = clamp(y, 0, 1) * simH;
          mouse.active = true;
        } else {
          // Match the original pointer-leave behavior: attraction fades at the visitor's
          // last position instead of jumping to the canvas origin while influence decays.
          mouse.active = false;
        }
        dirty = true;
      },
      resize(width, nextDpr) {
        if (disposed) return;
        layoutCssWidth = width;
        layoutDpr = nextDpr;
        layout();
        composite();
      },
      update(params, mode) {
        if (disposed) return;
        Object.assign(P, params || {});
        if (mode === 'rebuild') rebuild();
        else poke();
      },
      reseed,
      refreshFont() {
        if (!started || disposed) return false;
        const mc = createCanvas().getContext('2d');
        mc.font = FONT;
        if (Math.abs(mc.measureText(text).width - uw * 100) < 0.01) return false;
        measureNatural();
        buildSim();
        dist = null;
        layout();
        renderField();
        composite();
        onReady?.({ aspect: boxAspect, simW, simH });
        return true;
      },
      dispose() {
        disposed = true;
      },
    };
}


/* ----------------------- vanilla mount (login hero) ----------------------- */
// Port of the site's VoronoiTitleLegacy wrapper: font coordination, input,
// visibility, and resize around the shared deterministic engine.
const VORONOI_FONT = '700 100px "Playfair Display"';

function mountHeroTitle(wrap) {
  const canvas = wrap.querySelector('canvas');
  if (!canvas || wrap.dataset.mounted) return;
  wrap.dataset.mounted = '1';
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let disposed = false, started = false, running = false, engine = null, raf = 0, resizeRaf = 0;

  const frame = () => {
    if (disposed || !engine) { raf = 0; return; }
    engine.tick();
    raf = running ? requestAnimationFrame(frame) : 0;
  };
  const ensureLoop = () => { if (!raf && running && engine) raf = requestAnimationFrame(frame); };
  const start = () => {
    if (started || disposed) return;
    started = true;
    engine = createVoronoiEngine({
      canvas,
      createCanvas: () => document.createElement('canvas'),
      text: 'CUPI',
      cssWidth: wrap.clientWidth || 600,
      dpr: Math.min(2, window.devicePixelRatio || 1),
      reduced,
      params: VORONOI_P,
      onReady: ({ aspect }) => {
        if (disposed) return;
        wrap.style.aspectRatio = String(aspect);
        wrap.classList.add('is-ready');
      },
    });
    running = true;
    ensureLoop();
  };

  const fallback = setTimeout(() => { if (!disposed && !started) start(); }, 1600);
  let fontLoad;
  try { fontLoad = document.fonts?.load ? document.fonts.load(VORONOI_FONT, 'CUPI') : Promise.resolve(); }
  catch (e) { fontLoad = Promise.resolve(); }
  Promise.resolve(fontLoad).catch(() => {}).then(() => {
    if (disposed) return;
    clearTimeout(fallback);
    if (started) { engine?.refreshFont(); ensureLoop(); } else start();
  });
  const onFontsDone = () => { if (engine?.refreshFont()) ensureLoop(); };
  document.fonts?.addEventListener?.('loadingdone', onFontsDone);

  const io = new IntersectionObserver((entries) => {
    const visible = entries.some((entry) => entry.isIntersecting);
    if (visible && started) { running = true; ensureLoop(); }
    else { running = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  }, { threshold: 0.01 });
  io.observe(wrap);

  const onVisibility = () => {
    if (document.hidden) { running = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
    else if (started) { running = true; ensureLoop(); }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const onPointerMove = (event) => {
    if (!engine) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const active = x >= -0.15 && x <= 1.15 && y >= -0.15 && y <= 1.15;
    engine.pointer(x, y, active);
    if (active) ensureLoop();
  };
  const clearPointer = () => engine?.pointer(0, 0, false);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerdown', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', clearPointer);

  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (disposed || !engine) return;
      engine.resize(wrap.clientWidth || 600, Math.min(2, window.devicePixelRatio || 1));
    });
  });
  ro.observe(wrap);

  cadCleanups.push(() => {
    disposed = true;
    running = false;
    if (raf) cancelAnimationFrame(raf);
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    clearTimeout(fallback);
    document.fonts?.removeEventListener?.('loadingdone', onFontsDone);
    io.disconnect();
    ro.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerdown', onPointerMove);
    document.removeEventListener('pointerleave', clearPointer);
    engine?.dispose();
  });
}
