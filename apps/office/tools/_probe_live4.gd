extends SceneTree
func _init() -> void:
	var base := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--base="):
			base = a.substr(7)
	var live := LiveTransport.new()
	live.configure(base)
	var events: Array = []
	live.event_ready.connect(func(e: Dictionary): events.append(e))
	live.play()
	var d := Time.get_ticks_msec() + 2000
	while Time.get_ticks_msec() < d:
		live.advance(0)
	var t := HttpTransport.new()
	t.configure(base)
	t.request(HTTPClient.METHOD_POST, "/api/session", {"id": "ses_probe4"})
	var d2 := Time.get_ticks_msec() + 1500
	while Time.get_ticks_msec() < d2:
		t.poll(4)
	live.submit_prompt("ses_probe4", "probe text", "msg_probe_1")
	var d3 := Time.get_ticks_msec() + 4000
	while Time.get_ticks_msec() < d3:
		live.advance(0)
	for e in events:
		if str(e.get("type","")) == "session.input.admitted":
			print("ADMITTED inputID=", e.get("data",{}).get("inputID"))
			quit(0); return
	print("NOT ADMITTED. types=", events.map(func(e): return e.get("type")))
	quit(1)
