extends SceneTree
func _init() -> void:
	var base := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--base="):
			base = a.substr(7)
	var t := HttpTransport.new()
	t.configure(base)
	var rid := t.request(HTTPClient.METHOD_POST, "/api/session", {"id": "ses_probe"})
	print("create request id=", rid)
	var deadline := Time.get_ticks_msec() + 3000
	var done := false
	while Time.get_ticks_msec() < deadline and not done:
		for e in t.poll(4):
			print("  create entry kind=", e.get("kind"), " status=", e.get("status"), " body=", str(e.get("body")).substr(0,120))
			if str(e.get("kind","")) == "response":
				done = true
	print("create settled=", done)
	quit(0)
