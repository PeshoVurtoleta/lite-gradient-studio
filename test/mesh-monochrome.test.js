/**
 * monochromeMesh(base, cols, rows, opts?) — factory returning a MeshGradient
 * with all points sharing base c/h (or c=0 for grayscale), L varying per direction.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MeshGradient, monochromeMesh } from '../src/mesh.js';

// ---- Returns a valid MeshGradient ----

test('monochromeMesh returns a MeshGradient instance', () => {
    const m = monochromeMesh({ l: 0.5, c: 0.15, h: 260 }, 3, 3);
    assert.ok(m instanceof MeshGradient);
});

test('monochromeMesh honors cols and rows in the returned mesh', () => {
    const m = monochromeMesh({ l: 0.5, c: 0, h: 0 }, 4, 5);
    assert.equal(m.cols, 4);
    assert.equal(m.rows, 5);
    assert.equal(m.stops.length, 20);
});

// ---- Modes ----

test('monochromeMesh default mode=tinted retains base chroma and hue', () => {
    const m = monochromeMesh({ l: 0.5, c: 0.15, h: 260 }, 3, 3);
    for (const s of m.stops) {
        assert.equal(s.c, 0.15);
        assert.equal(s.h, 260);
    }
});

test('monochromeMesh grayscale mode forces c=0 across all points', () => {
    const m = monochromeMesh(
        { l: 0.5, c: 0.35, h: 120 },
        3, 3,
        { mode: 'grayscale' }
    );
    for (const s of m.stops) assert.equal(s.c, 0);
});

// ---- Direction: horizontal ----

test('monochromeMesh direction=horizontal: L varies across columns, uniform per row', () => {
    const m = monochromeMesh(
        { l: 0.5, c: 0, h: 0 },
        3, 3,
        { direction: 'horizontal' }
    );
    // For a 3x3 mesh, columns 0/1/2 → L = 0/0.5/1
    // Check row 0
    assert.ok(Math.abs(m.stops[0].l - 0) < 1e-12);   // col 0, row 0
    assert.ok(Math.abs(m.stops[1].l - 0.5) < 1e-12); // col 1, row 0
    assert.ok(Math.abs(m.stops[2].l - 1) < 1e-12);   // col 2, row 0
    // Row 1 should mirror row 0 exactly
    assert.equal(m.stops[3].l, m.stops[0].l); // col 0, row 1 == col 0, row 0
    assert.equal(m.stops[4].l, m.stops[1].l);
    assert.equal(m.stops[5].l, m.stops[2].l);
});

// ---- Direction: vertical ----

test('monochromeMesh direction=vertical: L varies across rows, uniform per column', () => {
    const m = monochromeMesh(
        { l: 0.5, c: 0, h: 0 },
        3, 3,
        { direction: 'vertical' }
    );
    // Rows 0/1/2 → L = 0/0.5/1; each column identical
    assert.ok(Math.abs(m.stops[0].l - 0) < 1e-12);   // row 0
    assert.ok(Math.abs(m.stops[3].l - 0.5) < 1e-12); // row 1
    assert.ok(Math.abs(m.stops[6].l - 1) < 1e-12);   // row 2
    // Within row 0, all columns share L
    assert.equal(m.stops[0].l, m.stops[1].l);
    assert.equal(m.stops[1].l, m.stops[2].l);
});

// ---- Direction: diagonal (default) ----

test('monochromeMesh default direction is diagonal', () => {
    const explicit = monochromeMesh({ l: 0.5, c: 0, h: 0 }, 3, 3, { direction: 'diagonal' });
    const implicit = monochromeMesh({ l: 0.5, c: 0, h: 0 }, 3, 3);
    for (let i = 0; i < 9; i++) {
        assert.equal(explicit.stops[i].l, implicit.stops[i].l);
    }
});

test('monochromeMesh direction=diagonal: top-left is lo, bottom-right is hi', () => {
    const m = monochromeMesh(
        { l: 0.5, c: 0, h: 0 },
        3, 3,
        { direction: 'diagonal', range: [0.2, 0.9] }
    );
    // Top-left corner (col 0, row 0)
    assert.ok(Math.abs(m.stops[0].l - 0.2) < 1e-12);
    // Bottom-right corner (col 2, row 2, index 8)
    assert.ok(Math.abs(m.stops[8].l - 0.9) < 1e-12);
});

// ---- Direction: radial ----

test('monochromeMesh direction=radial: center is lo, corners are hi', () => {
    const m = monochromeMesh(
        { l: 0.5, c: 0, h: 0 },
        3, 3,
        { direction: 'radial' }
    );
    // Center of 3x3 is (1, 1), index 4
    assert.ok(Math.abs(m.stops[4].l - 0) < 1e-12);
    // Corners should be at max L (1)
    // Corner (0,0) index 0
    assert.ok(Math.abs(m.stops[0].l - 1) < 1e-12);
    // Corner (2,0) index 2
    assert.ok(Math.abs(m.stops[2].l - 1) < 1e-12);
    // Corner (0,2) index 6
    assert.ok(Math.abs(m.stops[6].l - 1) < 1e-12);
    // Corner (2,2) index 8
    assert.ok(Math.abs(m.stops[8].l - 1) < 1e-12);
});

// ---- Range ----

test('monochromeMesh custom range endpoints are respected', () => {
    const m = monochromeMesh(
        { l: 0.5, c: 0, h: 0 },
        3, 3,
        { direction: 'horizontal', range: [0.15, 0.85] }
    );
    // Col 0 → L=0.15; Col 2 → L=0.85
    assert.ok(Math.abs(m.stops[0].l - 0.15) < 1e-12);
    assert.ok(Math.abs(m.stops[2].l - 0.85) < 1e-12);
});

// ---- Sampling ----

test('monochromeMesh returned mesh samples correctly via sampleAt', () => {
    const m = monochromeMesh({ l: 0.5, c: 0.1, h: 240 }, 3, 3);
    const out = { l: 0, c: 0, h: 0, a: 0 };
    m.sampleAt(0.5, 0.5, out); // center should be roughly middle L
    assert.ok(out.l > 0 && out.l < 1);
    assert.equal(out.c, 0.1);
    assert.equal(out.h, 240);
});

// ---- Validation ----

test('monochromeMesh throws on missing/malformed base', () => {
    assert.throws(() => monochromeMesh(null, 3, 3), /base/);
    assert.throws(() => monochromeMesh({}, 3, 3), /base/);
    assert.throws(() => monochromeMesh({ l: 0.5, c: 'x', h: 0 }, 3, 3), /base/);
});

test('monochromeMesh throws on invalid cols/rows', () => {
    const base = { l: 0.5, c: 0, h: 0 };
    assert.throws(() => monochromeMesh(base, 1, 3), /cols/);
    assert.throws(() => monochromeMesh(base, 3, 1), /rows/);
    assert.throws(() => monochromeMesh(base, 2.5, 3), /cols/);
    assert.throws(() => monochromeMesh(base, 3, 0), /rows/);
});

test('monochromeMesh throws on unknown mode', () => {
    assert.throws(
        () => monochromeMesh({ l: 0.5, c: 0, h: 0 }, 3, 3, { mode: 'nope' }),
        /mode/
    );
});

test('monochromeMesh throws on unknown direction', () => {
    assert.throws(
        () => monochromeMesh({ l: 0.5, c: 0, h: 0 }, 3, 3, { direction: 'sideways' }),
        /direction/
    );
});

test('monochromeMesh throws on invalid range', () => {
    const base = { l: 0.5, c: 0, h: 0 };
    assert.throws(() => monochromeMesh(base, 3, 3, { range: [0.5, 0.5] }), /range/);
    assert.throws(() => monochromeMesh(base, 3, 3, { range: [0.8, 0.2] }), /range/);
    assert.throws(() => monochromeMesh(base, 3, 3, { range: [-0.1, 0.9] }), /range/);
});

// ---- Isolation ----

test('monochromeMesh does not mutate the input base', () => {
    const base = { l: 0.5, c: 0.15, h: 260 };
    monochromeMesh(base, 3, 3, { mode: 'grayscale' });
    assert.equal(base.l, 0.5);
    assert.equal(base.c, 0.15);
    assert.equal(base.h, 260);
});

test('monochromeMesh: separate calls produce independent meshes', () => {
    const base = { l: 0.5, c: 0.15, h: 260 };
    const a = monochromeMesh(base, 3, 3);
    const b = monochromeMesh(base, 3, 3);
    a.setPoint(0, 0, 0.99, 0, 0);
    // b's corresponding point should be unaffected
    assert.notEqual(a.stops[0].l, b.stops[0].l);
});
