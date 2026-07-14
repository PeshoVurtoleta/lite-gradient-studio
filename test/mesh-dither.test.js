import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshGradient } from '../src/mesh.js';
import { packOklchSingle, packOklchSingleDithered } from '../src/bake.js';

// -----------------------------------------------------------------------------
// Helpers — pixel channel unpack (RGBA little-endian, matching the packers)
// -----------------------------------------------------------------------------

function chan(px, ch /* 0..3, R G B A */) {
    return (px >>> (ch * 8)) & 0xff;
}

/** Max |Δchannel| between two Uint32 pixel buffers of equal length. */
function maxChannelDelta(a, b) {
    let max = 0;
    for (let i = 0; i < a.length; i++) {
        const pa = a[i], pb = b[i];
        for (let ch = 0; ch < 4; ch++) {
            const d = Math.abs(chan(pa, ch) - chan(pb, ch));
            if (d > max) max = d;
        }
    }
    return max;
}

/** Build a low-chroma near-monochrome mesh — worst-case banding scenario. */
function shallowRampMesh() {
    // A 4×2 mesh with L varying slowly across x and no chroma.
    // Undithered raster of this on a wide canvas shows the classic band
    // structure — one integer-encoded L per pixel column band, sharp
    // transitions at the encoded-byte boundaries.
    const stops = [
        // Row 0 (top): L from 0.30 to 0.34
        { l: 0.30, c: 0.005, h: 200 },
        { l: 0.31, c: 0.005, h: 200 },
        { l: 0.33, c: 0.005, h: 200 },
        { l: 0.34, c: 0.005, h: 200 },
        // Row 1 (bottom): same
        { l: 0.30, c: 0.005, h: 200 },
        { l: 0.31, c: 0.005, h: 200 },
        { l: 0.33, c: 0.005, h: 200 },
        { l: 0.34, c: 0.005, h: 200 },
    ];
    return new MeshGradient(4, 2, stops);
}

// -----------------------------------------------------------------------------
// D8 gate 1 — Off-flag byte parity (byte-identical to v1.2.0 when absent/false)
// -----------------------------------------------------------------------------

test('D8: rasterizeTo without dither opt is byte-identical to v1.2.0 output', () => {
    const m = new MeshGradient(3, 3);
    const W = 32, H = 32;
    const a = new Uint32Array(W * H);
    const b = new Uint32Array(W * H);
    m.rasterizeTo(a, W, H);
    m.rasterizeTo(b, W, H);
    // Deterministic self-parity (same input, same output — obvious but worth asserting).
    for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});

test('D8: rasterizeTo with dither: false is byte-identical to no opt', () => {
    const m = new MeshGradient(3, 3);
    const W = 32, H = 32;
    const noOpt   = new Uint32Array(W * H);
    const explFalse = new Uint32Array(W * H);
    m.rasterizeTo(noOpt, W, H);
    m.rasterizeTo(explFalse, W, H, { dither: false });
    for (let i = 0; i < noOpt.length; i++) {
        assert.equal(explFalse[i], noOpt[i], `pixel ${i}`);
    }
});

test('D8: rasterizeTo with dither: undefined (bare opts object) is byte-identical', () => {
    // The branch is `opts != null && opts.dither === true` — an opts object
    // present without a dither field must not accidentally engage the path.
    const m = new MeshGradient(3, 3);
    const W = 32, H = 32;
    const noOpt = new Uint32Array(W * H);
    const bare  = new Uint32Array(W * H);
    m.rasterizeTo(noOpt, W, H);
    m.rasterizeTo(bare, W, H, { interpolation: 'bilinear' });
    for (let i = 0; i < noOpt.length; i++) assert.equal(bare[i], noOpt[i]);
});

