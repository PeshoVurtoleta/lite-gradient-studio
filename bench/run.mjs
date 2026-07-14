/**
 * lite-gradient-studio benchmarks.
 *
 * Honest numbers, runnable on any machine. Each bench warms up,
 * runs a timed pass, computes ops/sec from elapsed time, and prints
 * a compact table. No external framework — `process.hrtime.bigint()`
 * gives us nanosecond resolution which is more than enough.
 *
 * Run:   node --expose-gc bench/run.mjs
 * Filter: node --expose-gc bench/run.mjs mesh   (substring match)
 */

import { Gradient, formatCssLinear } from '../src/index.js';
import {
    MeshGradient,
    packOklchSingle,
    parseGradientCss,
    extractPalette,
    toCssMesh,
} from '../src/index.js';

const filter = process.argv[2] || '';

const COLORS_3 = [
    { l: 0.42, c: 0.22, h: 270, pos: 0.0 },
    { l: 0.65, c: 0.26, h: 320, pos: 0.5 },
    { l: 0.82, c: 0.18, h:  55, pos: 1.0 },
];
const COLORS_5 = [
    { l: 0.35, c: 0.20, h: 240, pos: 0.00 },
    { l: 0.50, c: 0.24, h: 285, pos: 0.25 },
    { l: 0.65, c: 0.26, h: 330, pos: 0.50 },
    { l: 0.75, c: 0.22, h:  15, pos: 0.75 },
    { l: 0.82, c: 0.18, h:  55, pos: 1.00 },
];

function bench(name, opsPerCall, fn) {
    if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
    // Warmup — JIT primer.
    for (let i = 0; i < 50; i++) fn();
    if (global.gc) global.gc();
    const targetMs = 400;
    let iters = 0;
    const start = process.hrtime.bigint();
    while (Number(process.hrtime.bigint() - start) / 1e6 < targetMs) {
        fn();
        iters++;
    }
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const elapsedSec = elapsedNs / 1e9;
    const opsPerSec = (iters * opsPerCall) / elapsedSec;
    const fmt = opsPerSec > 1e6
        ? `${(opsPerSec / 1e6).toFixed(1)}M ops/sec`
        : opsPerSec > 1e3
            ? `${(opsPerSec / 1e3).toFixed(1)}K ops/sec`
            : `${opsPerSec.toFixed(0)} ops/sec`;
    console.log(`  ${name.padEnd(50)} ${fmt}`);
}

console.log('\n@zakkster/lite-gradient-studio — benchmarks\n');
console.log(`  Node ${process.version} on ${process.platform}/${process.arch}\n`);

// ── Gradient sampling ───────────────────────────────────────────
console.log('1D gradient (Gradient class)');
{
    const g3 = new Gradient(COLORS_3);
    const g5 = new Gradient(COLORS_5);
    const scratch = { l: 0, c: 0, h: 0, a: 1 };
    bench('Gradient.at(t) — 3 stops',  1, () => g3.at(0.5, scratch));
    bench('Gradient.at(t) — 5 stops',  1, () => g5.at(0.5, scratch));
    bench('Gradient.at(t) — sweep 1000 t — 5 stops', 1000, () => {
        for (let i = 0; i < 1000; i++) g5.at(i / 999, scratch);
    });
}

// ── CSS emit ────────────────────────────────────────────────────
console.log('\nCSS emit');
{
    const g3 = new Gradient(COLORS_3);
    const g5 = new Gradient(COLORS_5);
    bench('formatCssLinear — 3 stops',         1, () => formatCssLinear(g3, { angle: 90, oklchInterp: true }));
    bench('formatCssLinear — 5 stops, no hint', 1, () => formatCssLinear(g5, { angle: 90, oklchInterp: false }));
}

