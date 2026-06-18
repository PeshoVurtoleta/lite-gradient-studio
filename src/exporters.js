/**
 * Multi-format exporters for 1D and mesh gradients.
 *
 * Pattern follows `@zakkster/lite-hueforge` — each format is a small
 * pure function taking the gradient data + opts and returning a
 * string; a `toTokens1d` / `toTokensMesh` dispatcher picks one by id.
 *
 * The 1D state shape (matches g1d serialize/load in the app):
 *   {
 *     mode:    'linear' | 'radial' | 'conic',
 *     stops:   [{ l, c, h, stop }, ...],
 *     angle:   number,       // linear
 *     radShape:'circle'|'ellipse',                       // radial
 *     radCx:   number, radCy: number,                    // 0–100 percent
 *     conFrom: number,                                   // conic
 *     conCx:   number, conCy: number,                    // 0–100 percent
 *   }
 *
 * Backward compat: pre-v0.0.17 snapshots used keyword strings
 * (radPos / conPos: 'center' | 'top right' | ...). `posFor` accepts
 * either schema, preferring the numeric form when both are present.
 *
 * The mesh state shape:
 *   {
 *     cols: number, rows: number,
 *     stops: [{ x, y, l, c, h }, ...],
 *   }
 *
 * All exporters honor `name` (default 'gradient') for token naming.
 */

import { toCssOklch } from '@zakkster/lite-color';
import { toHex }      from './color-convert.js';
import {
    formatCssLinear, formatCssRadial, formatCssConic,
} from './css-emitters.js';
import { formatCssMesh } from './mesh-css.js';

/* Format identifiers — frozen so consumers can iterate without
   accidentally mutating. */
export const EXPORT_FORMATS_1D   = Object.freeze([
    'css', 'css-var', 'scss', 'tailwind', 'json', 'svg',
]);
export const EXPORT_FORMATS_MESH = Object.freeze([
    'css', 'css-var', 'json',
]);

/* Format → human label + a one-line hint for the export modal foot. */
export const FORMAT_META = Object.freeze({
    'css':      { label: 'CSS',          hint: 'Drop into any `background:` property. Uses `in oklch` interpolation.' },
    'css-var':  { label: 'CSS variable', hint: 'Named `:root` custom property. Reference via `var(--name)`.' },
    'scss':     { label: 'SCSS',         hint: 'SCSS variable. Reference via `$name`.' },
    'tailwind': { label: 'Tailwind',     hint: 'Add to `theme.extend.backgroundImage` in tailwind.config.js (v3 syntax).' },
    'json':     { label: 'JSON',         hint: 'Portable definition — re-importable by Gradient Studio or your build tool.' },
    'svg':      { label: 'SVG',          hint: 'Standalone SVG. Hex stops for renderer compatibility.' },
});

/* ── dispatchers ─────────────────────────────────────────────────── */

export function toTokens1d(g1d, format, opts = {}) {
    switch (format) {
        case 'css':      return toCss1d(g1d, opts);
        case 'css-var':  return toCssVar1d(g1d, opts);
        case 'scss':     return toScss1d(g1d, opts);
        case 'tailwind': return toTailwind1d(g1d, opts);
        case 'json':     return toJson1d(g1d, opts);
        case 'svg':      return toSvg1d(g1d, opts);
        default: throw new Error(
            `Unknown 1D export format: "${format}". Try one of: ${EXPORT_FORMATS_1D.join(', ')}`);
    }
}

export function toTokensMesh(mesh, format, opts = {}) {
    switch (format) {
        case 'css':     return toCssMesh(mesh, opts);
        case 'css-var': return toCssVarMesh(mesh, opts);
        case 'json':    return toJsonMesh(mesh, opts);
        default: throw new Error(
            `Unknown mesh export format: "${format}". Try one of: ${EXPORT_FORMATS_MESH.join(', ')}`);
    }
}

/* ── 1D exporters ────────────────────────────────────────────────── */

