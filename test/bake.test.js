import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    Gradient,
    bakeGradientToLut,
    flattenStopsToBuffer,
    sampleLut,
    packOklchSingle,
} from '../src/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────
const evenStops = new Gradient([
    { l: 0.20, c: 0.05, h: 240 },
    { l: 0.55, c: 0.20, h: 320 },
    { l: 0.90, c: 0.10, h:  60 },
]);

const unevenStops = new Gradient([
    { l: 0.20, c: 0.05, h: 240, stop: 0.00 },
    { l: 0.55, c: 0.20, h: 320, stop: 0.15 }, // pinched left
    { l: 0.90, c: 0.10, h:  60, stop: 1.00 },
]);

// ── flattenStopsToBuffer ─────────────────────────────────────────────
test('flattenStopsToBuffer writes [L,C,H,...] in stop order', () => {
    // Note: Float32Array narrows from f64 to f32, so expected values must too.
    const f = Math.fround;
    const buf = flattenStopsToBuffer(evenStops);
    assert.equal(buf.length, 9);
    assert.equal(buf[0], f(0.20)); assert.equal(buf[1], f(0.05)); assert.equal(buf[2], f(240));
    assert.equal(buf[3], f(0.55)); assert.equal(buf[4], f(0.20)); assert.equal(buf[5], f(320));
    assert.equal(buf[6], f(0.90)); assert.equal(buf[7], f(0.10)); assert.equal(buf[8], f(60));
});

test('flattenStopsToBuffer reuses caller-owned buffer when large enough (zero-GC)', () => {
    const reuse = new Float32Array(9);
    const ret = flattenStopsToBuffer(evenStops, reuse);
    assert.equal(ret, reuse, 'returns the same buffer reference');
});

test('flattenStopsToBuffer allocates fresh when caller buffer is too small', () => {
    const tooSmall = new Float32Array(3);
    const ret = flattenStopsToBuffer(evenStops, tooSmall);
    assert.notEqual(ret, tooSmall);
    assert.equal(ret.length, 9);
});

// ── bakeGradientToLut: shape + endpoints ─────────────────────────────
test('bakeGradientToLut returns Uint32Array of requested resolution', () => {
    const lut = bakeGradientToLut(evenStops, 64);
    assert.ok(lut instanceof Uint32Array);
    assert.equal(lut.length, 64);
});

test('bakeGradientToLut endpoints match direct pack of first/last stops', () => {
    const lut = bakeGradientToLut(evenStops, 256);
    const expectedFirst = packOklchSingle(0.20, 0.05, 240, 1);
    const expectedLast  = packOklchSingle(0.90, 0.10,  60, 1);
    assert.equal(lut[0], expectedFirst, 'LUT[0] should equal packed first stop');
    assert.equal(lut[lut.length - 1], expectedLast, 'LUT[last] should equal packed last stop');
});

// ── Uneven-spacing path correctness ──────────────────────────────────
test('uneven spacing: LUT[i] reflects Gradient.at(i/(R-1)) — position warp is honored', () => {
    // Under uneven spacing, the LUT must sample positions via Gradient.at,
    // not by treating raw stops as evenly spaced. Verify at the index
    // closest to the pinched stop where the difference is largest.
    const R = 256;
    const lut = bakeGradientToLut(unevenStops, R);

    // Compute expected at the LUT's actual t-grid (i / (R-1)), not at t=0.5.
    const out = { l: 0, c: 0, h: 0 };
    const i = 128;
    unevenStops.at(i / (R - 1), out);
    const expected = packOklchSingle(out.l, out.c, out.h, 1);

    // Allow 1-byte-per-channel rounding noise from float→uint8 quantization.
    const channelDelta = (a, b) => {
        let max = 0;
        for (let shift = 0; shift < 32; shift += 8) {
            const d = Math.abs(((a >>> shift) & 0xFF) - ((b >>> shift) & 0xFF));
            if (d > max) max = d;
        }
        return max;
    };
    const delta = channelDelta(lut[i], expected);
    assert.ok(delta <= 1,
        `LUT[${i}] should match Gradient.at(${i}/${R-1}) within 1 LSB; got channel delta ${delta}`);
});

test('uneven and even gradients with same endpoints agree at LUT[0] and LUT[last]', () => {
    const lutE = bakeGradientToLut(evenStops,   128);
    const lutU = bakeGradientToLut(unevenStops, 128);
    assert.equal(lutE[0],   lutU[0],   'first pixel identical');
    assert.equal(lutE[127], lutU[127], 'last pixel identical');
});

// ── ImageData aliasing path (the real use case) ──────────────────────
test('LUT aliases cleanly into a Uint8ClampedArray (ImageData backing)', () => {
    const lut = bakeGradientToLut(evenStops, 16);
    // Simulate the ImageData blit: alias the same backing buffer two ways.
    const ab = lut.buffer;
    const u8 = new Uint8ClampedArray(ab);
    assert.equal(u8.length, 16 * 4, 'byte length = pixels * 4');
    // Sanity: first pixel's alpha byte should be 0xFF (we passed alpha=1).
    // Little-endian RGBA → byte 3 of pixel 0 is alpha.
    assert.equal(u8[3], 0xFF, 'first pixel alpha = 255');
    assert.equal(u8[(16 - 1) * 4 + 3], 0xFF, 'last pixel alpha = 255');
});

// ── sampleLut ────────────────────────────────────────────────────────
test('sampleLut clamps out-of-range t', () => {
    const lut = bakeGradientToLut(evenStops, 8);
    assert.equal(sampleLut(lut, -1),  lut[0]);
    assert.equal(sampleLut(lut, 0),   lut[0]);
    assert.equal(sampleLut(lut, 1),   lut[7]);
    assert.equal(sampleLut(lut, 999), lut[7]);
});

test('sampleLut returns middle for t=0.5 on even-length LUT', () => {
    const lut = bakeGradientToLut(evenStops, 8);
    // t=0.5, length=8 → idx = (0.5 * 7) | 0 = 3
    assert.equal(sampleLut(lut, 0.5), lut[3]);
});

// ── Validation forwarded from lite-color-engine ──────────────────────
test('bakeGradientToLut surfaces resolution < 2 errors from the engine', () => {
    assert.throws(() => bakeGradientToLut(evenStops, 1), /resolution >= 2/);
});

// ── No-mutation discipline ───────────────────────────────────────────
test('bakeGradientToLut does not mutate the gradient', () => {
    const before = JSON.parse(JSON.stringify(unevenStops.stops));
    bakeGradientToLut(unevenStops, 64);
    bakeGradientToLut(unevenStops, 64);
    const after = JSON.parse(JSON.stringify(unevenStops.stops));
    assert.deepEqual(after, before);
});
