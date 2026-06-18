/**
 * OKLCH <-> hex.
 *
 * Pure math; no DOM. Ported from `@zakkster/lite-hueforge` so this
 * library doesn't depend on Hueforge for a single utility -- and so
 * future consumers can use Gradient Studio's exporters standalone.
 *
 * `toHex` is the hot path (called once per stop per export). The
 * gamut mapper does a 10-iteration binary search on chroma when the
 * requested color is out of sRGB -- precision dC ~= 0.0002, which is
 * well below perceptual threshold.
 *
 * Zero-GC discipline:
 * - `oklchToLinearSrgb(L, C, H, out?)`: pass a `[r, g, b]` array to
 *   `out` for zero-allocation; otherwise allocates one fresh array.
 * - `linearSrgbToOklch(r, g, b, out?)`: pass a `{l, c, h}` object to
 *   `out` for zero-allocation; otherwise allocates one fresh object.
 * - The internal binary-search helper uses a module-level scratch and
 *   takes (L, cosH, sinH) by parameter rather than closing over them,
 *   so no per-call closure is allocated either way.
 */

/* Module-level scratch for the gamut-mapping binary search. Single-
 * threaded JS: safe to reuse across calls. Not exposed. */
const _gamutTry = [0, 0, 0];

/**
 * Evaluate (L, C, H) -> linear-sRGB into `dst[0..2]`.
 * Pure helper: takes everything by parameter, no closures. Inlines fine.
 */
function evalOklchRgb(L, cosH, sinH, cVal, dst) {
    const a = cVal * cosH;
    const b = cVal * sinH;
    const lP = L + 0.3963377774 * a + 0.2158037573 * b;
    const mP = L - 0.1055613458 * a - 0.0638541728 * b;
    const sP = L - 0.0894841775 * a - 1.2914855480 * b;
    const lL = lP * lP * lP;
    const mL = mP * mP * mP;
    const sL = sP * sP * sP;
    dst[0] = +4.0767416621 * lL - 3.3077115913 * mL + 0.2309699292 * sL;
    dst[1] = -1.2684380046 * lL + 2.6097574011 * mL - 0.3413193965 * sL;
    dst[2] = -0.0041960863 * lL - 0.7034186147 * mL + 1.7076147010 * sL;
}

/**
 * OKLCH -> linear sRGB triplet, with sRGB-gamut mapping by chroma reduction.
 * Output range: each channel in [0, 1].
 *
 * @param {number} L
 * @param {number} C
 * @param {number} H
 * @param {number[]} [out]   3-element array. If provided, written in place
 *                           and returned (zero allocation). Otherwise a
 *                           fresh `[r, g, b]` array is allocated.
 * @returns {number[]}       Same `out` if provided, else a new array.
 */
export function oklchToLinearSrgb(L, C, H, out) {
    if (!out) out = [0, 0, 0];

    const hRad = H * Math.PI / 180;
    const cosH = Math.cos(hRad);
    const sinH = Math.sin(hRad);

    // Try the requested chroma. If it's in-gamut, we're done.
    evalOklchRgb(L, cosH, sinH, C, out);
    if (
        out[0] >= 0 && out[0] <= 1 &&
        out[1] >= 0 && out[1] <= 1 &&
        out[2] >= 0 && out[2] <= 1
    ) {
        return out;
    }

    // Out of gamut. Try C=0 (a neutral at the same L). If that's STILL
    // out of gamut, L is extreme (caller passed L > 1 or L < 0); clamp
    // channelwise and return.
    evalOklchRgb(L, cosH, sinH, 0, _gamutTry);
    if (
        _gamutTry[0] < 0 || _gamutTry[0] > 1 ||
        _gamutTry[1] < 0 || _gamutTry[1] > 1 ||
        _gamutTry[2] < 0 || _gamutTry[2] > 1
    ) {
        if (out[0] < 0) out[0] = 0; else if (out[0] > 1) out[0] = 1;
        if (out[1] < 0) out[1] = 0; else if (out[1] > 1) out[1] = 1;
        if (out[2] < 0) out[2] = 0; else if (out[2] > 1) out[2] = 1;
        return out;
    }

    // Binary search for the largest in-gamut chroma in [0, C]. The fit
    // is held in `out`; the candidate at the current `midC` is in
    // `_gamutTry`. Precision dC ~= C / 2^10 ~= 0.0002 -- well below
    // perceptual threshold.
    let lo = 0, hi = C;
    out[0] = _gamutTry[0]; out[1] = _gamutTry[1]; out[2] = _gamutTry[2];
    for (let i = 0; i < 10; i++) {
        const midC = (lo + hi) / 2;
        evalOklchRgb(L, cosH, sinH, midC, _gamutTry);
        if (
            _gamutTry[0] >= 0 && _gamutTry[0] <= 1 &&
            _gamutTry[1] >= 0 && _gamutTry[1] <= 1 &&
            _gamutTry[2] >= 0 && _gamutTry[2] <= 1
        ) {
            lo = midC;
            out[0] = _gamutTry[0];
            out[1] = _gamutTry[1];
            out[2] = _gamutTry[2];
        } else {
            hi = midC;
        }
    }
    return out;
}

