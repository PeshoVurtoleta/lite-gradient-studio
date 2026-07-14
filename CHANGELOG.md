# Changelog

All notable changes to `@zakkster/lite-gradient-studio` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This library follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-07-14  "Tiles + Dither"

The **toroidal-mesh + dither release**. Both roadmap tracks (D1-D6 wrap,
D7-D8 dither) land together.

> Originally cut as two patches, `1.2.0` (wrap) and `1.2.1` (dither), on the
> assumption that 1.2.0 had shipped. It had not — npm's latest is 1.1.0 — so a
> patch bump on top of an unpublished minor would have invented a version that
> never existed. Folded into a single minor.

---

## Wrap (D1-D6)

The **toroidal-mesh release**. `MeshGradient` becomes cylindrical or
toroidal on demand, with a real C¹ seam in cubic mode — the flagship
feature: read real neighbours across the boundary via modulo indexing
instead of clamping to duplicated endpoints.

### Added — Structural wrap on the constructor

`new MeshGradient(cols, rows, stops, { wrapX, wrapY })`. Both flags are
optional, default `false`, and independent (torus = both on; cylinder =
one on). Wrap is stored on the instance as `readonly wrapX` / `readonly
wrapY` for downstream consumers to branch on.

- **UV period.** On a wrapped axis the cell count is `cols`, not
  `cols - 1`. Default control-point positions become `col / cols`.
- **`sampleAt` (bilinear + smooth).** Wrapped axis wraps the coord via
  `u - Math.floor(u)`, then reads the last-cell neighbour with `(col + 1)
  % cols` — so `sampleAt(1, v)` is exactly `sampleAt(0, v)`, any float
  is a valid position (raw accumulating animation phase, negatives,
  arbitrary magnitudes).
- **`sampleAt` cubic — C¹ continuity across the seam.** The whole
  reason wrap exists: `_sampleAtCubic` and `_cubicRow` use modulo
  neighbour indexing on wrapped axes (`((col - 1) % cols + cols) % cols`
  and `(col + 2) % cols`). Catmull-Rom now reads real neighbours across
  the boundary, giving a genuinely smooth seam instead of a spline that
  degrades toward bilinear at the edge. Bilinear and smooth get
  seamlessness from the wrap coord alone; cubic is where wrap earns
  "exists in no other library."
- **`rasterizeTo` period sampling.** On wrapped axes, `u = x / width`
  (drops the `- 1` divisor). Pixel column 0 of the "next tile" lands
  exactly at `u ≡ 0` — no duplicated edge column, so `drawImage`-based
  tiling of the rasterized output butts perfectly.
- **`rasterizeDeformedTo` fails loudly on wrap.** Throws with
  `err.code = 'WRAP_DEFORMED_UNSUPPORTED'` when called on a wrapped
  mesh. Deformed + wrap needs ghost quads that cross the seam (Newton
  solve against wrapped corner positions) — real work deferred to v1.3.
  Silent seamed output would be worse than the error; consumer code can
  branch on the code string instead of matching messages.
- **`defaultMeshColor` — wrap-aware defaults.** Trailing `wrapX` /
  `wrapY` args (backward-compat: absent → v1.1.0 output byte-identical).
  When `wrapX`, hue advances a uniform `360/cols` per column (no
  aperiodic compression at the wrap boundary). When `wrapY`, the row
  drift becomes sinusoidal and L switches to `cos(2π · rT)` so
  top and bottom rows agree.

### Guarantees

- **Byte-parity on the non-wrap path.** All 218 pre-existing tests pass
  unmodified. The alloc test file gains three new wrapped-rasterize
  invariants (all under the same 128 KB / 100-frame ceiling). Every
  non-wrap code path — constructor with no opts, `sampleAt` on a
  non-wrapped mesh, `rasterizeTo` on a non-wrapped mesh — walks the
  exact same v1.1.0 code, byte for byte.
