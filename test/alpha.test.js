/**
 * Alpha-channel coverage (v0.0.18).
 *
 * Threading alpha through the full pipeline (state → emitters → raster)
 * is the kind of change that breaks silently — a forgotten `s.a` in
 * one site means the channel collapses to 1 everywhere downstream.
 * These tests pin each boundary so a regression has somewhere to fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MeshGradient,
    formatCssLinear, formatCssRadial, formatCssConic,
    formatCssMesh,
    toCss1d, toJson1d, toSvg1d,
    toJsonMesh,
} from '../src/index.js';

/* ── 1D CSS emitters ────────────────────────────────────────────── */

test('formatCssLinear includes alpha in each stop', () => {
    const css = formatCssLinear({
        stops: [
            { l: 0.5, c: 0.2, h: 90,  a: 0.5, pos: 0 },
            { l: 0.5, c: 0.2, h: 270, a: 1.0, pos: 1 },
        ],
    }, { angle: 90 });
    // Alpha 0.5 surfaces as `/ 0.5`.
    assert.match(css, /oklch\([^)]+\/ 0\.5\)/);
    // Alpha 1 surfaces as `/ 1`.
    assert.match(css, /oklch\([^)]+\/ 1\)/);
});

test('formatCssLinear defaults missing alpha to 1', () => {
    // Stops without `.a` field — previous schema. Emit should still
    // produce valid CSS; the spec allows omitting alpha but
    // lite-color emits `/ 1` for consistency.
    const css = formatCssLinear({
        stops: [
            { l: 0.5, c: 0.2, h: 90,  pos: 0 },
            { l: 0.5, c: 0.2, h: 270, pos: 1 },
        ],
    });
    assert.ok(css.includes('/ 1'));
});

test('formatCssRadial threads alpha', () => {
    const css = formatCssRadial({
        stops: [{ l: 0.3, c: 0.1, h: 30, a: 0.25, pos: 0 }],
    }, { position: '50% 50%' });
    assert.match(css, /\/ 0\.25\)/);
});

test('formatCssConic threads alpha', () => {
    const css = formatCssConic({
        stops: [{ l: 0.3, c: 0.1, h: 30, a: 0.75, pos: 0 }],
    });
    assert.match(css, /\/ 0\.75\)/);
});

/* ── Mesh raster ────────────────────────────────────────────────── */

test('MeshGradient defaults stop alpha to 1 when missing', () => {
    const m = new MeshGradient(2, 2, [
        { l: 0.5, c: 0.1, h:  0 },
        { l: 0.5, c: 0.1, h: 90 },
        { l: 0.5, c: 0.1, h: 180 },
        { l: 0.5, c: 0.1, h: 270 },
    ]);
    for (const s of m.stops) {
        assert.equal(s.a, 1, 'stop should have a=1 after construction');
    }
});

test('MeshGradient preserves explicit alpha', () => {
    const m = new MeshGradient(2, 2, [
        { l: 0.5, c: 0.1, h:   0, a: 0.25 },
        { l: 0.5, c: 0.1, h:  90, a: 0.50 },
        { l: 0.5, c: 0.1, h: 180, a: 0.75 },
        { l: 0.5, c: 0.1, h: 270, a: 1.00 },
    ]);
    assert.equal(m.stops[0].a, 0.25);
    assert.equal(m.stops[1].a, 0.50);
    assert.equal(m.stops[2].a, 0.75);
    assert.equal(m.stops[3].a, 1.00);
});

test('sampleAt bilinear-lerps alpha', () => {
    // Diagonal alpha ramp: top-left = 0, bottom-right = 1.
    // Center (u=v=0.5) should be 0.5.
    const m = new MeshGradient(2, 2, [
        { l: 0.5, c: 0.1, h:  0, a: 0.0 },  // (0,0)
        { l: 0.5, c: 0.1, h: 90, a: 0.5 },  // (1,0)
        { l: 0.5, c: 0.1, h: 180, a: 0.5 }, // (0,1)
        { l: 0.5, c: 0.1, h: 270, a: 1.0 }, // (1,1)
    ]);
    const out = { l: 0, c: 0, h: 0, a: 0 };
    m.sampleAt(0.5, 0.5, out);
    assert.ok(Math.abs(out.a - 0.5) < 1e-6,
        `expected alpha 0.5 at center, got ${out.a}`);
});

