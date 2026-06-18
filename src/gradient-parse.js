/**
 * CSS gradient string → editable Gradient Studio state.
 *
 * Counterpart to the export emitters. Accepts the CSS we produce, plus
 * the broadly-used subset designers paste from other tools:
 *
 *   linear-gradient([angle] [in oklch], <color> [pos], ...)
 *   radial-gradient([shape] [size] [at <pos>] [in oklch], <color> [pos], ...)
 *   conic-gradient([from <angle>] [at <pos>] [in oklch], <color> [pos], ...)
 *
 * Color formats: 3/4/6/8-char hex, rgb(), rgba(), oklch() with optional
 * `/ alpha`, hsl(), hsla(). Named colors are not supported (the table
 * is huge and 99% of pasted gradients use hex or rgb).
 *
 * Returns a normalized state object matching the 1D editor's schema —
 * the app's loadG1d picks it up directly. Throws on malformed input
 * (caller shows a friendly error).
 *
 * Not goals (yet):
 *   - Multiple background-image layers separated by top-level comma
 *     (the outer parser still splits on commas at depth 0, but only
 *     the first gradient is parsed; future versions can layer)
 *   - Direction keywords ("to right", "to bottom left") — translated
 *     to numeric angles here in a small table; partial coverage
 *   - `<length>` positions (px, em). Only `<percentage>` accepted.
 *   - Color spaces other than oklch. The `in <space>` modifier is
 *     parsed but currently ignored — Studio always interpolates in OKLCH.
 */

import { fromHex } from './color-convert.js';

/* ── public entry ─────────────────────────────────────────────── */

/**
 * Parse a CSS gradient string. Returns a 1D-state-shaped object:
 *   { mode, stops, angle?, radShape?, radCx?, radCy?, conFrom?, conCx?, conCy? }
 *
 * The fields not relevant to the parsed mode are left undefined (e.g.
 * radShape is undefined for linear gradients).
 *
 * @throws Error on malformed input — message is user-facing.
 */
export function parseGradientCss(input) {
    if (typeof input !== 'string') throw new Error('parseGradientCss: expected a string');
    // Trim any leading `background:` / `background-image:` / trailing `;`
    // — paste convenience.
    let src = input.trim();
    src = src.replace(/^background(?:-image)?\s*:\s*/i, '');
    src = src.replace(/;[\s\n]*$/, '');
    src = src.trim();

    // Detect mode + extract inside of outer parens.
    const m = /^(linear|radial|conic)-gradient\s*\(([\s\S]+)\)\s*$/i.exec(src);
    if (!m) throw new Error('parseGradientCss: not a CSS gradient function');
    const mode = m[1].toLowerCase();
    const body = m[2];

    // Top-level comma split (respecting nested parens — color functions
    // contain commas).
    const parts = splitTopLevel(body);
    if (parts.length < 2) {
        throw new Error('parseGradientCss: need at least two color stops');
    }

    // First part: either a direction/shape preamble or already a color.
    // We sniff by attempting to parse the first part as a color — if it
    // succeeds, it's a color (any format we support); if it throws, it
    // must be a preamble. This catches named colors that a regex-based
    // sniff would miss (`"red"` doesn't start with `#`/`rgb`/`oklch`).
    const firstTrim = parts[0].trim();
    const { color: firstColorPart } = splitColorAndPos(firstTrim);
    let looksLikeColor = false;
    try { parseColor(firstColorPart); looksLikeColor = true; }
    catch { /* not a color → preamble */ }

    let preamble = '';
    let stopParts;
    if (looksLikeColor) {
        // No preamble — implicit defaults for the mode.
        stopParts = parts;
    } else {
        preamble = firstTrim;
        stopParts = parts.slice(1);
    }

    if (stopParts.length < 2) {
        throw new Error('parseGradientCss: need at least two color stops');
    }

    const stops = parseStops(stopParts, mode);

    if (mode === 'linear') {
        return { mode, stops, angle: parseLinearAngle(preamble) };
    }
    if (mode === 'radial') {
        const { shape, cx, cy } = parseRadialPreamble(preamble);
        return { mode, stops, radShape: shape, radCx: cx, radCy: cy };
    }
    // conic
    const { from, cx, cy } = parseConicPreamble(preamble);
    return { mode, stops, conFrom: from, conCx: cx, conCy: cy };
}

/* ── splitting utilities ───────────────────────────────────────── */

/**
 * Split on commas that aren't inside parens. Color functions like
 * `rgba(255, 0, 0, 0.5)` contain commas we don't want to split on.
 */
