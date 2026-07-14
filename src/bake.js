/**
 * Pixel-buffer bake helpers.
 *
 * Builds on @zakkster/lite-color-engine's bakeGradientToUint32, with one
 * correctness wrapper: lite-color-engine treats keyframes as evenly spaced
 * internally. Gradients with custom stop positions must be pre-sampled at
 * LUT resolution so the position warp is baked in before packing.
 *
 * The pre-sample path also handles the more important second job: any
 * single-color "ramp" or fully-custom stop layout still bakes correctly
 * without having to teach the underlying engine about positions.
 */

import {
    bakeGradientToUint32,
    packOklchBufferToUint32,
    packOklchBufferToUint32Dithered,
} from '@zakkster/lite-color-engine';

const EVEN_SPACING_EPS = 1e-9;

/**
 * @param {{ stops: Array<{pos: number}> }} gradient
 * @returns {boolean}
 */
function stopsAreEvenlySpaced(gradient) {
    const stops = gradient.stops;
    const n = stops.length;
    if (n < 2) return true;
    const denom = n - 1;
    for (let i = 0; i < n; i++) {
        const expected = i / denom;
        if (Math.abs(stops[i].pos - expected) > EVEN_SPACING_EPS) return false;
    }
    return true;
}

/**
 * Flatten gradient stops into a Float32Array of [L, C, H, L, C, H, ...].
 * Caller-owned output for zero-GC if a buffer is supplied.
 *
 * @param {{ stops: Array<{l:number,c:number,h:number}> }} gradient
 * @param {Float32Array} [out]
 * @returns {Float32Array}
 */
export function flattenStopsToBuffer(gradient, out) {
    const stops = gradient.stops;
    const n = stops.length;
    const buf = out && out.length >= n * 3 ? out : new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const s = stops[i];
        const o = i * 3;
        buf[o]     = s.l;
        buf[o + 1] = s.c;
        buf[o + 2] = s.h;
    }
    return buf;
}

/**
 * Bake a Gradient into a fixed-resolution Uint32Array LUT of packed RGBA
 * (little-endian byte order — directly aliasable as ImageData).
 *
 * Honors custom stop positions via a pre-sample step. Use this for any
 * high-fidelity preview or PNG export path where Canvas2D's sRGB
 * interpolation between sampled stops is not acceptable.
 *
 * @param {object} gradient   A lite-gradient Gradient instance.
 * @param {number} [resolution=256]
 * @param {object} [opts]
 * @param {(t:number)=>number} [opts.easeFn]   Easing applied before stop selection (even-spaced path only).
 * @param {Function} [opts.packer]             Override packer (e.g. packOklchBufferToUint32Fast).
 * @returns {Uint32Array}
 */
export function bakeGradientToLut(gradient, resolution = 256, opts = {}) {
    const { easeFn, packer } = opts;

    if (stopsAreEvenlySpaced(gradient)) {
        // Fast path: hand raw stops to bake, let it interpolate up to LUT res.
        const keyframes = flattenStopsToBuffer(gradient);
        return bakeGradientToUint32(
            keyframes,
            gradient.stops.length,
            resolution,
            easeFn,
            packer,
        );
    }

    // Position-warped path: pre-sample at LUT resolution so authored
    // positions are honored, then bake at numStops=resolution (per-cell
    // interp degenerates to no-ops; effectively just packs).
    //
    // Note: easeFn is intentionally ignored here. Pre-sampling already
    // resolves authored positions to evenly spaced output cells, so warping
    // a second time would compound. Apply easing at sampleArray-call time
    // if you need it on this path.
    const sampled = new Float32Array(resolution * 3);
    gradient.sampleArray(sampled, resolution);
    return bakeGradientToUint32(
        sampled,
        resolution,
        resolution,
        undefined,
        packer,
    );
}

/**
 * Sample a single color from a baked LUT at parametric t.
 * Helper for testing and one-off lookups; for fills, write straight to
 * ImageData via Uint32Array aliasing instead.
 *
 * @param {Uint32Array} lut
 * @param {number} t  In [0, 1]; clamped.
 * @returns {number}  Packed RGBA in little-endian byte order.
 */
export function sampleLut(lut, t) {
    if (t <= 0) return lut[0];
    if (t >= 1) return lut[lut.length - 1];
    const idx = (t * (lut.length - 1)) | 0;
    return lut[idx];
}

/**
 * Pack a single OKLCH color directly to a 32-bit RGBA value.
 * Convenience re-export wrapping a 3-float scratch buffer so callers
 * don't have to manage one.
 *
 * @param {number} l
 * @param {number} c
 * @param {number} h
 * @param {number} [alpha=1]
 * @returns {number}
 */
const _packScratch = new Float32Array(3);
export function packOklchSingle(l, c, h, alpha = 1) {
    _packScratch[0] = l;
    _packScratch[1] = c;
    _packScratch[2] = h;
    return packOklchBufferToUint32(_packScratch, 0, alpha);
}

/**
 * Scalar-arg convenience wrapper around lite-color-engine v1.5's
 * `packOklchBufferToUint32Dithered`. Same output byte order (RGBA-LE),
 * same gamma-encode semantics — the only difference from `packOklchSingle`
 * is a threshold-offset applied at the round step: `byte = (enc*255 + noise01) | 0`
 * instead of `(enc*255 + 0.5) | 0`.
 *
 * Contract from the engine (restated for T2 D8):
 *   - The **same** noise value is used for R, G, and B at one pixel —
 *     luminance-patterned dither, no chroma speckle.
 *   - Alpha is undithered (banding on alpha is rarely visible and would
 *     interact badly with premultiplication).
 *   - `noise01 = 0.5` reproduces `packOklchSingle` exactly (identity
 *     anchor — trivially provable by the +0.5 rounding in the plain
 *     packer, which is what the dithered form emits at that noise value).
 *
 * Zero-GC: reuses the module-scoped `_packScratch` Float32Array(3) that
 * `packOklchSingle` uses. Consumers must not call both in reentrant
 * contexts (the studio rasterizers never do — one loop, one packer).
 *
 * @param {number} l  OKLCH lightness (0..1)
 * @param {number} c  OKLCH chroma (~0..0.4)
 * @param {number} h  OKLCH hue in degrees
 * @param {number} alpha  (0..1); undithered
 * @param {number} noise01  Threshold offset in [0, 1). Typically `(tile[i] + 0.5) / 256`
 *   where `tile` is `getBlueNoise64()` from the engine.
 * @returns {number} Uint32 RGBA-LE pixel.
 */
export function packOklchSingleDithered(l, c, h, alpha, noise01) {
    _packScratch[0] = l;
    _packScratch[1] = c;
    _packScratch[2] = h;
    return packOklchBufferToUint32Dithered(_packScratch, 0, alpha, noise01);
}
