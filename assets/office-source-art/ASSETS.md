# Office art asset manifest

Provenance and attribution for every shipped raster asset in this directory.

## Provenance summary

Every shipped `.png` in `office/art/` is **generated in-repo**:

- scene, character, floor, wall and prop art by `apps/office/tools/generate_art.py`
- the application icon by `apps/office/tools/generate_icon.py`

There is **no third-party, stock, purchased, downloaded or externally authored
asset** in this directory, and therefore no third-party licence or redistribution
restriction attaches to it. The icon generator reuses the same palette constants
as the scene generator, so the icon cannot drift from the office it represents.

- No network access: the generator's only imports are `argparse`, `random`,
  `struct`, `zlib` and `pathlib`. There is no `urllib`, `requests`, `socket`,
  `http`, `subprocess`, `os.system`, `popen` or `urlopen` reference anywhere in
  the file, so it cannot fetch or shell out.
- No external art dependency: the rasterizer is a self-contained `Canvas` class
  (`tools/generate_art.py:194`) that writes PNG bytes directly with `struct` +
  `zlib` (`Canvas.to_png`, `tools/generate_art.py:267`). No image library is
  imported.
- Original in-house work is stated at `tools/generate_art.py:4`:
  "Original in-house artwork: no third-party pack, so there is no licensing or
  redistribution restriction."

### Determinism evidence

The generator is deterministic. Every source of variation is a fixed integer
seed, and there is no unseeded entropy, clock or process input:

| Source of variation | Site | Seed |
| --- | --- | --- |
| Table-top wood grain | `tools/generate_art.py:1024` (`build_table`) | `random.Random(31)` |
| Shelf book spines | `tools/generate_art.py:1057` (`_books`, `random.Random(seed)`) | seeds `410 + index` at `1090` and `700 + index` at `1115` |

No `time`, `datetime`, `os.urandom`, `secrets`, `random.random()` or
`random.randrange()` (module-level, unseeded) call exists in the file. All
drawing is integer arithmetic over a fixed palette; `zlib.compress(..., 9)` is a
fixed compression level.

Byte-level evidence, reproduced with:

```
python3 apps/office/tools/generate_art.py --out /tmp/artcheck
# then sha256-compare /tmp/artcheck/*.png against office/art/*.png
```

Result: **48 files regenerated, 0 SHA-256 differences** against the committed
bytes. Regenerating produces byte-identical output.

## Manifest

Derived from the actual directory listing and the actual generator source; the
`Generator call` column is the exact expression in `main()` / `build_props()` /
`build_wall_decor()` that writes that file.

