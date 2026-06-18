import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MeshGradient,
    EXPORT_FORMATS_1D, EXPORT_FORMATS_MESH, FORMAT_META,
    toTokens1d, toTokensMesh,
    toCss1d, toCssVar1d, toScss1d, toTailwind1d, toJson1d, toSvg1d,
    toCssMesh, toCssVarMesh, toJsonMesh,
} from '../src/index.js';

const sample1d = {
    mode: 'linear',
    angle: 90,
    radShape: 'circle', radPos: 'center',
    conFrom: 0, conPos: 'center',
    stops: [
        { l: 0.30, c: 0.15, h: 270, stop: 0.0 },
        { l: 0.55, c: 0.25, h: 330, stop: 0.5 },
        { l: 0.85, c: 0.15, h:  60, stop: 1.0 },
    ],
};

test('EXPORT_FORMATS_1D is frozen', () => {
    assert.throws(() => EXPORT_FORMATS_1D.push('x'));
});

test('FORMAT_META has entries for every 1D format', () => {
    for (const f of EXPORT_FORMATS_1D) {
        assert.ok(FORMAT_META[f], `missing meta for ${f}`);
        assert.ok(FORMAT_META[f].label);
        assert.ok(FORMAT_META[f].hint);
    }
});

test('toTokens1d dispatches to each named format without throwing', () => {
    for (const f of EXPORT_FORMATS_1D) {
        const out = toTokens1d(sample1d, f);
        assert.equal(typeof out, 'string');
        assert.ok(out.length > 0, `empty output for ${f}`);
    }
});

test('toTokens1d rejects unknown format', () => {
    assert.throws(() => toTokens1d(sample1d, 'invented'));
});

test('toCss1d emits a background: declaration with linear-gradient', () => {
    const css = toCss1d(sample1d);
    assert.match(css, /^background: linear-gradient\(/);
    assert.ok(css.endsWith(';'));
});

test('toCss1d switches by mode', () => {
    assert.match(toCss1d({ ...sample1d, mode: 'radial' }), /radial-gradient\(/);
    assert.match(toCss1d({ ...sample1d, mode: 'conic'  }), /conic-gradient\(/);
});

test('toCssVar1d slugifies the name', () => {
    const css = toCssVar1d(sample1d, { name: 'Hero Banner' });
    assert.match(css, /--hero-banner:/);
});

test('toScss1d uses $ prefix', () => {
    const scss = toScss1d(sample1d, { name: 'my gradient' });
    assert.match(scss, /^\$my-gradient:/);
});

test('toTailwind1d wraps in backgroundImage extend', () => {
    const tw = toTailwind1d(sample1d, { name: 'hero' });
    assert.match(tw, /backgroundImage:/);
    assert.match(tw, /'hero':/);
    assert.match(tw, /bg-hero/);
});

test('toJson1d is valid JSON with expected shape', () => {
    const json = toJson1d(sample1d);
    const obj  = JSON.parse(json);
    assert.equal(obj.$studio, 'gradient-studio');
    assert.equal(obj.type, 'linear');
    assert.equal(obj.angle, 90);
    assert.equal(obj.stops.length, 3);
    assert.ok(obj.stops[0].hex.match(/^#[0-9a-f]{6}$/));
});

test('toJson1d includes mode-specific params', () => {
    const lin = JSON.parse(toJson1d({ ...sample1d, mode: 'linear', angle: 45 }));
    assert.equal(lin.angle, 45);

    const rad = JSON.parse(toJson1d({ ...sample1d, mode: 'radial', radShape: 'ellipse', radPos: 'top left' }));
    assert.equal(rad.shape, 'ellipse');
    assert.equal(rad.position, 'top left');
    assert.equal(rad.angle, undefined);

    const con = JSON.parse(toJson1d({ ...sample1d, mode: 'conic', conFrom: 90, conPos: 'center' }));
    assert.equal(con.from, 90);
    assert.equal(con.position, 'center');
});

test('toSvg1d emits a self-contained <svg> with stops as hex', () => {
    const svg = toSvg1d(sample1d);
    assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<linearGradient id="gradient"/);
    // Each input stop becomes a <stop> with hex color.
    const stopMatches = svg.match(/<stop offset="[\d.]+%" stop-color="#[0-9a-f]{6}"/g);
    assert.equal(stopMatches.length, 3);
});

test('toSvg1d radial mode uses radialGradient element', () => {
    const svg = toSvg1d({ ...sample1d, mode: 'radial' });
    assert.match(svg, /<radialGradient id="gradient"/);
});

test('toSvg1d honors width/height opts', () => {
    const svg = toSvg1d(sample1d, { width: 1920, height: 1080 });
    assert.match(svg, /width="1920" height="1080"/);
});

/* ── mesh exporters ──────────────────────────────────────────────── */

test('EXPORT_FORMATS_MESH is frozen', () => {
    assert.throws(() => EXPORT_FORMATS_MESH.push('x'));
});

test('toTokensMesh dispatches all formats', () => {
    const m = new MeshGradient(3, 3);
    for (const f of EXPORT_FORMATS_MESH) {
        const out = toTokensMesh(m, f);
        assert.equal(typeof out, 'string');
        assert.ok(out.length > 0);
    }
});

test('toJsonMesh includes cols, rows, and one stop per grid cell', () => {
    const m = new MeshGradient(3, 3);
    const obj = JSON.parse(toJsonMesh(m));
    assert.equal(obj.type, 'mesh');
    assert.equal(obj.cols, 3);
    assert.equal(obj.rows, 3);
    assert.equal(obj.stops.length, 9);
    // Each stop has hex
    assert.ok(obj.stops.every((s) => s.hex.match(/^#[0-9a-f]{6}$/)));
});

test('toCssMesh wraps formatCssMesh with `background:`', () => {
    const m = new MeshGradient(2, 2);
    const css = toCssMesh(m);
    assert.match(css, /^background: /);
    assert.ok(css.endsWith(';'));
});

test('toCssVarMesh slugifies and assigns to a custom property', () => {
    const m = new MeshGradient(2, 2);
    const css = toCssVarMesh(m, { name: 'Hero Mesh' });
    assert.match(css, /--hero-mesh:/);
});
