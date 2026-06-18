// @zakkster/lite-gradient-studio v1.0.0 -- type definitions.
//
// (c) Zahary Shinikchiev. MIT licensed.

// ---------------------------------------------------------------------------
//  Re-exports from @zakkster/lite-gradient
// ---------------------------------------------------------------------------

export { Gradient } from '@zakkster/lite-gradient';
export type {
    GradientStop,
    GradientConstructorStop,
    GradientOptions,
} from '@zakkster/lite-gradient';

// ---------------------------------------------------------------------------
//  Common color shapes
// ---------------------------------------------------------------------------

/** Plain OKLCH color object. Alpha is optional and defaults to 1. */
export interface OklchColor {
    l: number;
    c: number;
    h: number;
    a?: number;
}

/** OKLCH color with alpha always present (after construction-time defaulting). */
export interface OklchColorA {
    l: number;
    c: number;
    h: number;
    a: number;
}

/** Mesh stop with optional deformed-grid position. */
export interface MeshStop extends OklchColor {
    x?: number;
    y?: number;
}

/** Mesh stop fully populated (post-construction): always has x, y, a. */
export interface MeshStopFull {
    l: number;
    c: number;
    h: number;
    a: number;
    x: number;
    y: number;
}

/** 2D position out-parameter shape. */
export interface XYOut {
    x: number;
    y: number;
}

// ---------------------------------------------------------------------------
//  MeshGradient
// ---------------------------------------------------------------------------

export type InterpolationMode = 'bilinear' | 'smooth' | 'cubic';

export interface MeshRasterizeOptions {
    /** Default 'bilinear'. */
    interpolation?: InterpolationMode;
    /** Legacy boolean: `true` is equivalent to `interpolation: 'smooth'`. */
    smooth?: boolean;
}

/**
 * Procedural default color for a control point at (col, row) of a cols x rows
 * mesh. Pure function. Used internally by MeshGradient when no `stops` array
 * is supplied; re-exported for callers who want to inspect or override the
 * default field.
 */
export function defaultMeshColor(
    col: number,
    row: number,
    cols: number,
    rows: number,
): OklchColor;

export class MeshGradient {
    constructor(cols: number, rows: number, stops?: ReadonlyArray<MeshStop>);

    readonly cols: number;
    readonly rows: number;
    readonly stops: MeshStopFull[];

    /** Read the (col, row) color into a caller-owned out. Zero-GC. */
    getPoint<T extends Partial<OklchColor>>(col: number, row: number, out: T): T;
    /** Mutate the (col, row) color in place. */
    setPoint(col: number, row: number, l: number, c: number, h: number): void;

    /** Set the (x, y) deformed-grid position of a control point. */
    setPointPosition(col: number, row: number, x: number, y: number): void;
    /** Read the (x, y) position into a caller-owned `{ x, y }` out. Zero-GC. */
    getPointPosition<T extends XYOut>(col: number, row: number, out: T): T;
    /** Restore all control-point positions to the regular grid. */
    resetPositions(): void;

    /**
     * Sample at parametric (u, v) in [0, 1]^2 into `out`. Zero-GC.
     *
     * `modeOrSmooth`:
     *   - false / undefined -> 'bilinear'
     *   - true              -> 'smooth' (smoothstep)
     *   - 'cubic'           -> Catmull-Rom 2D
     *   - any of the strings above explicitly
     */
    sampleAt<T extends Partial<OklchColorA>>(
        u: number,
        v: number,
        out: T,
        modeOrSmooth?: boolean | InterpolationMode,
    ): T;

    /**
     * Rasterize on the REGULAR grid into a packed-RGBA Uint32Array (little-
     * endian byte order; aliasable as Uint8ClampedArray for ImageData).
     */
    rasterizeTo(
        out: Uint32Array,
        width: number,
        height: number,
        opts?: MeshRasterizeOptions,
    ): Uint32Array;

    /**
     * Rasterize honoring control-point positions (deformable mesh). Pixels
     * outside any quad are LEFT UNTOUCHED -- callers that want a clean
     * canvas must fill or zero `out` first.
     */
    rasterizeDeformedTo(
        out: Uint32Array,
        width: number,
        height: number,
        opts?: MeshRasterizeOptions,
    ): Uint32Array;

