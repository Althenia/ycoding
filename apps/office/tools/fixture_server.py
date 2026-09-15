#!/usr/bin/env python3
"""Local fixture service for the Godot office client's integration tests.

Serves the verified YCoding HTTP/SSE contract so the client can be exercised
without a live server. Python 3 standard library only; importing this module has
no side effects. Binds loopback only, and credentials come only from the
--password argument, never from files or the environment.

    python3 fixture_server.py --port 0
    python3 fixture_server.py --port 0 --password SECRET
    python3 fixture_server.py --selftest

Protocol reference: ycoding-godot-handoff/contracts/wire-audit.json.

SSE frames are exactly "data: <json>\\n\\n"; heartbeats are comment lines
(": keep-alive"). No id:, event:, or retry: field is ever emitted.
"""

import argparse
import base64
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

FIXTURE_VERSION = "fixture"
SESSION_TITLE = "Fixture session"
LOCATION_DIRECTORY = "/fixture/workspace"
CREATED_BASE_MS = 1_700_000_000_000
KEEP_ALIVE_SECONDS = 1.0
## How often the feed checks for newly published events.
PUSH_POLL_SECONDS = 0.01
AUTH_USERNAME = "ycoding"
WWW_AUTHENTICATE = 'Basic realm="Secure Area"'
STREAM_HEADERS = [
    ("content-type", "text/event-stream"),
    ("cache-control", "no-cache, no-transform"),
    ("x-accel-buffering", "no"),
    ("connection", "close"),
]


def sse_frame(payload):
    return ("data: " + json.dumps(payload, separators=(",", ":")) + "\n\n").encode("utf-8")


def keep_alive_comment(text="keep-alive"):
    return (": " + text + "\n\n").encode("utf-8")


def wait(seconds):
    threading.Event().wait(seconds)


def read_stream(url, password, seconds):
    """Read SSE frames for a bounded time. Returns the raw lines seen."""
    stream = open_stream(url, password, timeout=0.5)
    lines = []
    deadline = time.time() + seconds
    try:
        while time.time() < deadline:
            try:
                raw = stream.readline()
            except (TimeoutError, OSError):
                continue
            if not raw:
                break
            lines.append(raw.decode("utf-8", "replace").rstrip("\n"))
    finally:
        stream.close()
    return lines


