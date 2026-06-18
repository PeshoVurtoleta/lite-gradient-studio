import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractPalette, toHex, fromHex } from '../src/index.js';

/* ── synthetic ImageData builders ─────────────────────────────── */

/** Fill an RGBA buffer with a single color. */
function solid(w, h, r, g, b) {
    const buf = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < buf.length; i += 4) {
        buf[i]     = r;
        buf[i + 1] = g;
        buf[i + 2] = b;
        buf[i + 3] = 255;
    }
    return buf;
}

/** Concatenate horizontal strips of solid colors into one image. */
function strips(w, h, colors) {
    const buf = new Uint8ClampedArray(w * h * 4);
    const stripH = Math.floor(h / colors.length);
    for (let y = 0; y < h; y++) {
        const idx = Math.min(Math.floor(y / stripH), colors.length - 1);
        const [r, g, b] = colors[idx];
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            buf[i]     = r;
            buf[i + 1] = g;
            buf[i + 2] = b;
            buf[i + 3] = 255;
        }
    }
    return buf;
}

/* ── tests ────────────────────────────────────────────────────── */

test('extractPalette returns empty array for empty input', () => {
    const out = extractPalette(new Uint8ClampedArray(0), 5);
    assert.deepEqual(out, []);
});

test('extractPalette returns empty for all-transparent image', () => {
    const buf = new Uint8ClampedArray(40 * 40 * 4);
    // alpha = 0 everywhere
    const out = extractPalette(buf, 5);
    assert.deepEqual(out, []);
});

test('extractPalette on solid red returns one color near red', () => {
    const buf = solid(50, 50, 255, 0, 0);
    const palette = extractPalette(buf, 5);
    assert.equal(palette.length, 1, 'solid color = one palette entry');
    const hex = toHex(palette[0]);
    // Quantization tolerance: bucket center sits at the 4-bit midpoint,
    // so #FF0000 reads back as around #F88 (240, 8, 8). Verify it's red.
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    assert.ok(r > 200, `red channel should dominate, got ${hex}`);
    assert.ok(g < 50,  `green channel should be low, got ${hex}`);
    assert.ok(b < 50,  `blue channel should be low, got ${hex}`);
});

test('extractPalette on three strips returns three colors', () => {
    // Pure RGB primaries — should land in three distinct OKLCH cells.
    const buf = strips(90, 90, [
        [255,   0,   0],   // red
        [  0, 255,   0],   // green
        [  0,   0, 255],   // blue
    ]);
    const palette = extractPalette(buf, 5);
    assert.equal(palette.length, 3, 'three strips → three colors');
});

test('extractPalette sorts by lightness ascending', () => {
    // Black, mid-grey, white — pure L variation, no chroma.
    const buf = strips(60, 60, [
        [  0,   0,   0],
        [128, 128, 128],
        [255, 255, 255],
    ]);
    const palette = extractPalette(buf, 5);
    for (let i = 1; i < palette.length; i++) {
        assert.ok(palette[i].l >= palette[i - 1].l,
            `L should be non-decreasing: ${JSON.stringify(palette.map((p) => p.l.toFixed(2)))}`);
    }
});

test('extractPalette respects count parameter', () => {
    const buf = strips(80, 80, [
        [255,   0,   0],
        [  0, 255,   0],
        [  0,   0, 255],
        [255, 255,   0],
        [255,   0, 255],
        [  0, 255, 255],
        [128,   0, 128],
        [  0, 128, 128],
    ]);
    assert.equal(extractPalette(buf, 1).length, 1);
    assert.equal(extractPalette(buf, 3).length, 3);
    assert.ok(extractPalette(buf, 12).length <= 8,
        'cannot exceed available distinct colors');
});

test('extractPalette dedups near-duplicate colors', () => {
    // Two colors that quantize to adjacent buckets — should fold into one.
    // RGB (240, 0, 0) and (250, 0, 0) both bucket to (15, 0, 0) at 4-bit
    // quantization. But (240, 10, 10) and (250, 0, 0) end up in nearby
    // buckets — test that perceptual dedup catches them.
    const buf = strips(60, 60, [
        [240,  10,  10],
        [250,   0,   0],
    ]);
    const palette = extractPalette(buf, 5);
    // Both are nearly-pure red. Dedup should produce 1 color.
    assert.equal(palette.length, 1,
        `expected 1 deduped red, got ${palette.length}`);
});

test('extractPalette skips transparent pixels', () => {
    const w = 40, h = 40;
    const buf = new Uint8ClampedArray(w * h * 4);
    // Top half: solid red, fully opaque.
    // Bottom half: solid blue, alpha = 0 (transparent).
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (y < h / 2) {
                buf[i] = 255; buf[i + 1] = 0;   buf[i + 2] = 0;   buf[i + 3] = 255;
            } else {
                buf[i] = 0;   buf[i + 1] = 0;   buf[i + 2] = 255; buf[i + 3] = 0;
            }
        }
    }
    const palette = extractPalette(buf, 5);
    assert.equal(palette.length, 1, 'transparent blue should be ignored');
    // Make sure it's red, not blue.
    const hex = toHex(palette[0]);
    const r = parseInt(hex.slice(1, 3), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    assert.ok(r > b, `expected red-dominant, got ${hex}`);
});

test('extractPalette perf: 200×200 image extracts in under 50 ms', () => {
    // Realistic input size after downsample.
    const buf = new Uint8ClampedArray(200 * 200 * 4);
    // Random-ish content
    for (let i = 0; i < buf.length; i += 4) {
        buf[i]     = (i * 7) & 0xFF;
        buf[i + 1] = (i * 11) & 0xFF;
        buf[i + 2] = (i * 13) & 0xFF;
        buf[i + 3] = 255;
    }
    const t0 = performance.now();
    extractPalette(buf, 5);
    const dt = performance.now() - t0;
    assert.ok(dt < 50, `expected < 50ms, took ${dt.toFixed(1)} ms`);
});
