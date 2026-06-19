# Changelog

All notable changes to `@zakkster/lite-gradient-studio` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This library follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — docs accuracy patch

Patch release. No code changes — every export, every behavior is
identical to 1.0.0. The 1.0.0 documentation drifted from the
implementation in several places; users following the docs exactly
would hit runtime errors. Comprehensive fix.

### Fixed

- `toTokens1d(state, format, opts)` documented order. The 1.0.0 README
  showed `toTokens1d(format, state, opts)`. The implementation is and
  always was `(state, format, opts)`. Same fix for `toTokensMesh(mesh,
  format, opts)`.
- `extractPalette(pixels, count?)` documented signature. The 1.0.0
  README showed `(pixels, width, height, count)` — width/height aren't
  parameters; the algorithm scans linearly.
- `MeshGradient.setPoint(col, row, l, c, h)` documented method name.
  The 1.0.0 README called it `setPointColor` with an alpha parameter;
  the actual method is `setPoint` and writes L/C/H only (alpha lives
  on the stop and can be set by direct mutation).
- Mesh interpolation mode names. The 1.0.0 README used `'linear'` for
  the bilinear mode; the actual accepted values are `'bilinear'`,
  `'smooth'`, `'cubic'`. (`sampleAt` also accepts the legacy boolean.)
- `rasterizeTo` / `rasterizeDeformedTo` options key. The 1.0.0 README
  showed `{ mode: 'smooth' }`; the actual key is `{ interpolation:
  'smooth' }` (`opts.smooth: true` is also accepted as a legacy alias).
  Unknown keys silently fell back to `'bilinear'`, so 1.0.0 docs would
  also have made these benchmarks measure the wrong path under wrong
  labels.
- `oklchToLinearSrgb(L, C, H)` documented return type. Returns
  `[r, g, b]`; the 1.0.0 README incorrectly described a zero-GC out
  param. Same for `linearSrgbToOklch(r, g, b)` which returns
  `{ l, c, h }`.
- `bakeGradientToLut(gradient, resolution?, opts?)` documented
  signature. Returns the `Uint32Array`; the 1.0.0 README showed a
  caller-owned buffer pattern that doesn't match the implementation.
- `flattenStopsToBuffer(gradient, out?)` documented first arg. Takes
  a gradient instance (the function reads `gradient.stops`), not a
  stops array directly.
- `srgbGamma(x) / srgbInverseGamma(x)` documented input range. Operates
  on `[0, 1]` linear values, not `[0, 255]` bytes.

### Changed

- Benchmark suite (`npm run bench`) now exercises the correct rasterize
  opts key and includes separate `bilinear` / `smooth` / `cubic`
  rasterize timings. The 1.0.0 bench labels were technically all
  measuring the bilinear path (the `mode` key was silently ignored).
  README throughput numbers updated.

If you wrote code against 1.0.0 by copy-pasting from the README and
hit "Unknown 1D export format: '[object Object]'", "setPointColor is
not a function", or similar, this release fixes the documentation —
your code needs to use the actual signatures above. No upgrade is
required for users who read the source directly.

## [1.0.0] — first public release

First npm publish. Internal pre-1.0 versions powered Gradient Studio
through ~40 iterations; the API surface below is what survived that
production use.

### Added

#### Core gradient layer
- `Gradient` (re-exported from `@zakkster/lite-gradient`) — 1D OKLCH
  gradient with `at(t, out)` zero-GC sampling and N-stop support.
- `MeshGradient` — N×M control grid with `sampleAt(u, v, out, mode)`
  in `'linear'` / `'smooth'` / `'cubic'` modes. Catmull-Rom blending
  across cell boundaries for cubic, with hue-axis alignment so 350°
  and 10° don't fight at boundaries.
- `setPointPosition(col, row, x, y)` — deform a handle to any (x, y)
  including outside `[0, 1]`. Geometry only; the color basis stays on
  the regular grid.
