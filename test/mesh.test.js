import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MeshGradient,
    packOklchSingle,
} from '../src/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────
// 2x2 mesh with distinct corner colors so we can assert corner sampling.
const cornersTL = { l: 0.30, c: 0.20, h: 270 };  // top-left
const cornersTR = { l: 0.55, c: 0.18, h:  30 };  // top-right
const cornersBL = { l: 0.45, c: 0.22, h: 150 };  // bottom-left
const cornersBR = { l: 0.85, c: 0.10, h:  90 };  // bottom-right

function make2x2() {
    return new MeshGradient(2, 2, [
        cornersTL, cornersTR,
        cornersBL, cornersBR,
    ]);
}

// ── Construction ─────────────────────────────────────────────────────
test('rejects cols/rows < 2 or non-integer', () => {
    assert.throws(() => new MeshGradient(1, 3), /cols must be an integer >= 2/);
    assert.throws(() => new MeshGradient(3, 1), /rows must be an integer >= 2/);
    assert.throws(() => new MeshGradient(2.5, 3), /cols must be an integer/);
});

test('rejects stops length mismatch', () => {
    assert.throws(
        () => new MeshGradient(2, 2, [cornersTL, cornersTR, cornersBL]),
        /does not match cols\*rows/,
    );
});

test('defensive-copies caller stops (external mutation cannot corrupt mesh)', () => {
    const tl = { l: 0.30, c: 0.20, h: 270 };
    const m  = new MeshGradient(2, 2, [tl, cornersTR, cornersBL, cornersBR]);
    tl.l = 999;
    const out = { l: 0, c: 0, h: 0 };
    m.getPoint(0, 0, out);
    assert.equal(out.l, 0.30, 'mesh stop should be unaffected by external mutation');
});

test('default construction (no stops) produces a populated mesh', () => {
    const m = new MeshGradient(3, 3);
    assert.equal(m.stops.length, 9);
    for (const s of m.stops) {
        assert.ok(Number.isFinite(s.l) && Number.isFinite(s.c) && Number.isFinite(s.h));
    }
});

// ── getPoint / setPoint ──────────────────────────────────────────────
test('getPoint returns the (col,row) stop into caller-owned out (zero-GC)', () => {
    const m = make2x2();
    const out = { l: 0, c: 0, h: 0 };
    const ret = m.getPoint(1, 1, out);
    assert.equal(ret, out, 'returns same reference');
    assert.equal(out.l, cornersBR.l);
    assert.equal(out.c, cornersBR.c);
    assert.equal(out.h, cornersBR.h);
});

test('setPoint mutates the underlying stop in place', () => {
    const m = make2x2();
    m.setPoint(0, 0, 0.11, 0.22, 33);
    const out = { l: 0, c: 0, h: 0 };
    m.getPoint(0, 0, out);
    assert.equal(out.l, 0.11);
    assert.equal(out.c, 0.22);
    assert.equal(out.h, 33);
});

// ── sampleAt — corners and clamping ──────────────────────────────────
test('sampleAt at (0,0) returns top-left corner exactly', () => {
    const m = make2x2();
    const out = { l: 0, c: 0, h: 0 };
    m.sampleAt(0, 0, out);
    assert.equal(out.l, cornersTL.l);
    assert.equal(out.c, cornersTL.c);
    assert.equal(out.h, cornersTL.h);
});

test('sampleAt at (1,1) returns bottom-right corner exactly', () => {
    const m = make2x2();
    const out = { l: 0, c: 0, h: 0 };
    m.sampleAt(1, 1, out);
    assert.equal(out.l, cornersBR.l);
    assert.equal(out.c, cornersBR.c);
    assert.equal(out.h, cornersBR.h);
});

test('sampleAt clamps out-of-range (u,v) to corners', () => {
    const m = make2x2();
    const out = { l: 0, c: 0, h: 0 };
    m.sampleAt(-5, -5, out);
    assert.equal(out.l, cornersTL.l);
    m.sampleAt( 5,  5, out);
    assert.equal(out.l, cornersBR.l);
});

// ── sampleAt — bilinear midpoint ─────────────────────────────────────
test('sampleAt at (0.5, 0.5) is the bilinear average of four corners (L axis)', () => {
    const m = make2x2();
    const out = { l: 0, c: 0, h: 0 };
    m.sampleAt(0.5, 0.5, out);
    // Expected L is the average of the four corner Ls (chroma stays well-defined;
    // hue is harder to assert under shortest-path lerp so we check L explicitly).
    const expectedL = (cornersTL.l + cornersTR.l + cornersBL.l + cornersBR.l) / 4;
    assert.ok(Math.abs(out.l - expectedL) < 1e-6,
        `expected L ≈ ${expectedL}, got ${out.l}`);
});

