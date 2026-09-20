## Lane U measurement probe 2: fresh instances only, because a Control caches its
## combined minimum and does not revalidate inside a headless _init run.
extends SceneTree


func _init() -> void:
	print("=== lane U measure probe 2 ===")
	_button("plain", false, 0)
	_button("clip", true, 0)
	_button("overrun", false, int(TextServer.OVERRUN_TRIM_ELLIPSIS))
	_label("plain", false, false)
	_label("clip", true, false)
	_plain_control_host()
	quit(0)


func _button(tag: String, clip: bool, overrun: int) -> void:
	var button := Button.new()
	button.flat = true
	button.text = "YCoding Office  \u2304"
	button.clip_text = clip
	if overrun != 0:
		button.text_overrun_behavior = overrun
	print("button %-8s %s" % [tag, button.get_combined_minimum_size()])


func _label(tag: String, clip: bool, overrun: bool) -> void:
	var label := Label.new()
	label.text = "reception /Users/somebody/Workspace/Project/long/path"
	label.clip_text = clip
	print("label  %-8s %s" % [tag, label.get_combined_minimum_size()])


## A plain Control host reports no minimum of its own, so wrapping a row in one is
## a candidate way to keep a long label from inflating the panel.
func _plain_control_host() -> void:
	var host := Control.new()
	host.clip_contents = true
	var child := Label.new()
	child.text = "reception /Users/somebody/Workspace/Project/long/path"
	host.add_child(child)
	print("plain host      %s (child %s)" % [host.get_combined_minimum_size(), child.get_combined_minimum_size()])