    /** Release internal references for GC. */
    destroy(): void;
}

// ---------------------------------------------------------------------------
//  CSS emitters
// ---------------------------------------------------------------------------

/** Gradient shape accepted by the CSS emitters (a `stops` array of OKLCH+pos). */
export interface GradientLike {
    stops: ReadonlyArray<OklchColor & { pos: number }>;
}

export interface FormatCssLinearOptions {
    /** Default 90 (left -> right). */
    angle?: number;
    /** Default true. Emits `in oklch` so browsers interpolate perceptually. */
    oklchInterp?: boolean;
}

export interface FormatCssRadialOptions {
    /** Default 'circle'. */
    shape?: 'circle' | 'ellipse';
    /** Default 'farthest-corner'. */
    size?: string;
    /** Default 'center'. Accepts CSS position syntax. */
    position?: string;
    /** Default true. */
    oklchInterp?: boolean;
}

export interface FormatCssConicOptions {
    /** Default 0. Starting angle in degrees. */
    from?: number;
    /** Default 'center'. */
    position?: string;
    /** Default true. */
    oklchInterp?: boolean;
}

export function formatCssLinear(gradient: GradientLike, opts?: FormatCssLinearOptions): string;
export function formatCssRadial(gradient: GradientLike, opts?: FormatCssRadialOptions): string;
export function formatCssConic(gradient: GradientLike, opts?: FormatCssConicOptions): string;

// ---------------------------------------------------------------------------
//  Mesh CSS approximation
// ---------------------------------------------------------------------------

export interface FormatCssMeshOptions {
    /** Layer radius as % of farthest corner. Auto-sized by mesh dims if absent. */
    radiusPct?: number;
    /** Default 'circle'. */
    shape?: 'circle' | 'ellipse';
    /** Default true. */
    oklchInterp?: boolean;
    /** Default true. Append an average-color base layer to fill gaps. */
    includeBase?: boolean;
}

export function formatCssMesh(mesh: MeshGradient, opts?: FormatCssMeshOptions): string;

// ---------------------------------------------------------------------------
//  Color conversion
// ---------------------------------------------------------------------------

/**
 * OKLCH -> linear sRGB triplet. sRGB-gamut-mapped via 10-iteration binary
 * search on chroma when the requested color is out of gamut.
 *
 * @param out Optional 3-element `[r, g, b]` array. If supplied, written in
 *            place and returned (zero allocation). Otherwise a fresh array
 *            is allocated.
 */
export function oklchToLinearSrgb(
    L: number,
    C: number,
    H: number,
    out?: number[],
): number[];

/**
 * Linear sRGB -> OKLCH.
 * @param out Optional `{l, c, h}` object. If supplied, written in place and
 *            returned (zero allocation). The `a` field is left untouched.
 */
export function linearSrgbToOklch<T extends Partial<OklchColor>>(
    r: number,
    g: number,
    b: number,
    out?: T,
): T;

/** sRGB transfer (linear -> gamma-encoded). IEC 61966-2-1. */
export function srgbGamma(x: number): number;
/** sRGB inverse transfer (gamma-encoded -> linear). */
export function srgbInverseGamma(x: number): number;

/**
 * OKLCH -> hex. Emits '#rrggbb' for opaque colors and '#rrggbbaa' otherwise.
 * Output always lowercase.
 */
export function toHex(color: OklchColor): string;

/**
 * Hex -> OKLCH. Accepts 3, 4, 6, or 8-char hex; '#' optional; case-insensitive.
 * @throws on malformed input.
 */
export function fromHex(hex: string): OklchColorA;

// ---------------------------------------------------------------------------
//  Bake / pixel helpers
// ---------------------------------------------------------------------------

/** Flatten `gradient.stops` into a Float32Array of [L, C, H, L, C, H, ...]. */
export function flattenStopsToBuffer(
    gradient: { stops: ReadonlyArray<OklchColor> },
    out?: Float32Array,
): Float32Array;

