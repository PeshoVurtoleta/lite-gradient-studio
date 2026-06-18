/**
 * Smooth (smoothstep) interpolation coverage. The smooth path applies
 * `t² · (3 − 2t)` to (cu, cv) before the bilinear blend. Properties to
 * pin:
 *   1. corner colors are preserved exactly (smoothstep(0)=0, (1)=1)
 *   2. center color matches the smoothstep-weighted blend, NOT the
 *      plain bilinear blend
 *   3. derivative across quad seams is C¹ (zero on both sides → match)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshGradient } from '../src/index.js';

/* ── corner preservation ─────────────────────────────────────────── */

test('smooth: corners are preserved exactly (smoothstep fixes 0 and 1)', () => {
    const m = new MeshGradient(2, 2, [
        { l: 0.10, c: 0.05, h:  10 },  // (0, 0)
        { l: 0.40, c: 0.15, h: 100 },  // (1, 0)
        { l: 0.60, c: 0.20, h: 190 },  // (0, 1)
        { l: 0.90, c: 0.25, h: 280 },  // (1, 1)
    ]);
    const out = { l: 0, c: 0, h: 0, a: 1 };

    m.sampleAt(0, 0, out, true);
    assert.equal(out.l, 0.10); assert.equal(out.h, 10);

    m.sampleAt(1, 0, out, true);
    assert.equal(out.l, 0.40); assert.equal(out.h, 100);

    m.sampleAt(0, 1, out, true);
    assert.equal(out.l, 0.60); assert.equal(out.h, 190);

    m.sampleAt(1, 1, out, true);
    assert.equal(out.l, 0.90); assert.equal(out.h, 280);
});

/* ── smoothstep vs bilinear difference ───────────────────────────── */

test('smooth: center differs from bilinear (smoothstep weight = 0.5 at t=0.5)', () => {
    // At cu = cv = 0.5, smoothstep(0.5) = 0.5 — same as bilinear!
    // So the result is identical at the patch center; the interesting
    // difference is at other parametric points. Test t = 0.25 instead:
    //   smoothstep(0.25) = 0.0625 × 2.5 = 0.15625
    // For an L ramp [0, 1] along u, the bilinear result is 0.25; the
    // smoothstep result is 0.15625 — measurably different.
    const m = new MeshGradient(2, 2, [
        { l: 0.0, c: 0, h: 0 },   // u=0
        { l: 1.0, c: 0, h: 0 },   // u=1
        { l: 0.0, c: 0, h: 0 },
        { l: 1.0, c: 0, h: 0 },
    ]);
    const bilOut    = { l: 0, c: 0, h: 0, a: 1 };
    const smoothOut = { l: 0, c: 0, h: 0, a: 1 };
    m.sampleAt(0.25, 0.5, bilOut,    false);
    m.sampleAt(0.25, 0.5, smoothOut, true);
    assert.ok(Math.abs(bilOut.l    - 0.25)    < 1e-6, `bilinear L should be 0.25, got ${bilOut.l}`);
    assert.ok(Math.abs(smoothOut.l - 0.15625) < 1e-6, `smooth L should be 0.15625, got ${smoothOut.l}`);
});

test('smooth: at patch center (0.5, 0.5) matches bilinear (smoothstep fixes 0.5 → 0.5)', () => {
    const m = new MeshGradient(2, 2, [
        { l: 0.20, c: 0.10, h: 30 },
        { l: 0.80, c: 0.20, h: 60 },
        { l: 0.30, c: 0.15, h: 90 },
        { l: 0.90, c: 0.25, h: 120 },
    ]);
    const bilOut    = { l: 0, c: 0, h: 0, a: 1 };
    const smoothOut = { l: 0, c: 0, h: 0, a: 1 };
    m.sampleAt(0.5, 0.5, bilOut,    false);
    m.sampleAt(0.5, 0.5, smoothOut, true);
    assert.ok(Math.abs(bilOut.l - smoothOut.l) < 1e-9);
    assert.ok(Math.abs(bilOut.c - smoothOut.c) < 1e-9);
});

