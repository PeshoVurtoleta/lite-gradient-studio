/**
 * Zero-GC discipline -- pins the allocation budgets for every hot-path
 * function in the public surface. Skips gracefully without --expose-gc.
 *
 * Run with: node --expose-gc --test test/allocation.test.js
 * Or:       npm run test:gc
 *
 * Each test uses the same pattern:
 *   1. Construct + warm up. JIT picks up the call sites and stabilizes shapes.
 *   2. globalThis.gc() x 2 (minor + major), snapshot heap.
 *   3. Tight loop of the operation under test, N iterations.
 *   4. globalThis.gc() x 2, measure delta.
 *   5. Assert delta is below a budget that's well under any per-call alloc.
 *
 * Budgets are deliberately generous (KBs not bytes) -- V8 heap-shape
 * settling produces measurable noise even on truly zero-alloc code. The
 * test is "much less than per-iteration alloc would produce", not "zero".
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    Gradient,
    MeshGradient,
    bakeGradientToLut,
    flattenStopsToBuffer,
    sampleLut,
    packOklchSingle,
    toHex,
    oklchToLinearSrgb,
    linearSrgbToOklch,
    extractPalette,
} from '../src/index.js';

const GC_AVAILABLE = typeof globalThis.gc === 'function';
const KB = 1024;
const skip = !GC_AVAILABLE && 'requires --expose-gc';

/** Force a GC and return the resulting `heapUsed`. */
function heapNow() {
    globalThis.gc();
    globalThis.gc();
    return process.memoryUsage().heapUsed;
}

/** Measure heap delta across a closure, in bytes. */
function heapDelta(fn) {
    const before = heapNow();
    fn();
    const after = heapNow();
    return after - before;
}

/* ── fixtures ──────────────────────────────────────────────────── */

const threeStop = new Gradient([
    { l: 0.30, c: 0.15, h: 270 },
    { l: 0.55, c: 0.25, h: 330 },
    { l: 0.85, c: 0.15, h:  60 },
]);

function make3x3() {
    return new MeshGradient(3, 3);
}