/** Bake a Gradient into a fixed-resolution Uint32Array LUT of packed RGBA. */
export function bakeGradientToLut(
    gradient: { stops: ReadonlyArray<OklchColor & { pos: number }>; sampleArray(out: Float32Array, n: number): void },
    resolution?: number,
    opts?: {
        easeFn?: (t: number) => number;
        packer?: Function;
    },
): Uint32Array;

/** Sample a single packed color from a baked LUT at parametric t in [0, 1]. */
export function sampleLut(lut: Uint32Array, t: number): number;

/** Pack a single OKLCH color directly to a 32-bit RGBA value. */
export function packOklchSingle(l: number, c: number, h: number, alpha?: number): number;

// ---------------------------------------------------------------------------
//  Palette extraction
// ---------------------------------------------------------------------------

/**
 * Extract a designer-friendly palette from raw RGBA pixels. Chroma-weighted
 * hue-bucketing with >= 50 deg hue separation between picks. Returns up to
 * `count` colors sorted by L ascending; may return fewer on low-diversity
 * images (e.g. monochrome).
 */
export function extractPalette(
    pixels: Uint8ClampedArray,
    count?: number,
): OklchColor[];

// ---------------------------------------------------------------------------
//  CSS parser
// ---------------------------------------------------------------------------

export interface ParsedLinearGradient {
    mode: 'linear';
    angle: number;
    stops: Array<OklchColorA & { stop: number }>;
}

export interface ParsedRadialGradient {
    mode: 'radial';
    radShape: 'circle' | 'ellipse';
    radCx: number;
    radCy: number;
    stops: Array<OklchColorA & { stop: number }>;
}

export interface ParsedConicGradient {
    mode: 'conic';
    conFrom: number;
    conCx: number;
    conCy: number;
    stops: Array<OklchColorA & { stop: number }>;
}

export type ParsedGradient =
    | ParsedLinearGradient
    | ParsedRadialGradient
    | ParsedConicGradient;

/** Parse a CSS `linear-gradient`/`radial-gradient`/`conic-gradient` string. */
export function parseGradientCss(input: string): ParsedGradient;

// ---------------------------------------------------------------------------
//  Multi-format exporters
// ---------------------------------------------------------------------------

export type Export1dFormat = 'css' | 'css-var' | 'scss' | 'tailwind' | 'json' | 'svg';
export type ExportMeshFormat = 'css' | 'css-var' | 'json';

export const EXPORT_FORMATS_1D: ReadonlyArray<Export1dFormat>;
export const EXPORT_FORMATS_MESH: ReadonlyArray<ExportMeshFormat>;

export interface FormatMetaEntry {
    label: string;
    hint: string;
}

export const FORMAT_META: Readonly<Record<Export1dFormat, FormatMetaEntry>>;

/** 1D state shape consumed by the exporters (matches the editor's serialize/load). */
export interface State1d {
    mode: 'linear' | 'radial' | 'conic';
    stops: Array<{
        l: number;
        c: number;
        h: number;
        a?: number;
        stop: number;
    }>;
    angle?: number;            // linear
    radShape?: 'circle' | 'ellipse';
    radCx?: number; radCy?: number;
    radPos?: string;           // legacy keyword form
    conFrom?: number;
    conCx?: number; conCy?: number;
    conPos?: string;           // legacy keyword form
}

export interface ExportOptions {
    name?: string;
    width?: number;            // svg only
    height?: number;           // svg only
}

export function toTokens1d(state: State1d, format: Export1dFormat, opts?: ExportOptions): string;
export function toTokensMesh(mesh: MeshGradient, format: ExportMeshFormat, opts?: ExportOptions): string;

export function toCss1d(state: State1d, opts?: ExportOptions): string;
export function toCssVar1d(state: State1d, opts?: ExportOptions): string;
export function toScss1d(state: State1d, opts?: ExportOptions): string;
export function toTailwind1d(state: State1d, opts?: ExportOptions): string;
export function toJson1d(state: State1d, opts?: ExportOptions): string;
export function toSvg1d(state: State1d, opts?: ExportOptions): string;

export function toCssMesh(mesh: MeshGradient, opts?: ExportOptions): string;
export function toCssVarMesh(mesh: MeshGradient, opts?: ExportOptions): string;
export function toJsonMesh(mesh: MeshGradient, opts?: ExportOptions): string;