/* ── C¹ continuity across quad seams ─────────────────────────────── */

test('smooth: derivative across quad seam is zero on both sides → C¹', () => {
    // 3×3 mesh. The internal seam is at u = 0.5. With smoothstep, the
    // derivative dL/du should be zero on both sides of that seam — the
    // diamond-facet artifact of plain bilinear comes from a non-zero
    // jump in dL/du there.
    const m = new MeshGradient(3, 3, [
        { l: 0.10, c: 0, h: 0 }, { l: 0.50, c: 0, h: 0 }, { l: 0.90, c: 0, h: 0 },
        { l: 0.20, c: 0, h: 0 }, { l: 0.50, c: 0, h: 0 }, { l: 0.80, c: 0, h: 0 },
        { l: 0.30, c: 0, h: 0 }, { l: 0.50, c: 0, h: 0 }, { l: 0.70, c: 0, h: 0 },
    ]);
    const eps = 1e-4;
    const left  = { l: 0, c: 0, h: 0, a: 1 };
    const right = { l: 0, c: 0, h: 0, a: 1 };
    // Sample just before and just after the seam at u = 0.5.
    m.sampleAt(0.5 - eps, 0.5, left,  true);
    m.sampleAt(0.5 + eps, 0.5, right, true);
    // Derivative magnitude on both sides should be tiny — bounded by
    // O(eps) since smoothstep'(0)=smoothstep'(1)=0.
    const dL = Math.abs(right.l - left.l) / (2 * eps);
    assert.ok(dL < 0.5,
        `dL/du across seam should be small (smoothstep edge), got ${dL}`);
});

test('smooth: rasterizeTo(opts.smooth=true) writes pixels (smoke)', () => {
    const m = new MeshGradient(2, 2, [
        { l: 0.5, c: 0.1, h:  0 },
        { l: 0.5, c: 0.1, h: 90 },
        { l: 0.5, c: 0.1, h: 180 },
        { l: 0.5, c: 0.1, h: 270 },
    ]);
    const out = new Uint32Array(8 * 8);
    m.rasterizeTo(out, 8, 8, { smooth: true });
    // Every pixel should be opaque (alpha = 0xFF in high byte).
    for (let i = 0; i < out.length; i++) {
        const a = (out[i] >>> 24) & 0xFF;
        assert.equal(a, 0xFF);
    }
});

test('smooth: rasterizeDeformedTo(opts.smooth=true) writes pixels (smoke)', () => {
    const m = new MeshGradient(2, 2, [
        { l: 0.5, c: 0.1, h:   0 },
        { l: 0.5, c: 0.1, h:  90 },
        { l: 0.5, c: 0.1, h: 180 },
        { l: 0.5, c: 0.1, h: 270 },
    ]);
    const out = new Uint32Array(16 * 16);
    m.rasterizeDeformedTo(out, 16, 16, { smooth: true });
    // Centre pixel should have a non-zero color (mesh covers whole canvas).
    const center = out[8 * 16 + 8];
    assert.notEqual(center, 0);
    // Alpha byte = 0xFF.
    assert.equal((center >>> 24) & 0xFF, 0xFF);
});

test('smooth: rasterizeTo without opts behaves as before (back-compat)', () => {
    // Caller passes no opts → smooth defaults to false → identical
    // output to the v0.0.22 raster.
    const m = new MeshGradient(2, 2, [
        { l: 0.3, c: 0.1, h:   0 },
        { l: 0.7, c: 0.2, h:  90 },
        { l: 0.4, c: 0.1, h: 180 },
        { l: 0.8, c: 0.2, h: 270 },
    ]);
    const bilA = new Uint32Array(4 * 4);
    const bilB = new Uint32Array(4 * 4);
    m.rasterizeTo(bilA, 4, 4);
    m.rasterizeTo(bilB, 4, 4, { smooth: false });
    for (let i = 0; i < bilA.length; i++) {
        assert.equal(bilA[i], bilB[i], `pixel ${i} drifted`);
    }
});
