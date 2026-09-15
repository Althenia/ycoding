## Measure the running office so resource claims are recorded rather than assumed.
##
## Reports frame time, draw-call count and process memory over a bounded run, and
## prints a compact trend so a leak or an unbounded queue shows up as a slope.
extends SceneTree
var _scene: Node
var _frames := 0
var _samples: Array = []
var _last := 0
func _initialize() -> void:
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	_last = Time.get_ticks_msec()
func _process(_d: float) -> bool:
	_frames += 1
	var now := Time.get_ticks_msec()
	var elapsed := now - _last
	_last = now
	# Ten samples spaced a second apart, so the trend covers a sustained run.
	if _frames % 60 == 0:
		_samples.append({
			"ms": elapsed,
			"draws": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
			"objects": Performance.get_monitor(Performance.OBJECT_COUNT),
			"static_mem": int(Performance.get_monitor(Performance.MEMORY_STATIC)),
		})
	var target := 60
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--samples="):
			target = int(a.substr(10))
	if _samples.size() < target:
		return false
	var times: Array = []
	for sample in _samples:
		times.append(float(sample["ms"]))
	times.sort()
	print("frames=", _frames)
	print("frame_ms p50=%.1f p95=%.1f max=%.1f" % [times[5], times[9], times[9]])
	print("draw_calls first=", _samples[0]["draws"], " last=", _samples[9]["draws"])
	print("objects first=", _samples[0]["objects"], " last=", _samples[9]["objects"])
	print("static_mem first_kb=", int(_samples[0]["static_mem"]) / 1024, " last_kb=", int(_samples[9]["static_mem"]) / 1024)
	quit(0)
	return true