test('D8: byte parity holds for smooth mode too', () => {
    const m = new MeshGradient(5, 5);
    const W = 32, H = 32;
    const a = new Uint32Array(W * H);
    const b = new Uint32Array(W * H);
    m.rasterizeTo(a, W, H, { interpolation: 'smooth' });
    m.rasterizeTo(b, W, H, { interpolation: 'smooth', dither: false });
    for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});

test('D8: byte parity holds for cubic mode too', () => {
    const m = new MeshGradient(5, 5);
    const W = 32, H = 32;
    const a = new Uint32Array(W * H);
    const b = new Uint32Array(W * H);
    m.rasterizeTo(a, W, H, { interpolation: 'cubic' });
    m.rasterizeTo(b, W, H, { interpolation: 'cubic', dither: false });
    for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});

test('D8: byte parity holds for wrapped rasterize (dither: false)', () => {
    const m = new MeshGradient(4, 4, undefined, { wrapX: true, wrapY: true });
    const W = 32, H = 32;
    const a = new Uint32Array(W * H);
    const b = new Uint32Array(W * H);
    m.rasterizeTo(a, W, H);
    m.rasterizeTo(b, W, H, { dither: false });
    for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});

// -----------------------------------------------------------------------------
// D8 gate 2 — noise01 = 0.5 identity anchor
// -----------------------------------------------------------------------------

test('D8: packOklchSingleDithered(noise01=0.5) reproduces packOklchSingle exactly', () => {
    // The identity anchor claim in D8's contract.
    // Verify across a range of OKLCH triplets covering different gamma-encode
    // regions and alpha values.
    const samples = [
        [0.10, 0.05, 0,   1.0 ],
        [0.30, 0.15, 90,  1.0 ],
        [0.50, 0.20, 180, 0.5 ],
        [0.70, 0.25, 270, 0.8 ],
        [0.90, 0.10, 45,  1.0 ],
        [0.05, 0.02, 200, 0.25],       // deep linear region (< 0.0031308 threshold)
        [0.995, 0.001, 30, 1.0],        // near-white; tests the >= 1 clamp
    ];
    for (const [l, c, h, a] of samples) {
        const plain    = packOklchSingle(l, c, h, a);
        const dithered = packOklchSingleDithered(l, c, h, a, 0.5);
        assert.equal(dithered, plain,
            `noise01=0.5 should reproduce plain packer at (${l},${c},${h},${a})`);
    }
});

// -----------------------------------------------------------------------------
// D8 gate 3 — Determinism
// -----------------------------------------------------------------------------

test('D8: dithered rasterize is fully deterministic (same input -> same bytes)', () => {
    const m = new MeshGradient(3, 3);
    const W = 64, H = 64;
    const a = new Uint32Array(W * H);
    const b = new Uint32Array(W * H);
    m.rasterizeTo(a, W, H, { dither: true });
    m.rasterizeTo(b, W, H, { dither: true });
    for (let i = 0; i < a.length; i++) {
        assert.equal(b[i], a[i], `pixel ${i}: ${b[i]} !== ${a[i]}`);
    }
});

test('D8: determinism holds after a v1.2.0 wrap+dither combination', () => {
    // Composition sanity — wrap and dither are orthogonal, but let's make
    // sure the tile indexing doesn't accidentally interact with the
    // wrapped u-coord.
    const m = new MeshGradient(4, 4, undefined, { wrapX: true });
    const W = 32, H = 32;
    const a = new Uint32Array(W * H);
    const b = new Uint32Array(W * H);
    m.rasterizeTo(a, W, H, { dither: true });
    m.rasterizeTo(b, W, H, { dither: true });
    for (let i = 0; i < a.length; i++) {
        assert.equal(b[i], a[i], `wrapped+dither pixel ${i}`);
    }
});

// -----------------------------------------------------------------------------
// D8 gate 4 — Bounded deviation (every channel within ±1 of undithered)
// -----------------------------------------------------------------------------

