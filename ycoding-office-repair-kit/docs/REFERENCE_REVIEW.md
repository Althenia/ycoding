# Screenshot review → implementation obligations

## Current supplied YCoding render

Image 02 is 1600×900 physical image pixels. The left panel is roughly x=20…762, y=20…880; the composer roughly x=780…1580, y=560…850. These are approximate visual measurements, not runtime Control rectangles or known logical coordinates. Together they obscure much of the scene. The filename contains `200`, but this is **not proof of the active UI scale or device ratio**.

Observed issues: the sidebar is a floating card rather than a disciplined application rail; large text and tall controls dominate; composer height/width is out of proportion to its small content; model text is truncated while large unused space remains; a top-right control extends beyond the image; ancillary input-row text has weak visibility; a synthetic-playback label is prominent. None establishes whether the unshown interactions work.

Do not replace the office artwork simply because the surrounding shell is wrong. The visible furniture/tiles may be reusable; assess source assets, animation and depth in the actual build.

## Reference-derived requirements

The general app/sidebar references show compact navigation, grouped sections, a contained footer and a restrained control scale. The composer reference separates the text entry from a lower action row and gives space to input. The settings reference uses a dedicated page with navigation and grouped, described rows. The effort reference demonstrates a compact model option, not a demand to implement a specific slider or model.

Translate those to YCoding: a normal-density shell, full-height office, bottom-centered composer, optional session/agent inspector, settings reached in one action, compact capability-driven controls. Keep scene and UI typography distinct.

## Comparison method

Capture unchanged and repaired app at the SAME physical window dimensions, logical content size, effective UI scale and world zoom. Compare component geometry separately from colors, then inspect focus/hover/open states. A still image cannot prove clickability, scrolling, movement, stream updates or persistence; record interaction evidence too.

Require normal/light/dark, 100/150/200% effective UI settings, the provided 1600×900 capture size, compact windows and fullscreen/restore. At larger UI settings, reflow/collapse rather than cancelling the user's accessibility choice. Inspect 03/05 controls at long model names and localized/long labels.

Use [templates/VISUAL_REVIEW.md](../templates/VISUAL_REVIEW.md) and the [verification cases](../contracts/verification-cases.json). Proposed numerical sizes in the UI spec are starting targets, not literal values extracted from another app.