/** sRGB transfer (linear -> gamma-encoded). IEC 61966-2-1. */
export function srgbGamma(x) {
    return x <= 0.0031308
        ? x * 12.92
        : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** sRGB inverse transfer (gamma-encoded -> linear). */
export function srgbInverseGamma(x) {
    return x <= 0.04045
        ? x / 12.92
        : Math.pow((x + 0.055) / 1.055, 2.4);
}

/* Scratch for `toHex`. Single allocation at module load; safe to reuse
 * because toHex completes synchronously and JS is single-threaded. */
const _toHexRgb = [0, 0, 0];

/**
 * OKLCH -> hex. Emits '#rrggbb' for opaque colors (a >= 1 or undefined)
 * and '#rrggbbaa' when alpha is below 1. Output always lowercase.
 *
 * Bit-pack trick: `(1<<24) | (R<<16) | (G<<8) | B` produces a number
 * whose hex string is exactly `1RRGGBB`. One `.toString(16)` + one
 * `.slice(1)` beats three `padStart(2, '0')` calls in both speed and
 * intermediate garbage.
 */
export function toHex({ l, c, h, a }) {
    oklchToLinearSrgb(l, c, h, _toHexRgb);
    const R = (srgbGamma(_toHexRgb[0]) * 255 + 0.5) | 0;
    const G = (srgbGamma(_toHexRgb[1]) * 255 + 0.5) | 0;
    const B = (srgbGamma(_toHexRgb[2]) * 255 + 0.5) | 0;
    const rgb = '#' + ((1 << 24) | (R << 16) | (G << 8) | B).toString(16).slice(1);
    // Opacity: skip the alpha byte when fully opaque, so the common case
    // produces clean 6-char hex matching design-tool conventions.
    if (a === undefined || a >= 1) return rgb;
    const A = clampByte(a * 255);
    return rgb + (A < 16 ? '0' : '') + A.toString(16);
}

function clampByte(v) {
    const n = (v + 0.5) | 0;
    return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * Linear sRGB -> OKLCH. Used by fromHex and the palette extractor.
 *
 * @param {number} r       Linear red, [0, 1].
 * @param {number} g
 * @param {number} b
 * @param {{l:number,c:number,h:number,a?:number}} [out]
 *        If provided, written in place and returned (zero allocation).
 *        The `a` field is left untouched -- callers that need alpha
 *        plumbing set it themselves.
 * @returns {{l:number,c:number,h:number}}  Same `out` if provided.
 */
export function linearSrgbToOklch(r, g, b, out) {
    if (!out) out = { l: 0, c: 0, h: 0 };
    const lLms = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const mLms = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const sLms = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    const lP = Math.cbrt(lLms);
    const mP = Math.cbrt(mLms);
    const sP = Math.cbrt(sLms);
    const L = 0.2104542553 * lP + 0.7936177850 * mP - 0.0040720468 * sP;
    const aa = 1.9779984951 * lP - 2.4285922050 * mP + 0.4505937099 * sP;
    const bb = 0.0259040371 * lP + 0.7827717662 * mP - 0.8086757660 * sP;
    const C = Math.sqrt(aa * aa + bb * bb);
    let H = Math.atan2(bb, aa) * 180 / Math.PI;
    if (H < 0) H += 360;
    out.l = L; out.c = C; out.h = H;
    return out;
}

/**
 * Hex string -> { l, c, h, a }. Accepts:
 *   - 3-char  '#rgb'      (alpha defaults to 1)
 *   - 4-char  '#rgba'     (each nibble doubled)
 *   - 6-char  '#rrggbb'   (alpha defaults to 1)
 *   - 8-char  '#rrggbbaa'
 * '#' prefix is optional; case-insensitive.
 *
 * @throws on malformed input.
 */
export function fromHex(hex) {
    let s = String(hex).trim();
    if (s.startsWith('#')) s = s.slice(1);

    let r, g, b, a = 1;
    if (s.length === 3 && /^[0-9a-fA-F]{3}$/.test(s)) {
        r = parseInt(s[0] + s[0], 16) / 255;
        g = parseInt(s[1] + s[1], 16) / 255;
        b = parseInt(s[2] + s[2], 16) / 255;
    } else if (s.length === 4 && /^[0-9a-fA-F]{4}$/.test(s)) {
        r = parseInt(s[0] + s[0], 16) / 255;
        g = parseInt(s[1] + s[1], 16) / 255;
        b = parseInt(s[2] + s[2], 16) / 255;
        a = parseInt(s[3] + s[3], 16) / 255;
    } else if (s.length === 6 && /^[0-9a-fA-F]{6}$/.test(s)) {
        r = parseInt(s.slice(0, 2), 16) / 255;
        g = parseInt(s.slice(2, 4), 16) / 255;
        b = parseInt(s.slice(4, 6), 16) / 255;
    } else if (s.length === 8 && /^[0-9a-fA-F]{8}$/.test(s)) {
        r = parseInt(s.slice(0, 2), 16) / 255;
        g = parseInt(s.slice(2, 4), 16) / 255;
        b = parseInt(s.slice(4, 6), 16) / 255;
        a = parseInt(s.slice(6, 8), 16) / 255;
    } else {
        throw new Error(`fromHex: invalid hex "${hex}"`);
    }

    const oklch = linearSrgbToOklch(
        srgbInverseGamma(r),
        srgbInverseGamma(g),
        srgbInverseGamma(b),
    );
    oklch.a = a;
    return oklch;
}