/** Return the raw CSS gradient string for this 1D state. */
function cssBodyFor1d(g) {
    // Build a Gradient-shaped stops array (renames `stop` → `pos`).
    // Alpha (s.a) passes through so the CSS emitters can emit
    // `oklch(L C H / A)` syntax.
    const stopsForCss = g.stops.map((s) => ({
        l: s.l, c: s.c, h: s.h,
        a: s.a === undefined ? 1 : s.a,
        pos: s.stop,
    }));
    const fake = { stops: stopsForCss };  // formatCss* only reads .stops
    if (g.mode === 'linear') {
        return formatCssLinear(fake, { angle: g.angle });
    }
    if (g.mode === 'radial') {
        return formatCssRadial(fake, {
            shape: g.radShape, position: posFor(g, 'rad'),
        });
    }
    return formatCssConic(fake, { from: g.conFrom, position: posFor(g, 'con') });
}

/**
 * Read a position from either schema. v0.0.17+ uses numeric
 * cx/cy fields ('rad' + 'Cx' = radCx); pre-v0.0.17 used keyword
 * strings (radPos: 'center'). Both still load; new emits prefer
 * the numeric form because it survives round-trips with no loss.
 */
function posFor(g, prefix) {
    const cx = g[prefix + 'Cx'];
    const cy = g[prefix + 'Cy'];
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
        return `${cx}% ${cy}%`;
    }
    return g[prefix + 'Pos'] || 'center';
}

export function toCss1d(g, opts = {}) {
    return `background: ${cssBodyFor1d(g)};`;
}

export function toCssVar1d(g, opts = {}) {
    const name = opts.name || 'gradient';
    return `:root {\n    --${slugify(name)}: ${cssBodyFor1d(g)};\n}`;
}

export function toScss1d(g, opts = {}) {
    const name = opts.name || 'gradient';
    return `$${slugify(name)}: ${cssBodyFor1d(g)};`;
}

export function toTailwind1d(g, opts = {}) {
    const name = opts.name || 'gradient';
    const body = cssBodyFor1d(g).replace(/'/g, "\\'");
    return [
        '// tailwind.config.js (v3)',
        'module.exports = {',
        '    theme: {',
        '        extend: {',
        '            backgroundImage: {',
        `                '${slugify(name)}': '${body}',`,
        '            },',
        '        },',
        '    },',
        '};',
        '',
        `// Usage: <div class="bg-${slugify(name)}">…</div>`,
    ].join('\n');
}

export function toJson1d(g, opts = {}) {
    const name = opts.name || 'gradient';
    const out = {
        $studio: 'gradient-studio',
        $version: 1,
        name,
        type: g.mode,
        interpolation: 'oklch',
        stops: g.stops.map((s) => {
            const stop = {
                position: round3(s.stop),
                color: { l: round3(s.l), c: round3(s.c), h: round1(s.h) },
                hex: toHex(s),
            };
            // Only emit alpha when not fully opaque — keeps the common
            // case clean and matches the toHex 6-vs-8 char convention.
            if (s.a !== undefined && s.a < 1) {
                stop.color.a = round3(s.a);
                stop.alpha   = round3(s.a);
            }
            return stop;
        }),
    };
    if (g.mode === 'linear') {
        out.angle = g.angle;
    } else if (g.mode === 'radial') {
        out.shape    = g.radShape;
        out.position = posFor(g, 'rad');
    } else if (g.mode === 'conic') {
        out.from     = g.conFrom;
        out.position = posFor(g, 'con');
    }
    return JSON.stringify(out, null, 2);
}

export function toSvg1d(g, opts = {}) {
    const W = opts.width  || 800;
    const H = opts.height || 320;
    const id = slugify(opts.name || 'gradient');

    let defs;
    if (g.mode === 'linear') {
        // SVG linearGradient endpoint coords for a CSS-style angle.
        // CSS angle: clockwise from north. SVG default is 0%,0% → 100%,0%.
        const rad = g.angle * Math.PI / 180;
        const dx =  Math.sin(rad);
        const dy = -Math.cos(rad);
        // Normalize to [0%, 100%] coords. Endpoints are projected onto
        // the angle line passing through the box center.
        const halfX = Math.abs(dx) / 2;
        const halfY = Math.abs(dy) / 2;
        const cx = 50, cy = 50;
        defs = `        <linearGradient id="${id}" x1="${(cx - dx * 50).toFixed(2)}%" y1="${(cy - dy * 50).toFixed(2)}%" x2="${(cx + dx * 50).toFixed(2)}%" y2="${(cy + dy * 50).toFixed(2)}%">\n`
             + g.stops.map((s) => stopLine(s)).join('\n') + '\n'
             + `        </linearGradient>`;
    } else if (g.mode === 'radial') {
        const { cx, cy } = posToPct(posFor(g, 'rad'));
        defs = `        <radialGradient id="${id}" cx="${cx}%" cy="${cy}%" r="100%">\n`
             + g.stops.map((s) => stopLine(s)).join('\n') + '\n'
             + `        </radialGradient>`;
    } else {
        // SVG has no native conic gradient. Hint the user.
        defs = `        <!-- SVG has no native conic-gradient. -->\n`
             + `        <!-- Rasterize via the PNG export instead, or use a CSS-in-foreignObject fallback. -->\n`
             + `        <linearGradient id="${id}" x1="0%" y1="0%" x2="100%" y2="0%">\n`
             + g.stops.map((s) => stopLine(s)).join('\n') + '\n'
             + `        </linearGradient>`;
    }

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
        `    <defs>`,
        defs,
        `    </defs>`,
        `    <rect width="100%" height="100%" fill="url(#${id})" />`,
        `</svg>`,
    ].join('\n');
}