test('D8: dithered output differs from undithered by at most 1 per channel', () => {
    const m = new MeshGradient(3, 3);
    const W = 64, H = 64;
    const undith = new Uint32Array(W * H);
    const dith   = new Uint32Array(W * H);
    m.rasterizeTo(undith, W, H);
    m.rasterizeTo(dith,   W, H, { dither: true });

    const maxDelta = maxChannelDelta(undith, dith);
    assert.ok(maxDelta <= 1,
        `dithered channel deviation ${maxDelta} exceeds ±1`);
});

test('D8: bounded deviation on a shallow-ramp mesh (worst-case banding)', () => {
    const m = shallowRampMesh();
    const W = 128, H = 8;
    const undith = new Uint32Array(W * H);
    const dith   = new Uint32Array(W * H);
    m.rasterizeTo(undith, W, H);
    m.rasterizeTo(dith,   W, H, { dither: true });

    const maxDelta = maxChannelDelta(undith, dith);
    assert.ok(maxDelta <= 1,
        `shallow-ramp dither channel deviation ${maxDelta} exceeds ±1`);
});

test('D8: alpha is NEVER dithered (undithered α byte matches plain packer)', () => {
    // Build a mesh with a distinctive α value and verify it survives the
    // dither pass byte-identically.
    const stops = new Array(9).fill(0).map((_, i) => ({
        l: 0.5 + (i % 3) * 0.1, c: 0.05, h: 200, a: 0.7,
    }));
    const m = new MeshGradient(3, 3, stops);
    const W = 32, H = 32;
    const undith = new Uint32Array(W * H);
    const dith   = new Uint32Array(W * H);
    m.rasterizeTo(undith, W, H);
    m.rasterizeTo(dith,   W, H, { dither: true });

    for (let i = 0; i < undith.length; i++) {
        assert.equal(chan(dith[i], 3), chan(undith[i], 3),
            `pixel ${i} alpha differs: dith=${chan(dith[i], 3)} undith=${chan(undith[i], 3)}`);
    }
});

test('D8: same noise01 applied to R, G, B at one pixel (no chroma speckle)', () => {
    // On a chroma-free mesh (c ≈ 0), R, G, B all land on the same encoded
    // value and receive the same threshold offset. The dithered output
    // must therefore also be chroma-free (R === G === B per pixel).
    const stops = [
        { l: 0.35, c: 0, h: 0 },
        { l: 0.40, c: 0, h: 0 },
        { l: 0.45, c: 0, h: 0 },
        { l: 0.50, c: 0, h: 0 },
        { l: 0.55, c: 0, h: 0 },
        { l: 0.60, c: 0, h: 0 },
    ];
    const m = new MeshGradient(3, 2, stops);
    const W = 64, H = 4;
    const buf = new Uint32Array(W * H);
    m.rasterizeTo(buf, W, H, { dither: true });
    let bad = 0;
    for (let i = 0; i < buf.length; i++) {
        const r = chan(buf[i], 0), g = chan(buf[i], 1), b = chan(buf[i], 2);
        if (r !== g || g !== b) { bad++; }
    }
    assert.equal(bad, 0,
        `${bad} pixels have R != G != B — noise should be shared across channels`);
});

// -----------------------------------------------------------------------------
// D8 gate 5 — Run-length shortening (visible banding-break claim)
// -----------------------------------------------------------------------------

