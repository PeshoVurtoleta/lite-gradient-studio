/**
 * MeshGradient — NxM control grid of OKLCH stops with bilinear interpolation.
 *
 * Storage: row-major array of plain { l, c, h } stop objects.
 *   stops[row * cols + col]  →  the (col, row) control point.
 *
 * Sampling: bilinear in OKLCH space, using lite-color's lerpOklchTo which
 * takes the hue-shortest path. Hue wrap (e.g. 350° ↔ 10°) interpolates
 * through 360°/0° correctly without special handling here.
 *
 * Rasterization: per-pixel sampleAt + pack → Uint32Array, byte-order
 * compatible with `new Uint8ClampedArray(out.buffer)` for ImageData blits.
 * This is the baseline kernel — direct, O(width * height) sample+pack.
 * Worth measuring before optimizing (Web Worker, 2D LUT, GPU paths all
 * available later if drag perf demands it).
 *
 * v0.0.2 scope: regular NxM grid only. Arbitrary 2D control points via
 * Delaunay triangulation (lite-delaunay) is a separate kernel for later.
 */

import { lerpOklchTo } from '@zakkster/lite-color';
import { packOklchSingle } from './bake.js';

/** Normalize a hue angle to [0, 360). Handles negative and >=360 inputs. */
function normHue(h) {
    let n = h % 360;
    if (n < 0) n += 360;
    return n;
}

/**
 * Catmull-Rom 1D blending — 4 control points + parameter t in [0, 1]
 * between p1 and p2. p0 and p3 are the neighbours that supply tangent
 * info. Standard form: tangent at p1 is (p2 - p0)/2, at p2 is (p3 - p1)/2.
 *
 * Output is exact at p1 (t=0) and p2 (t=1), C¹ continuous across
 * boundaries when neighbouring patches share the same end-point tangent
 * (which they do here — adjacent patches read shared corner colors).
 *
 * Can overshoot the input range: for an L-channel input [0.3, 0.9, 0.9, 0.3]
 * the cubic may peak above 0.9 in the middle. Callers clamp final
 * channel outputs to valid ranges.
 */
function catmullRom1D(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
        2 * p1 +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
}

/**
 * Align 4 hue values onto a consistent monotone-friendly axis so
 * Catmull-Rom doesn't take the long way around the colour wheel.
 *
 * Strategy: anchor on h1, then walk outward. Each neighbour is
 * shifted by ±360° to land within 180° of the preceding aligned hue.
 * After this, plain catmullRom1D on the aligned values produces the
 * shortest-path interpolation; mod-360 the final output.
 *
 * Returns into the shared `_hueAlign` scratch (no allocation per call).
 * Concurrent calls would clobber, but sampleAt's tight loop reads the
 * result immediately so this is safe.
 */
const _hueAlign = [0, 0, 0, 0];
function alignHues4(h0, h1, h2, h3) {
    h0 = normHue(h0);
    h1 = normHue(h1);
    h2 = normHue(h2);
    h3 = normHue(h3);
    let d = h2 - h1;
    if (d > 180) h2 -= 360;
    else if (d < -180) h2 += 360;
    d = h0 - h1;
    if (d > 180) h0 -= 360;
    else if (d < -180) h0 += 360;
    d = h3 - h2;
    if (d > 180) h3 -= 360;
    else if (d < -180) h3 += 360;
    _hueAlign[0] = h0; _hueAlign[1] = h1; _hueAlign[2] = h2; _hueAlign[3] = h3;
    return _hueAlign;
}

/** Clamp final channel outputs after Catmull-Rom — overshoot can push
 *  L or A outside [0, 1] and C outside [0, 0.5]. Hue is wrapped, not
 *  clamped. */
function clampChannels(out) {
    if (out.l < 0) out.l = 0; else if (out.l > 1) out.l = 1;
    if (out.c < 0) out.c = 0; else if (out.c > 0.5) out.c = 0.5;
    if (out.a < 0) out.a = 0; else if (out.a > 1) out.a = 1;
    out.h = normHue(out.h);
}

/** Resolve rasterizer opts to a canonical interpolation mode string.
 *  Supports the new `opts.interpolation` AND the legacy `opts.smooth`
 *  boolean from v0.0.23. Unknown strings fall back to 'bilinear'. */