- **Empirical wrap-on ceilings (this container, node 22):**

  | path | v1.1.0 baseline | v1.2.0 wrapped | overhead |
  |---|---|---|---|
  | `sampleAt` 5×5 smooth | 5.2M ops/s | 5.0M wrapX / 4.7M torus | 4–10% |
  | `sampleAt` 5×5 cubic  | 1.9M ops/s | 2.0M wrapX / 2.0M torus | within noise |
  | `rasterizeTo` 5×5 → 256² | 2.1M px/s | 2.3M px/s wrapped     | JIT ties or wins |
  | `rasterizeTo` 5×5 cubic → 256² | (not measured) | 2.3M px/s wrapX | ceiling set |

  Wrap paths came in on parity or a hair faster; the branch structure
  turns out to be slightly cleaner for the JIT than the non-wrap
  interior-clamp branches. Empirical, not prior-based — the ceilings
  above are the number to beat in T3.

### Peer bumps

- `@zakkster/lite-color-engine`: `^1.0.0 → ^1.5.0`. T3's dither work
  will delegate to engine v1.5's `getBlueNoise64` + dithered packers.
- `@zakkster/lite-gradient`: `^1.1.0 → ^1.2.0`. Picks up `Gradient`'s
  new `closed: true` for downstream `formatCssConic` work.

### Notes

- 31 new wrap tests in `test/mesh-wrap.test.js` covering: D1 (opts +
  guards + cols=2 wrapped legality), D2 (period spacing, seam identity
  in bilinear/smooth, raw-phase and negative-u sampling, tile-equality
  across 21 sample points, non-wrap axis retains clamp), D3 (cubic
  seam identity, C¹ derivative test via central differences,
  real-neighbour indexing verified against a deliberately non-uniform
  L mesh), D4 (rasterize period sampling, non-wrap y retains closed
  interval), D5 (WRAP_DEFORMED_UNSUPPORTED on wrapX / wrapY / torus,
  non-wrap deformed still works), D6 (byte-parity of the four-arg
  form, periodic hue step and L symmetry, integration with
  `MeshGradient` defaults).
- Wrap suite: 252 green (218 pre-existing + 31 wrap + 3 wrap-alloc
  invariants) at the point wrap landed; 271 with dither folded in.

---

## Known / measured — the allocation gate is a leak gate

`test/allocation.test.js` asserts things like *"MeshGradient.rasterizeTo x 100 frames
at 128x128 stays under 128 KB"*, measured as `gc(); gc(); heapUsed` before and after.
That is a **leak** gate. It measures RETAINED memory, and it is structurally blind to
short-lived garbage — a value allocated and dropped inside the loop is scavenged
before the second sample and never appears in the delta.

`rasterizeTo` does allocate, and the gate cannot see it. Measured by counting GC
events over a fixed wall-clock budget, against a zero-alloc arithmetic control and a
one-object-per-pixel control in the same process:

```
zero-alloc floor (arithmetic)          1 GC / 6 s
allocating ceiling (1 obj/pixel)    3587 GC / 6 s
rasterizeTo bilinear, no dither       72 GC / 6 s     <- not the floor
```

The source is not a `new` anywhere in the loop — there isn't one. It is
`const tmp = { l: 0, c: 0, h: 0, a: 1 }`. **V8 removed double-field unboxing in 9.x**,
so every write of a non-Smi double to an object property boxes a `HeapNumber` — and
`sampleAt` writes four of them per pixel, 16,384 times per raster. Isolated:

```
write 4 doubles into an OBJECT,        16384x   ->  3519 GC
write 4 doubles into a Float64Array,   16384x   ->   497 GC
write 4 Smis   into an OBJECT,         16384x   ->   496 GC
```

**Cost, in the only unit that matters: 0.37%–0.95% of wall time** in a synthetic loop
running 150 rasters/sec; roughly half that at a realistic 60/sec. It is real, it is
measurable, and it does not matter.

Not fixed, deliberately. The only way to remove it is a `Float64Array` scratch, which
means changing `sampleAt(u, v, out, mode)`'s public object-out contract or duplicating
the sampler. That is a bad trade for half a percent. Logged with the number so the
call is informed.

What *should* change is the gate's name and its comment, which currently imply it
proves zero-GC. It proves no leak. Those are different claims, and the ecosystem has
now made this mistake in three packages.

---

## Dither (D7-D8)

The dither track (D7/D8). One flag on `rasterizeTo` and one scalar-arg
packer wrapper. `dither: false` (or absent) is byte-identical to the
undithered path — verified, not asserted.

### Added — `opts.dither: true` on `MeshGradient.rasterizeTo`

Delegates to `@zakkster/lite-color-engine >= 1.5.0`'s
`packOklchBufferToUint32Dithered` + `getBlueNoise64` — the roadmap's D7
already ratified the engine as the noise-source owner, so studio
consumes and does not duplicate:

