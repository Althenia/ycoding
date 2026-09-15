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
	live.failure.connect(func(m: String): print("FAILURE: ", m))
	live.play()
	var d := Time.get_ticks_msec() + 2000
	while Time.get_ticks_msec() < d:
		live.advance(0)
	print("after play: connected events=", events.size())
	for e in events:
		print("  ", e.get("type"), " epoch=", e.get("sourceEpoch", ""))
	var t := HttpTransport.new()
	t.configure(base)
	t.request(HTTPClient.METHOD_POST, "/api/session", {"id": "ses_probe2"})
	var d2 := Time.get_ticks_msec() + 2000
	while Time.get_ticks_msec() < d2:
		t.poll(4)
	print("session created; submitting prompt")
	var reason := live.submit_prompt("ses_probe2", "probe text", "msg_probe_1")
	print("submit reason='", reason, "'")
	var d3 := Time.get_ticks_msec() + 4000
	while Time.get_ticks_msec() < d3:
		live.advance(0)
		for e in events:
			if str(e.get("type","")) == "session.input.admitted":
				print("ADMITTED: ", e.get("data"))
				quit(0); return
	print("NOT ADMITTED. total events=", events.size())
	for e in events:
		print("  seen: ", e.get("type"))
	quit(1)