function resolveInterpMode(opts) {
    if (!opts) return 'bilinear';
    if (opts.interpolation === 'cubic')    return 'cubic';
    if (opts.interpolation === 'smooth')   return 'smooth';
    if (opts.interpolation === 'bilinear') return 'bilinear';
    if (opts.smooth === true)              return 'smooth';
    return 'bilinear';
}

/**
 * Procedural default color for a control point at (col, row) of a cols×rows
 * mesh. Produces a Stripe-style aurora: blue at one corner sweeping through
 * magenta to warm pink at the other, with chroma peaking in the middle and
 * L gently darkening top-to-bottom. Smooth in all axes — no two adjacent
 * cells are identical, no tiling artifacts at any mesh size.
 *
 * Pure function. Same input always returns the same output.
 *
 * @param {number} col   0..cols-1
 * @param {number} row   0..rows-1
 * @param {number} cols  >= 2
 * @param {number} rows  >= 2
 * @returns {{l:number,c:number,h:number}} fresh OKLCH triplet
 */
export function defaultMeshColor(col, row, cols, rows) {
    const cT = cols === 1 ? 0.5 : col / (cols - 1);
    const rT = rows === 1 ? 0.5 : row / (rows - 1);

    // L: lighter at top, darker at bottom — gentle so colors stay vivid.
    const l = 0.70 - 0.30 * rT;

    // C: tent peak at (0.5, 0.5); edges keep some chroma so corners
    // aren't flat gray. Range ≈ 0.15 (corners) to 0.25 (center).
    const cDist = 1 - Math.abs(cT * 2 - 1);
    const rDist = 1 - Math.abs(rT * 2 - 1);
    const c = 0.15 + 0.10 * cDist * rDist;

    // H: sweep across columns (deep blue → magenta → warm) + small
    // diagonal drift by row. Wrap into [0, 360).
    const h = normHue(240 + 120 * cT + 30 * rT);

    return { l, c, h };
}

export class MeshGradient {
    /**
     * @param {number} cols  Number of columns (>= 2).
     * @param {number} rows  Number of rows (>= 2).
     * @param {Array<{l:number,c:number,h:number}>} [stops]
     *   Optional row-major array of cols*rows control points. If omitted,
     *   a sensible default mesh is generated (currently only supported
     *   for cols=rows=3; other sizes get a tiled clone of DEFAULT_3x3).
     */
    constructor(cols, rows, stops) {
        if (!Number.isInteger(cols) || cols < 2) {
            throw new Error('MeshGradient: cols must be an integer >= 2');
        }
        if (!Number.isInteger(rows) || rows < 2) {
            throw new Error('MeshGradient: rows must be an integer >= 2');
        }

        this.cols = cols;
        this.rows = rows;
        const total = cols * rows;

        if (stops) {
            if (stops.length !== total) {
                throw new Error(
                    `MeshGradient: stops length (${stops.length}) does not match cols*rows (${total})`,
                );
            }
            // Defensive copy — caller-provided objects get rewritten into
            // our shape so external mutation can't corrupt the mesh.
            // Default positions = regular grid. Caller stops may provide
            // x/y to override; missing values default per (col, row).
            // Alpha defaults to 1 when not specified; the field is always
            // present on the internal stops to keep sampleAt's bilinear
            // path branch-free.
            this.stops = new Array(total);
            for (let i = 0; i < total; i++) {
                const s = stops[i];
                const col = i % cols;
                const row = (i / cols) | 0;
                this.stops[i] = {
                    l: s.l, c: s.c, h: s.h,
                    a: s.a === undefined ? 1 : s.a,
                    x: s.x !== undefined ? s.x : col / (cols - 1),
                    y: s.y !== undefined ? s.y : row / (rows - 1),
                };
            }
        } else {
            // Procedural default: smooth aurora at any size, no tiling.
            this.stops = new Array(total);
            for (let i = 0; i < total; i++) {
                const col = i % cols;
                const row = (i / cols) | 0;
                const src = defaultMeshColor(col, row, cols, rows);
                this.stops[i] = {
                    l: src.l, c: src.c, h: src.h, a: 1,
                    x: col / (cols - 1),
                    y: row / (rows - 1),
                };
            }
        }

        // Scratch slots for the two intermediate edge lerps in bilinear
        // sampling. Allocated once, reused per sample → zero-GC.
        this._scratchTop = { l: 0, c: 0, h: 0, a: 1 };
        this._scratchBot = { l: 0, c: 0, h: 0, a: 1 };

        // Catmull-Rom 2D needs 4 row results before the column blend.
        // Pre-allocated as one fixed array; the sample loop reads them
        // immediately so reuse across calls is safe.
        this._scratchCubicRows = [
            { l: 0, c: 0, h: 0, a: 1 },
            { l: 0, c: 0, h: 0, a: 1 },
            { l: 0, c: 0, h: 0, a: 1 },
            { l: 0, c: 0, h: 0, a: 1 },
        ];
    }

