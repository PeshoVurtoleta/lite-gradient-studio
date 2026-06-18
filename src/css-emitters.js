/**
 * CSS gradient emitters — linear, radial, conic.
 *
 * Why these exist (vs lite-gradient's built-in toCssLinear): the
 * upstream emitter resamples at N evenly spaced positions, discarding
 * the authored stop positions. These emit the actual stops at their
 * authored positions and optionally tag the gradient with the
 * `in oklch` interpolation hint so the browser interpolates in OKLCH
 * (matching the canvas preview perceptually instead of through sRGB).
 *
 * Conic isn't in lite-gradient at all — this module is its only home.
 */

import { toCssOklch } from '@zakkster/lite-color';

/**
 * @param {object}  gradient            { stops: [{l,c,h,pos}, ...] }
 * @param {object}  [opts]
 * @param {number}  [opts.angle=90]           90 = left→right.
 * @param {boolean} [opts.oklchInterp=true]   Emit `in oklch` hint.
 */
export function formatCssLinear(gradient, opts = {}) {
    const { angle = 90, oklchInterp = true } = opts;
    const scratch = { l: 0, c: 0, h: 0, a: 1 };
    const parts = [];
    for (let i = 0; i < gradient.stops.length; i++) {
        const s = gradient.stops[i];
        scratch.l = s.l; scratch.c = s.c; scratch.h = s.h;
        scratch.a = s.a === undefined ? 1 : s.a;
        parts.push(`${toCssOklch(scratch)} ${(s.pos * 100).toFixed(2)}%`);
    }
    const prefix = oklchInterp ? `${angle}deg in oklch` : `${angle}deg`;
    return `linear-gradient(${prefix}, ${parts.join(', ')})`;
}

/**
 * @param {object}  gradient
 * @param {object}  [opts]
 * @param {string}  [opts.shape='circle']           'circle' | 'ellipse'
 * @param {string}  [opts.size='farthest-corner']
 * @param {string}  [opts.position='center']
 * @param {boolean} [opts.oklchInterp=true]
 */
export function formatCssRadial(gradient, opts = {}) {
    const {
        shape = 'circle',
        size = 'farthest-corner',
        position = 'center',
        oklchInterp = true,
    } = opts;
    const scratch = { l: 0, c: 0, h: 0, a: 1 };
    const parts = [];
    for (let i = 0; i < gradient.stops.length; i++) {
        const s = gradient.stops[i];
        scratch.l = s.l; scratch.c = s.c; scratch.h = s.h;
        scratch.a = s.a === undefined ? 1 : s.a;
        parts.push(`${toCssOklch(scratch)} ${(s.pos * 100).toFixed(2)}%`);
    }
    const geometry = `${shape} ${size} at ${position}`;
    const prefix = oklchInterp ? `${geometry} in oklch` : geometry;
    return `radial-gradient(${prefix}, ${parts.join(', ')})`;
}

/**
 * Stops are mapped from gradient's [0,1] range to [0deg, 360deg].
 *
 * @param {object}  gradient
 * @param {object}  [opts]
 * @param {number}  [opts.from=0]            Starting angle in degrees.
 * @param {string}  [opts.position='center']
 * @param {boolean} [opts.oklchInterp=true]
 */
export function formatCssConic(gradient, opts = {}) {
    const { from = 0, position = 'center', oklchInterp = true } = opts;
    const scratch = { l: 0, c: 0, h: 0, a: 1 };
    const parts = [];
    for (let i = 0; i < gradient.stops.length; i++) {
        const s = gradient.stops[i];
        scratch.l = s.l; scratch.c = s.c; scratch.h = s.h;
        scratch.a = s.a === undefined ? 1 : s.a;
        parts.push(`${toCssOklch(scratch)} ${(s.pos * 360).toFixed(2)}deg`);
    }
    const geometry = `from ${from}deg at ${position}`;
    const prefix = oklchInterp ? `${geometry} in oklch` : geometry;
    return `conic-gradient(${prefix}, ${parts.join(', ')})`;
}
