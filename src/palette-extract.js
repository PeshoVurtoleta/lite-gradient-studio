/**
 * Extract a designer-friendly palette from raw RGBA pixel data.
 *
 * v2 (post v0.0.30 review): chroma-weighted hue-bucket extraction, ported
 * from the algorithm used in `@zakkster/lite-hueforge` v0.4.2.
 *
 * The previous v1 algorithm did frequency-weighted RGB quantization +
 * OKLCH dedup. It failed reliably on photos: a photo of a person in a
 * blue shirt produces ~80% skin / hair / background warm tones by pixel
 * count, with blue confined to a small region. Frequency picks all five
 * top buckets from the warm cluster (variants of skin) and the blue
 * either gets dedup'd against the warm picks or ranked below them.
 * Designer's lived expectation: "import this photo of a baby in a blue
 * shirt → I should see blue in the palette."
 *
 * The fix is to count CHROMA, not pixels — and to enforce a minimum hue
 * separation between picks. A handful of vivid-blue pixels at C ≈ 0.20
 * contribute more weight than a thousand near-grey pixels at C ≈ 0.02.
 * A 50° hue-separation rule then guarantees the second pick can't be
 * another shade of the first pick's hue.
 *
 * Algorithm:
 *   1. Single-pass walk of RGBA pixels. Convert each to OKLCH inline
 *      (no per-pixel function call overhead — the matrix path is
 *      duplicated from color-convert.js for speed).
 *   2. Skip pixels darker than `darkFloor` (L < 0.10) — shadows, not
 *      "colors". Skip fully-transparent pixels.
 *   3. Pixels below `chromaticThreshold` (C < 0.02) feed a NEUTRAL
 *      pool — accumulated L average becomes the single representative
 *      neutral output, slotted at the desired position.
 *   4. Chromatic pixels are binned into 24 hue buckets (15° each).
 *      Per bucket we track: total chroma weight, count, and the
 *      MOST VIVID pixel's L/C/H (this becomes the bucket's
 *      representative — picking the most-vivid avoids muddy
 *      "average" colors that real-photo k-means produces).
 *   5. Sort buckets by total chroma weight. Greedy pick top buckets,
 *      enforcing `minHueSeparation` between picks. If we can't fill
 *      enough slots at 50°, progressively relax to 30° / 15° / 0°.
 *   6. Sort the final picks by L for natural dark→light gradient order.
 *
 * Behavior preserved from v1:
 *   - Returns Array<{l, c, h}> sorted by lightness ascending.
 *   - May return fewer than `count` entries on truly low-diversity
 *     images (e.g. monochrome). Callers handle short arrays gracefully.
 *
 * Behavior changed from v1:
 *   - Mesh callers used to receive ALL chromatic colors with no neutral
 *     suppression. Now: near-grey pixels feed a separate neutral pool
 *     that contributes ONE output slot rather than several "grey-ish"
 *     stops. The user noted this is intentional and correct for mesh.
 *     1D callers still get the same neutral via the standard pick path
 *     when they request enough slots.
 *
 * Performance: a 240×180 sample = 43 200 pixels iterates in ~5 ms on
 * a typical laptop. Single Map allocation (none — pre-allocated
 * buckets array). Zero per-pixel allocations in the inner loop.
 */

const HUE_BUCKETS         = 24;     // 15° per bucket
const DEFAULT_MIN_HUE_SEP = 50;     // initial hue separation requirement
const RELAXATION_LADDER   = [30, 15, 0];  // tried in order if 50° underfills
const CHROMATIC_THRESHOLD = 0.02;   // C below this → neutral pool
const DARK_FLOOR          = 0.10;   // L below this → skip (shadow)
const NEUTRAL_CHROMA      = 0.005;  // tiny tint for the neutral slot

/**
 * @param {Uint8ClampedArray} pixels   RGBA, length must be multiple of 4.
 * @param {number}            [count]  Target palette size (default 5).
 * @returns {Array<{l:number, c:number, h:number}>}
 *          Sorted by L ascending. May be shorter than `count`.
 */
