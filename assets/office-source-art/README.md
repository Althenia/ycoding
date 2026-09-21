# Office source art (archived)

Original in-house pixel art preserved when the Godot office client under `apps/office/`
was removed. These PNGs are engine-independent raster assets. Every Godot-specific
artifact (`.import` sidecars, the hand-authored `TileSet`, scenes, scripts and the
generators) was removed with the client and is recoverable from Git history.

## Provenance

- Extracted verbatim from `apps/office/office/art/` at commit
  `6aece46e0583f2c5db667c58f02786bcc66e3b7b` (branch `remote-access`). The same asset
  family exists on the `office` branch at `bbd04241e101211188011c1b1455d12e7b4546ce`.
- All 49 PNGs were generated in-repo by the removed `apps/office/tools/generate_art.py`
  and `apps/office/tools/generate_icon.py`. There is no third-party, stock, purchased,
  downloaded or externally authored asset here, so no third-party licence or
  redistribution restriction attaches to this directory.
- `ASSETS.md` is the authored per-file manifest, kept unchanged. Its `Generator call`
  column and `tools/generate_art.py:<line>` references point at the removed generator
  sources and are historical records, not live paths.
- Determinism was verified against the deleted generators (48 files regenerated, 0
  SHA-256 differences). That check no longer runs: the generator and the
  `tests/suites/test_asset_provenance.gd` suite were removed with the client.

## Scope

Reference material for a future office surface. No current runtime, package, build or
release artifact reads this directory.