function splitTopLevel(s) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(s.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(s.slice(start));
    return parts;
}

/* ── stop parsing ─────────────────────────────────────────────── */

function parseStops(parts, mode) {
    const stops = [];
    const positionUnit = mode === 'conic' ? 'deg' : '%';
    // For conic, positions are angles 0..360deg. For linear/radial they
    // are percentages 0..100%. Both normalize to 0..1 in our stop schema.

    for (const part of parts) {
        const { color, position } = splitColorAndPos(part.trim());
        const oklch = parseColor(color);
        stops.push({
            l: oklch.l, c: oklch.c, h: oklch.h,
            a: oklch.a === undefined ? 1 : oklch.a,
            // Position deferred — may be missing on some stops; fill in
            // a second pass below.
            stop: position === null
                ? null
                : normalizeStopPos(position, positionUnit, mode),
        });
    }

    // Fill in missing positions: evenly distribute among unset ones,
    // bracketed by their neighbours. Common pattern: paste
    //   "linear-gradient(red, blue)"     → no positions at all.
    fillMissingPositions(stops);
    return stops;
}

/**
 * Split a stop-spec into color + optional position. The color may
 * itself contain spaces (e.g. `oklch(0.5 0.2 90)`), so we look for the
 * LAST whitespace-separated token and check if it's a position.
 */
function splitColorAndPos(s) {
    // Strip trailing whitespace.
    s = s.trim();
    // Search backwards for a position token: <number><unit>
    const m = /(.+?)\s+(-?\d+(?:\.\d+)?(?:%|deg|turn|rad))\s*$/.exec(s);
    if (m) return { color: m[1].trim(), position: m[2] };
    return { color: s, position: null };
}

/** Convert a position token like '50%' / '0.25turn' / '90deg' to 0..1. */
function normalizeStopPos(pos, unit, mode) {
    const m = /^(-?\d+(?:\.\d+)?)(%|deg|turn|rad)$/.exec(pos);
    if (!m) throw new Error(`parseGradientCss: malformed position "${pos}"`);
    const n = parseFloat(m[1]);
    const u = m[2];
    let normalized;
    if (u === '%')      normalized = n / 100;
    else if (u === 'deg')  normalized = n / 360;
    else if (u === 'turn') normalized = n;
    else                normalized = n / (2 * Math.PI);
    // For linear/radial we ignore deg units (they'd be unusual; bug if
    // it happens). For conic, we want the deg/turn interpretation.
    // Either way, clamp to [0, 1] so out-of-range positions don't break
    // the rail.
    return Math.max(0, Math.min(1, normalized));
}

function fillMissingPositions(stops) {
    // Walk runs of null positions, distribute evenly between the last
    // known position (or 0) and the next known position (or 1).
    const n = stops.length;
    if (stops[0].stop === null)    stops[0].stop = 0;
    if (stops[n - 1].stop === null) stops[n - 1].stop = 1;
    let i = 0;
    while (i < n) {
        if (stops[i].stop !== null) { i++; continue; }
        // Find run end.
        let j = i;
        while (j < n && stops[j].stop === null) j++;
        // stops[i-1].stop is the anchor before, stops[j].stop the anchor after.
        const before = stops[i - 1].stop;
        const after  = stops[j].stop;
        const count  = j - i + 1;       // including anchors at j
        for (let k = i; k < j; k++) {
            stops[k].stop = before + (after - before) * ((k - i + 1) / count);
        }
        i = j;
    }
}

/* ── color parsing ────────────────────────────────────────────── */

function parseColor(s) {
    const t = s.trim();

    // Hex
    if (t.startsWith('#')) return fromHex(t);

    // rgb()/rgba()
    let m = /^rgba?\s*\(([^)]+)\)\s*$/i.exec(t);
    if (m) return rgbFunctionToOklch(m[1]);

    // oklch()
    m = /^oklch\s*\(([^)]+)\)\s*$/i.exec(t);
    if (m) return oklchFunctionToObj(m[1]);

    // hsl()/hsla()
    m = /^hsla?\s*\(([^)]+)\)\s*$/i.exec(t);
    if (m) return hslFunctionToOklch(m[1]);

    // Named color — small table covering the CSS Level 1 + a few
    // extensions designers actually paste. Not exhaustive; if a user
    // needs hotpink they'll paste hex.
    const named = NAMED_COLORS[t.toLowerCase()];
    if (named) return fromHex(named);

    throw new Error(`parseGradientCss: unsupported color "${t}"`);
}