    /**
     * Get a control point by (col, row) into a caller-owned output.
     * Zero-GC.
     *
     * @param {number} col
     * @param {number} row
     * @param {{l:number,c:number,h:number}} out
     * @returns {{l:number,c:number,h:number}} same `out`
     */
    getPoint(col, row, out) {
        const s = this.stops[row * this.cols + col];
        out.l = s.l; out.c = s.c; out.h = s.h;
        return out;
    }

    /**
     * Set a control point by (col, row). Mutates the underlying stop in
     * place — safe to call inside a reactive effect's batch.
     */
    setPoint(col, row, l, c, h) {
        const s = this.stops[row * this.cols + col];
        s.l = l; s.c = c; s.h = h;
    }

    /**
     * Set the (x, y) position of a control point in normalized [0, 1]²
     * canvas space. Positions are honored by `rasterizeDeformedTo`;
     * `rasterizeTo` and `sampleAt` ignore positions (they assume the
     * regular-grid UV mapping).
     */
    setPointPosition(col, row, x, y) {
        const s = this.stops[row * this.cols + col];
        s.x = x;
        s.y = y;
    }

    /**
     * Read the (x, y) position of a control point into a caller-owned
     * `{ x, y }` output. Zero-GC.
     */
    getPointPosition(col, row, out) {
        const s = this.stops[row * this.cols + col];
        out.x = s.x;
        out.y = s.y;
        return out;
    }

