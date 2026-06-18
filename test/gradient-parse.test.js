/**
 * parseGradientCss — handles the CSS we emit, plus the common paste
 * formats designers bring from other tools.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGradientCss, toCss1d } from '../src/index.js';

/* ── happy paths ─────────────────────────────────────────────── */

test('parses a basic linear-gradient with hex stops', () => {
    const out = parseGradientCss('linear-gradient(90deg, #ff0000 0%, #00ff00 50%, #0000ff 100%)');
    assert.equal(out.mode, 'linear');
    assert.equal(out.angle, 90);
    assert.equal(out.stops.length, 3);
    assert.equal(out.stops[0].stop, 0);
    assert.equal(out.stops[1].stop, 0.5);
    assert.equal(out.stops[2].stop, 1);
});

test('defaults missing stop positions to even distribution', () => {
    // No explicit positions → 0, 0.5, 1.
    const out = parseGradientCss('linear-gradient(red, green, blue)');
    assert.equal(out.stops.length, 3);
    assert.equal(out.stops[0].stop, 0);
    assert.ok(Math.abs(out.stops[1].stop - 0.5) < 1e-9);
    assert.equal(out.stops[2].stop, 1);
});

test('defaults missing angle to 180deg (CSS default)', () => {
    const out = parseGradientCss('linear-gradient(#fff 0%, #000 100%)');
    assert.equal(out.angle, 180);
});

test('strips background: prefix and trailing semicolon', () => {
    const out = parseGradientCss('background: linear-gradient(45deg, #fff, #000);');
    assert.equal(out.mode, 'linear');
    assert.equal(out.angle, 45);
});

test('strips background-image: prefix', () => {
    const out = parseGradientCss('background-image: linear-gradient(#fff, #000)');
    assert.equal(out.mode, 'linear');
});

test('ignores `in oklch` modifier on linear', () => {
    const out = parseGradientCss('linear-gradient(90deg in oklch, #fff 0%, #000 100%)');
    assert.equal(out.mode, 'linear');
    assert.equal(out.angle, 90);
});

/* ── radial / conic ─────────────────────────────────────────── */

test('parses radial-gradient with shape + position', () => {
    const out = parseGradientCss('radial-gradient(circle at 30% 70%, #fff, #000)');
    assert.equal(out.mode, 'radial');
    assert.equal(out.radShape, 'circle');
    assert.equal(out.radCx, 30);
    assert.equal(out.radCy, 70);
});

test('radial defaults: ellipse + center', () => {
    const out = parseGradientCss('radial-gradient(#fff, #000)');
    assert.equal(out.radShape, 'ellipse');
    assert.equal(out.radCx, 50);
    assert.equal(out.radCy, 50);
});

test('parses conic-gradient with from + at', () => {
    const out = parseGradientCss('conic-gradient(from 45deg at 50% 50%, red, blue, red)');
    assert.equal(out.mode, 'conic');
    assert.equal(out.conFrom, 45);
    assert.equal(out.conCx, 50);
    assert.equal(out.conCy, 50);
    assert.equal(out.stops.length, 3);
});

/* ── color formats ───────────────────────────────────────────── */

test('rgb() colors', () => {
    const out = parseGradientCss('linear-gradient(rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)');
    assert.equal(out.stops.length, 2);
    // hex round-trip would be #ff0000-ish for the first stop
    assert.ok(out.stops[0].c > 0.2);   // red has high chroma
    assert.ok(Math.abs(out.stops[0].h - 29) < 2 || Math.abs(out.stops[0].h - 30) < 2);
});

test('rgba() with alpha', () => {
    const out = parseGradientCss('linear-gradient(rgba(255, 0, 0, 0.5), rgba(0, 0, 255, 0.5))');
    assert.equal(out.stops[0].a, 0.5);
    assert.equal(out.stops[1].a, 0.5);
});

test('oklch() colors with slash-alpha', () => {
    const out = parseGradientCss('linear-gradient(90deg, oklch(0.5 0.2 30) 0%, oklch(0.7 0.15 200 / 0.6) 100%)');
    assert.equal(out.stops[0].l, 0.5);
    assert.equal(out.stops[0].c, 0.2);
    assert.equal(out.stops[0].h, 30);
    assert.equal(out.stops[0].a, 1);
    assert.equal(out.stops[1].a, 0.6);
});

test('hsl() colors', () => {
    const out = parseGradientCss('linear-gradient(hsl(0, 100%, 50%), hsl(240, 100%, 50%))');
    assert.equal(out.stops.length, 2);
    // hsl(0 100% 50%) is pure red → near hue 29° in OKLCH
    assert.ok(out.stops[0].c > 0.15);
});