const NAMED_COLORS = {
    black:   '#000000',
    silver:  '#c0c0c0',
    gray:    '#808080',
    grey:    '#808080',
    white:   '#ffffff',
    maroon:  '#800000',
    red:     '#ff0000',
    purple:  '#800080',
    fuchsia: '#ff00ff',
    magenta: '#ff00ff',
    // CSS "green" is dark green; designers usually mean bright. Map
    // "green" to CSS-spec dark green and provide "lime" for bright.
    green:   '#008000',
    lime:    '#00ff00',
    olive:   '#808000',
    yellow:  '#ffff00',
    navy:    '#000080',
    blue:    '#0000ff',
    teal:    '#008080',
    aqua:    '#00ffff',
    cyan:    '#00ffff',
    orange:  '#ffa500',
    pink:    '#ffc0cb',
    brown:   '#a52a2a',
    transparent: '#00000000',
};

function rgbFunctionToOklch(inner) {
    // Accept comma OR space separators, optional alpha with `/` or `,`.
    const tokens = inner.split(/[\s,\/]+/).filter(Boolean);
    if (tokens.length < 3) throw new Error('parseGradientCss: malformed rgb()');
    const r = parseColorComponent(tokens[0], 255);
    const g = parseColorComponent(tokens[1], 255);
    const b = parseColorComponent(tokens[2], 255);
    const a = tokens[3] !== undefined
        ? parseColorComponent(tokens[3], 1, true)
        : 1;
    // Build hex and reuse fromHex for the RGB→OKLCH path.
    const hex = '#' + (
        ((r * 255 + 0.5) | 0).toString(16).padStart(2, '0') +
        ((g * 255 + 0.5) | 0).toString(16).padStart(2, '0') +
        ((b * 255 + 0.5) | 0).toString(16).padStart(2, '0')
    );
    const oklch = fromHex(hex);
    oklch.a = a;
    return oklch;
}

function oklchFunctionToObj(inner) {
    // oklch(L C H [/ A]) — L can be "50%" or "0.5", others are numbers.
    // Split on whitespace; the optional `/` denotes alpha.
    const slashIdx = inner.indexOf('/');
    const main = slashIdx >= 0 ? inner.slice(0, slashIdx) : inner;
    const alphaPart = slashIdx >= 0 ? inner.slice(slashIdx + 1) : null;
    const tokens = main.trim().split(/\s+/);
    if (tokens.length < 3) throw new Error('parseGradientCss: malformed oklch()');
    const l = parseColorComponent(tokens[0], 1, true);   // 0..1 or 0..100%
    const c = parseFloat(tokens[1]);                      // chroma 0..0.5ish
    const h = parseFloat(tokens[2]);                      // hue 0..360
    const a = alphaPart !== null
        ? parseColorComponent(alphaPart.trim(), 1, true)
        : 1;
    return { l, c, h, a };
}

function hslFunctionToOklch(inner) {
    const tokens = inner.split(/[\s,\/]+/).filter(Boolean);
    if (tokens.length < 3) throw new Error('parseGradientCss: malformed hsl()');
    let h = parseFloat(tokens[0]);
    // Strip 'deg'/'turn'/'rad' unit suffix on hue.
    if (/turn/i.test(tokens[0])) h *= 360;
    if (/rad/i.test(tokens[0]))  h *= 180 / Math.PI;
    const s = parseColorComponent(tokens[1], 1, true);
    const lt = parseColorComponent(tokens[2], 1, true);
    const a = tokens[3] !== undefined ? parseColorComponent(tokens[3], 1, true) : 1;
    // HSL → RGB → hex → fromHex (same path rgb uses).
    const [r, g, b] = hslToRgb(h, s, lt);
    const hex = '#' + (
        ((r * 255 + 0.5) | 0).toString(16).padStart(2, '0') +
        ((g * 255 + 0.5) | 0).toString(16).padStart(2, '0') +
        ((b * 255 + 0.5) | 0).toString(16).padStart(2, '0')
    );
    const oklch = fromHex(hex);
    oklch.a = a;
    return oklch;
}

function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r1, g1, b1;
    if      (hp <= 1) { r1 = c; g1 = x; b1 = 0; }
    else if (hp <= 2) { r1 = x; g1 = c; b1 = 0; }
    else if (hp <= 3) { r1 = 0; g1 = c; b1 = x; }
    else if (hp <= 4) { r1 = 0; g1 = x; b1 = c; }
    else if (hp <= 5) { r1 = x; g1 = 0; b1 = c; }
    else              { r1 = c; g1 = 0; b1 = x; }
    const mLight = l - c / 2;
    return [r1 + mLight, g1 + mLight, b1 + mLight];
}