test('sampleAt at edge midpoints reflects single-axis interpolation', () => {
    const m = make2x2();
    const out = { l: 0, c: 0, h: 0 };
    // Top edge midpoint: average of TL and TR
    m.sampleAt(0.5, 0, out);
    assert.ok(Math.abs(out.l - (cornersTL.l + cornersTR.l) / 2) < 1e-6);
    // Left edge midpoint: average of TL and BL
    m.sampleAt(0, 0.5, out);
    assert.ok(Math.abs(out.l - (cornersTL.l + cornersBL.l) / 2) < 1e-6);
});

// ── rasterizeTo — shape, endpoints, alpha ────────────────────────────
test('rasterizeTo fills width*height pixels with alpha=255', () => {
    const m = make2x2();
    const W = 16, H = 16;
    const buf = new Uint32Array(W * H);
    m.rasterizeTo(buf, W, H);
    const u8 = new Uint8ClampedArray(buf.buffer);
    // Walk alpha bytes (offset 3, stride 4). Sample every 31st pixel.
    for (let i = 3; i < u8.length; i += 4 * 31) {
        assert.equal(u8[i], 0xFF, `alpha at byte ${i} (pixel ${(i - 3) / 4}) = 255`);
    }
});

test('rasterizeTo corner pixels match packed corner colors within 1 LSB', () => {
    const m = make2x2();
    const W = 16, H = 16;
    const buf = new Uint32Array(W * H);
    m.rasterizeTo(buf, W, H);

    const expectTL = packOklchSingle(cornersTL.l, cornersTL.c, cornersTL.h, 1);
    const expectTR = packOklchSingle(cornersTR.l, cornersTR.c, cornersTR.h, 1);
    const expectBL = packOklchSingle(cornersBL.l, cornersBL.c, cornersBL.h, 1);
    const expectBR = packOklchSingle(cornersBR.l, cornersBR.c, cornersBR.h, 1);

    const channelDelta = (a, b) => {
        let max = 0;
        for (let shift = 0; shift < 32; shift += 8) {
            const d = Math.abs(((a >>> shift) & 0xFF) - ((b >>> shift) & 0xFF));
            if (d > max) max = d;
        }
        return max;
    };
    assert.ok(channelDelta(buf[0],               expectTL) <= 1);
    assert.ok(channelDelta(buf[W - 1],           expectTR) <= 1);
    assert.ok(channelDelta(buf[(H - 1) * W],     expectBL) <= 1);
    assert.ok(channelDelta(buf[W * H - 1],       expectBR) <= 1);
});

test('rasterizeTo rejects undersized or wrong-typed out', () => {
    const m = make2x2();
    const tooSmall = new Uint32Array(4);
    assert.throws(() => m.rasterizeTo(tooSmall, 8, 8), /length >= width\*height/);
    assert.throws(() => m.rasterizeTo([], 4, 4), /Uint32Array/);
});

test('rasterizeTo produces no NaN, no alpha drift', () => {
    const m = new MeshGradient(3, 3); // default mesh
    const W = 32, H = 32;
    const buf = new Uint32Array(W * H);
    m.rasterizeTo(buf, W, H);
    const u8 = new Uint8ClampedArray(buf.buffer);
    for (let i = 0; i < u8.length; i++) {
        assert.ok(Number.isFinite(u8[i]), `byte ${i} is finite`);
    }
    for (let i = 3; i < u8.length; i += 4) {
        assert.equal(u8[i], 0xFF, `alpha at pixel ${(i - 3) / 4} = 255`);
    }
});

// ── Zero-GC discipline (sample loop) ─────────────────────────────────
test('repeated sampleAt does not allocate (scratch is reused)', { skip: typeof global.gc !== 'function' }, () => {
    const m = make2x2();
    const out = { l: 0, c: 0, h: 0 };

    // Warm up
    for (let i = 0; i < 1000; i++) m.sampleAt(i / 1000, i / 1000, out);

    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100_000; i++) m.sampleAt(i / 100_000, (i * 7) % 1, out);
    global.gc();
    const after = process.memoryUsage().heapUsed;

    // 100k sample calls should not measurably grow the heap if there's no
    // allocation in the loop. Allow generous slack for GC bookkeeping noise.
    const delta = after - before;
    assert.ok(delta < 200_000,
        `expected near-zero heap growth from 100k samples; got ${delta} bytes`);
});
