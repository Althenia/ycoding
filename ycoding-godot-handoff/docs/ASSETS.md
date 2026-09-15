# Asset pipeline and art scope

The previous videos did not establish a production art baseline. This package contains **no pixel artwork, fonts, purchased asset packs or finished Godot scenes**. M0/M2 must obtain or create the approved art and record its provenance.

## Approaches

| Approach | Idea | Best when | Main weakness |
|---|---|---|---|
| One licensed office/character family — default | Use coherent source tiles/sprites with suitable directional and seated poses | Fast route to a consistent scene | Gaps in interaction animations or redistribution restrictions |
| Original commissioned art | Commission a small shared style sheet and required animation/prop set | Product identity and full control matter | Requires budget, clear rights and iteration |
| Original in-house sprites | Create a small complete art family locally | Art skills/time are available and scope is tightly controlled | Quality may lag without dedicated review |

Do not combine unrelated packs merely because each is free. Reject assets that cannot support the required perspective, pivots, seat poses or clean integer scaling. Generated one-off pictures are not a substitute for consistent, production-tested sprite sheets.

## First-slice inventory

Two employee profiles; directional idle/walk; seated typing/reading; standing talking; sit/stand transition; a neutral waiting/blocked gesture; one coffee/ambient cycle. Floor/wall/door/window tiles, two desks with monitor/keyboard/chair parts, plant, rug, whiteboard and coffee prop. World/character shadows and small status indicators. Speech bubble frame and professional panel theme.

Full office adds Frontend/QA display profiles, meeting table/seats, QA bench/monitor variants, break seating, extra plants/decorations and alternate desk orientations. Sharing a body animation set across profiles is fine when silhouettes remain distinct. Do not require bespoke animations for every tool name.

## Asset record

Maintain [tracking/asset_manifest.json](../tracking/asset_manifest.json): internal ID, source/creator, source URL or receipt locator, version/digest, license identifier/text location, modification rights, attribution requirement, redistribution permission, included source files and exported derived files. Unknown rights means not release-ready. Store receipts privately when necessary; do not leak purchase credentials.

No external fonts are included in this handoff. Use an appropriately licensed UI typeface locally and retain its attribution where required. Do not distribute private system fonts or copy another product's UI art.

## Import and authoring

Record frame size, grid, origin at the feet, direction ordering, animation names/frame rate and furniture split layers. Keep originals and export settings traceable. Disable unintended filtering/mip artifacts for pixel-world assets according to the pinned engine. UI text is rendered separately at readable screen resolution. Keep `.tscn`/`.tres` source resources text-based where feasible for agent review.

One owner edits a shared scene/tileset at a time. Other agents may edit independent sprites or tests but should not concurrently rewrite imported resource IDs. Asset replacement reopens the affected fidelity gate.

## Quality review

Before importing a large pack, make a two-actor art board: next to a door/desk at default scale, one seated and one standing, plus a sample bubble and history panel. Test at 720p/1080p and intended zoom. Reject inconsistent scale and unreadable visual hierarchy early. Use the actual Godot scene for final acceptance; a style board alone is insufficient.
