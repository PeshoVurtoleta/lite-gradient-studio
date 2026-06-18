import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MeshGradient, formatCssMesh } from '../src/index.js';

test('formatCssMesh emits one radial-gradient per stop plus base', () => {
    const m = new MeshGradient(3, 3);
    const css = formatCssMesh(m);
    const radialCount = (css.match(/radial-gradient\(/g) || []).length;
    assert.equal(radialCount, 9, '3×3 mesh → 9 radial layers');
});

test('formatCssMesh emits no base when includeBase: false', () => {
    const m = new MeshGradient(2, 2);
    const css = formatCssMesh(m, { includeBase: false });
    const radialCount = (css.match(/radial-gradient\(/g) || []).length;
    assert.equal(radialCount, 4);
    // Last segment should still be a gradient, not a base color.
    const lastSeg = css.split(/,\s*\n\s*/).pop();
    assert.ok(lastSeg.startsWith('radial-gradient'), 'last layer is a gradient');
});

test('formatCssMesh layer positions match stop (x, y) as percentages', () => {
    const m = new MeshGradient(2, 2);
    const css = formatCssMesh(m);
    // Corner positions: (0,0), (1,0), (0,1), (1,1)
    assert.match(css, /at 0\.0% 0\.0%/);
    assert.match(css, /at 100\.0% 0\.0%/);
    assert.match(css, /at 0\.0% 100\.0%/);
    assert.match(css, /at 100\.0% 100\.0%/);
});

test('formatCssMesh honors oklchInterp toggle', () => {
    const m = new MeshGradient(2, 2);
    const withInterp = formatCssMesh(m, { oklchInterp: true });
    const noInterp   = formatCssMesh(m, { oklchInterp: false });
    assert.match(withInterp, /in oklch/);
    assert.doesNotMatch(noInterp, /in oklch/);
});

test('formatCssMesh accepts ellipse shape', () => {
    const m = new MeshGradient(2, 2);
    const css = formatCssMesh(m, { shape: 'ellipse' });
    assert.match(css, /radial-gradient\(ellipse at/);
    assert.doesNotMatch(css, /radial-gradient\(circle at/);
});

test('formatCssMesh radius scales sensibly with mesh size', () => {
    const m2 = new MeshGradient(2, 2);
    const m5 = new MeshGradient(5, 5);
    const css2 = formatCssMesh(m2);
    const css5 = formatCssMesh(m5);
    const extractRadius = (css) => {
        const m = css.match(/transparent (\d+)%/);
        return m ? +m[1] : NaN;
    };
    const r2 = extractRadius(css2);
    const r5 = extractRadius(css5);
    assert.ok(r5 < r2,
        `5×5 should have smaller per-layer radius than 2×2 (${r5} vs ${r2})`);
});

test('formatCssMesh accepts explicit radiusPct override', () => {
    const m = new MeshGradient(3, 3);
    const css = formatCssMesh(m, { radiusPct: 42 });
    assert.match(css, /transparent 42%/);
});

test('formatCssMesh is deterministic for the same mesh', () => {
    const m = new MeshGradient(3, 3);
    assert.equal(formatCssMesh(m), formatCssMesh(m));
});

test('formatCssMesh does not mutate the mesh', () => {
    const m = new MeshGradient(3, 3);
    const before = JSON.parse(JSON.stringify(m.stops));
    formatCssMesh(m);
    formatCssMesh(m);
    const after = JSON.parse(JSON.stringify(m.stops));
    assert.deepEqual(after, before);
});

test('formatCssMesh circular hue averaging — 350/10 averages near 0/360, not 180', () => {
    // Two stops on opposite sides of the 0/360 wrap. If naive arithmetic
    // average is used, base hue lands at 180 (cyan). Circular mean must
    // give ~0 (red).
    const m = new MeshGradient(2, 2, [
        { l: 0.5, c: 0.2, h: 350 },
        { l: 0.5, c: 0.2, h:  10 },
        { l: 0.5, c: 0.2, h: 350 },
        { l: 0.5, c: 0.2, h:  10 },
    ]);
    const css = formatCssMesh(m);
    // The last comma-separated layer (after \n            ) is the base
    // color (when includeBase is true). Parse its hue out.
    const segments = css.split(',\n            ');
    const base = segments[segments.length - 1];
    const hueMatch = base.match(/oklch\([\d.]+ [\d.]+ ([\d.]+)/);
    assert.ok(hueMatch, 'base layer should be an oklch() value');
    const hue = parseFloat(hueMatch[1]);
    // Acceptable range near 0/360.
    const nearZero = hue < 15 || hue > 345;
    assert.ok(nearZero,
        `base hue should be near 0/360 (red), got ${hue}`);
});