function stopLine(s) {
    // SVG's <stop> supports stop-opacity as a separate attribute. We
    // emit `stop-color` (6-char hex, no alpha) plus `stop-opacity` when
    // alpha < 1 — many SVG processors choke on 8-char hex strings.
    const hex = toHex({ l: s.l, c: s.c, h: s.h });
    const op  = s.a !== undefined && s.a < 1
        ? ` stop-opacity="${(s.a).toFixed(3)}"`
        : '';
    return `            <stop offset="${(s.stop * 100).toFixed(2)}%" stop-color="${hex}"${op} />`;
}

/* ── mesh exporters ──────────────────────────────────────────────── */

export function toCssMesh(mesh, opts = {}) {
    return `background: ${formatCssMesh(mesh)};`;
}

export function toCssVarMesh(mesh, opts = {}) {
    const name = opts.name || 'mesh-gradient';
    return `:root {\n    --${slugify(name)}: ${formatCssMesh(mesh)};\n}`;
}

export function toJsonMesh(mesh, opts = {}) {
    const name = opts.name || 'mesh-gradient';
    return JSON.stringify({
        $studio: 'gradient-studio',
        $version: 1,
        name,
        type: 'mesh',
        interpolation: 'bilinear-oklch',
        cols: mesh.cols,
        rows: mesh.rows,
        stops: mesh.stops.map((s) => {
            const stop = {
                x: round3(s.x),
                y: round3(s.y),
                color: { l: round3(s.l), c: round3(s.c), h: round1(s.h) },
                hex: toHex(s),
            };
            if (s.a !== undefined && s.a < 1) {
                stop.color.a = round3(s.a);
                stop.alpha   = round3(s.a);
            }
            return stop;
        }),
    }, null, 2);
}

/* ── helpers ─────────────────────────────────────────────────────── */

function posToPct(pos) {
    // Numeric format first: "30% 70%" or "30 70" — used by Gradient
    // Studio v0.0.17+. Position strings reach the SVG emitter via the
    // app's `${cx}% ${cy}%` formatter, not as keywords.
    const m = /^\s*(-?[\d.]+)\s*%?\s+(-?[\d.]+)\s*%?\s*$/.exec(pos);
    if (m) {
        return { cx: parseFloat(m[1]), cy: parseFloat(m[2]) };
    }
    // Keyword fallback for older callers / hand-written input.
    let cx = 50, cy = 50;
    if (pos.includes('top'))    cy = 0;
    if (pos.includes('bottom')) cy = 100;
    if (pos.includes('left'))   cx = 0;
    if (pos.includes('right'))  cx = 100;
    return { cx, cy };
}

function slugify(s) {
    return String(s)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'gradient';
}

function round1(v) { return Math.round(v * 10) / 10; }
function round3(v) { return Math.round(v * 1000) / 1000; }
