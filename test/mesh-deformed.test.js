import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MeshGradient, packOklchSingle } from '../src/index.js';

const cornersTL = { l: 0.30, c: 0.20, h: 270 };
const cornersTR = { l: 0.55, c: 0.18, h:  30 };
const cornersBL = { l: 0.45, c: 0.22, h: 150 };
const cornersBR = { l: 0.85, c: 0.10, h:  90 };

function make2x2() {
    return new MeshGradient(2, 2, [cornersTL, cornersTR, cornersBL, cornersBR]);
}

// ── Position defaults ────────────────────────────────────────────────
test('default positions form a regular grid in [0,1] x [0,1]', () => {
    const m = new MeshGradient(3, 3);
    const out = { x: 0, y: 0 };
    m.getPointPosition(0, 0, out);
    assert.equal(out.x, 0);   assert.equal(out.y, 0);
    m.getPointPosition(2, 2, out);
    assert.equal(out.x, 1);   assert.equal(out.y, 1);
    m.getPointPosition(1, 1, out);
    assert.equal(out.x, 0.5); assert.equal(out.y, 0.5);
});

test('caller-provided x/y in stops override defaults', () => {
    const m = new MeshGradient(2, 2, [
        { ...cornersTL, x: 0.10, y: 0.05 },
        { ...cornersTR, x: 0.95, y: 0.10 },
        { ...cornersBL, x: 0.00, y: 0.90 },
        { ...cornersBR, x: 1.00, y: 1.00 },
    ]);
    const out = { x: 0, y: 0 };
    m.getPointPosition(0, 0, out);
    assert.equal(out.x, 0.10); assert.equal(out.y, 0.05);
    m.getPointPosition(1, 0, out);
    assert.equal(out.x, 0.95); assert.equal(out.y, 0.10);
});

// ── set/get/reset ────────────────────────────────────────────────────
test('setPointPosition mutates in place', () => {
    const m = make2x2();
    m.setPointPosition(0, 0, 0.25, 0.35);
    const out = { x: 0, y: 0 };
    m.getPointPosition(0, 0, out);
    assert.equal(out.x, 0.25);
    assert.equal(out.y, 0.35);
});

test('resetPositions restores the regular grid', () => {
    const m = new MeshGradient(3, 3);
    m.setPointPosition(1, 1, 0.99, 0.01);
    m.resetPositions();
    const out = { x: 0, y: 0 };
    m.getPointPosition(1, 1, out);
    assert.equal(out.x, 0.5);
    assert.equal(out.y, 0.5);
});

// ── Deformed rasterizer: identity case matches the regular path ─────
test('deformed rasterizer with default positions ≈ regular rasterizer', () => {
    // With positions on the regular grid, the deformed kernel should
    // produce essentially the same image as the regular kernel — within
    // a small per-channel tolerance for the inverse-bilinear arithmetic.
    const m = make2x2();
    const W = 16, H = 16;
    const reg  = new Uint32Array(W * H);
    const def  = new Uint32Array(W * H);
    m.rasterizeTo(reg, W, H);
    m.rasterizeDeformedTo(def, W, H);

    const u8r = new Uint8ClampedArray(reg.buffer);
    const u8d = new Uint8ClampedArray(def.buffer);

    let maxDelta = 0;
    for (let i = 0; i < u8r.length; i++) {
        const d = Math.abs(u8r[i] - u8d[i]);
        if (d > maxDelta) maxDelta = d;
    }
    // Inverse bilinear at the canvas edge can be 1 LSB off due to the
    // Newton converge threshold; keep this generous and revisit if it
    // grows.
    assert.ok(maxDelta <= 2,
        `regular vs deformed identity-case max channel delta = ${maxDelta} (expected ≤ 2)`);
});

// ── Deformed rasterizer: corner pixels at corner positions ───────────
test('deformed rasterizer: corner pixels match packed corner colors', () => {
    const m = make2x2();
    const W = 32, H = 32;
    const buf = new Uint32Array(W * H);
    m.rasterizeDeformedTo(buf, W, H);

    const expectTL = packOklchSingle(cornersTL.l, cornersTL.c, cornersTL.h, 1);
    const expectTR = packOklchSingle(cornersTR.l, cornersTR.c, cornersTR.h, 1);
    const expectBL = packOklchSingle(cornersBL.l, cornersBL.c, cornersBL.h, 1);
    const expectBR = packOklchSingle(cornersBR.l, cornersBR.c, cornersBR.h, 1);

    const channelDelta = (a, b) => {
        let max = 0;
        for (let sh = 0; sh < 32; sh += 8) {
            const d = Math.abs(((a >>> sh) & 0xFF) - ((b >>> sh) & 0xFF));
            if (d > max) max = d;
        }
        return max;
    };
    assert.ok(channelDelta(buf[0],             expectTL) <= 1, 'TL corner');
    assert.ok(channelDelta(buf[W - 1],         expectTR) <= 1, 'TR corner');
    assert.ok(channelDelta(buf[(H - 1) * W],   expectBL) <= 1, 'BL corner');
    assert.ok(channelDelta(buf[W * H - 1],     expectBR) <= 1, 'BR corner');
});

// ── Deformed rasterizer: actually deformed produces different output ─
test('deformed rasterizer with shifted point != regular rasterizer', () => {
    const m = make2x2();
    const W = 32, H = 32;
    const reg = new Uint32Array(W * H);
    const def = new Uint32Array(W * H);

    m.rasterizeTo(reg, W, H);
    m.setPointPosition(1, 0, 0.25, 0.0);  // pull TR corner left
    m.rasterizeDeformedTo(def, W, H);

    let differentPixels = 0;
    for (let i = 0; i < reg.length; i++) {
        if (reg[i] !== def[i]) differentPixels++;
    }
    assert.ok(differentPixels > W * H / 10,
        `expected substantial difference after deformation; only ${differentPixels} / ${reg.length} pixels differ`);
});

// ── Deformed rasterizer rejects bad out ──────────────────────────────
test('rasterizeDeformedTo validates out buffer', () => {
    const m = make2x2();
    assert.throws(() => m.rasterizeDeformedTo(new Uint32Array(4), 8, 8), /length >= width\*height/);
    assert.throws(() => m.rasterizeDeformedTo([], 4, 4), /Uint32Array/);
});

// ── Deformed rasterizer: pixels outside any quad stay zero ───────────
test('deformed rasterizer leaves pixels outside the mesh untouched', () => {
    const m = make2x2();
    // Shrink the mesh into the top-left quarter of the canvas.
    m.setPointPosition(0, 0, 0.0, 0.0);
    m.setPointPosition(1, 0, 0.5, 0.0);
    m.setPointPosition(0, 1, 0.0, 0.5);
    m.setPointPosition(1, 1, 0.5, 0.5);

    const W = 32, H = 32;
    const buf = new Uint32Array(W * H);
    // Pre-fill with a sentinel that the renderer must not overwrite outside
    // the mesh.
    buf.fill(0xDEADBEEF);
    m.rasterizeDeformedTo(buf, W, H);

    // Bottom-right pixel is well outside the shrunk mesh; sentinel survives.
    assert.equal(buf[W * H - 1], 0xDEADBEEF,
        'pixel outside the deformed mesh region must not be written');
    // Top-left pixel is inside; sentinel overwritten.
    assert.notEqual(buf[0], 0xDEADBEEF, 'pixel inside the mesh region must be written');
});