export function extractPalette(pixels, count = 5) {
    if (count < 1) return [];

    // Pre-allocated bucket state — written in place, never reallocated.
    const buckets = new Array(HUE_BUCKETS);
    for (let i = 0; i < HUE_BUCKETS; i++) {
        buckets[i] = { weight: 0, count: 0, maxC: 0, mcL: 0, mcH: 0 };
    }
    let neutralLsum = 0;
    let neutralCount = 0;

    // Single pass. Convert each pixel sRGB byte → OKLCH inline to keep
    // the hot path allocation-free. The matrix coefficients are the
    // canonical OKLab transform (Björn Ottosson, 2020).
    for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 128) continue;   // skip transparent

        const r8 = pixels[i], g8 = pixels[i + 1], b8 = pixels[i + 2];
        const rN = r8 / 255, gN = g8 / 255, bN = b8 / 255;
        // sRGB inverse gamma → linear sRGB.
        const rL = rN <= 0.04045 ? rN / 12.92 : Math.pow((rN + 0.055) / 1.055, 2.4);
        const gL = gN <= 0.04045 ? gN / 12.92 : Math.pow((gN + 0.055) / 1.055, 2.4);
        const bL = bN <= 0.04045 ? bN / 12.92 : Math.pow((bN + 0.055) / 1.055, 2.4);
        // Linear sRGB → LMS' (cube-rooted) → OKLab.
        const lp = Math.cbrt(0.4122214708 * rL + 0.5363325363 * gL + 0.0514459929 * bL);
        const mp = Math.cbrt(0.2119034982 * rL + 0.6806995451 * gL + 0.1073969566 * bL);
        const sp = Math.cbrt(0.0883024619 * rL + 0.2817188376 * gL + 0.6299787005 * bL);
        const L  = 0.2104542553 * lp + 0.7936177850 * mp - 0.0040720468 * sp;
        const A  = 1.9779984951 * lp - 2.4285922050 * mp + 0.4505937099 * sp;
        const B  = 0.0259040371 * lp + 0.7827717662 * mp - 0.8086757660 * sp;
        const C  = Math.sqrt(A * A + B * B);

        if (L < DARK_FLOOR) continue;        // shadows are not colors

        if (C < CHROMATIC_THRESHOLD) {       // near-grey → neutral pool
            neutralLsum += L;
            neutralCount++;
            continue;
        }

        // Hue in [0, 360). atan2 returns [-π, π].
        let H = Math.atan2(B, A) * 180 / Math.PI;
        if (H < 0) H += 360;

        const bucketIdx = (H * HUE_BUCKETS / 360) | 0;
        const bkt = buckets[bucketIdx];
        bkt.weight += C;       // chroma-weighted, NOT pixel-count weighted
        bkt.count++;
        if (C > bkt.maxC) {    // track the most-vivid pixel as the rep
            bkt.maxC = C;
            bkt.mcL  = L;
            bkt.mcH  = H;
        }
    }

    // Sort buckets by total chroma weight, descending. Only consider
    // buckets that actually received pixels.
    const sortedBuckets = buckets
        .filter((b) => b.count > 0)
        .sort((a, b) => b.weight - a.weight);

    // Greedy pick respecting min hue separation. The separation rule is
    // what surfaces cool subject colors from a warm-dominated photo.
    const pickWithSeparation = (separation) => {
        const picks = [];
        for (const b of sortedBuckets) {
            if (picks.length >= count) break;
            let tooClose = false;
            for (const p of picks) {
                const d = Math.abs(b.mcH - p.h) % 360;
                if (Math.min(d, 360 - d) < separation) { tooClose = true; break; }
            }
            if (!tooClose) picks.push({ l: b.mcL, c: b.maxC, h: b.mcH });
        }
        return picks;
    };

    // Try the canonical 50° separation. If the image is genuinely low-
    // diversity (monochrome, hue-collapsed), relax progressively.
    let picks = pickWithSeparation(DEFAULT_MIN_HUE_SEP);
    if (picks.length < count) {
        for (const relaxed of RELAXATION_LADDER) {
            const tried = pickWithSeparation(relaxed);
            if (tried.length > picks.length) picks = tried;
            if (picks.length >= count) break;
        }
    }

    // Append the neutral if there are pixels for it AND we have room.
    // The neutral's hue is anchored to the first chromatic pick so any
    // downstream gradient interpolation has a sensible path.
    if (neutralCount > 0 && picks.length < count) {
        picks.push({
            l: neutralLsum / neutralCount,
            c: NEUTRAL_CHROMA,
            h: picks[0] ? picks[0].h : 240,
        });
    }

    // Lightness-ascending output — natural dark→light gradient order.
    picks.sort((a, b) => a.l - b.l);
    return picks;
}