- **Per-pixel tile lookup** — `tile[((y & 63) << 6) | (x & 63)]`. Pure
  bit ops (torus wrap via mask, row stride via shift), zero-GC trivially.
- **Same noise value shared R/G/B at a pixel** — luminance-patterned
  dither, no chroma speckle. Verified by a test that rasterizes a
  chroma-free mesh with dither on and asserts R === G === B per pixel.
- **Alpha undithered.** Verified against undithered α on a distinctive
  α mesh.
- **`noise01 = 0.5` reproduces the plain packer exactly** — the identity
  anchor from D8, verified across seven representative OKLCH triplets
  covering different gamma-encode regions and alpha values.
- **`dither: false` or absent → byte-identical to v1.2.0.** The branch
  is resolved once per rasterize call, two loop bodies — no per-pixel
  branch cost on the undithered path. Six regression tests assert this
  across bilinear, smooth, cubic, wrapped, and `dither: false` vs
  absent-opt.

### Added — `packOklchSingleDithered(l, c, h, alpha, noise01)`

New export from `./bake.js`. Scalar-arg convenience wrapper around the
engine's `packOklchBufferToUint32Dithered` using the same
`Float32Array(3)` scratch as `packOklchSingle` — no additional module-
level allocation, safe to alternate between plain and dithered calls
in the rasterize inner loop.

### Empirical dither ceilings (node 22, container)

| path | undithered | dithered | overhead |
|---|---|---|---|
| `rasterizeTo` 5×5 smooth → 256² | 2.1M px/s | 1.6M px/s | ~24% |
| `rasterizeTo` 5×5 wrapX+smooth  | 2.5M px/s | 1.9M px/s | ~24% |
| `rasterizeTo` 5×5 cubic         | (v1.2.0 gate) | 1.7M px/s | ceiling set |

The 24% overhead pays for one blue-noise tile lookup + a threshold-offset
gamma-encode round per pixel (the engine's dithered packer inlines the
sRGB gamma-encode inline instead of calling out to `linearToSrgbByte`,
which is why the overhead is small).

### Test count

+15 dither tests in `test/mesh-dither.test.js`:
- Off-flag byte parity: 6 tests (bilinear, smooth, cubic, wrapped,
  `dither: false` explicit, bare-opts).
- `noise01 = 0.5` identity anchor: 1 test, 7 OKLCH samples.
- Determinism: 2 tests (plain, wrap+dither composition).
- Bounded deviation ±1 per channel: 2 tests (typical mesh, shallow-ramp).
- Contract properties: 2 tests (alpha never dithered, R === G === B on
  chroma-free mesh).
- Run-length shortening on shallow ramp: 1 test.
- Zero-GC under `--expose-gc`: 1 test (128 KB / 100 frames).

+2 dither-alloc invariants in `test/allocation.test.js` (plain dither,
wrapX+dither).

Total suite: **269/269 green.** Byte-parity gate on the 218 v1.1.0
tests still holds unmodified.

### Notes

- `rasterizeDeformedTo` still throws `WRAP_DEFORMED_UNSUPPORTED` on
  wrapped meshes (unchanged from v1.2.0). Dither on `rasterizeDeformedTo`
  silently ignores the flag — deformed + dither is scheduled to land
  alongside the v1.3 ghost-quad seam work, so consumers on 1.2.x
  should treat this as "dither is rasterizeTo only."
- The engine's blue-noise tile is decoded once at first use (~sub-ms
  from a base64 blob into a shared `Uint8Array(4096)`). Subsequent
  calls return the same reference — the alloc test's warm-up phase
  triggers the one-time decode before the timed loop.
- No peer bumps — engine v1.5.0 was already the floor from v1.2.0.

## [1.1.0] — 2026-07-03

### Added — Monochrome mesh

Mesh-level analogue of the `monochromeGradient` factory that shipped in
`@zakkster/lite-gradient` v1.1.0. Both together form a coordinated
monochrome capability across the ecosystem — 1D continuous gradients in
lite-gradient, 2D deformable meshes in lite-gradient-studio.