test('rasterizeTo packs alpha into output Uint32', () => {
    // All four corners have alpha 0.5. The packed Uint32 should encode
    // alpha ~= 0x80 (128) in the high byte.
    const m = new MeshGradient(2, 2, [
        { l: 0.5, c: 0.1, h:  0, a: 0.5 },
        { l: 0.5, c: 0.1, h: 90, a: 0.5 },
        { l: 0.5, c: 0.1, h: 180, a: 0.5 },
        { l: 0.5, c: 0.1, h: 270, a: 0.5 },
    ]);
    const out = new Uint32Array(16 * 16);
    m.rasterizeTo(out, 16, 16);
    // Little-endian byte order: alpha is the high byte.
    const alphaByte = (out[0] >>> 24) & 0xFF;
    assert.ok(Math.abs(alphaByte - 0x80) <= 2,
        `expected ~0x80 alpha byte, got 0x${alphaByte.toString(16)}`);
});

test('rasterizeDeformedTo packs alpha into output Uint32', () => {
    const m = new MeshGradient(2, 2, [
        { l: 0.5, c: 0.1, h:  0, a: 0.25 },
        { l: 0.5, c: 0.1, h: 90, a: 0.25 },
        { l: 0.5, c: 0.1, h: 180, a: 0.25 },
        { l: 0.5, c: 0.1, h: 270, a: 0.25 },
    ]);
    const out = new Uint32Array(8 * 8);
    m.rasterizeDeformedTo(out, 8, 8);
    // Sample a pixel near center — corners may be miss due to strict
    // in-quad test, but interior is covered.
    const centerPx = out[4 * 8 + 4];
    const alphaByte = (centerPx >>> 24) & 0xFF;
    assert.ok(Math.abs(alphaByte - 0x40) <= 2,
        `expected ~0x40 (25%) alpha byte, got 0x${alphaByte.toString(16)}`);
});

/* ── multi-format exporters ──────────────────────────────────────── */

test('toCss1d emits alpha for translucent stops', () => {
    const css = toCss1d({
        mode: 'linear',
        angle: 90,
        stops: [
            { l: 0.5, c: 0.2, h:  0, a: 0.3, stop: 0 },
            { l: 0.5, c: 0.2, h: 90, a: 1.0, stop: 1 },
        ],
    });
    assert.match(css, /\/ 0\.3\)/);
});

test('toJson1d includes alpha only when < 1', () => {
    const json = JSON.parse(toJson1d({
        mode: 'linear',
        angle: 90,
        stops: [
            { l: 0.5, c: 0.2, h:  0, a: 1.0, stop: 0 },   // opaque, no field
            { l: 0.5, c: 0.2, h: 90, a: 0.5, stop: 1 },   // translucent, field
        ],
    }));
    assert.equal(json.stops[0].alpha, undefined,
        'opaque stop should omit alpha field');
    assert.equal(json.stops[1].alpha, 0.5,
        'translucent stop should include alpha field');
    // JSON should also include 8-char hex for the translucent stop.
    assert.match(json.stops[1].hex, /^#[0-9a-f]{8}$/);
    assert.match(json.stops[0].hex, /^#[0-9a-f]{6}$/);
});

test('toSvg1d uses stop-opacity attribute for alpha', () => {
    const svg = toSvg1d({
        mode: 'linear',
        angle: 90,
        stops: [
            { l: 0.5, c: 0.2, h:  0, a: 0.4, stop: 0 },
            { l: 0.5, c: 0.2, h: 90, a: 1.0, stop: 1 },
        ],
    });
    // Translucent stop should have stop-opacity attribute.
    assert.match(svg, /stop-opacity="0\.400"/);
    // Opaque stop should NOT have stop-opacity (cleaner output).
    const lines = svg.split('\n').filter((l) => l.includes('<stop'));
    assert.equal(lines.length, 2);
    assert.ok(!lines[1].includes('stop-opacity'),
        'opaque stop should omit stop-opacity attribute');
});

test('toJsonMesh includes alpha when < 1', () => {
    const m = new MeshGradient(2, 2, [
        { l: 0.5, c: 0.1, h:  0, a: 0.3 },
        { l: 0.5, c: 0.1, h: 90 },              // defaults to a=1
        { l: 0.5, c: 0.1, h: 180 },
        { l: 0.5, c: 0.1, h: 270 },
    ]);
    const json = JSON.parse(toJsonMesh(m));
    assert.equal(json.stops[0].alpha, 0.3);
    assert.equal(json.stops[1].alpha, undefined);
});

test('formatCssMesh threads alpha through radial layers', () => {
    const m = new MeshGradient(2, 2, [
        { l: 0.5, c: 0.1, h:  0, a: 0.4 },
        { l: 0.5, c: 0.1, h: 90, a: 0.4 },
        { l: 0.5, c: 0.1, h: 180, a: 0.4 },
        { l: 0.5, c: 0.1, h: 270, a: 0.4 },
    ]);
    const css = formatCssMesh(m);
    // At least one radial layer should carry the 0.4 alpha through.
    assert.match(css, /\/ 0\.4\)/);
});
