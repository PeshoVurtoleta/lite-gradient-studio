import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toHex, fromHex, oklchToLinearSrgb, linearSrgbToOklch, srgbGamma } from '../src/index.js';

test('toHex returns lowercase 7-char #rrggbb', () => {
    const hex = toHex({ l: 0.5, c: 0.15, h: 240 });
    assert.match(hex, /^#[0-9a-f]{6}$/);
});

test('toHex of pure white = #ffffff (within rounding)', () => {
    const hex = toHex({ l: 1, c: 0, h: 0 });
    // L=1 C=0 = white in OKLCH; gamma encoded → 255,255,255
    assert.equal(hex, '#ffffff');
});

test('toHex of pure black = #000000', () => {
    const hex = toHex({ l: 0, c: 0, h: 0 });
    assert.equal(hex, '#000000');
});

test('toHex round-trips through fromHex within ~1 byte tolerance', () => {
    // OKLCH → hex → OKLCH should land within 1/255 per channel.
    const start = { l: 0.55, c: 0.18, h: 280 };
    const hex = toHex(start);
    const back = fromHex(hex);
    // L tolerance ~0.005 (one byte step in sRGB ≈ this in OKLCH-L).
    assert.ok(Math.abs(back.l - start.l) < 0.01,
        `L drift: ${start.l} → ${back.l}`);
    assert.ok(Math.abs(back.c - start.c) < 0.02,
        `C drift: ${start.c} → ${back.c}`);
    // Hue can wrap; use circular distance.
    const dh = Math.abs(((back.h - start.h) + 540) % 360 - 180);
    assert.ok(dh < 3, `H drift: ${start.h} → ${back.h} (Δ=${dh}°)`);
});

test('fromHex accepts #rgb shorthand', () => {
    const a = fromHex('#f00');
    const b = fromHex('#ff0000');
    assert.ok(Math.abs(a.l - b.l) < 1e-6);
    assert.ok(Math.abs(a.c - b.c) < 1e-6);
    assert.ok(Math.abs(a.h - b.h) < 1e-6);
});

test('fromHex accepts hex without leading #', () => {
    const a = fromHex('00ff00');
    const b = fromHex('#00ff00');
    assert.deepEqual(a, b);
});

test('fromHex throws on malformed input', () => {
    assert.throws(() => fromHex('zzz'));
    assert.throws(() => fromHex('#12'));
    assert.throws(() => fromHex('#1234567'));
});

/* ── alpha (v0.0.18+) ────────────────────────────────────────────── */

test('toHex emits 6-char (no alpha) for opaque colors', () => {
    // Missing `.a` → opaque, emit 6-char.
    assert.equal(toHex({ l: 0, c: 0, h: 0 }), '#000000');
    // Explicit a=1 → still opaque, still 6-char.
    assert.equal(toHex({ l: 0, c: 0, h: 0, a: 1 }), '#000000');
    // Above 1 also treated as opaque (defensive against floating drift).
    assert.equal(toHex({ l: 0, c: 0, h: 0, a: 1.001 }), '#000000');
});

test('toHex emits 8-char #rrggbbaa for translucent colors', () => {
    const hex = toHex({ l: 0, c: 0, h: 0, a: 0.5 });
    assert.match(hex, /^#[0-9a-f]{8}$/);
    // alpha = 0.5 * 255 = 127.5 → rounds to 128 (0x80).
    assert.equal(hex, '#00000080');
});

test('toHex emits 8-char for fully transparent', () => {
    assert.equal(toHex({ l: 0, c: 0, h: 0, a: 0 }), '#00000000');
});

test('toHex 8-char alpha low-byte padding', () => {
    // a = 1/255 ≈ 0.00392; rounds to 1 (0x01). Pad to two digits.
    const hex = toHex({ l: 0, c: 0, h: 0, a: 1 / 255 });
    assert.equal(hex, '#00000001');
});

test('fromHex accepts 4-char #rgba shorthand', () => {
    const a = fromHex('#f008');
    const b = fromHex('#ff000088');
    assert.ok(Math.abs(a.l - b.l) < 1e-6);
    assert.ok(Math.abs(a.c - b.c) < 1e-6);
    assert.ok(Math.abs(a.h - b.h) < 1e-6);
    assert.ok(Math.abs(a.a - b.a) < 1e-6);
});

test('fromHex 6-char defaults alpha to 1', () => {
    const c = fromHex('#ff0000');
    assert.equal(c.a, 1);
});

test('fromHex 8-char reads alpha byte', () => {
    const c = fromHex('#ff000080');
    // 0x80 / 255 ≈ 0.502
    assert.ok(Math.abs(c.a - 0x80 / 255) < 1e-9);
});

test('toHex/fromHex alpha round-trip', () => {
    // Pick a non-trivial alpha; the byte quantization is exact at /255.
    const start = { l: 0.55, c: 0.18, h: 280, a: 0x40 / 255 };
    const hex = toHex(start);
    const back = fromHex(hex);
    // Alpha quantizes exactly through the byte; expect exact equality.
    assert.equal(back.a, 0x40 / 255);
});

test('fromHex 8-char with all-zero alpha (fully transparent)', () => {
    const c = fromHex('#ffffff00');
    assert.equal(c.a, 0);
});

test('oklchToLinearSrgb gamut-maps out-of-gamut colors', () => {
    // Wildly out-of-gamut: high chroma at extreme hue. Should clamp
    // to a valid in-gamut color without crashing.
    const rgb = oklchToLinearSrgb(0.5, 0.5, 30);
    assert.ok(rgb.every((c) => c >= 0 && c <= 1),
        `gamut-mapped output should be in [0,1]: ${rgb}`);
});

/* ── oklchToLinearSrgb / linearSrgbToOklch: optional out-param ─────── */

test('oklchToLinearSrgb writes into a caller-owned out array when supplied', () => {
    const out = [-1, -1, -1];
    const ret = oklchToLinearSrgb(0.5, 0.1, 240, out);
    assert.equal(ret, out, 'returns the same array reference');
    assert.ok(out.every((v) => v >= 0 && v <= 1),
        `each channel should be in [0, 1]; got ${JSON.stringify(out)}`);
});

test('oklchToLinearSrgb without out allocates a fresh 3-element array (back-compat)', () => {
    const ret = oklchToLinearSrgb(0.5, 0.1, 240);
    assert.ok(Array.isArray(ret));
    assert.equal(ret.length, 3);
});

test('oklchToLinearSrgb with out yields identical numerical values to the allocating form', () => {
    // Same inputs both paths -- bit-identical outputs since the math is the same.
    const fresh = oklchToLinearSrgb(0.62, 0.18, 145);
    const reused = [0, 0, 0];
    oklchToLinearSrgb(0.62, 0.18, 145, reused);
    for (let i = 0; i < 3; i++) {
        assert.equal(fresh[i], reused[i], `channel ${i} differs`);
    }
});

test('oklchToLinearSrgb with out also handles the gamut-mapped path', () => {
    // Wildly out-of-gamut input must still write a clamped result into `out`.
    const out = [99, 99, 99];   // sentinel
    oklchToLinearSrgb(0.5, 0.5, 30, out);
    assert.ok(out.every((c) => c >= 0 && c <= 1),
        `out-of-gamut path with out should still produce [0,1] values: ${out}`);
});

test('linearSrgbToOklch writes into a caller-owned out when supplied', () => {
    const out = { l: 0, c: 0, h: 0 };
    const ret = linearSrgbToOklch(0.5, 0.5, 0.5, out);
    assert.equal(ret, out, 'returns the same object reference');
    assert.ok(out.l > 0 && out.l < 1);
    // 50% grey: chroma is ~0 (within rounding noise).
    assert.ok(out.c < 0.01);
});

test('linearSrgbToOklch without out allocates a fresh object (back-compat)', () => {
    const ret = linearSrgbToOklch(0.5, 0.5, 0.5);
    assert.ok(typeof ret.l === 'number');
    assert.ok(typeof ret.c === 'number');
    assert.ok(typeof ret.h === 'number');
});

test('linearSrgbToOklch with out preserves an alpha already on the object', () => {
    // Documented behaviour: the `a` field is left untouched. Callers who
    // plumb alpha through can stash it in the out object before the call.
    const out = { l: 0, c: 0, h: 0, a: 0.42 };
    linearSrgbToOklch(0.5, 0.5, 0.5, out);
    assert.equal(out.a, 0.42, 'pre-existing alpha must survive');
});

test('srgbGamma matches piecewise definition', () => {
    // Toe region: linear * 12.92
    assert.equal(srgbGamma(0), 0);
    assert.equal(srgbGamma(0.001), 0.001 * 12.92);
    // Power region: 1.055 * x^(1/2.4) - 0.055
    const x = 0.5;
    assert.ok(Math.abs(srgbGamma(x) - (1.055 * Math.pow(x, 1 / 2.4) - 0.055)) < 1e-12);
});
