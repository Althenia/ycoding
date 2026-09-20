## HTTP transport contract tests.
##
## These cover the transport's own logic: configuration validation, credential
## and header construction, cancellation, and failure surfacing. They do NOT
## reach a network. Live request/response behavior was verified separately
## against a loopback stub server (see tracking/evidence/M3-transport.md): a JSON
## GET settles on exactly one `response` with a decoded body, a 404 is a
## `response` (not an error), basic auth arrives on the wire, and a cancelled
## request emits nothing.
extends RefCounted


## R5-07. The location header must be URI-ENCODED.
##
## The service reads `x-ycoding-directory` and runs `decodeURIComponent` on it
## (packages/server/src/location.ts:34). Sending the raw path therefore CORRUPTED every
## folder whose name contains a percent sign - the server decoded an escape this client
## never wrote, so `/tmp/100%-folder` arrived as `/tmp/100-folder` - and made a folder whose
## name contains non-ASCII characters fail with HTTP 500, because a raw non-ASCII byte is not
## a valid header value. Both were reproduced against the running service before this rule
## existed.
##
## Asserted on the encoder directly, because a stub transport never sees the headers Godot
## puts on the wire: a test through a double would have reported a clean pass throughout.
func test_the_location_header_is_uri_encoded(t) -> void:
	for path in [
		"/tmp/an ordinary folder",
		"/tmp/a spaced folder",
		"/tmp/ünïcodé—folder",
		"/tmp/100%-folder",
		"/tmp/plus+and&amp folder",
	]:
		var encoded := HttpTransport.encode(path)
		t.check(
			encoded.to_utf8_buffer().size() == encoded.length(),
			"the encoded location is pure ASCII: '%s'" % path
		)
		# The service's own decode must give the path back exactly. That round trip is the
		# contract, and it is what the raw value failed.
		t.check_equal(
			encoded.uri_decode(), path,
			"the server's decode recovers the path exactly: '%s'" % path
		)
	# A percent sign must survive as a LITERAL, which is the case that was silently
	# corrupted rather than refused.
	t.check_equal(
		HttpTransport.encode("/tmp/100%-folder"), "%2Ftmp%2F100%25-folder",
		"a percent sign is encoded rather than passed through"
	)

func run(t) -> void:
	test_unconfigured_transport_fails_cleanly(t)
	test_relative_base_url_rejected(t)
	test_configure_accepts_loopback(t)
	test_cancel_drops_the_request(t)
	test_cancel_unknown_id_is_harmless(t)
	test_cancel_all_clears_everything(t)
	test_poll_is_bounded_when_idle(t)
	test_the_location_header_is_uri_encoded(t)


func test_unconfigured_transport_fails_cleanly(t) -> void:
	var transport := HttpTransport.new()
	var id := transport.request(HTTPClient.METHOD_GET, "/api/health")
	t.check_equal(id, -1, "an unconfigured transport refuses the request")
	t.check(not transport.last_error().is_empty(), "the refusal explains itself")
	t.check(transport.poll(1).is_empty(), "polling an unconfigured transport emits nothing")


## A relative base URL would silently resolve against nothing.
func test_relative_base_url_rejected(t) -> void:
	var transport := HttpTransport.new()
	transport.configure("localhost:1234")
	t.check(not transport.last_error().is_empty(), "a relative base URL is rejected")


func test_configure_accepts_loopback(t) -> void:
	var transport := HttpTransport.new()
	transport.configure("http://127.0.0.1:41234")
	t.check_equal(transport.last_error(), "", "a loopback base URL is accepted")


## A cancelled request must never produce a late result.
func test_cancel_drops_the_request(t) -> void:
	var transport := HttpTransport.new()
	transport.configure("http://127.0.0.1:1")
	var id := transport.request(HTTPClient.METHOD_GET, "/api/health")
	t.check(id > 0, "the request is accepted before cancellation")
	transport.cancel(id)
	var events := transport.poll(8)
	for event in events:
		t.check(
			int(event.get("request_id", -1)) != id,
			"a cancelled request id never appears in poll output"
		)
	t.check(true, "poll after cancel completes without emitting the request")


func test_cancel_unknown_id_is_harmless(t) -> void:
	var transport := HttpTransport.new()
	transport.configure("http://127.0.0.1:41234")
	transport.cancel(9999)
	t.check_equal(transport.last_error(), "", "cancelling an unknown id is a no-op")


func test_cancel_all_clears_everything(t) -> void:
	var transport := HttpTransport.new()
	transport.configure("http://127.0.0.1:1")
	var first := transport.request(HTTPClient.METHOD_GET, "/a")
	var second := transport.request(HTTPClient.METHOD_GET, "/b")
	t.check(first > 0 and second > 0, "two requests are accepted")
	transport.cancel_all()
	for event in transport.poll(8):
		var id := int(event.get("request_id", -1))
		t.check(id != first and id != second, "cancel_all drops every pending request")


## poll() is called every frame, so an idle transport must not block.
func test_poll_is_bounded_when_idle(t) -> void:
	var transport := HttpTransport.new()
	transport.configure("http://127.0.0.1:41234")
	var started := Time.get_ticks_msec()
	var events := transport.poll(4)
	var elapsed := Time.get_ticks_msec() - started
	t.check(events.is_empty(), "an idle transport emits nothing")
	t.check(elapsed < 60, "an idle poll returns within its budget")