test('8-char hex alpha', () => {
    const out = parseGradientCss('linear-gradient(#ff000080, #0000ffff)');
    // 0x80 / 255 ≈ 0.502
    assert.ok(Math.abs(out.stops[0].a - 0x80 / 255) < 1e-9);
    assert.equal(out.stops[1].a, 1);
});

test('3-char hex shorthand', () => {
    const out = parseGradientCss('linear-gradient(#f00, #00f)');
    assert.equal(out.stops.length, 2);
    assert.ok(out.stops[0].c > 0.15);
});

/* ── angle handling ─────────────────────────────────────────── */

test('direction keyword "to right" → 90deg', () => {
    const out = parseGradientCss('linear-gradient(to right, #fff, #000)');
    assert.equal(out.angle, 90);
});

test('direction keyword "to bottom" → 180deg (= CSS default)', () => {
    const out = parseGradientCss('linear-gradient(to bottom, #fff, #000)');
    assert.equal(out.angle, 180);
});

test('turn-unit angle', () => {
    const out = parseGradientCss('linear-gradient(0.25turn, #fff, #000)');
    assert.equal(out.angle, 90);
});

test('negative angle wraps into 0..360', () => {
    const out = parseGradientCss('linear-gradient(-90deg, #fff, #000)');
    assert.equal(out.angle, 270);
});

/* ── malformed input ─────────────────────────────────────────── */

test('throws on non-gradient input', () => {
    assert.throws(() => parseGradientCss('hello world'));
    assert.throws(() => parseGradientCss('color: red'));
});

test('throws on single-stop gradient', () => {
    assert.throws(() => parseGradientCss('linear-gradient(red)'));
});

test('throws on unsupported color', () => {
    // "indianred" (named color) — we don't support named.
    assert.throws(() => parseGradientCss('linear-gradient(indianred, blue)'));
});

/* ── round-trip with the emitter ─────────────────────────────── */

test('parse(emit(x)) preserves linear gradient roughly', () => {
    const original = {
        mode: 'linear',
        angle: 135,
        stops: [
            { l: 0.30, c: 0.15, h: 270, a: 1, stop: 0 },
            { l: 0.85, c: 0.10, h:  60, a: 1, stop: 1 },
        ],
    };
    const css = toCss1d(original);
    // toCss1d wraps in `background: ...;` — parser strips the prefix.
    const parsed = parseGradientCss(css);
    assert.equal(parsed.mode, 'linear');
    assert.equal(parsed.angle, 135);
    assert.equal(parsed.stops.length, 2);
    // OKLCH values should round-trip exactly (we emit them directly).
    assert.ok(Math.abs(parsed.stops[0].l - 0.30) < 1e-3);
    assert.ok(Math.abs(parsed.stops[0].c - 0.15) < 1e-3);
    assert.ok(Math.abs(parsed.stops[0].h - 270) < 1e-1);
});

test('parse(emit(x)) preserves alpha', () => {
    const original = {
        mode: 'linear',
        angle: 90,
        stops: [
            { l: 0.5, c: 0.2, h: 0,  a: 0.4, stop: 0 },
            { l: 0.5, c: 0.2, h: 90, a: 1.0, stop: 1 },
        ],
    };
    const css = toCss1d(original);
    const parsed = parseGradientCss(css);
    assert.ok(Math.abs(parsed.stops[0].a - 0.4) < 0.01);
    assert.equal(parsed.stops[1].a, 1);
});

test('parse(emit(x)) preserves radial center', () => {
    const css = 'background: radial-gradient(circle farthest-corner at 30% 70% in oklch, oklch(0.5 0.2 30 / 1) 0%, oklch(0.8 0.1 90 / 1) 100%);';
    const parsed = parseGradientCss(css);
    assert.equal(parsed.mode, 'radial');
    assert.equal(parsed.radShape, 'circle');
    assert.equal(parsed.radCx, 30);
    assert.equal(parsed.radCy, 70);
});

test('parse(emit(x)) preserves conic from-angle', () => {
    const css = 'conic-gradient(from 222deg at 23% 24% in oklch, oklch(0.5 0.2 30) 0deg, oklch(0.8 0.1 90) 360deg)';
    const parsed = parseGradientCss(css);
    assert.equal(parsed.mode, 'conic');
    assert.equal(parsed.conFrom, 222);
    assert.equal(parsed.conCx, 23);
    assert.equal(parsed.conCy, 24);
});
