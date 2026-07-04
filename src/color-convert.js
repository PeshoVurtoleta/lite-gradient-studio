/**
 * OKLCH ↔ hex.
 *
 * Pure math; no DOM. Ported from `@zakkster/lite-hueforge` so this
 * library doesn't depend on Hueforge for a single utility — and so
 * future consumers can use Gradient Studio's exporters standalone.
 *
 * `toHex` is the hot path (called once per stop per export). The
 * gamut mapper does a 10-iteration binary search on chroma when the
 * requested color is out of sRGB — precision Δc ≈ 0.0002, which is
 * well below perceptual threshold.
 */

/**
 * OKLCH → linear sRGB triplet, with sRGB-gamut mapping by chroma reduction.
 * Output: `[r, g, b]` each in `[0, 1]`.
 *
 * Zero-GC path: pass a caller-owned 3-element array as `out`. The function
 * writes into it and returns the same reference. Omit `out` (or pass null)
 * to get a fresh allocated array — back-compat with the 3-arg call shape.
 */
export function oklchToLinearSrgb(L, C, H, out) {
    const hRad = H * Math.PI / 180;
    const cosH = Math.cos(hRad);
    const sinH = Math.sin(hRad);

    function getRgb(cVal) {
        const a = cVal * cosH;
        const b = cVal * sinH;
        const lP = L + 0.3963377774 * a + 0.2158037573 * b;
        const mP = L - 0.1055613458 * a - 0.0638541728 * b;
        const sP = L - 0.0894841775 * a - 1.2914855480 * b;
        const lL = lP * lP * lP;
        const mL = mP * mP * mP;
        const sL = sP * sP * sP;
        const r  = +4.0767416621 * lL - 3.3077115913 * mL + 0.2309699292 * sL;
        const g  = -1.2684380046 * lL + 2.6097574011 * mL - 0.3413193965 * sL;
        const bb = -0.0041960863 * lL - 0.7034186147 * mL + 1.7076147010 * sL;
        return [r, g, bb];
    }

    let [r, g, bb] = getRgb(C);

    if (r >= 0 && r <= 1 && g >= 0 && g <= 1 && bb >= 0 && bb <= 1) {
        if (out) { out[0] = r; out[1] = g; out[2] = bb; return out; }
        return [r, g, bb];
    }

    // Gamut map via binary search on chroma. The C=0 point at this L is
    // always in gamut if L ∈ [0,1]; defensive fallback covers caller
    // passing out-of-range L.
    const [gr, gg, gb] = getRgb(0);
    if (gr < 0 || gr > 1 || gg < 0 || gg > 1 || gb < 0 || gb > 1) {
        if (r  < 0) r  = 0; else if (r  > 1) r  = 1;
        if (g  < 0) g  = 0; else if (g  > 1) g  = 1;
        if (bb < 0) bb = 0; else if (bb > 1) bb = 1;
        if (out) { out[0] = r; out[1] = g; out[2] = bb; return out; }
        return [r, g, bb];
    }

    let lo = 0, hi = C;
    let fitR = gr, fitG = gg, fitB = gb;
    for (let i = 0; i < 10; i++) {
        const midC = (lo + hi) / 2;
        const [mr, mg, mbb] = getRgb(midC);
        if (mr >= 0 && mr <= 1 && mg >= 0 && mg <= 1 && mbb >= 0 && mbb <= 1) {
            lo = midC;
            fitR = mr; fitG = mg; fitB = mbb;
        } else {
            hi = midC;
        }
    }
    if (out) { out[0] = fitR; out[1] = fitG; out[2] = fitB; return out; }
    return [fitR, fitG, fitB];
}

/** sRGB transfer (linear → gamma-encoded). IEC 61966-2-1. */
export function srgbGamma(x) {
    return x <= 0.0031308
        ? x * 12.92
        : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** sRGB inverse transfer (gamma-encoded → linear). */
export function srgbInverseGamma(x) {
    return x <= 0.04045
        ? x / 12.92
        : Math.pow((x + 0.055) / 1.055, 2.4);
}

/**
 * OKLCH → hex. Emits '#rrggbb' for opaque colors (a >= 1 or undefined)
 * and '#rrggbbaa' when alpha is below 1. Output always lowercase.
 *
 * Bit-pack trick: `(1<<24) | (R<<16) | (G<<8) | B` produces a number
 * whose hex string is exactly `1RRGGBB`. One `.toString(16)` + one
 * `.slice(1)` beats three `padStart(2, '0')` calls in both speed and
 * intermediate garbage.
 */
export function toHex({ l, c, h, a }) {
    const linRgb = oklchToLinearSrgb(l, c, h);
    const R = (srgbGamma(linRgb[0]) * 255 + 0.5) | 0;
    const G = (srgbGamma(linRgb[1]) * 255 + 0.5) | 0;
    const B = (srgbGamma(linRgb[2]) * 255 + 0.5) | 0;
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
 * Linear sRGB → OKLCH. Used by fromHex and the palette extractor.
 */
/**
 * Linear sRGB → OKLCH. Inverse of `oklchToLinearSrgb`.
 *
 * Zero-GC path: pass a caller-owned `{ l, c, h }` as `out`. The function
 * writes into it and returns the same reference. Omit `out` (or pass null)
 * to get a fresh allocated object — back-compat with the 3-arg call shape.
 */
export function linearSrgbToOklch(r, g, b, out) {
    const lLms = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const mLms = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const sLms = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    const lP = Math.cbrt(lLms);
    const mP = Math.cbrt(mLms);
    const sP = Math.cbrt(sLms);
    const L = 0.2104542553 * lP + 0.7936177850 * mP - 0.0040720468 * sP;
    const a = 1.9779984951 * lP - 2.4285922050 * mP + 0.4505937099 * sP;
    const bb = 0.0259040371 * lP + 0.7827717662 * mP - 0.8086757660 * sP;
    const C = Math.sqrt(a * a + bb * bb);
    let H = Math.atan2(bb, a) * 180 / Math.PI;
    if (H < 0) H += 360;
    if (out) { out.l = L; out.c = C; out.h = H; return out; }
    return { l: L, c: C, h: H };
}

/**
 * Hex string → { l, c, h, a }. Accepts:
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
