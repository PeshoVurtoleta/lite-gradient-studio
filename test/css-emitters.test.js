import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    Gradient,
    formatCssLinear,
    formatCssRadial,
    formatCssConic,
} from '../src/index.js';

const threeStop = new Gradient([
    { l: 0.30, c: 0.15, h: 270 },
    { l: 0.55, c: 0.25, h: 330 },
    { l: 0.85, c: 0.15, h:  60 },
]);

test('formatCssLinear emits authored stop positions, not resampled ones', () => {
    const css = formatCssLinear(threeStop, { angle: 90, oklchInterp: false });
    assert.match(css, /^linear-gradient\(90deg, /);
    // Three stops, three positions
    assert.match(css, /0\.00%/);
    assert.match(css, /50\.00%/);
    assert.match(css, /100\.00%/);
    // Only three commas-separated parts after the angle
    const body = css.replace(/^linear-gradient\(90deg, /, '').replace(/\)$/, '');
    assert.equal(body.split(/,\s+/).length, 3);
});

test('formatCssLinear honors custom stop positions', () => {
    const g = new Gradient([
        { l: 0.10, c: 0.0, h: 0,   stop: 0.00 },
        { l: 0.50, c: 0.0, h: 0,   stop: 0.20 },
        { l: 0.90, c: 0.0, h: 0,   stop: 1.00 },
    ]);
    const css = formatCssLinear(g, { angle: 45, oklchInterp: false });
    assert.match(css, /^linear-gradient\(45deg, /);
    assert.match(css, /20\.00%/);
});

test('formatCssLinear with oklchInterp tags the gradient correctly', () => {
    const css = formatCssLinear(threeStop, { angle: 90, oklchInterp: true });
    assert.match(css, /^linear-gradient\(90deg in oklch, /);
});

test('formatCssRadial emits geometry and stops', () => {
    const css = formatCssRadial(threeStop, { oklchInterp: false });
    assert.match(css, /^radial-gradient\(circle farthest-corner at center, /);
    assert.match(css, /0\.00%/);
    assert.match(css, /100\.00%/);
});

test('formatCssRadial accepts shape, size, position overrides', () => {
    const css = formatCssRadial(threeStop, {
        shape: 'ellipse',
        size: 'closest-side',
        position: 'top left',
        oklchInterp: false,
    });
    assert.match(css, /ellipse closest-side at top left/);
});

test('formatCssConic maps [0,1] to [0deg, 360deg]', () => {
    const css = formatCssConic(threeStop, { oklchInterp: false });
    assert.match(css, /^conic-gradient\(from 0deg at center, /);
    assert.match(css, /0\.00deg/);
    assert.match(css, /180\.00deg/);
    assert.match(css, /360\.00deg/);
});

test('formatCssConic honors from-angle override', () => {
    const css = formatCssConic(threeStop, { from: 45, oklchInterp: true });
    assert.match(css, /^conic-gradient\(from 45deg at center in oklch, /);
});

test('emitters do not mutate the gradient', () => {
    const before = JSON.parse(JSON.stringify(threeStop.stops));
    formatCssLinear(threeStop);
    formatCssRadial(threeStop);
    formatCssConic(threeStop);
    const after = JSON.parse(JSON.stringify(threeStop.stops));
    assert.deepEqual(after, before);
});

test('Gradient re-export wires through unchanged', () => {
    // Sanity: the underlying Gradient is the one from lite-gradient and still works
    const out = { l: 0, c: 0, h: 0 };
    threeStop.at(0.0, out);
    assert.equal(out.l, 0.30);
    threeStop.at(1.0, out);
    assert.equal(out.l, 0.85);
});