| File | Size (px) | Generator function | Provenance | Generator call |
| --- | --- | --- | --- | --- |
| icon_512.png | 512x512 | build | build() | generated in-repo by tools/generate_icon.py; no third-party or external asset |
| char_backend.png | 128x896 | build_character_sheet | build_character_sheet("backend") | generated in-repo by tools/generate_art.py; no third-party or external asset |
| char_frontend.png | 128x896 | build_character_sheet | build_character_sheet("frontend") | generated in-repo by tools/generate_art.py; no third-party or external asset |
| char_lead.png | 128x896 | build_character_sheet | build_character_sheet("lead") | generated in-repo by tools/generate_art.py; no third-party or external asset |
| char_qa.png | 128x896 | build_character_sheet | build_character_sheet("qa") | generated in-repo by tools/generate_art.py; no third-party or external asset |
| door_frame.png | 128x56 | build_door_frame | build_door_frame() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_aquarium.png | 64x56 | build_aquarium | build_aquarium() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_arcade.png | 48x72 | build_arcade | build_arcade() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_armchair.png | 48x52 | build_armchair | build_armchair() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_bookshelf.png | 64x88 | build_bookshelf | build_bookshelf() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_cabinet.png | 32x64 | build_cabinet | build_cabinet() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_chair.png | 32x44 | build_chair | build_chair() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_coffee.png | 64x72 | build_coffee | build_coffee() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_cooler.png | 32x46 | build_cooler | build_cooler() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_counter.png | 96x48 | build_counter | build_counter() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_desk.png | 96x96 | build_desk | build_desk() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_filing_cabinet.png | 32x64 | build_filing_cabinet | build_filing_cabinet() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_fridge.png | 32x68 | build_fridge | build_fridge() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_lamp.png | 32x52 | build_lamp | build_lamp() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_lockers.png | 64x80 | build_lockers | build_lockers() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_pingpong.png | 96x68 | build_pingpong | build_pingpong() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_plant.png | 32x44 | build_plant | build_plant() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_pouf.png | 32x32 | build_pouf | build_pouf() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_rack.png | 48x80 | build_rack | build_rack() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_reading_chair.png | 32x48 | build_reading_chair | build_reading_chair() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_round_table.png | 48x44 | build_round_table | build_round_table() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_rug_blue.png | 96x64 | _rug | _rug(TILE * 3, TILE * 2, (198, 212, 236, 255), (150, 172, 212, 255), (230, 238, 250, 255)) | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_rug_checker.png | 96x64 | build_rug_checker | build_rug_checker() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_rug_pink.png | 96x64 | _rug | _rug(TILE * 3, TILE * 2, (238, 206, 216, 255), (208, 160, 178, 255), (250, 232, 238, 255)) | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_rug_warm.png | 96x64 | _rug | _rug(TILE * 3, TILE * 2, (240, 222, 198, 255), (208, 178, 142, 255), (252, 240, 222, 255)) | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_shelf.png | 64x72 | build_shelf | build_shelf() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_side_table.png | 32x40 | build_side_table | build_side_table() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_sofa.png | 96x72 | build_sofa | build_sofa() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_table.png | 64x68 | build_table | build_table() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_tv_stand.png | 96x48 | build_tv_stand | build_tv_stand() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_vending.png | 48x72 | build_vending | build_vending() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_wall_tv.png | 64x40 | build_wall_tv | build_wall_tv() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_water_cooler.png | 32x56 | build_water_cooler | build_water_cooler() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_whiteboard.png | 96x44 | build_whiteboard | build_whiteboard() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| prop_window.png | 64x48 | build_window | build_window() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| tiles_floor.png | 416x32 | build_floor_tiles | build_floor_tiles() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| wall_clock.png | 24x24 | build_wall_clock | build_wall_clock() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| wall_frame_art.png | 32x28 | build_wall_frame_art | build_wall_frame_art() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| wall_pinboard.png | 56x32 | build_wall_pinboard | build_wall_pinboard() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| wall_poster.png | 28x36 | build_wall_poster | build_wall_poster() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| wall_screen.png | 48x32 | build_wall_screen | build_wall_screen() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| wall_side.png | 22x64 | build_wall_side | build_wall_side() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| wall_sign.png | 64x20 | build_wall_sign | build_wall_sign() | generated in-repo by tools/generate_art.py; no third-party or external asset |
| wall_top.png | 128x56 | build_wall_top | build_wall_top() | generated in-repo by tools/generate_art.py; no third-party or external asset |

Total: 49 shipped PNG assets, all generator-produced.

## Repository-local build artifacts (not assets)

- `*.png.import` — 48 files, one per PNG. Godot's import sidecar metadata,
  written by the engine's importer on `--editor --import`; not artwork and not
  shipped by hand.
- `.godot/` — engine cache, git-ignored (`.gitignore:52`).

`office/maps/hq/hq_tileset.tres` is a hand-authored Godot `TileSet` resource that
*references* `tiles_floor.png`; it contains no embedded artwork.

## How this manifest is kept true

`tests/suites/test_asset_provenance.gd` parses this file and the real directory
and fails when the two disagree: a PNG shipped without a row here, a row here
without a PNG on disk, or a claimed size that does not match the bytes.