describe('zero-allocation hot path', () => {
    test('Gradient.at(t, scratch) x 200k grows the heap by less than 32 KB', { skip }, () => {
        const out = { l: 0, c: 0, h: 0, a: 1 };
        // Warm up.
        for (let i = 0; i < 5000; i++) threeStop.at((i & 1023) / 1024, out);

        const delta = heapDelta(() => {
            for (let i = 0; i < 200_000; i++) {
                threeStop.at((i & 1023) / 1024, out);
            }
        });
        assert.ok(delta < 32 * KB, `heap delta ${delta} >= 32 KB`);
    });

    test('MeshGradient.sampleAt bilinear x 200k stays under 32 KB', { skip }, () => {
        const m = make3x3();
        const out = { l: 0, c: 0, h: 0, a: 1 };
        for (let i = 0; i < 5000; i++) m.sampleAt((i & 1023) / 1024, ((i * 7) & 1023) / 1024, out);

        const delta = heapDelta(() => {
            for (let i = 0; i < 200_000; i++) {
                m.sampleAt((i & 1023) / 1024, ((i * 7) & 1023) / 1024, out);
            }
        });
        assert.ok(delta < 32 * KB, `heap delta ${delta} >= 32 KB`);
    });

    test('MeshGradient.sampleAt smoothstep x 200k stays under 32 KB', { skip }, () => {
        const m = make3x3();
        const out = { l: 0, c: 0, h: 0, a: 1 };
        for (let i = 0; i < 5000; i++) m.sampleAt((i & 1023) / 1024, ((i * 7) & 1023) / 1024, out, true);

        const delta = heapDelta(() => {
            for (let i = 0; i < 200_000; i++) {
                m.sampleAt((i & 1023) / 1024, ((i * 7) & 1023) / 1024, out, true);
            }
        });
        assert.ok(delta < 32 * KB, `heap delta ${delta} >= 32 KB`);
    });

    test('MeshGradient.sampleAt cubic x 100k stays under 64 KB', { skip }, () => {
        // Cubic is 4x cost and walks a 4x4 neighbourhood per sample; allow
        // a wider budget to absorb heap settling under the heavier loop.
        const m = make3x3();
        const out = { l: 0, c: 0, h: 0, a: 1 };
        for (let i = 0; i < 5000; i++) m.sampleAt((i & 1023) / 1024, ((i * 7) & 1023) / 1024, out, 'cubic');

        const delta = heapDelta(() => {
            for (let i = 0; i < 100_000; i++) {
                m.sampleAt((i & 1023) / 1024, ((i * 7) & 1023) / 1024, out, 'cubic');
            }
        });
        assert.ok(delta < 64 * KB, `heap delta ${delta} >= 64 KB`);
    });

    test('MeshGradient.rasterizeTo x 100 frames at 128x128 stays under 128 KB', { skip }, () => {
        const m = make3x3();
        const W = 128, H = 128;
        const buf = new Uint32Array(W * H);
        for (let i = 0; i < 5; i++) m.rasterizeTo(buf, W, H);

        const delta = heapDelta(() => {
            for (let i = 0; i < 100; i++) m.rasterizeTo(buf, W, H);
        });
        assert.ok(delta < 128 * KB, `heap delta ${delta} >= 128 KB`);
    });

    test('MeshGradient.rasterizeDeformedTo x 100 frames at 128x128 stays under 128 KB', { skip }, () => {
        const m = make3x3();
        // Deform a corner slightly so the Newton path actually runs.
        m.setPointPosition(0, 0, 0.02, 0.02);
        const W = 128, H = 128;
        const buf = new Uint32Array(W * H);
        for (let i = 0; i < 5; i++) m.rasterizeDeformedTo(buf, W, H);

        const delta = heapDelta(() => {
            for (let i = 0; i < 100; i++) m.rasterizeDeformedTo(buf, W, H);
        });
        assert.ok(delta < 128 * KB, `heap delta ${delta} >= 128 KB`);
    });

    // v1.2.0 wrap paths — alloc invariant must hold on wrapped meshes too.
    // The wrap arithmetic (u - Math.floor(u), modulo indices) is pure ints
    // and floats, no closures or transient objects, so the ceiling matches
    // the non-wrap raster.
    test('MeshGradient.rasterizeTo wrapX (cylinder) x 100 frames at 128x128 stays under 128 KB', { skip }, () => {
        const m = new MeshGradient(3, 3, undefined, { wrapX: true });
        const W = 128, H = 128;
        const buf = new Uint32Array(W * H);
        for (let i = 0; i < 5; i++) m.rasterizeTo(buf, W, H);

        const delta = heapDelta(() => {
            for (let i = 0; i < 100; i++) m.rasterizeTo(buf, W, H);
        });
        assert.ok(delta < 128 * KB, `heap delta ${delta} >= 128 KB`);
    });

    test('MeshGradient.rasterizeTo wrapX+wrapY (torus) x 100 frames at 128x128 stays under 128 KB', { skip }, () => {
        const m = new MeshGradient(3, 3, undefined, { wrapX: true, wrapY: true });
        const W = 128, H = 128;
        const buf = new Uint32Array(W * H);
        for (let i = 0; i < 5; i++) m.rasterizeTo(buf, W, H);

        const delta = heapDelta(() => {
            for (let i = 0; i < 100; i++) m.rasterizeTo(buf, W, H);
        });
        assert.ok(delta < 128 * KB, `heap delta ${delta} >= 128 KB`);
    });

    test('MeshGradient.rasterizeTo wrapX cubic x 100 frames at 128x128 stays under 128 KB', { skip }, () => {
        // The flagship path: modulo neighbour indexing across the seam.
        const m = new MeshGradient(4, 4, undefined, { wrapX: true });
        const W = 128, H = 128;
        const buf = new Uint32Array(W * H);
        for (let i = 0; i < 5; i++) m.rasterizeTo(buf, W, H, { interpolation: 'cubic' });

        const delta = heapDelta(() => {
            for (let i = 0; i < 100; i++) m.rasterizeTo(buf, W, H, { interpolation: 'cubic' });
        });
        assert.ok(delta < 128 * KB, `heap delta ${delta} >= 128 KB`);
    });

    // v1.2.0 dither paths — same invariant. The engine's blue-noise tile
    // decode is a one-time module-level allocation (before the timed loop
    // via warm-up), and the per-pixel packer wrapper reuses the same
    // Float32Array(3) scratch as the undithered packer.
    test('MeshGradient.rasterizeTo dither x 100 frames at 128x128 stays under 128 KB', { skip }, () => {
        const m = make3x3();
        const W = 128, H = 128;
        const buf = new Uint32Array(W * H);
        for (let i = 0; i < 5; i++) m.rasterizeTo(buf, W, H, { dither: true });

        const delta = heapDelta(() => {
            for (let i = 0; i < 100; i++) m.rasterizeTo(buf, W, H, { dither: true });
        });
        assert.ok(delta < 128 * KB, `heap delta ${delta} >= 128 KB`);
    });

    test('MeshGradient.rasterizeTo wrapX + dither x 100 frames at 128x128 stays under 128 KB', { skip }, () => {
        const m = new MeshGradient(4, 4, undefined, { wrapX: true });
        const W = 128, H = 128;
        const buf = new Uint32Array(W * H);
        for (let i = 0; i < 5; i++) m.rasterizeTo(buf, W, H, { dither: true });

        const delta = heapDelta(() => {
            for (let i = 0; i < 100; i++) m.rasterizeTo(buf, W, H, { dither: true });
        });
        assert.ok(delta < 128 * KB, `heap delta ${delta} >= 128 KB`);
    });

    test('packOklchSingle x 1M stays under 16 KB', { skip }, () => {
        for (let i = 0; i < 5000; i++) packOklchSingle(0.5, 0.2, 240, 1);

        const delta = heapDelta(() => {
            let sink = 0;
            for (let i = 0; i < 1_000_000; i++) {
                sink ^= packOklchSingle((i & 255) / 255, 0.2, (i & 359), 1);
            }
            // Defeat dead-code elimination.
            if (sink === Number.NaN) throw new Error();
        });
        assert.ok(delta < 16 * KB, `heap delta ${delta} >= 16 KB`);
    });

    test('sampleLut x 1M stays under 8 KB', { skip }, () => {
        const lut = bakeGradientToLut(threeStop, 256);
        for (let i = 0; i < 5000; i++) sampleLut(lut, (i & 1023) / 1024);

        const delta = heapDelta(() => {
            let sink = 0;
            for (let i = 0; i < 1_000_000; i++) {
                sink ^= sampleLut(lut, (i & 1023) / 1024);
            }
            if (sink === Number.NaN) throw new Error();
        });
        assert.ok(delta < 8 * KB, `heap delta ${delta} >= 8 KB`);
    });

    test('oklchToLinearSrgb with out x 500k stays under 16 KB', { skip }, () => {
        // The whole point of the v1 `out` parameter: zero-alloc form.
        const out = [0, 0, 0];
        for (let i = 0; i < 5000; i++) oklchToLinearSrgb(0.5, 0.2, (i & 359), out);

        const delta = heapDelta(() => {
            for (let i = 0; i < 500_000; i++) {
                oklchToLinearSrgb(0.5, 0.2, (i & 359), out);
            }
        });
        assert.ok(delta < 16 * KB, `heap delta ${delta} >= 16 KB`);
    });

    test('oklchToLinearSrgb with out hits the gamut path zero-alloc too', { skip }, () => {
        // Force the out-of-gamut binary search to actually run.
        const out = [0, 0, 0];
        for (let i = 0; i < 5000; i++) oklchToLinearSrgb(0.5, 0.5, (i & 359), out);

        const delta = heapDelta(() => {
            for (let i = 0; i < 100_000; i++) {
                oklchToLinearSrgb(0.5, 0.5, (i & 359), out);
            }
        });
        assert.ok(delta < 16 * KB, `heap delta ${delta} >= 16 KB`);
    });

    test('linearSrgbToOklch with out x 500k stays under 16 KB', { skip }, () => {
        const out = { l: 0, c: 0, h: 0 };
        for (let i = 0; i < 5000; i++) {
            linearSrgbToOklch((i & 255) / 255, ((i * 7) & 255) / 255, ((i * 11) & 255) / 255, out);
        }

        const delta = heapDelta(() => {
            for (let i = 0; i < 500_000; i++) {
                linearSrgbToOklch((i & 255) / 255, ((i * 7) & 255) / 255, ((i * 11) & 255) / 255, out);
            }
        });
        assert.ok(delta < 16 * KB, `heap delta ${delta} >= 16 KB`);
    });

    test('toHex x 100k stays under 1 MB (string output dominates the budget)', { skip }, () => {
        // toHex allocates ONE string per call -- can't avoid that; it's the
        // return value. But the internal computation should not allocate
        // beyond the string. ~10 bytes/string x 100k = ~1 MB upper bound;
        // budget pinned at that ceiling.
        const c = { l: 0.5, c: 0.2, h: 240 };
        for (let i = 0; i < 5000; i++) toHex(c);

        const delta = heapDelta(() => {
            let sink = '';
            for (let i = 0; i < 100_000; i++) {
                c.h = i & 359;
                sink = toHex(c);
            }
            if (sink === 'x') throw new Error();
        });
        assert.ok(delta < 1024 * KB, `heap delta ${delta} >= 1024 KB`);
    });

    test('extractPalette x 200 calls on a 100x100 image stays under 256 KB', { skip }, () => {
        // The function allocates the result array + the pick objects, but
        // the bucket state and the sorted view are module-scoped.
        // Per-call output is the only allocation we can't avoid.
        const pixels = new Uint8ClampedArray(100 * 100 * 4);
        for (let i = 0; i < pixels.length; i += 4) {
            pixels[i]     = (i * 7) & 255;
            pixels[i + 1] = (i * 11) & 255;
            pixels[i + 2] = (i * 13) & 255;
            pixels[i + 3] = 255;
        }
        for (let i = 0; i < 10; i++) extractPalette(pixels, 5);

        const delta = heapDelta(() => {
            for (let i = 0; i < 200; i++) extractPalette(pixels, 5);
        });
        // 200 calls x (5 stop objects + result array) -- well under 256 KB.
        assert.ok(delta < 256 * KB, `heap delta ${delta} >= 256 KB`);
    });

    test('flattenStopsToBuffer with reused buffer x 100k stays under 8 KB', { skip }, () => {
        const buf = new Float32Array(9);
        for (let i = 0; i < 5000; i++) flattenStopsToBuffer(threeStop, buf);

        const delta = heapDelta(() => {
            for (let i = 0; i < 100_000; i++) flattenStopsToBuffer(threeStop, buf);
        });
        assert.ok(delta < 8 * KB, `heap delta ${delta} >= 8 KB`);
    });
});

// Smoke test that runs without --expose-gc -- just verifies the code paths
// don't crash. The real allocation assertions live above.
describe('hot-path smoke (always runs)', () => {
    test('typical inner-loop sequence: sampleAt + packOklchSingle x 1000', () => {
        const m = make3x3();
        const out = { l: 0, c: 0, h: 0, a: 1 };
        let acc = 0;
        for (let i = 0; i < 1000; i++) {
            m.sampleAt((i & 511) / 512, ((i * 7) & 511) / 512, out);
            acc ^= packOklchSingle(out.l, out.c, out.h, out.a);
        }
        assert.ok(acc !== 0, 'acc should accumulate non-zero packed values');
    });
});