class FixtureState:
    """Mutable fixture data. Every read and write takes the same lock."""

    def __init__(self, password=None):
        self.password = password
        self.source_epoch = "fixture-%d" % os.getpid()
        self.lock = threading.Lock()
        self.counter = 0
        self.sessions = {}
        self.active = {}
        # Live subscribers, mirroring the real server's feed: the connected frame
        # is written first, then every event published afterwards is pushed.
        self.subscribers = []

    def _next(self):
        self.counter += 1
        return self.counter

    def _now(self):
        return CREATED_BASE_MS + self.counter * 1000

    def _append_event(self, session_id, event_type, version, data):
        record = self.sessions[session_id]
        record["seq"] += 1
        event = {
            "id": "evt_%06d" % self._next(),
            "type": event_type,
            "created": self._now(),
            "sourceEpoch": self.source_epoch,
            "durable": {"aggregateID": session_id, "seq": record["seq"], "version": version},
            "data": data,
        }
        record["events"].append(event)
        for queue in list(self.subscribers):
            queue.append(event)
        return event

    def subscribe(self):
        with self.lock:
            queue = []
            self.subscribers.append(queue)
            return queue

    def unsubscribe(self, queue):
        with self.lock:
            if queue in self.subscribers:
                self.subscribers.remove(queue)

    def connected_event(self):
        with self.lock:
            return {
                "id": "evt_%06d" % self._next(),
                "type": "server.connected",
                "created": self._now(),
                "data": {},
                "sourceEpoch": self.source_epoch,
            }

    def create_session(self, requested_id=None):
        with self.lock:
            session_id = requested_id or "ses_%06d" % self._next()
            created = self._now()
            info = {
                "id": session_id,
                "projectID": "global",
                "cost": 0,
                "tokens": {
                    "input": 0,
                    "output": 0,
                    "reasoning": 0,
                    "cache": {"read": 0, "write": 0},
                },
                "time": {"created": created, "updated": created},
                "title": SESSION_TITLE,
                "location": {"directory": LOCATION_DIRECTORY},
            }
            self.sessions[session_id] = {"info": info, "messages": [], "events": [], "seq": 0}
            self._append_event(
                session_id,
                "session.created",
                2,
                {
                    "sessionID": session_id,
                    "projectID": "global",
                    "location": {"directory": LOCATION_DIRECTORY},
                    "title": SESSION_TITLE,
                    "created": created,
                },
            )
            return info

    def list_sessions(self):
        with self.lock:
            return [record["info"] for record in self.sessions.values()]

    def active_sessions(self):
        with self.lock:
            return dict(self.active)

    def snapshot(self, session_id):
        with self.lock:
            record = self.sessions.get(session_id)
            if record is None:
                return None
            return {
                "sourceEpoch": self.source_epoch,
                "session": record["info"],
                "messages": list(record["messages"]),
                "watermark": {"type": "log.synced", "aggregateID": session_id, "seq": record["seq"]},
            }

    def messages(self, session_id):
        with self.lock:
            record = self.sessions.get(session_id)
            if record is None:
                return None
            return list(record["messages"])

    def log_after(self, session_id, after):
        with self.lock:
            record = self.sessions.get(session_id)
            if record is None:
                return None
            events = [event for event in record["events"] if event["durable"]["seq"] > after]
            watermark = {"type": "log.synced", "aggregateID": session_id, "seq": record["seq"]}
            return events, watermark

    def switch_model(self, session_id, model):
        with self.lock:
            record = self.sessions.get(session_id)
            if record is None:
                return None
            record["info"]["model"] = dict(model)
            record["info"]["time"]["updated"] = self._now()
            return record["info"]

    def admit_prompt(self, session_id, payload):
        with self.lock:
            record = self.sessions.get(session_id)
            if record is None:
                return None
            text = payload["text"]
            delivery = payload.get("delivery") or "steer"
            message_id = payload.get("id") or "msg_%06d" % self._next()
            now = self._now()
            record["info"]["time"]["updated"] = now
            record["messages"].append(
                {
                    "id": message_id,
                    "type": "user",
                    "text": text,
                    "files": [],
                    "agents": [],
                    "time": {"created": now},
                }
            )
            event = self._append_event(
                session_id,
                "session.input.admitted",
                1,
                {
                    "sessionID": session_id,
                    "inputID": message_id,
                    "input": {"type": "user", "data": {"text": text}, "delivery": delivery},
                },
            )
            if payload.get("resume", True) is not False:
                self.active[session_id] = {"type": "running"}
            return {
                "admittedSeq": event["durable"]["seq"],
                "id": message_id,
                "sessionID": session_id,
                "timeCreated": now,
                "type": "user",
                "data": {"text": text},
                "delivery": delivery,
            }

    def interrupt(self, session_id):
        with self.lock:
            if session_id not in self.sessions:
                return False
            self.active.pop(session_id, None)
            return True


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "YCodingFixture/" + FIXTURE_VERSION

    def log_message(self, format, *args):
        pass

    # -- auth ---------------------------------------------------------------

    def _authorized(self):
        password = self.server.state.password
        if not password:
            return True
        header = self.headers.get("authorization", "")
        if not header.lower().startswith("basic "):
            return False
        try:
            decoded = base64.b64decode(header.split(None, 1)[1].strip(), validate=True).decode("utf-8")
        except Exception:
            return False
        username, _, supplied = decoded.partition(":")
        return username == AUTH_USERNAME and supplied == password

    def _require_auth(self):
        if self._authorized():
            return True
        body = json.dumps({"message": "Authentication required"}).encode("utf-8")
        self.send_response(401)
        self.send_header("www-authenticate", WWW_AUTHENTICATE)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return False

    # -- responses ----------------------------------------------------------

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _no_content(self):
        self.send_response(204)
        self.end_headers()

    def _open_stream(self):
        self.send_response(200)
        for name, value in STREAM_HEADERS:
            self.send_header(name, value)
        self.end_headers()

    def _write_frame(self, payload):
        self.wfile.write(sse_frame(payload))
        self.wfile.flush()

    def _write_comment(self, text):
        self.wfile.write(keep_alive_comment(text))
        self.wfile.flush()

    # -- request body -------------------------------------------------------

    def _read_json(self):
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return {}
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        return body if isinstance(body, dict) else None

    # -- routing ------------------------------------------------------------

    def do_GET(self):
        if not self._require_auth():
            return
        url = urlparse(self.path)
        state = self.server.state
        if url.path == "/api/health":
            return self._json(
                200,
                {
                    "healthy": True,
                    "version": FIXTURE_VERSION,
                    "pid": os.getpid(),
                    "sourceEpoch": state.source_epoch,
                },
            )
        if url.path == "/api/session/active":
            return self._json(200, {"data": state.active_sessions()})
        if url.path == "/api/session":
            return self._json(200, {"data": state.list_sessions(), "cursor": {}})
        if url.path == "/api/event":
            return self._event_stream()
        if url.path.startswith("/api/experimental/session/") and url.path.endswith("/log"):
            session_id = url.path[len("/api/experimental/session/") : -len("/log")]
            return self._log_stream(session_id, parse_qs(url.query))
        if url.path.startswith("/api/session/") and url.path.endswith("/snapshot"):
            return self._snapshot(url.path[len("/api/session/") : -len("/snapshot")])
        if url.path.startswith("/api/session/") and url.path.endswith("/message"):
            return self._messages(url.path[len("/api/session/") : -len("/message")])
        self._json(404, {"message": "Not found"})

    def do_POST(self):
        if not self._require_auth():
            return
        url = urlparse(self.path)
        state = self.server.state
        if url.path == "/api/session":
            body = self._read_json()
            if body is None:
                return self._json(400, {"message": "Invalid JSON body"})
            return self._json(200, {"data": state.create_session(body.get("id"))})
        if url.path.startswith("/api/session/") and url.path.endswith("/prompt"):
            session_id = url.path[len("/api/session/") : -len("/prompt")]
            body = self._read_json()
            if body is None:
                return self._json(400, {"message": "Invalid JSON body"})
            if not isinstance(body.get("text"), str):
                return self._json(400, {"message": "text is required"})
            admitted = state.admit_prompt(session_id, body)
            if admitted is None:
                return self._json(404, {"message": "Unknown session"})
            return self._json(200, {"data": admitted})
        if url.path.startswith("/api/session/") and url.path.endswith("/model"):
            session_id = url.path[len("/api/session/") : -len("/model")]
            body = self._read_json()
            if body is None:
                return self._json(400, {"message": "Invalid JSON body"})
            model = body.get("model")
            # Mirror the real route's contract: the payload is a Model.Ref with
            # id and providerID, and variant only when one was chosen.
            if not isinstance(model, dict) or not model.get("id") or not model.get("providerID"):
                return self._json(400, {"message": "model requires id and providerID"})
            switched = state.switch_model(session_id, model)
            if switched is None:
                return self._json(404, {"message": "Unknown session"})
            return self._json(200, {"data": switched})
        if url.path.startswith("/api/session/") and url.path.endswith("/interrupt"):
            session_id = url.path[len("/api/session/") : -len("/interrupt")]
            if not state.interrupt(session_id):
                return self._json(404, {"message": "Unknown session"})
            return self._no_content()
        self._json(404, {"message": "Not found"})

    # -- session-scoped reads ----------------------------------------------

    def _snapshot(self, session_id):
        projection = self.server.state.snapshot(session_id)
        if projection is None:
            return self._json(404, {"message": "Unknown session"})
        self._json(200, projection)

    def _messages(self, session_id):
        messages = self.server.state.messages(session_id)
        if messages is None:
            return self._json(404, {"message": "Unknown session"})
        self._json(200, {"data": messages})

    # -- streams ------------------------------------------------------------

    def _event_stream(self):
        queue = self.server.state.subscribe()
        self._open_stream()
        try:
            self._write_frame(self.server.state.connected_event())
            idle = 0.0
            while True:
                # Push promptly: a published event must not wait for the keep-alive
                # interval, or a client would see it up to a second late.
                drained = False
                while queue:
                    self._write_frame(queue.pop(0))
                    drained = True
                if drained:
                    idle = 0.0
                    continue
                wait(PUSH_POLL_SECONDS)
                idle += PUSH_POLL_SECONDS
                if idle >= KEEP_ALIVE_SECONDS:
                    self._write_comment("keep-alive")
                    idle = 0.0
        except OSError:
            return
        finally:
            self.server.state.unsubscribe(queue)

    def _log_stream(self, session_id, query):
        state = self.server.state
        after = self._int_param(query, "after", 0)
        follow = self._bool_param(query, "follow")
        replay = state.log_after(session_id, after)
        if replay is None:
            return self._json(404, {"message": "Unknown session"})
        events, watermark = replay
        self._open_stream()
        try:
            for event in events:
                self._write_frame(event)
            self._write_frame(watermark)
            if not follow:
                return
            cursor = watermark["seq"]
            while True:
                wait(KEEP_ALIVE_SECONDS)
                live = state.log_after(session_id, cursor)
                if live is None:
                    return
                new_events, _ = live
                if not new_events:
                    self._write_comment("keep-alive")
                    continue
                for event in new_events:
                    self._write_frame(event)
                cursor = new_events[-1]["durable"]["seq"]
        except OSError:
            return

    def _int_param(self, query, name, default):
        values = query.get(name)
        if not values:
            return default
        try:
            return int(values[0])
        except ValueError:
            return default

    def _bool_param(self, query, name):
        values = query.get(name)
        if not values:
            return False
        return values[0].lower() in ("1", "true", "yes", "on")


