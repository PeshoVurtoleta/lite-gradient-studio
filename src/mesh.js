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
import { getBlueNoise64 } from '@zakkster/lite-color-engine';
import { packOklchSingle, packOklchSingleDithered } from './bake.js';

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
 * v1.2.0: the trailing `wrapX` and `wrapY` args are optional and default
 * to `false`; when either is set, the corresponding axis's parameterization
 * switches to a periodic form so a wrapped default mesh doesn't compress
 * 120° of hue into the final cell. Callers passing four args as before
 * get byte-identical output.
 *
 * @param {number}  col   0..cols-1
 * @param {number}  row   0..rows-1
 * @param {number}  cols  >= 2
 * @param {number}  rows  >= 2
 * @param {boolean} [wrapX=false]  v1.2.0 — when true, hue advances by
 *   `360/cols` per column (uniform step everywhere including the seam,
 *   no aperiodic compression at the wrap boundary).
 * @param {boolean} [wrapY=false]  v1.2.0 — when true, the small row-driven
 *   hue drift and the L gradient both take a sinusoidal (periodic) shape
 *   so `row = 0` and `row = rows` land on the same color.
 * @returns {{l:number,c:number,h:number}} fresh OKLCH triplet
 */
export function defaultMeshColor(col, row, cols, rows, wrapX = false, wrapY = false) {
    // Column parameter — periodic when wrapping in x. On a wrapped axis
    // the "cells" go 0..cols and cell (cols) is identified with cell 0, so
    // `col / cols` (not `col / (cols - 1)`) is the right period step.
    const cT = wrapX
        ? col / cols
        : (cols === 1 ? 0.5 : col / (cols - 1));
    const rT = wrapY
        ? row / rows
        : (rows === 1 ? 0.5 : row / (rows - 1));

    // L: lighter at top, darker at bottom. In wrapY mode the top and bottom
    // must agree, so drive L with cos(2π·rT) instead of a linear ramp —
    // rT = 0 and rT = 1 both give cos = 1, i.e. the same L.
    const l = wrapY
        ? 0.55 + 0.15 * Math.cos(2 * Math.PI * rT)
        : 0.70 - 0.30 * rT;

    // C: tent peak at the center. In wrapY mode the "distance from center"
    // rDist has to be periodic; use `|sin(π·rT)|` which peaks at rT=0.5 and
    // reaches 0 at rT=0 and rT=1 — same shape, seamless. Same for wrapX.
    const cDist = wrapX
        ? Math.abs(Math.sin(Math.PI * cT))
        : 1 - Math.abs(cT * 2 - 1);
    const rDist = wrapY
        ? Math.abs(Math.sin(Math.PI * rT))
        : 1 - Math.abs(rT * 2 - 1);
    const c = 0.15 + 0.10 * cDist * rDist;

    // H: sweep across columns + small diagonal drift by row.
    // - wrapX: uniform 360/cols step per column so cT = 0 and cT = 1 close
    //   at the same hue (both are 0 mod 360). Base offset 240 preserves the
    //   familiar "starts in blue" palette.
    // - wrapY: the row drift becomes periodic via sin(2π·rT) so top and
    //   bottom rows share the drift value 0. Amplitude kept at 30° to
    //   match the linear-mode magnitude.
    const hueSweep = wrapX ? 360 * cT : 120 * cT;
    const hueDrift = wrapY ? 30 * Math.sin(2 * Math.PI * rT) : 30 * rT;
    const h = normHue(240 + hueSweep + hueDrift);

    return { l, c, h };
}

