/**
 * Mesh → CSS approximation.
 *
 * Real mesh gradients don't have a CSS primitive — `mesh-gradient()`
 * isn't standardized. The conventional workaround (Mesher.app, Stripe-
 * style aurora backgrounds, etc.) is to stack one `radial-gradient()`
 * per control point, each fading from the point's color at center to
 * transparent at an outer radius. With sensible overlap the alpha
 * composites approximate the true bilinear field.
 *
 * This is genuinely an approximation, not a faithful reproduction —
 * adjacent control points blend through the alpha layer, not through
 * OKLCH interpolation. The visible result is close enough that most
 * users prefer it to a giant PNG. For pixel-perfect output, use the
 * PNG export path which renders our deformable bilinear kernel direct
 * to a buffer.
 *
 * Output uses the `in oklch` interpolation hint on each radial so the
 * color → transparent fade respects perceptual uniformity in browsers
 * that support it (Chrome 111+, Firefox 113+, Safari 16.4+).
 */

import { toCssOklch } from '@zakkster/lite-color';

/**
 * @param {object} mesh         A MeshGradient instance (uses .stops, .cols, .rows)
 * @param {object} [opts]
 * @param {number} [opts.radiusPct]    Layer radius as % of farthest-corner.
 *                                      Defaults to a formula scaled by mesh size.
 * @param {string} [opts.shape='circle']  'circle' or 'ellipse'
 * @param {boolean} [opts.oklchInterp=true]  Emit `in oklch` per layer.
 * @param {boolean} [opts.includeBase=true]  Append a base color layer at end so
 *                                            gaps between radials are filled.
 * @returns {string}  A CSS `background:` value (no `background:` keyword, no
 *                    trailing semicolon — caller decides how to wrap it).
 */
export function formatCssMesh(mesh, opts = {}) {
    const {
        radiusPct   = autoRadius(mesh),
        shape       = 'circle',
        oklchInterp = true,
        includeBase = true,
    } = opts;

    const scratch = { l: 0, c: 0, h: 0, a: 1 };
    const layers  = [];
    const interp  = oklchInterp ? ' in oklch' : '';

    for (const s of mesh.stops) {
        scratch.l = s.l; scratch.c = s.c; scratch.h = s.h;
        scratch.a = s.a === undefined ? 1 : s.a;
        const color = toCssOklch(scratch);
        const x = (s.x * 100).toFixed(1);
        const y = (s.y * 100).toFixed(1);
        // `transparent` resolves to oklch(0 0 0 / 0) — same hue interpolation.
        layers.push(
            `radial-gradient(${shape} at ${x}% ${y}%${interp}, ` +
            `${color}, transparent ${radiusPct.toFixed(0)}%)`
        );
    }

    if (includeBase) {
        // Base layer = average of all stops. Picks a sensible "background"
        // tone so gaps between radials don't show as transparent.
        const avg = averageColor(mesh.stops);
        scratch.l = avg.l; scratch.c = avg.c; scratch.h = avg.h;
        scratch.a = avg.a;
        layers.push(toCssOklch(scratch));
    }

    return layers.join(',\n            ');
}

/**
 * Heuristic radius. Larger meshes → smaller per-layer radii (each
 * layer covers less canvas, so seams between adjacent points stay
 * tight; otherwise the alpha stack reduces to a muddy average).
 *
 * Tuned against 2×2 → 5×5: the multiplier (1.2×) gives ~20% overlap
 * between neighbouring layers — enough that they blend, not enough
 * that the field collapses toward the average. The base layer beneath
 * fills any remaining gaps.
 */
function autoRadius(mesh) {
    const n = Math.max(mesh.cols, mesh.rows);
    if (n <= 2) return 70;
    return Math.round(100 / (n - 1) * 1.2);
}

/**
 * Average L/C and circular-mean H of the stops. Used as the base layer
 * so the visible field has a sensible color where layers don't reach.
 *
 * Hue is averaged via vector mean (sum unit vectors at each hue, take
 * angle of the resultant) so that a 350°/10° pair averages to ~0°/360°,
 * not 180°. Standard circular-statistics trick.
 */
function averageColor(stops) {
    let lSum = 0, cSum = 0, aSum = 0;
    let hxSum = 0, hySum = 0;
    const n = stops.length;
    for (const s of stops) {
        lSum += s.l;
        cSum += s.c;
        aSum += s.a === undefined ? 1 : s.a;
        const rad = s.h * Math.PI / 180;
        hxSum += Math.cos(rad);
        hySum += Math.sin(rad);
    }
    let hAvg = Math.atan2(hySum / n, hxSum / n) * 180 / Math.PI;
    if (hAvg < 0) hAvg += 360;
    return { l: lSum / n, c: cSum / n, h: hAvg, a: aSum / n };
}