/**
 * Parse a single component which may be "127", "50%", or "0.5".
 * @param {string} tok
 * @param {number} max   Range max when the value is not a percentage.
 * @param {boolean} [floatOK]  If true, treat bare values as already-normalized 0..1.
 */
function parseColorComponent(tok, max, floatOK) {
    if (tok.endsWith('%')) return parseFloat(tok) / 100;
    const v = parseFloat(tok);
    if (floatOK && v <= 1) return v;
    return v / max;
}

/* ── preamble parsers (per mode) ──────────────────────────────── */

const DIRECTION_KEYWORDS = {
    'to top':          0,
    'to top right':   45,
    'to right':       90,
    'to bottom right': 135,
    'to bottom':      180,
    'to bottom left': 225,
    'to left':        270,
    'to top left':    315,
};

function parseLinearAngle(preamble) {
    if (!preamble) return 180;   // CSS default for linear-gradient
    // Drop the `in <space>` modifier if present.
    const clean = preamble.replace(/\s+in\s+\S+/i, '').trim();
    if (!clean) return 180;
    // Direction keyword?
    const kw = DIRECTION_KEYWORDS[clean.toLowerCase()];
    if (kw !== undefined) return kw;
    // <angle> — accept deg, turn, rad.
    const m = /^(-?\d+(?:\.\d+)?)(deg|turn|rad)?\s*$/.exec(clean);
    if (!m) return 180;
    let n = parseFloat(m[1]);
    if (m[2] === 'turn') n *= 360;
    if (m[2] === 'rad')  n *= 180 / Math.PI;
    // Wrap into 0..360.
    return ((n % 360) + 360) % 360;
}

function parseRadialPreamble(preamble) {
    let shape = 'ellipse';
    let cx = 50, cy = 50;
    if (!preamble) return { shape, cx, cy };
    // Drop `in <space>`.
    const clean = preamble.replace(/\s+in\s+\S+/i, '').trim();
    if (/\bcircle\b/i.test(clean))   shape = 'circle';
    if (/\bellipse\b/i.test(clean))  shape = 'ellipse';
    // Extract position from `at <x> <y>`.
    const m = /\bat\s+([^,]+)$/i.exec(clean);
    if (m) {
        const pos = parsePosition(m[1].trim());
        cx = pos.cx;
        cy = pos.cy;
    }
    return { shape, cx, cy };
}

function parseConicPreamble(preamble) {
    let from = 0;
    let cx = 50, cy = 50;
    if (!preamble) return { from, cx, cy };
    const clean = preamble.replace(/\s+in\s+\S+/i, '').trim();
    const fromMatch = /\bfrom\s+(-?\d+(?:\.\d+)?)(deg|turn|rad)?/i.exec(clean);
    if (fromMatch) {
        let n = parseFloat(fromMatch[1]);
        if (fromMatch[2] === 'turn') n *= 360;
        if (fromMatch[2] === 'rad')  n *= 180 / Math.PI;
        from = ((n % 360) + 360) % 360;
    }
    const atMatch = /\bat\s+(.+)$/i.exec(clean);
    if (atMatch) {
        const pos = parsePosition(atMatch[1].trim());
        cx = pos.cx;
        cy = pos.cy;
    }
    return { from, cx, cy };
}

/**
 * `<position>` → { cx, cy } in 0..100 percent. Accepts keywords
 * (center, top, etc.), single-axis keyword pairs, and `<percentage>
 * <percentage>` numeric pairs.
 */
function parsePosition(s) {
    const t = s.trim().toLowerCase();
    // Numeric: "30% 70%" or "50% 50%"
    const num = /^(-?\d+(?:\.\d+)?)\s*%\s+(-?\d+(?:\.\d+)?)\s*%$/.exec(t);
    if (num) return { cx: parseFloat(num[1]), cy: parseFloat(num[2]) };
    // Single percent: "30%" — y defaults to 50.
    const single = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(t);
    if (single) return { cx: parseFloat(single[1]), cy: 50 };
    // Keyword pair or single keyword.
    let cx = 50, cy = 50;
    if (t.includes('left'))   cx = 0;
    if (t.includes('right'))  cx = 100;
    if (t.includes('top'))    cy = 0;
    if (t.includes('bottom')) cy = 100;
    return { cx, cy };
}