export class MeshGradient {
    /**
     * @param {number} cols  Number of columns (>= 2).
     * @param {number} rows  Number of rows (>= 2).
     * @param {Array<{l:number,c:number,h:number}>} [stops]
     *   Optional row-major array of cols*rows control points. If omitted,
     *   a sensible default mesh is generated by `defaultMeshColor`.
     * @param {object} [opts]
     * @param {boolean} [opts.wrapX=false]  v1.2.0 — treat the X axis as
     *   cyclic. Structural: changes the UV period (`u = 1` wraps to `u = 0`),
     *   the cell count (`cols` cells instead of `cols - 1`), and the default
     *   control-point positions (`col / cols`). `sampleAt` wraps the u
     *   coordinate via `u = u - Math.floor(u)`. Cubic mode reads real
     *   neighbours across the seam via modulo indexing → C¹ continuity at
     *   `u = 0`. `rasterizeTo` samples the period, not the closed interval.
     *   `rasterizeDeformedTo` throws `WRAP_DEFORMED_UNSUPPORTED` — deformed
     *   + wrap needs ghost quads that cross the seam, deferred to v1.3.
     *   `cols` must be `>= 2` for any mesh, wrapped or not (the outer
     *   integer-check on the constructor rejects `cols < 2` before wrap
     *   is inspected). Degenerate `cols = 2` wrapped IS legal — cubic
     *   neighbour indices alternate `(a, b, a, b)` and the Catmull-Rom
     *   basis handles it as a low-amplitude oscillation.
     * @param {boolean} [opts.wrapY=false]  v1.2.0 — same for the Y axis.
     *   Independent of `wrapX` (torus = both, cylinder = one).
     */
    constructor(cols, rows, stops, opts) {
        if (!Number.isInteger(cols) || cols < 2) {
            throw new Error('MeshGradient: cols must be an integer >= 2');
        }
        if (!Number.isInteger(rows) || rows < 2) {
            throw new Error('MeshGradient: rows must be an integer >= 2');
        }

        // v1.2.0 wrap opts. Both default false; when either flag is off the
        // resulting object walks the same code paths as v1.1.0 (byte-parity
        // is a hard exit-gate for T2).
        //
        // The roadmap's `WRAP_AXIS_TOO_SMALL` guard (cols=1 under modulo
        // collapses every cubic neighbour index to 0, silently breaking the
        // basis) is already covered by the outer `cols/rows < 2` guards
        // above — cols=1 can never construct a MeshGradient at all, wrapped
        // or not. `cols === 2` wrapped IS legal: neighbour indices alternate
        // `(a, b, a, b)` and Catmull-Rom handles it as a low-amplitude
        // oscillation.
        const wrapX = opts != null && opts.wrapX === true;
        const wrapY = opts != null && opts.wrapY === true;

        this.cols = cols;
        this.rows = rows;
        this.wrapX = wrapX;
        this.wrapY = wrapY;
        const total = cols * rows;

        // Default-position denominators: on a wrapped axis there are `cols`
        // cells (not `cols - 1`), so the natural spacing is `col / cols`.
        // Non-wrapped axes keep the endpoint-inclusive `col / (cols - 1)`
        // mapping.
        const xDenom = wrapX ? cols : (cols - 1);
        const yDenom = wrapY ? rows : (rows - 1);

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
                    x: s.x !== undefined ? s.x : col / xDenom,
                    y: s.y !== undefined ? s.y : row / yDenom,
                };
            }
        } else {
            // Procedural default: smooth aurora at any size, no tiling.
            // Passes wrapX/wrapY through so the aperiodic hue sweep gets
            // swapped for the periodic form on wrapped axes (D6 in T2).
            this.stops = new Array(total);
            for (let i = 0; i < total; i++) {
                const col = i % cols;
                const row = (i / cols) | 0;
                const src = defaultMeshColor(col, row, cols, rows, wrapX, wrapY);
                this.stops[i] = {
                    l: src.l, c: src.c, h: src.h, a: 1,
                    x: col / xDenom,
                    y: row / yDenom,
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

        const cols = this.cols;
        const rows = this.rows;
        const stops = this.stops;

        // v1.2.0 axis handling — wrapped axes use period wrap
        // `u - Math.floor(u)` instead of the unit-square clamp. Cell count
        // becomes `cols` (not `cols - 1`) so `sampleAt(1, v)` maps to the
        // same cell coordinate as `sampleAt(0, v)`. Non-wrapped axes keep
        // v1.1.0 semantics byte-for-byte.
        let fu, col, cu;
        if (this.wrapX) {
            const uw = u - Math.floor(u);
            fu = uw * cols;
            col = fu | 0;
            cu = fu - col;
            if (col >= cols) col = 0;   // safety net for uw ≈ 1.0 float rounding
        } else {
            if (u < 0) u = 0; else if (u > 1) u = 1;
            fu = u * (cols - 1);
            col = fu | 0;
            cu = fu - col;
            if (col >= cols - 1) { col = cols - 2; cu = 1; }
        }

        let fv, row, cv;
        if (this.wrapY) {
            const vw = v - Math.floor(v);
            fv = vw * rows;
            row = fv | 0;
            cv = fv - row;
            if (row >= rows) row = 0;
        } else {
            if (v < 0) v = 0; else if (v > 1) v = 1;
            fv = v * (rows - 1);
            row = fv | 0;
            cv = fv - row;
            if (row >= rows - 1) { row = rows - 2; cv = 1; }
        }

        if (mode === 'smooth') {
            // smoothstep eases the (cu, cv) → blend mapping; corner colors
            // (cu/cv = 0 or 1) are preserved exactly.
            cu = cu * cu * (3 - 2 * cu);
            cv = cv * cv * (3 - 2 * cv);
        }

        // Neighbour indices — modulo on wrapped axes so the last cell blends
        // back to the first.
        const colN = this.wrapX ? (col + 1) % cols : col + 1;
        const rowN = this.wrapY ? (row + 1) % rows : row + 1;

        const c00 = stops[row  * cols + col];
        const c10 = stops[row  * cols + colN];
        const c01 = stops[rowN * cols + col];
        const c11 = stops[rowN * cols + colN];

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
        const cols = this.cols;
        const rows = this.rows;

        // Wrapped-axis handling — same shape as `sampleAt`: period-wrap
        // the coord and use `cols` cells instead of `cols - 1`.
        let fu, col, cu;
        if (this.wrapX) {
            const uw = u - Math.floor(u);
            fu = uw * cols;
            col = fu | 0;
            cu = fu - col;
            if (col >= cols) col = 0;
        } else {
            if (u < 0) u = 0; else if (u > 1) u = 1;
            fu = u * (cols - 1);
            col = fu | 0;
            cu = fu - col;
            if (col >= cols - 1) { col = cols - 2; cu = 1; }
        }

        let fv, row, cv;
        if (this.wrapY) {
            const vw = v - Math.floor(v);
            fv = vw * rows;
            row = fv | 0;
            cv = fv - row;
            if (row >= rows) row = 0;
        } else {
            if (v < 0) v = 0; else if (v > 1) v = 1;
            fv = v * (rows - 1);
            row = fv | 0;
            cv = fv - row;
            if (row >= rows - 1) { row = rows - 2; cv = 1; }
        }

        // 4×4 neighbour columns + rows. This is D3 — the flagship. On a
        // wrapped axis, the (col - 1) and (col + 2) neighbours read real
        // cells across the seam via modulo instead of clamping to a
        // duplicated endpoint. That is what gives C¹ continuity at the
        // tile boundary — bilinear and smooth get seamlessness from the
        // wrap coord alone, but cubic needs its input samples to actually
        // exist across the seam. Non-wrapped axes keep the v1.1.0 clamp
        // behaviour byte-for-byte.
        //
        // Modulo formula: `((x % n) + n) % n` is the classic safe form for
        // possibly-negative dividends. On wrapped axes `col` is already in
        // `[0, cols)` from the cell-index arithmetic above, so `col - 1`
        // can be -1 (needs the +n rescue) and `col + 2` can be `cols` or
        // `cols + 1` (harmless — the second `% n` normalizes them).
        let im1, i0, i1, i2;
        if (this.wrapX) {
            im1 = ((col - 1) % cols + cols) % cols;
            i0  = col;
            i1  = (col + 1) % cols;
            i2  = (col + 2) % cols;
        } else {
            im1 = col - 1 < 0 ? 0 : col - 1;
            i0  = col;
            i1  = col + 1;
            i2  = col + 2 >= cols ? cols - 1 : col + 2;
        }

        let jm1, j0, j1, j2;
        if (this.wrapY) {
            jm1 = ((row - 1) % rows + rows) % rows;
            j0  = row;
            j1  = (row + 1) % rows;
            j2  = (row + 2) % rows;
        } else {
            jm1 = row - 1 < 0 ? 0 : row - 1;
            j0  = row;
            j1  = row + 1;
            j2  = row + 2 >= rows ? rows - 1 : row + 2;
        }

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
        // v1.2.0 — D4: on a wrapped axis, sample the period (`x / width`),
        // NOT the closed interval (`x / (width - 1)`). Pixel column 0 of
        // the "next tile" would land at `u = 1 ≡ 0` — no duplicated edge
        // column, so `drawImage`-based tiling of the rasterized output
        // butts perfectly. Non-wrapped axes keep v1.1.0 semantics.
        const wInv = this.wrapX ? 1 / width  : 1 / (width  - 1);
        const hInv = this.wrapY ? 1 / height : 1 / (height - 1);

        // v1.2.0 — D8: dither branch resolved ONCE per call, two loop
        // bodies. `dither: false` (or absent) walks the exact same code
        // as v1.2.0 — the byte-parity guarantee for undithered output
        // is the whole reason the branch is out here and not per-pixel.
        //
        // Dither mechanics (contract owned by lite-color-engine v1.5, F1):
        //   - Blue-noise tile is 64×64 bytes (0..255), shared reference.
        //   - Per pixel: `noiseByte = tile[((y & 63) << 6) | (x & 63)]`
        //     — pure bit ops (torus wrap via mask, row stride via shift).
        //   - `noise01 = (noiseByte + 0.5) / 256` centers the perturbation
        //     around 0.5 so it matches the plain packer's rounding offset.
        //     Consequence: uniform 128 fills would still round identically;
        //     the actual dither effect surfaces on smooth ramps where the
        //     encoded byte lands near an integer boundary.
        //   - Same `noise01` reused for R/G/B at the pixel — luminance-
        //     patterned dither, no chroma speckle.
        const dither = opts != null && opts.dither === true;
        if (dither) {
            const tile = getBlueNoise64();       // shared Uint8Array(4096)
            const INV_256 = 1 / 256;
            let i = 0;
            for (let y = 0; y < height; y++) {
                const v = y * hInv;
                const rowBase = (y & 63) << 6;
                for (let x = 0; x < width; x++) {
                    const u = x * wInv;
                    this.sampleAt(u, v, tmp, mode);
                    const noise01 = (tile[rowBase | (x & 63)] + 0.5) * INV_256;
                    out[i++] = packOklchSingleDithered(tmp.l, tmp.c, tmp.h, tmp.a, noise01);
                }
            }
            return out;
        }
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
        // v1.2.0 — D5: deformed + wrap is a real feature (ghost quads
        // crossing the seam, Newton solve against wrapped corner positions),
        // deferred to v1.3. Silent seamed output is worse than no output —
        // fail loudly with a code consumers can branch on cleanly instead
        // of string-matching. The `WRAP_AXIS_TOO_SMALL` guard in the
        // constructor carries the same `err.code` pattern.
        if (this.wrapX || this.wrapY) {
            const err = new Error(
                'MeshGradient.rasterizeDeformedTo: deformed rasterization on a ' +
                'wrapped mesh is not supported in v1.2 (planned for v1.3). ' +
                'Use rasterizeTo (regular grid) for wrapped meshes.'
            );
            err.code = 'WRAP_DEFORMED_UNSUPPORTED';
            throw err;
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

// ---- Monochrome mesh (v1.1.0) --------------------------------------------

/**
 * Build a monochromatic MeshGradient from a single base OKLCH color.
 *
 * Chroma and hue are held constant across every control point in the mesh;
 * only lightness varies according to `direction`. This is the mesh-level
 * analogue to lite-gradient's `monochromeGradient(base, opts)` — a
 * client-work-friendly mesh that never looks like an "AI-generated random
 * gradient" because the palette is fixed to a single brand tone.
 *
 * Typical use: subtle premium backgrounds for cards, hero sections,
 * editorial layouts. The mesh structure means users can post-hoc
 * `setPointPosition(...)` control points off-grid to warp the L
 * distribution — impossible with a flat 1D gradient.
 *
 * @param {{ l: number, c: number, h: number }} base
 *   OKLCH base color. `c` and `h` are held constant across the mesh
 *   (or c=0 if `mode: 'grayscale'`).
 * @param {number} cols  Number of columns (integer >= 2).
 * @param {number} rows  Number of rows (integer >= 2).
 * @param {Object} [opts]
 * @param {'tinted' | 'grayscale'} [opts.mode='tinted']
 * @param {[number, number]} [opts.range=[0, 1]]
 *   L-axis endpoints. Must satisfy `0 <= lo < hi <= 1`.
 * @param {'horizontal' | 'vertical' | 'diagonal' | 'radial'} [opts.direction='diagonal']
 *   How L varies across the mesh:
 *   - `'horizontal'`: L varies left-to-right, uniform across each row.
 *   - `'vertical'`: L varies top-to-bottom, uniform across each column.
 *   - `'diagonal'`: L varies from top-left (lo) to bottom-right (hi).
 *   - `'radial'`: L is `lo` at center, `hi` at corners.
 * @returns {MeshGradient}
 *
 * @throws {TypeError}  On invalid `base`, `mode`, `direction`, or `range` shape.
 * @throws {RangeError} On invalid `range` values or `cols`/`rows` < 2.
 *
 * @example
 * // Subtle premium background for a brand card
 * const mesh = monochromeMesh({ l: 0.5, c: 0.06, h: 245 }, 3, 3);
 * const buf = new Uint32Array(800 * 600);
 * mesh.rasterizeTo(buf, 800, 600);
 * const img = new ImageData(new Uint8ClampedArray(buf.buffer), 800, 600);
 * ctx.putImageData(img, 0, 0);
 */
export function monochromeMesh(base, cols, rows, opts) {
    if (base == null || typeof base !== 'object' ||
        typeof base.l !== 'number' || typeof base.c !== 'number' ||
        typeof base.h !== 'number') {
        throw new TypeError(
            'monochromeMesh: base must be { l, c, h } with numeric fields'
        );
    }
    if (!Number.isInteger(cols) || cols < 2) {
        throw new RangeError(
            'monochromeMesh: cols must be an integer >= 2, got ' + cols
        );
    }
    if (!Number.isInteger(rows) || rows < 2) {
        throw new RangeError(
            'monochromeMesh: rows must be an integer >= 2, got ' + rows
        );
    }

    const o = opts || {};
    const mode = o.mode == null ? 'tinted' : o.mode;
    const range = o.range == null ? [0, 1] : o.range;
    const direction = o.direction == null ? 'diagonal' : o.direction;

    if (mode !== 'tinted' && mode !== 'grayscale') {
        throw new TypeError(
            'monochromeMesh: mode must be "tinted" or "grayscale", got ' + mode
        );
    }
    if (!Array.isArray(range) || range.length !== 2) {
        throw new TypeError(
            'monochromeMesh: range must be a two-element [lo, hi] array'
        );
    }
    const lo = range[0];
    const hi = range[1];
    if (typeof lo !== 'number' || typeof hi !== 'number' ||
        !(lo >= 0 && hi <= 1 && lo < hi)) {
        throw new RangeError(
            'monochromeMesh: range must satisfy 0 <= lo < hi <= 1, got [' +
            lo + ', ' + hi + ']'
        );
    }
    if (direction !== 'horizontal' && direction !== 'vertical' &&
        direction !== 'diagonal' && direction !== 'radial') {
        throw new TypeError(
            'monochromeMesh: direction must be "horizontal", "vertical", ' +
            '"diagonal", or "radial", got ' + direction
        );
    }

    const c = mode === 'grayscale' ? 0 : base.c;
    const h = base.h;
    const span = hi - lo;
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    // Half-diagonal from center to a corner, used to normalize radial t.
    const maxRadial = Math.sqrt(cx * cx + cy * cy);
    // Diagonal length in grid units (top-left to bottom-right corner),
    // used to normalize diagonal t.
    const diagDenom = (cols - 1) + (rows - 1);

    const total = cols * rows;
    const stops = new Array(total);

    for (let i = 0; i < total; i++) {
        const col = i % cols;
        const row = (i / cols) | 0;

        let t;
        if (direction === 'horizontal') {
            t = cols === 1 ? 0 : col / (cols - 1);
        } else if (direction === 'vertical') {
            t = rows === 1 ? 0 : row / (rows - 1);
        } else if (direction === 'diagonal') {
            t = diagDenom === 0 ? 0 : (col + row) / diagDenom;
        } else {
            // radial: 0 at center, 1 at corners
            const dx = col - cx;
            const dy = row - cy;
            t = maxRadial === 0 ? 0 : Math.sqrt(dx * dx + dy * dy) / maxRadial;
        }

        stops[i] = { l: lo + span * t, c, h };
    }

    return new MeshGradient(cols, rows, stops);
}
