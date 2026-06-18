/**
 * Catmull-Rom 2D interpolation coverage.
 *
 * Properties to pin:
 *   1. corner colors preserved exactly (Catmull-Rom passes through p1/p2)
 *   2. hue wrap-around handled (e.g. samples between 350° and 10° don't
 *      take the long way through 180°)
 *   3. channels clamped to valid ranges (cubic can overshoot)
 *   4. opts.interpolation = 'cubic' routes through this path
 *   5. legacy opts.smooth still works (back-compat)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshGradient } from '../src/index.js';

/* ── corner preservation ─────────────────────────────────────────── */

test('cubic: grid points are preserved exactly at their (u, v)', () => {
    const m = new MeshGradient(3, 3, [
        { l: 0.10, c: 0.05, h:  10 }, { l: 0.40, c: 0.15, h: 100 }, { l: 0.70, c: 0.20, h: 190 },
        { l: 0.20, c: 0.10, h:  50 }, { l: 0.50, c: 0.18, h: 130 }, { l: 0.80, c: 0.22, h: 220 },
        { l: 0.30, c: 0.12, h:  80 }, { l: 0.60, c: 0.20, h: 160 }, { l: 0.90, c: 0.25, h: 250 },
    ]);
    const out = { l: 0, c: 0, h: 0, a: 1 };
    // Center stop = (col 1, row 1) = u = 0.5, v = 0.5
    m.sampleAt(0.5, 0.5, out, 'cubic');
    // Catmull-Rom passes through p1 (= center stop), so values match exactly.
    assert.ok(Math.abs(out.l - 0.50) < 1e-6, `L got ${out.l}`);
    assert.ok(Math.abs(out.c - 0.18) < 1e-6, `C got ${out.c}`);
    assert.ok(Math.abs(out.h - 130) < 1e-4,  `H got ${out.h}`);
});

test('cubic: 4 corners preserved exactly', () => {
    const m = new MeshGradient(3, 3, [
        { l: 0.10, c: 0.05, h:  10 }, { l: 0.40, c: 0.15, h: 100 }, { l: 0.70, c: 0.20, h: 190 },
        { l: 0.20, c: 0.10, h:  50 }, { l: 0.50, c: 0.18, h: 130 }, { l: 0.80, c: 0.22, h: 220 },
        { l: 0.30, c: 0.12, h:  80 }, { l: 0.60, c: 0.20, h: 160 }, { l: 0.90, c: 0.25, h: 250 },
    ]);
    const out = { l: 0, c: 0, h: 0, a: 1 };

    m.sampleAt(0, 0, out, 'cubic');
    assert.ok(Math.abs(out.l - 0.10) < 1e-6); assert.ok(Math.abs(out.h - 10) < 1e-4);
    m.sampleAt(1, 0, out, 'cubic');
    assert.ok(Math.abs(out.l - 0.70) < 1e-6); assert.ok(Math.abs(out.h - 190) < 1e-4);
    m.sampleAt(0, 1, out, 'cubic');
    assert.ok(Math.abs(out.l - 0.30) < 1e-6); assert.ok(Math.abs(out.h - 80) < 1e-4);
    m.sampleAt(1, 1, out, 'cubic');
    assert.ok(Math.abs(out.l - 0.90) < 1e-6); assert.ok(Math.abs(out.h - 250) < 1e-4);
});

/* ── hue wrap handling ────────────────────────────────────────────── */

test('cubic: hue wrap takes the short way (350° → 10° passes through 0°)', () => {
    // 3×3 mesh, all stops have similar L/C. Hues are arranged so the
    // x-axis sweeps from 350° to 10° — should travel +20° through 0°,
    // NOT -340° through 180°.
    const m = new MeshGradient(3, 3, [
        { l: 0.5, c: 0.1, h: 350 }, { l: 0.5, c: 0.1, h:   0 }, { l: 0.5, c: 0.1, h: 10 },
        { l: 0.5, c: 0.1, h: 350 }, { l: 0.5, c: 0.1, h:   0 }, { l: 0.5, c: 0.1, h: 10 },
        { l: 0.5, c: 0.1, h: 350 }, { l: 0.5, c: 0.1, h:   0 }, { l: 0.5, c: 0.1, h: 10 },
    ]);
    const out = { l: 0, c: 0, h: 0, a: 1 };
    // Sample at midway between (col 0, row 1) and (col 1, row 1) — should
    // land near 355°, NOT 175°.
    m.sampleAt(0.25, 0.5, out, 'cubic');
    // Acceptable range: ~340° to ~360° (or ~0°)
    const within = (out.h >= 340 && out.h <= 360) || out.h < 20;
    assert.ok(within, `expected hue near the short-path midpoint, got ${out.h}`);
});

/* ── overshoot clamping ──────────────────────────────────────────── */

