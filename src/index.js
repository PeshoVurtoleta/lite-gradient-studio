/**
 * @zakkster/lite-gradient-studio
 *
 * Authoring layer on top of @zakkster/lite-gradient:
 *   - High-fidelity CSS emitters (preserve authored stop positions, optional `in oklch` hint)
 *   - Conic CSS emitter (missing from lite-gradient)
 *   - Mesh gradient kernel — bilinear OKLCH over deformable control grid
 *   - Multi-radial mesh → CSS approximation
 *   - Multi-format exporters (CSS, SCSS, Tailwind, JSON, SVG)
 *   - OKLCH ↔ hex conversion with sRGB-gamut mapping
 *   - Pixel-buffer rasterizer for previews + PNG export
 */

import { Gradient } from '@zakkster/lite-gradient';

export { Gradient };
export * from '@zakkster/lite-gradient';
export {
    bakeGradientToLut,
    flattenStopsToBuffer,
    sampleLut,
    packOklchSingle,
} from './bake.js';
export { MeshGradient, defaultMeshColor, monochromeMesh } from './mesh.js';
export { formatCssLinear, formatCssRadial, formatCssConic } from './css-emitters.js';
export { formatCssMesh } from './mesh-css.js';
export {
    toHex, fromHex, oklchToLinearSrgb, srgbGamma, srgbInverseGamma,
    linearSrgbToOklch,
} from './color-convert.js';
export { extractPalette } from './palette-extract.js';
export { parseGradientCss } from './gradient-parse.js';
export {
    EXPORT_FORMATS_1D, EXPORT_FORMATS_MESH, FORMAT_META,
    toTokens1d, toTokensMesh,
    toCss1d, toCssVar1d, toScss1d, toTailwind1d, toJson1d, toSvg1d,
    toCssMesh, toCssVarMesh, toJsonMesh,
} from './exporters.js';
