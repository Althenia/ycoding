## User-interface text scale.
##
## The interface is authored in logical units at 1.0. A larger scale enlarges the
## text AND the panels together, because scaling only the fonts would overflow the
## controls that contain them.
##
## The scale is bounded rather than free: past the maximum the shell's own minimum
## widths exceed a typical window and a panel would be clipped, which would hide
## runtime state instead of enlarging it. A scale above the ceiling is therefore
## clamped, not honoured.
class_name UiScale
extends RefCounted

const MIN := 1.0
const MAX := 2.0

## The steps a user can choose between, coarsest last. 200% is the stated target,
## so it must be reachable exactly.
const STEPS := [1.0, 1.25, 1.5, 1.75, 2.0]


## A scale clamped into the supportable range.
##
## A non-finite or absurd request is clamped rather than rejected, so a corrupt
## stored preference still yields a usable interface.
static func clamp_scale(value: float) -> float:
	if is_nan(value) or is_inf(value):
		return MIN
	return clampf(value, MIN, MAX)


## The next step above the current scale, wrapping to the minimum past the top, so
## the control cycles rather than sticking at an end.
static func next_scale(current: float) -> float:
	var safe := clamp_scale(current)
	for step in STEPS:
		if step > safe + 0.001:
			return step
	return MIN


## The step index a scale sits on, or 0 when it sits between steps.
static func step_index(scale: float) -> int:
	var safe := clamp_scale(scale)
	for index in STEPS.size():
		if absf(STEPS[index] - safe) < 0.001:
			return index
	return 0


## Whether a requested scale is one this module would honour unchanged.
static func is_supported(scale: float) -> bool:
	return not is_nan(scale) and not is_inf(scale) and scale >= MIN and scale <= MAX