- `setPointColor(col, row, l, c, h, a?)` — mutate stop color in place.

#### Rasterization
- `rasterizeTo(out, w, h, opts)` — regular-grid fast path. Writes
  ARGB-packed `Uint32Array`, byte-order compatible with `new
  ImageData(new Uint8ClampedArray(buf.buffer), W, H)` for zero-copy
  blit.
- `rasterizeDeformedTo(out, w, h, opts)` — Newton inverse-bilinear
  for arbitrary handle positions. Per-pixel cost ~3-5× of `rasterizeTo`
  depending on convergence; covers folded-quad cases without painting
  outside the mesh.
- `packOklchSingle(l, c, h, a?)` — single-pixel OKLCH → ARGB pack
  for use as a rasterizer pre-fill (mesh-gap fallback, etc.).
- `bakeGradientToLut(gradient, lut, size)` + `sampleLut(lut, t)` — 1D
  gradient → flat Uint32Array LUT for cheap lookup-based sampling.
- `flattenStopsToBuffer(stops, buf)` — Float32Array layout for GPU upload.

#### CSS emit
- `formatCssLinear(gradient, { angle, oklchInterp })`.
- `formatCssRadial(gradient, { shape, position, oklchInterp })`.
- `formatCssConic(gradient, { from, position, oklchInterp })`.
- `formatCssMesh(mesh)` — multi-radial approximation. One radial per
  stop, layered by visual weight. No canvas required at consume time.
- All emitters preserve the originally authored stop positions; no
  resampling.

#### Multi-format export
- `toTokens1d(format, state, opts)` / `toTokensMesh(format, mesh, opts)`
  dispatchers.
- Direct format functions: `toCss1d`, `toCssVar1d`, `toScss1d`,
  `toTailwind1d`, `toJson1d`, `toSvg1d`, `toCssMesh`, `toCssVarMesh`,
  `toJsonMesh`.
- `EXPORT_FORMATS_1D` / `EXPORT_FORMATS_MESH` — frozen format-id arrays.
- `FORMAT_META` — UI labels + one-line hints per format.

#### CSS parsing
- `parseGradientCss(css)` — accepts `linear-gradient`, `radial-gradient`,
  `conic-gradient`. Round-trips with the emitters. Backward-compatible
  with pre-v0.0.17 internal snapshots that used keyword position strings
  (`'center'`, `'top right'`).

#### Palette extraction
- `extractPalette(rgba, w, h, count)` — chroma-weighted hue-bucketing.
  Skips shadows (`L < 0.10`) and near-neutrals (`C < 0.02`). Enforces
  ≥50° hue separation between picks so a photo of one warm subject
  doesn't return five skin tones. Designer-facing behavior: "import
  this photo of a baby in a blue shirt → blue shows up in the palette".

#### Color conversion
- `toHex({ l, c, h, a })` / `fromHex(str)` — OKLCH ↔ hex with sRGB
  gamut clip via boundary search.
- `oklchToLinearSrgb(l, c, h, out)` / `linearSrgbToOklch(r, g, b, out)`
  — zero-GC matrix conversions.
- `srgbGamma(c)` / `srgbInverseGamma(c)` — 8-bit sRGB transfer.

### Tests

178 cases over 11 test files. ~1:1 source-to-test ratio.

### Benchmarks

`npm run bench` produces per-machine numbers. Indicative figures on
Node v22, Linux x64:

| Operation | Throughput |
|---|---|
| `Gradient.at(t)` — single | ~9.4 M ops/sec |
| `MeshGradient.sampleAt` — 5×5 smooth | ~4.9 M ops/sec |
| `MeshGradient.sampleAt` — 5×5 cubic | ~1.9 M ops/sec |
| `rasterizeDeformedTo` — 5×5 → 256×256 | ~2.1 M px/sec |
| `formatCssLinear` — 3 stops | ~360 K ops/sec |
| `extractPalette` — 240×240, k=5 | ~41 calls/sec |
