extends SceneTree


func _initialize() -> void:
	root.size = Vector2i(1024, 720)
	var title := Label.new()
	title.text = "Synthetic quota presentation check - not real account data"
	title.position = Vector2(16, 12)
	root.add_child(title)
	var panel := StatisticsPanel.new()
	root.add_child(panel)
	panel.position = Vector2(16, 44)
	panel.size = Vector2(992, 660)
	var page := QuotaPage.new()
	var unsupported := {
		"providerID": "synthetic-unsupported", "label": "Hidden fixture provider",
		"status": "unsupported", "source": "synthetic", "stability": "stable",
		"updatedAt": 1789800000000, "windows": [],
	}
	page.adopt([unsupported, {
		"providerID": "synthetic-supported", "label": "Visible fixture provider",
		"status": "available", "source": "synthetic", "stability": "stable",
		"updatedAt": 1789800000000,
		"windows": [{"id": "weekly", "label": "Weekly", "unit": "percent", "used": 25}],
	}])
	panel.adopt_quota(page)
	panel.show_tab(StatisticsPanel.TAB_QUOTA)
	var destination := ProjectSettings.globalize_path("res://../../ycoding-office-repair-kit/evidence/hide-unsupported")
	if DirAccess.make_dir_recursive_absolute(destination) != OK:
		quit(2)
		return
	for state in ["mixed", "unsupported-only"]:
		if state == "unsupported-only":
			page.adopt([unsupported])
			panel.adopt_quota(page)
		for frame in 5:
			await process_frame
		await RenderingServer.frame_post_draw
		var text := visible_text(panel)
		if text.contains("Hidden fixture provider") or (state == "mixed" and not text.contains("Visible fixture provider")):
			printerr("Quota visibility check failed: ", state)
			quit(1)
			return
		var error := root.get_texture().get_image().save_png(destination.path_join(state + ".png"))
		if error != OK:
			quit(2)
			return
		print("NATIVE QUOTA ", state, " PASS")
	panel.queue_free()
	title.queue_free()
	await process_frame
	quit(0)


func visible_text(node: Node) -> String:
	var result: String = node.text if node is Label else ""
	for child in node.get_children():
		result += " " + visible_text(child)
	return result