# -- process entry points ---------------------------------------------------


def start_server(port, password=None):
    server = ThreadingHTTPServer(("127.0.0.1", port), FixtureHandler)
    server.state = FixtureState(password)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


# -- selftest ---------------------------------------------------------------


def basic_auth(password):
    return "Basic " + base64.b64encode((AUTH_USERNAME + ":" + password).encode("utf-8")).decode("ascii")


def decode_json(raw):
    if not raw:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def request(method, url, password=None, payload=None, timeout=10):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"
    if password is not None:
        headers["authorization"] = basic_auth(password)
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.headers, decode_json(response.read())
    except urllib.error.HTTPError as error:
        return error.code, error.headers, decode_json(error.read())


def open_stream(url, password=None, timeout=10):
    headers = {}
    if password is not None:
        headers["authorization"] = basic_auth(password)
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers, method="GET"), timeout=timeout)


def read_frame_lines(stream):
    lines = []
    while True:
        raw = stream.readline()
        if not raw:
            break
        line = raw.decode("utf-8").rstrip("\r\n")
        if line == "":
            break
        lines.append(line)
    return lines


def run_selftest():
    password = "selftest-secret"
    server = start_server(0, password)
    base = "http://127.0.0.1:%d" % server.server_address[1]
    results = []

    def record(name, passed, detail=""):
        results.append(passed)
        print("%s %s%s" % ("PASS" if passed else "FAIL", name, (" - " + detail) if detail else ""))

    try:
        status, headers, health = request("GET", base + "/api/health", password)
        epoch = health.get("sourceEpoch")
        record(
            "health",
            status == 200 and health.get("healthy") is True and isinstance(epoch, str) and bool(epoch),
            "status=%s body=%s" % (status, health),
        )

        status, headers, _ = request("GET", base + "/api/health")
        challenge = headers.get("www-authenticate")
        authed_status, _, _ = request("GET", base + "/api/health", password)
        record(
            "auth",
            status == 401 and bool(challenge) and authed_status == 200,
            "unauth=%s challenge=%r authed=%s" % (status, challenge, authed_status),
        )

        _, _, created = request("POST", base + "/api/session", password, {})
        session_id = created.get("data", {}).get("id")
        if not isinstance(session_id, str) or not session_id:
            record("session-create", False, "body=%s" % created)
            session_id = "ses_missing"
        else:
            record("session-create", True)

        status, _, _ = request("POST", base + "/api/session/%s/prompt" % session_id, password, {"text": "fixture prompt"})
        record("prompt admitted", status == 200, "status=%s" % status)
        status, _, switched = request(
            "POST",
            base + "/api/session/%s/model" % session_id,
            password,
            {"model": {"providerID": "openrouter", "id": "deepseek/deepseek-v4.1-flash", "variant": "high"}},
        )
        record("model switch accepted", status == 200, "status=%s" % status)
        record(
            "model switch is durable",
            switched.get("data", {}).get("model", {}).get("id") == "deepseek/deepseek-v4.1-flash",
            "body=%s" % switched,
        )
        status, _, _ = request(
            "POST",
            base + "/api/session/%s/model" % session_id,
            password,
            {"model": {"id": "no-provider"}},
        )
        record("model switch rejects an incomplete ref", status == 400, "status=%s" % status)

        # The feed must deliver events published after a client subscribes. A feed
        # that only ever sends the connected frame looks identical to a working one
        # until something needs to arrive live.
        live_lines = []
        reader = threading.Thread(
            target=lambda: live_lines.extend(read_stream(base + "/api/event", password, 4)),
            daemon=True,
        )
        reader.start()
        wait(0.3)
        request("POST", base + "/api/session/%s/prompt" % session_id, password, {"text": "live push"})
        reader.join(timeout=5)
        record(
            "feed delivers events published after subscribing",
            any("session.input.admitted" in line for line in live_lines),
            "lines=%d" % len(live_lines),
        )

        status, _, snapshot = request("GET", base + "/api/session/%s/snapshot" % session_id, password)
        watermark = snapshot.get("watermark", {})
        record(
            "snapshot",
            status == 200
            and isinstance(snapshot.get("sourceEpoch"), str)
            and isinstance(snapshot.get("messages"), list)
            and watermark.get("type") == "log.synced"
            and watermark.get("aggregateID") == session_id,
            "status=%s body=%s" % (status, snapshot),
        )

        status, _, active = request("GET", base + "/api/session/active", password)
        record(
            "session-active",
            status == 200 and active.get("data", {}).get(session_id) == {"type": "running"},
            "status=%s body=%s" % (status, active),
        )

        stream = open_stream(base + "/api/event", password)
        frame_lines = read_frame_lines(stream)
        stream.close()
        connected = None
        framing_ok = bool(frame_lines)
        for line in frame_lines:
            if line.startswith("data: "):
                connected = decode_json(line[len("data: ") :].encode("utf-8"))
            elif line.startswith("id:") or line.startswith("retry:") or line.startswith("event:"):
                framing_ok = False
        record(
            "event-stream",
            framing_ok and isinstance(connected, dict) and connected.get("type") == "server.connected",
            "lines=%r" % (frame_lines,),
        )

        stream = open_stream(base + "/api/experimental/session/%s/log?after=0" % session_id, password)
        raw = stream.read().decode("utf-8")
        stream.close()
        items = [
            decode_json(line[len("data: ") :].encode("utf-8"))
            for line in raw.splitlines()
            if line.startswith("data: ")
        ]
        events = [item for item in items if item.get("type") != "log.synced"]
        record(
            "log-replay",
            bool(events) and bool(items) and items[-1].get("type") == "log.synced" and items[-1].get("aggregateID") == session_id,
            "frames=%s" % (items,),
        )

        status, _, _ = request("POST", base + "/api/session/%s/interrupt" % session_id, password)
        record("interrupt", status == 204, "status=%s" % status)
    finally:
        server.shutdown()
        server.server_close()

    passed = sum(1 for result in results if result)
    print("SELFTEST %s (%d/%d)" % ("PASSED" if passed == len(results) else "FAILED", passed, len(results)))
    return 0 if passed == len(results) else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local YCoding fixture server for office-client integration tests.")
    parser.add_argument("--port", type=int, default=0, help="TCP port; 0 binds an ephemeral loopback port")
    parser.add_argument("--password", default=None, help="require HTTP Basic auth with this password")
    parser.add_argument("--selftest", action="store_true", help="run the acceptance selftest and exit")
    args = parser.parse_args(argv)

    if args.selftest:
        return run_selftest()

    server = start_server(args.port, args.password)
    print("fixture server listening on http://127.0.0.1:%d" % server.server_address[1], flush=True)
    try:
        while True:
            wait(3600.0)
    except KeyboardInterrupt:
        return 0
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
