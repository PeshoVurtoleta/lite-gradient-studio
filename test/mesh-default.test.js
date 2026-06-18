import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MeshGradient, defaultMeshColor } from '../src/index.js';

// ── Validity at all supported sizes ──────────────────────────────────
const SIZES = [
    [2, 2], [3, 3], [4, 4], [5, 5],
    [2, 5], [5, 2], [3, 4], [4, 3],
];

for (const [cols, rows] of SIZES) {
    test(`defaultMeshColor produces valid OKLCH at every cell of ${cols}x${rows}`, () => {
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const k = defaultMeshColor(c, r, cols, rows);
                assert.ok(k.l >= 0 && k.l <= 1,  `L in range at (${c},${r})`);
                assert.ok(k.c >= 0 && k.c <= 0.4, `C in range at (${c},${r})`);
                assert.ok(k.h >= 0 && k.h < 360, `H normalized at (${c},${r}) — got ${k.h}`);
            }
        }
    });
}

// ── No tiling: distinct cells get distinct colors ────────────────────
test('5x5 default has no repeated colors (catches old i%9 tiling bug)', () => {
    const m = new MeshGradient(5, 5);
    const seen = new Set();
    for (const s of m.stops) {
        const key = `${s.l.toFixed(4)}_${s.c.toFixed(4)}_${s.h.toFixed(2)}`;
        assert.ok(!seen.has(key), `duplicate color at L=${s.l} C=${s.c} H=${s.h}`);
        seen.add(key);
    }
    assert.equal(seen.size, 25);
});

test('3x3 default cells are all distinct', () => {
    const m = new MeshGradient(3, 3);
    const seen = new Set();
    for (const s of m.stops) {
        seen.add(`${s.l.toFixed(4)}_${s.c.toFixed(4)}_${s.h.toFixed(2)}`);
    }
    assert.equal(seen.size, 9);
});

// ── Smoothness: adjacent cells are close, not random ─────────────────
test('adjacent cells differ smoothly (no jumps > 0.3 in L, > 0.2 in C)', () => {
    const m = new MeshGradient(5, 5);
    const cols = m.cols, rows = m.rows;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols - 1; c++) {
            const a = m.stops[r * cols + c];
            const b = m.stops[r * cols + c + 1];
            assert.ok(Math.abs(a.l - b.l) < 0.3, `horizontal L jump at (${c},${r})`);
            assert.ok(Math.abs(a.c - b.c) < 0.2, `horizontal C jump at (${c},${r})`);
        }
    }
    for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols; c++) {
            const a = m.stops[r * cols + c];
            const b = m.stops[(r + 1) * cols + c];
            assert.ok(Math.abs(a.l - b.l) < 0.3, `vertical L jump at (${c},${r})`);
            assert.ok(Math.abs(a.c - b.c) < 0.2, `vertical C jump at (${c},${r})`);
        }
    }
});

// ── Determinism: pure function, same inputs → same outputs ──────────
test('defaultMeshColor is pure (deterministic, no internal state)', () => {
    const a = defaultMeshColor(1, 2, 4, 4);
    const b = defaultMeshColor(1, 2, 4, 4);
    assert.deepEqual(a, b);
});

// ── Corners actually use the extreme parameterization ───────────────
test('corner L values match expected formula endpoints', () => {
    // L = 0.70 - 0.30 * rT. Top row rT=0 → L=0.70. Bottom row rT=1 → L=0.40.
    const tl = defaultMeshColor(0,    0,    4, 4);
    const tr = defaultMeshColor(3,    0,    4, 4);
    const bl = defaultMeshColor(0,    3,    4, 4);
    const br = defaultMeshColor(3,    3,    4, 4);
    assert.ok(Math.abs(tl.l - 0.70) < 1e-9, 'top row L = 0.70');
    assert.ok(Math.abs(tr.l - 0.70) < 1e-9);
    assert.ok(Math.abs(bl.l - 0.40) < 1e-9, 'bottom row L = 0.40');
    assert.ok(Math.abs(br.l - 0.40) < 1e-9);
});

// ── Mesh constructor at varied sizes ────────────────────────────────
for (const [cols, rows] of SIZES) {
    test(`new MeshGradient(${cols}, ${rows}) populates ${cols * rows} stops`, () => {
        const m = new MeshGradient(cols, rows);
        assert.equal(m.stops.length, cols * rows);
        // Spot-check that positions span the unit square.
        const tl = m.stops[0];
        const br = m.stops[m.stops.length - 1];
        assert.equal(tl.x, 0); assert.equal(tl.y, 0);
        assert.equal(br.x, 1); assert.equal(br.y, 1);
    });
}