    /**
     * Reset all control-point positions to the regular grid (the default
     * after construction). Colors are untouched.
     */
    resetPositions() {
        const { cols, rows, stops } = this;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const s = stops[r * cols + c];
                s.x = c / (cols - 1);
                s.y = r / (rows - 1);
            }
        }
    }

    /**
     * Sample the mesh at normalized (u, v) ∈ [0, 1]² into `out`.
     * Zero-GC. Bilinear in OKLCH, hue-shortest-path via lerpOklchTo.
     *
     * Hue normalization: lerpOklchTo takes the shortest-path delta but
     * does NOT bound its output to [0, 360). At extreme corners or after
     * wrap-crossing lerps, the intermediate hue can land at 390 or -30.
     * Left unnormalized, that propagates into the second lerp and adds
     * another 360 to the final hue. We normalize after each stage.
     *
    /**
     * Sample the gradient at parametric (u, v) ∈ [0, 1]². Writes into `out`
     * to avoid the per-pixel allocation a return-by-value version would force.
     *
     * Hue normalization matters: `lerpOklchTo` picks the shortest hue path but
     * does NOT bound its output to [0, 360). At extreme corners or after
     * wrap-crossing lerps, the intermediate hue can land at 390 or -30.
     * Left unnormalized, that propagates into the second lerp and adds
     * another 360 to the final hue. We normalize after each stage.
     *
     * The optional fourth parameter selects interpolation. Accepts:
     *   - false / undefined → 'bilinear'   (original, C⁰)
     *   - true              → 'smooth'     (smoothstep on cu/cv, C¹ at seams)
     *   - 'cubic'           → Catmull-Rom 2D (C¹ everywhere; 4× cost)
     *   - any of the strings above explicitly
     *
     * @param {number} u
     * @param {number} v
     * @param {{l:number,c:number,h:number}} out
     * @param {boolean|string} [modeOrSmooth=false]
     * @returns {{l:number,c:number,h:number}} same `out`
     */
    sampleAt(u, v, out, modeOrSmooth = false) {
        // Normalize the legacy boolean to the string form. Hot path —
        // keep the conditional tight.
        const mode = modeOrSmooth === true ? 'smooth'
            : modeOrSmooth === false ? 'bilinear'
            : modeOrSmooth;
        if (mode === 'cubic') return this._sampleAtCubic(u, v, out);

        // Clamp to unit square.
        if (u < 0) u = 0; else if (u > 1) u = 1;
        if (v < 0) v = 0; else if (v > 1) v = 1;

        const cols = this.cols;
        const rows = this.rows;
        const stops = this.stops;

        // Map to grid coords. Last cell index is (cols-2, rows-2) — the
        // cell whose right/bottom edge is the mesh boundary.
        const fu = u * (cols - 1);
        const fv = v * (rows - 1);
        let col = fu | 0;
        let row = fv | 0;
        let cu = fu - col;
        let cv = fv - row;
        if (col >= cols - 1) { col = cols - 2; cu = 1; }
        if (row >= rows - 1) { row = rows - 2; cv = 1; }

        if (mode === 'smooth') {
            // smoothstep eases the (cu, cv) → blend mapping; corner colors
            // (cu/cv = 0 or 1) are preserved exactly.
            cu = cu * cu * (3 - 2 * cu);
            cv = cv * cv * (3 - 2 * cv);
        }

        const base = row * cols + col;
        const c00 = stops[base];
        const c10 = stops[base + 1];
        const c01 = stops[base + cols];
        const c11 = stops[base + cols + 1];

        // Top edge then bottom edge into scratch, then v-lerp into out.
        // Normalize each intermediate hue so subsequent lerps see a value
        // in [0, 360) and pick the right shortest path. Alpha lerps
        // linearly alongside — lerpOklchTo only touches L/C/H so we do
        // it inline.
        lerpOklchTo(c00, c10, cu, this._scratchTop);
        this._scratchTop.h = normHue(this._scratchTop.h);
        this._scratchTop.a = c00.a + (c10.a - c00.a) * cu;
        lerpOklchTo(c01, c11, cu, this._scratchBot);
        this._scratchBot.h = normHue(this._scratchBot.h);
        this._scratchBot.a = c01.a + (c11.a - c01.a) * cu;
        lerpOklchTo(this._scratchTop, this._scratchBot, cv, out);
        out.h = normHue(out.h);
        out.a = this._scratchTop.a + (this._scratchBot.a - this._scratchTop.a) * cv;
        return out;
    }

    /**
     * Catmull-Rom 2D sample. Internal — entry is via sampleAt's `mode`
     * parameter. Reads a 4×4 neighbourhood around the patch containing
     * (u, v); edge patches clamp out-of-grid indices to the nearest
     * valid stop (graceful degradation toward bilinear at edges, smooth
     * elsewhere).
     *
     * Channels L, C, A are scalar-interpolated; H aligns first to
     * avoid 0/360 wrap-around producing the wrong path. Outputs are
     * clamped to valid ranges since Catmull-Rom can overshoot.
     */
    _sampleAtCubic(u, v, out) {
        if (u < 0) u = 0; else if (u > 1) u = 1;
        if (v < 0) v = 0; else if (v > 1) v = 1;

        const cols = this.cols;
        const rows = this.rows;

        const fu = u * (cols - 1);
        const fv = v * (rows - 1);
        let col = fu | 0;
        let row = fv | 0;
        let cu = fu - col;
        let cv = fv - row;
        if (col >= cols - 1) { col = cols - 2; cu = 1; }
        if (row >= rows - 1) { row = rows - 2; cv = 1; }

        // 4×4 neighbour columns + rows, clamped to grid bounds. At a
        // boundary patch the spline degrades toward bilinear (duplicate
        // endpoints give a flat tangent there), which is the right
        // behaviour — there's no extrapolation data to inform a
        // sharper curve outside the grid.
        const im1 = col - 1 < 0 ? 0 : col - 1;
        const i0  = col;
        const i1  = col + 1;
        const i2  = col + 2 >= cols ? cols - 1 : col + 2;

        const jm1 = row - 1 < 0 ? 0 : row - 1;
        const j0  = row;
        const j1  = row + 1;
        const j2  = row + 2 >= rows ? rows - 1 : row + 2;

        // Step 1: blend each of the 4 rows along x at parameter cu.
        this._cubicRow(jm1, im1, i0, i1, i2, cu, this._scratchCubicRows[0]);
        this._cubicRow(j0,  im1, i0, i1, i2, cu, this._scratchCubicRows[1]);
        this._cubicRow(j1,  im1, i0, i1, i2, cu, this._scratchCubicRows[2]);
        this._cubicRow(j2,  im1, i0, i1, i2, cu, this._scratchCubicRows[3]);

        // Step 2: blend the 4 row results along y at parameter cv.
        const r0 = this._scratchCubicRows[0];
        const r1 = this._scratchCubicRows[1];
        const r2 = this._scratchCubicRows[2];
        const r3 = this._scratchCubicRows[3];
        const ah = alignHues4(r0.h, r1.h, r2.h, r3.h);
        out.l = catmullRom1D(r0.l, r1.l, r2.l, r3.l, cv);
        out.c = catmullRom1D(r0.c, r1.c, r2.c, r3.c, cv);
        out.h = catmullRom1D(ah[0], ah[1], ah[2], ah[3], cv);
        out.a = catmullRom1D(r0.a, r1.a, r2.a, r3.a, cv);
        clampChannels(out);
        return out;
    }

    /** Blend one row at columns (im1, i0, i1, i2) with parameter t,
     *  writing the result to `dst`. Helper for _sampleAtCubic. */
    _cubicRow(jRow, im1, i0, i1, i2, t, dst) {
        const cols = this.cols;
        const stops = this.stops;
        const s0 = stops[jRow * cols + im1];
        const s1 = stops[jRow * cols + i0];
        const s2 = stops[jRow * cols + i1];
        const s3 = stops[jRow * cols + i2];
        const ah = alignHues4(s0.h, s1.h, s2.h, s3.h);
        dst.l = catmullRom1D(s0.l, s1.l, s2.l, s3.l, t);
        dst.c = catmullRom1D(s0.c, s1.c, s2.c, s3.c, t);
        dst.h = catmullRom1D(ah[0], ah[1], ah[2], ah[3], t);
        dst.a = catmullRom1D(s0.a, s1.a, s2.a, s3.a, t);
    }

    /**
     * Rasterize the mesh into a packed-RGBA Uint32Array of width*height
     * pixels (little-endian byte order — aliasable as Uint8ClampedArray
     * for ImageData blits).
     *
     * @param {Uint32Array} out     Caller-owned buffer of length >= width*height.
     * @param {number}      width
     * @param {number}      height
     * @param {object}      [opts]
     * @param {'bilinear'|'smooth'|'cubic'} [opts.interpolation='bilinear']
     *        - 'bilinear' (default): C⁰, fastest.
     *        - 'smooth':   smoothstep on cu/cv, C¹ at seams, ~2 mults overhead.
     *        - 'cubic':    Catmull-Rom 2D, C¹ everywhere, ~4× slower.
     * @param {boolean}     [opts.smooth]  Legacy boolean: equivalent to
     *                                     interpolation='smooth' when true.
     *                                     Preserved for v0.0.23 callers.
     * @returns {Uint32Array}       Same `out`.
     */
    rasterizeTo(out, width, height, opts) {
        if (!(out instanceof Uint32Array) || out.length < width * height) {
            throw new Error('MeshGradient.rasterizeTo: out must be a Uint32Array with length >= width*height');
        }
        const mode = resolveInterpMode(opts);
        const tmp = { l: 0, c: 0, h: 0, a: 1 };
        const wInv = 1 / (width  - 1);
        const hInv = 1 / (height - 1);
        let i = 0;
        for (let y = 0; y < height; y++) {
            const v = y * hInv;
            for (let x = 0; x < width; x++) {
                const u = x * wInv;
                this.sampleAt(u, v, tmp, mode);
                out[i++] = packOklchSingle(tmp.l, tmp.c, tmp.h, tmp.a);
            }
        }
        return out;
    }

    /**
     * Rasterize honoring control-point positions (deformable mesh).
     *
     * For each grid quad, walk its pixel bounding box, solve the inverse
     * bilinear (Newton, 8-iter cap) to recover the local (u, v) within
     * that quad, blend the four corner colors with that local (u, v),
     * and pack. Pixels outside any quad are left untouched.
     *
     * Newton starts at (0.5, 0.5); converges in ~3-5 iters for
     * well-behaved (non-folded) quads. Degenerate / self-intersecting
     * quads will produce non-convergent pixels — they get skipped, which
     * shows as holes in the preview. Treat that as a visual cue to the
     * user that the mesh is broken rather than silently rendering
     * garbage.
     *
     * NOTE: this does NOT clear `out` first. Callers that need a clean
     * canvas (e.g. a fresh frame in an animation loop) must zero the
     * buffer themselves, or fill with a background color via a separate
     * pass before this.
     *
     * @param {Uint32Array} out
     * @param {number} width
     * @param {number} height
     * @param {object} [opts]
     * @param {'bilinear'|'smooth'|'cubic'} [opts.interpolation='bilinear']
     *        - 'bilinear' (default): standard forward bilinear blend.
     *        - 'smooth':   smoothstep on recovered (u, v) before blend.
     *        - 'cubic':    Catmull-Rom 2D over the 4×4 neighbourhood of
     *                      the patch containing the pixel (~4× slower).
     * @param {boolean} [opts.smooth]  Legacy boolean; true → 'smooth'.
     * @returns {Uint32Array}
     */
    rasterizeDeformedTo(out, width, height, opts) {
        if (!(out instanceof Uint32Array) || out.length < width * height) {
            throw new Error('MeshGradient.rasterizeDeformedTo: out must be a Uint32Array with length >= width*height');
        }
        const mode   = resolveInterpMode(opts);
        const smooth = mode === 'smooth';
        const cubic  = mode === 'cubic';
        const cols = this.cols;
        const rows = this.rows;
        const stops = this.stops;
        const Wm1 = width  - 1;
        const Hm1 = height - 1;

        // Reusable scratch for the per-pixel color blend.
        const top = this._scratchTop;
        const bot = this._scratchBot;
        const px  = { l: 0, c: 0, h: 0, a: 1 };

        for (let qr = 0; qr < rows - 1; qr++) {
            for (let qc = 0; qc < cols - 1; qc++) {
                const iTL = qr       * cols + qc;
                const iTR = iTL + 1;
                const iBL = (qr + 1) * cols + qc;
                const iBR = iBL + 1;

                const sTL = stops[iTL], sTR = stops[iTR];
                const sBL = stops[iBL], sBR = stops[iBR];

                // Corner positions in pixel space.
                const x00 = sTL.x * Wm1, y00 = sTL.y * Hm1;
                const x10 = sTR.x * Wm1, y10 = sTR.y * Hm1;
                const x01 = sBL.x * Wm1, y01 = sBL.y * Hm1;
                const x11 = sBR.x * Wm1, y11 = sBR.y * Hm1;

                // Bilinear parameterization:
                //   P(u,v) = a + u*E + v*F + u*v*G
                // where a = P00, E = P10-P00, F = P01-P00,
                //       G = P00 - P10 - P01 + P11.
                const ax = x00,                       ay = y00;
                const ex = x10 - x00,                 ey = y10 - y00;
                const fx = x01 - x00,                 fy = y01 - y00;
                const gx = x00 - x10 - x01 + x11,     gy = y00 - y10 - y01 + y11;

                // Quad bbox clipped to canvas.
                let minX = Math.min(x00, x10, x01, x11) | 0;
                let maxX = Math.ceil(Math.max(x00, x10, x01, x11));
                let minY = Math.min(y00, y10, y01, y11) | 0;
                let maxY = Math.ceil(Math.max(y00, y10, y01, y11));
                if (minX < 0)   minX = 0;
                if (minY < 0)   minY = 0;
                if (maxX > Wm1) maxX = Wm1;
                if (maxY > Hm1) maxY = Hm1;

                for (let py = minY; py <= maxY; py++) {
                    for (let pX = minX; pX <= maxX; pX++) {
                        const Hx = pX - ax;
                        const Hy = py - ay;

                        // Newton solve: R(u,v) = u*E + v*F + u*v*G - H = 0
                        let u = 0.5, v = 0.5;
                        let converged = false;
                        for (let iter = 0; iter < 8; iter++) {
                            const Rx = u * ex + v * fx + u * v * gx - Hx;
                            const Ry = u * ey + v * fy + u * v * gy - Hy;
                            const Jux = ex + v * gx;
                            const Juy = ey + v * gy;
                            const Jvx = fx + u * gx;
                            const Jvy = fy + u * gy;
                            const det = Jux * Jvy - Juy * Jvx;
                            if (Math.abs(det) < 1e-12) break;
                            const invDet = 1 / det;
                            const du = ( Jvy * Rx - Jvx * Ry) * invDet;
                            const dv = (-Juy * Rx + Jux * Ry) * invDet;
                            u -= du;
                            v -= dv;
                            if (Math.abs(du) + Math.abs(dv) < 1e-5) {
                                converged = true;
                                break;
                            }
                        }
                        if (!converged) continue;

                        // Strict in-quad test. A small epsilon would help
                        // seal cracks across shared edges of adjacent quads
                        // but also leaks into neighbors; the current write
                        // is idempotent for shared edges so it doesn't
                        // matter (both quads compute the same color there).
                        if (u < 0 || u > 1 || v < 0 || v > 1) continue;

                        if (cubic) {
                            // Catmull-Rom 2D over the 4×4 neighbourhood
                            // around quad (qc, qr). Indices clamp to the
                            // grid bounds at edges → degrades toward
                            // bilinear at the very border, smooth elsewhere.
                            const im1 = qc - 1 < 0 ? 0 : qc - 1;
                            const i0  = qc;
                            const i1  = qc + 1;
                            const i2  = qc + 2 >= cols ? cols - 1 : qc + 2;
                            const jm1 = qr - 1 < 0 ? 0 : qr - 1;
                            const j0  = qr;
                            const j1  = qr + 1;
                            const j2  = qr + 2 >= rows ? rows - 1 : qr + 2;
                            this._cubicRow(jm1, im1, i0, i1, i2, u, this._scratchCubicRows[0]);
                            this._cubicRow(j0,  im1, i0, i1, i2, u, this._scratchCubicRows[1]);
                            this._cubicRow(j1,  im1, i0, i1, i2, u, this._scratchCubicRows[2]);
                            this._cubicRow(j2,  im1, i0, i1, i2, u, this._scratchCubicRows[3]);
                            const r0 = this._scratchCubicRows[0];
                            const r1 = this._scratchCubicRows[1];
                            const r2 = this._scratchCubicRows[2];
                            const r3 = this._scratchCubicRows[3];
                            const ah = alignHues4(r0.h, r1.h, r2.h, r3.h);
                            px.l = catmullRom1D(r0.l, r1.l, r2.l, r3.l, v);
                            px.c = catmullRom1D(r0.c, r1.c, r2.c, r3.c, v);
                            px.h = catmullRom1D(ah[0], ah[1], ah[2], ah[3], v);
                            px.a = catmullRom1D(r0.a, r1.a, r2.a, r3.a, v);
                            clampChannels(px);
                            out[py * width + pX] = packOklchSingle(px.l, px.c, px.h, px.a);
                            continue;
                        }

                        // smoothstep (cu, cv) to match the regular-grid
                        // path. corner colors (u/v = 0 or 1) preserved
                        // exactly. shifts the perpendicular-to-edge
                        // derivative to zero on both sides → C¹ across
                        // the seam between this quad and its neighbour.
                        let cu = u, cv = v;
                        if (smooth) {
                            cu = u * u * (3 - 2 * u);
                            cv = v * v * (3 - 2 * v);
                        }

                        // Forward bilinear blend of the four corner colors
                        // with the recovered local (cu, cv). Same alpha
                        // bilinear-lerp pattern as sampleAt — lerpOklchTo
                        // only touches L/C/H so we walk alpha inline.
                        lerpOklchTo(sTL, sTR, cu, top);
                        top.h = normHue(top.h);
                        top.a = sTL.a + (sTR.a - sTL.a) * cu;
                        lerpOklchTo(sBL, sBR, cu, bot);
                        bot.h = normHue(bot.h);
                        bot.a = sBL.a + (sBR.a - sBL.a) * cu;
                        lerpOklchTo(top, bot, cv, px);
                        px.h = normHue(px.h);
                        px.a = top.a + (bot.a - top.a) * cv;

                        out[py * width + pX] = packOklchSingle(px.l, px.c, px.h, px.a);
                    }
                }
            }
        }

        return out;
    }

    /** Release internal references. */
    destroy() {
        this.stops = null;
        this._scratchTop = null;
        this._scratchBot = null;
    }
}