- **`monochromeMesh(base, cols, rows, opts?)`** — factory returning a
  `MeshGradient` where every control point shares `base.c` and `base.h`
  (or `c=0` if `mode: 'grayscale'`); only L varies according to
  `direction`. Post-construction, the returned mesh behaves like any
  other `MeshGradient` — `setPointPosition(...)` to warp the L
  distribution off-grid, `rasterizeTo(...)` / `rasterizeDeformedTo(...)`
  to render.

- **Options:**
  - `mode`: `'tinted'` (default) | `'grayscale'`
  - `range`: `[lo, hi]` with `0 <= lo < hi <= 1`, default `[0, 1]`
  - `direction`: `'horizontal'` | `'vertical'` | `'diagonal'` (default) | `'radial'`

- **Directions:**
  - `'horizontal'` — L varies left-to-right, uniform per row (equivalent
    to a linear gradient, but with mesh deformability post-hoc).
  - `'vertical'` — L varies top-to-bottom, uniform per column.
  - `'diagonal'` (default) — top-left corner (lo) to bottom-right
    corner (hi). Uses both axes meaningfully — the most versatile default.
  - `'radial'` — center (lo) outward to corners (hi). Atmospheric,
    "premium background" feel.

- **Type declarations:** `MonoMode`, `MonoMeshDirection`,
  `MonochromeMeshOptions`, plus the factory signature in
  `src/index.d.ts`.

- **Re-exports flow through:** `monochromeGradient`, `gradientMonoWarm`,
  `gradientMonoCool` from `@zakkster/lite-gradient` v1.1.0 are already
  visible via the existing `export * from '@zakkster/lite-gradient'`
  in `src/index.js`. No new studio-level 1D monochrome factory needed;
  users import from either package interchangeably.

### Why this matters

Designer feedback on the mesh-gradient positioning (the original
mesh-gradient authoring focus) surfaced two problems: (1) AI image
generators can produce arbitrary decorative gradients on demand, eating
the "generate a wild gradient" use case at the low end; (2) designers
doing client work don't have creative freedom to ship wild mesh
gradients — they're constrained to brand palettes.

Monochrome mesh dodges both problems. The palette is fixed to a single
brand tone (nothing "wild" or "random-looking"); the mesh capability
still gives designers organic-feeling backgrounds that flat 1D
gradients can't — subtle asymmetry via `setPointPosition`, off-center
radial gradients, non-linear L distributions. Same authoring surface,
narrower creative space that lands in the client-work zone.

### Peer dependency bump

- `@zakkster/lite-gradient`: `^1.0.4` → `^1.1.0`

Existing consumers using only pre-1.1.0 exports continue to work
identically. The bump ensures `monochromeGradient` and the two Mono
presets are guaranteed available via the re-export.

### Tests

18 new tests across `test/mesh-monochrome.test.js`. Coverage: the four
directions (verified by inspecting the initialized `stops` array — e.g.
horizontal makes row 0 == row 1 == row 2; radial makes center = lo and
all four corners = hi), both modes, custom range, sampling correctness,
every validation throw path, and base non-mutation.

The 4 previously-failing `color-convert.test.js` tests (documented in
1.0.1 as a docs-vs-implementation mismatch) now pass — see "Fixed"
below. Total: 218 tests, **203 pass**, 0 fail, 15 skipped.

### Fixed

- **`oklchToLinearSrgb(L, C, H, out?)` and `linearSrgbToOklch(r, g, b, out?)`
  now honor the optional `out` parameter** documented since 1.0.0 in
  `index.d.ts` and covered by tests that had been failing since publish.
  Pass a caller-owned 3-element array (or `{ l, c, h }` object) as the
  final argument; the function writes into it in place and returns the
  same reference — zero allocation on the hot path. Omitting `out` (or
  passing `null` / `undefined`) preserves the existing 3-arg call shape
  and returns a freshly-allocated result.

  Real impact: `oklchToLinearSrgb` is called per-pixel in `rasterizeTo` /
  `rasterizeDeformedTo` and per-color in every exporter. Callers threading
  a scratch array through that hot loop can now avoid allocating one
  triplet per pixel. Existing 3-arg calls are unchanged.

  The 1.0.1 CHANGELOG framed this as "docs drifted from implementation"
  and rolled back the docs. That was a stopgap. The correct resolution
  was implementing the feature the docs, types, and tests all documented;
  this ship does that. Non-breaking either way (the 3-arg signature is
  a strict subset of the new 4-arg signature).

### Non-breaking

Additive only. No existing API surface changed.

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