test('cubic: channel overshoot is clamped to valid range', () => {
    // Construct a mesh where Catmull-Rom would naturally overshoot.
    // Inner stops are high-L (0.9); outer stops also at 0.9; one anchor
    // at 0.3 induces a cubic that wants to overshoot above 0.9 (or below 0.3).
    // Verify the output is clamped to [0, 1].
    const m = new MeshGradient(4, 4, [
        { l: 0.30, c: 0.10, h: 0 }, { l: 0.90, c: 0.10, h: 0 }, { l: 0.90, c: 0.10, h: 0 }, { l: 0.30, c: 0.10, h: 0 },
        { l: 0.30, c: 0.10, h: 0 }, { l: 0.90, c: 0.10, h: 0 }, { l: 0.90, c: 0.10, h: 0 }, { l: 0.30, c: 0.10, h: 0 },
        { l: 0.30, c: 0.10, h: 0 }, { l: 0.90, c: 0.10, h: 0 }, { l: 0.90, c: 0.10, h: 0 }, { l: 0.30, c: 0.10, h: 0 },
        { l: 0.30, c: 0.10, h: 0 }, { l: 0.90, c: 0.10, h: 0 }, { l: 0.90, c: 0.10, h: 0 }, { l: 0.30, c: 0.10, h: 0 },
    ]);
    const out = { l: 0, c: 0, h: 0, a: 1 };
    // Sample several points; none should exceed [0, 1] for L.
    for (let t = 0; t <= 1; t += 0.05) {
        m.sampleAt(t, 0.5, out, 'cubic');
        assert.ok(out.l >= 0 && out.l <= 1, `L overshot: ${out.l} at u=${t}`);
        assert.ok(out.c >= 0 && out.c <= 0.5, `C overshot: ${out.c} at u=${t}`);
        assert.ok(out.h >= 0 && out.h < 360,  `H out of range: ${out.h}`);
    }
});

/* ── opts.interpolation routing ──────────────────────────────────── */

test('rasterizeTo: opts.interpolation = "cubic" produces output', () => {
    const m = new MeshGradient(3, 3, [
        { l: 0.30, c: 0.10, h:  10 }, { l: 0.50, c: 0.15, h:  90 }, { l: 0.70, c: 0.20, h: 170 },
        { l: 0.40, c: 0.12, h:  50 }, { l: 0.60, c: 0.18, h: 130 }, { l: 0.80, c: 0.22, h: 210 },
        { l: 0.50, c: 0.15, h:  90 }, { l: 0.70, c: 0.20, h: 170 }, { l: 0.90, c: 0.25, h: 250 },
    ]);
    const out = new Uint32Array(16 * 16);
    m.rasterizeTo(out, 16, 16, { interpolation: 'cubic' });
    // Every pixel opaque, non-zero color.
    for (let i = 0; i < out.length; i++) {
        const alpha = (out[i] >>> 24) & 0xFF;
        assert.equal(alpha, 0xFF, `pixel ${i} alpha != 0xFF`);
        assert.notEqual(out[i] & 0x00FFFFFF, 0, `pixel ${i} is black`);
    }
});

test('rasterizeTo: opts.interpolation differs from opts.smooth output', () => {
    // A pixel away from grid points should produce a different color
    // for cubic vs smooth — both differ from raw bilinear too.
    const m = new MeshGradient(3, 3, [
        { l: 0.10, c: 0.10, h:  10 }, { l: 0.90, c: 0.10, h:  10 }, { l: 0.10, c: 0.10, h:  10 },
        { l: 0.10, c: 0.10, h:  10 }, { l: 0.10, c: 0.10, h:  10 }, { l: 0.10, c: 0.10, h:  10 },
        { l: 0.10, c: 0.10, h:  10 }, { l: 0.10, c: 0.10, h:  10 }, { l: 0.10, c: 0.10, h:  10 },
    ]);
    const bil    = { l: 0, c: 0, h: 0, a: 1 };
    const smooth = { l: 0, c: 0, h: 0, a: 1 };
    const cubic  = { l: 0, c: 0, h: 0, a: 1 };
    // Sample at u = 0.15 (NOT a patch center — at the midpoint
    // smoothstep(0.5)=0.5 makes bilinear and smooth identical).
    m.sampleAt(0.15, 0, bil,    'bilinear');
    m.sampleAt(0.15, 0, smooth, 'smooth');
    m.sampleAt(0.15, 0, cubic,  'cubic');
    assert.ok(Math.abs(bil.l - smooth.l) > 1e-3,
        `bilinear (${bil.l}) and smooth (${smooth.l}) should differ`);
    assert.ok(Math.abs(smooth.l - cubic.l) > 1e-3,
        `smooth (${smooth.l}) and cubic (${cubic.l}) should differ`);
});

/* ── back-compat ─────────────────────────────────────────────────── */

test('legacy opts.smooth=true still routes to smoothstep path', () => {
    const m = new MeshGradient(2, 2, [
        { l: 0.30, c: 0.10, h:   0 },
        { l: 0.70, c: 0.10, h:   0 },
        { l: 0.30, c: 0.10, h: 180 },
        { l: 0.70, c: 0.10, h: 180 },
    ]);
    const a = new Uint32Array(8 * 8);
    const b = new Uint32Array(8 * 8);
    m.rasterizeTo(a, 8, 8, { smooth: true });
    m.rasterizeTo(b, 8, 8, { interpolation: 'smooth' });
    for (let i = 0; i < a.length; i++) {
        assert.equal(a[i], b[i], `opts.smooth and opts.interpolation='smooth' diverged at pixel ${i}`);
    }
});

test('cubic: rasterizeDeformedTo with opts.interpolation = "cubic" writes pixels', () => {
    const m = new MeshGradient(3, 3, [
        { l: 0.30, c: 0.10, h:  10 }, { l: 0.50, c: 0.15, h:  90 }, { l: 0.70, c: 0.20, h: 170 },
        { l: 0.40, c: 0.12, h:  50 }, { l: 0.60, c: 0.18, h: 130 }, { l: 0.80, c: 0.22, h: 210 },
        { l: 0.50, c: 0.15, h:  90 }, { l: 0.70, c: 0.20, h: 170 }, { l: 0.90, c: 0.25, h: 250 },
    ]);
    const out = new Uint32Array(24 * 24);
    m.rasterizeDeformedTo(out, 24, 24, { interpolation: 'cubic' });
    // Center pixel should have non-zero color, opaque alpha.
    const center = out[12 * 24 + 12];
    assert.notEqual(center, 0, 'centre pixel should be non-zero');
    assert.equal((center >>> 24) & 0xFF, 0xFF);
});
