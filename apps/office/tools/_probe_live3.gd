extends SceneTree
func _init() -> void:
	var base := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--base="):
			base = a.substr(7)
	var t := HttpTransport.new()
	t.configure(base)
	var rid := t.stream("/api/event")
	print("stream id=", rid)
	var d := Time.get_ticks_msec() + 1500
	while Time.get_ticks_msec() < d:
		for e in t.poll(4):
			print("RAW: ", JSON.stringify(e).substr(0, 300))
	# now publish something with a second transport
	var t2 := HttpTransport.new()
	t2.configure(base)
	t2.request(HTTPClient.METHOD_POST, "/api/session", {"id": "ses_probe3"})
	var d2 := Time.get_ticks_msec() + 1500
	while Time.get_ticks_msec() < d2:
		t2.poll(4)
	t2.request(HTTPClient.METHOD_POST, "/api/session/ses_probe3/prompt", {"text": "hello there"})
	print("--- prompt posted, listening ---")
	var d3 := Time.get_ticks_msec() + 3000
	while Time.get_ticks_msec() < d3:
		for e in t.poll(4):
			print("RAW2: ", JSON.stringify(e).substr(0, 300))
	quit(0)