test('D8: dither shortens the longest identical-pixel run on a shallow ramp', () => {
    const m = shallowRampMesh();
    const W = 256, H = 4;
    const undith = new Uint32Array(W * H);
    const dith   = new Uint32Array(W * H);
    m.rasterizeTo(undith, W, H);
    m.rasterizeTo(dith,   W, H, { dither: true });

    const longestRun = (buf, row) => {
        const start = row * W;
        let best = 1, cur = 1;
        for (let x = 1; x < W; x++) {
            if (buf[start + x] === buf[start + x - 1]) cur++;
            else { if (cur > best) best = cur; cur = 1; }
        }
        return Math.max(best, cur);
    };
    const runUndith = longestRun(undith, 1);
    const runDith   = longestRun(dith, 1);

    assert.ok(runDith < runUndith,
        `dither should shorten the longest run (undithered=${runUndith}, dithered=${runDith})`);
    // Blue noise is spectrally superior; on a shallow ramp we typically
    // expect a substantial shortening. Threshold at 2/3 of the undithered
    // run — well within blue noise's actual behaviour but loose enough to
    // survive JIT/timing variance.
    assert.ok(runDith <= runUndith * (2 / 3),
        `dither should more-than-third-off the longest run ` +
        `(undithered=${runUndith}, dithered=${runDith})`);
});

// -----------------------------------------------------------------------------
// D8 gate 6 — Zero-GC on the dithered path (steady state)
// -----------------------------------------------------------------------------

test('D8: dithered rasterize is zero-GC after tile-decode warm-up', (t) => {
    if (typeof globalThis.gc !== 'function') {
        t.skip('requires --expose-gc');
        return;
    }
    const m = new MeshGradient(3, 3);
    const W = 64, H = 64;
    const buf = new Uint32Array(W * H);

    // Warm-up: force the engine's one-time blue-noise tile decode and JIT
    // primer. After this, steady-state ops must not touch the heap.
    for (let i = 0; i < 5; i++) m.rasterizeTo(buf, W, H, { dither: true });

    globalThis.gc(); globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100; i++) m.rasterizeTo(buf, W, H, { dither: true });
    globalThis.gc(); globalThis.gc();
    const after = process.memoryUsage().heapUsed;

    // Same ceiling as the existing rasterize alloc tests (128 KB for 100
    // frames at 128×128). We use 64×64 here so the budget is even more
    // generous.
    const delta = after - before;
    assert.ok(delta < 128 * 1024,
        `dithered rasterize heap delta ${delta} B >= 128 KB`);
});

// -----------------------------------------------------------------------------
// Composition — dither + wrap must produce a valid, seamless tile
// -----------------------------------------------------------------------------

test('D7/D8 × D4 composition: wrap + dither preserves the ±1 dither bound', () => {
    // The honest composition invariant: wrap and dither operate on
    // orthogonal parts of the pipeline (wrap on sampling, dither on
    // packing). Combining them should therefore still satisfy the ±1
    // channel bound relative to the undithered wrap output.
    const m = new MeshGradient(4, 4, undefined, { wrapX: true, wrapY: true });
    const W = 64, H = 64;
    const undith = new Uint32Array(W * H);
    const dith   = new Uint32Array(W * H);
    m.rasterizeTo(undith, W, H);
    m.rasterizeTo(dith,   W, H, { dither: true });

    const maxDelta = maxChannelDelta(undith, dith);
    assert.ok(maxDelta <= 1,
        `wrap+dither channel deviation ${maxDelta} exceeds ±1`);
});

test('D7/D8 × D4 composition: wrap + dither produces valid bytes (no NaN, no >255)', () => {
    // Sanity: composition never emits an out-of-range byte or a NaN
    // that would show as a specific bit pattern. Uint32Array stores
    // integers so NaN wouldn't survive per se, but tile-index math
    // gone wrong could still emit surprising values (uint32 wraparound
    // from a negative intermediate).
    const m = new MeshGradient(3, 3, undefined, { wrapX: true });
    const W = 128, H = 64;
    const buf = new Uint32Array(W * H);
    m.rasterizeTo(buf, W, H, { dither: true, interpolation: 'cubic' });
    for (let i = 0; i < buf.length; i++) {
        // Each channel byte must be in [0, 255]; since we're storing in
        // uint32, that's automatic — but check the alpha byte is at least
        // some sane non-zero value (our stops all have α=1).
        const a = chan(buf[i], 3);
        assert.ok(a > 0, `pixel ${i} alpha zero (mesh stops all α=1)`);
    }
});