// ── Mesh sample + rasterize ────────────────────────────────────
console.log('\nMesh kernel');
{
    const m3 = new MeshGradient(3, 3);
    const m5 = new MeshGradient(5, 5);
    const scratch = { l: 0, c: 0, h: 0, a: 1 };
    bench('MeshGradient.sampleAt(u,v) — 3×3 smooth', 1, () => m3.sampleAt(0.5, 0.5, scratch, 'smooth'));
    bench('MeshGradient.sampleAt(u,v) — 5×5 smooth', 1, () => m5.sampleAt(0.5, 0.5, scratch, 'smooth'));
    bench('MeshGradient.sampleAt(u,v) — 5×5 cubic',  1, () => m5.sampleAt(0.5, 0.5, scratch, 'cubic'));

    // v1.2.0 wrap benches — establish empirical ceilings for the new paths.
    // Wrap-off numbers above stay comparable to v1.1.0. Wrap-on ceilings
    // land here after the first honest measurement of the implementation.
    const m5wx = new MeshGradient(5, 5, undefined, { wrapX: true });
    const m5wt = new MeshGradient(5, 5, undefined, { wrapX: true, wrapY: true });
    bench('MeshGradient.sampleAt — 5×5 smooth, wrapX', 1, () => m5wx.sampleAt(0.5, 0.5, scratch, 'smooth'));
    bench('MeshGradient.sampleAt — 5×5 smooth, torus', 1, () => m5wt.sampleAt(0.5, 0.5, scratch, 'smooth'));
    bench('MeshGradient.sampleAt — 5×5 cubic,  wrapX', 1, () => m5wx.sampleAt(0.5, 0.5, scratch, 'cubic'));
    bench('MeshGradient.sampleAt — 5×5 cubic,  torus', 1, () => m5wt.sampleAt(0.5, 0.5, scratch, 'cubic'));

    // Rasterize. Allocate buffer once outside the timing loop.
    const W = 256, H = 256;
    const buf = new Uint32Array(W * H);
    bench(`rasterizeTo — 3×3 → ${W}×${H} (${W * H} px)`, W * H, () => {
        m3.rasterizeTo(buf, W, H, { mode: 'smooth' });
    });
    bench(`rasterizeTo — 5×5 → ${W}×${H} (${W * H} px)`, W * H, () => {
        m5.rasterizeTo(buf, W, H, { mode: 'smooth' });
    });
    bench(`rasterizeTo — 5×5 wrapX → ${W}×${H}`, W * H, () => {
        m5wx.rasterizeTo(buf, W, H, { mode: 'smooth' });
    });
    bench(`rasterizeTo — 5×5 torus → ${W}×${H}`, W * H, () => {
        m5wt.rasterizeTo(buf, W, H, { mode: 'smooth' });
    });
    bench(`rasterizeTo — 5×5 cubic wrapX → ${W}×${H}`, W * H, () => {
        m5wx.rasterizeTo(buf, W, H, { mode: 'cubic' });
    });
    // v1.2.0 dither benches — the dithered path pays one extra tile lookup
    // + a threshold-offset gamma round per pixel. Ceilings set here for T3
    // parity checks.
    bench(`rasterizeTo — 5×5 dither → ${W}×${H}`, W * H, () => {
        m5.rasterizeTo(buf, W, H, { mode: 'smooth', dither: true });
    });
    bench(`rasterizeTo — 5×5 wrapX + dither → ${W}×${H}`, W * H, () => {
        m5wx.rasterizeTo(buf, W, H, { mode: 'smooth', dither: true });
    });
    bench(`rasterizeTo — 5×5 cubic + dither → ${W}×${H}`, W * H, () => {
        m5.rasterizeTo(buf, W, H, { mode: 'cubic', dither: true });
    });
    bench(`rasterizeDeformedTo — 5×5 → ${W}×${H}`, W * H, () => {
        m5.rasterizeDeformedTo(buf, W, H, { mode: 'smooth' });
    });
}

// ── Mesh CSS approximation ─────────────────────────────────────
console.log('\nMesh → CSS approximation');
{
    const m3 = new MeshGradient(3, 3);
    const m5 = new MeshGradient(5, 5);
    bench('toCssMesh — 3×3', 1, () => toCssMesh(m3));
    bench('toCssMesh — 5×5', 1, () => toCssMesh(m5));
}

// ── Pixel packing (rasterizer hot loop) ────────────────────────
console.log('\nPixel packing (rasterizer inner loop)');
bench('packOklchSingle — single pixel', 1, () => packOklchSingle(0.65, 0.26, 320, 1));

// ── Palette extract ────────────────────────────────────────────
console.log('\nPalette extraction');
{
    // 240×240 RGBA buffer = matches the downsample target used by the
    // Gradient Studio app's image-import pipeline.
    const W = 240, H = 240;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < rgba.length; i += 4) {
        rgba[i]     = (i / 4) % 256;
        rgba[i + 1] = ((i / 4) * 7) % 256;
        rgba[i + 2] = ((i / 4) * 13) % 256;
        rgba[i + 3] = 255;
    }
    bench(`extractPalette — ${W}×${H}, k=5`, 1, () => extractPalette(rgba, W, H, 5));
}

// ── Parsing ────────────────────────────────────────────────────
console.log('\nCSS parsing');
{
    const css = 'linear-gradient(135deg, oklch(0.42 0.22 270) 0%, oklch(0.65 0.26 320) 50%, oklch(0.82 0.18 55) 100%)';
    bench('parseGradientCss — 3-stop linear', 1, () => parseGradientCss(css));
}

console.log('\nDone.\n');
