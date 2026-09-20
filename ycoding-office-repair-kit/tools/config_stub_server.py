#!/usr/bin/env python3
"""Throwaway configuration stub service for the office client's config tests.

Serves ONLY the `server.config` contract so the client's real HTTP path (headers,
basic auth, JSON body, `Location.response` wrapper) can be exercised without a live
server. Python 3 standard library only, binds loopback only, no persistence.

It is deliberately NOT the shared `apps/office/tools/fixture_server.py`: that file is
owned elsewhere and is a release-gate fixture. This is a throwaway harness for R3-02
and it lives in the repair kit.

    python3 config_stub_server.py --port 0
    python3 config_stub_server.py --selftest

Contract source: packages/protocol/src/groups/config.ts and
specs/v2/configuration-api.md.
"""

import argparse
import base64
import json
import os
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

AUTH_USERNAME = "ycoding"
WWW_AUTHENTICATE = 'Basic realm="Secure Area"'
REDACTED = "[redacted]"

# The global revision the stub reports. A commit must present this back or is refused,
# which is what makes the stale-revision path reachable.
GLOBAL_REVISION = "g" * 64


class ConfigState:
    """The stub's effective configuration, with one withheld value."""

    def __init__(self):
        self.revision = GLOBAL_REVISION
        self.values = {
            # A value only the global document defines.
            "autoupdate": "notify",
            "shell": "/bin/zsh",
            # A value owned by a document with no file path: not writable.
            "username": REDACTED,
            "share": "manual",
            "instruction_max_bytes": 65536,
        }
        self.sources = [
            {
                "path": "/stub/global/ycoding.jsonc",
                "scope": "global",
                "keys": ["autoupdate", "shell", "share", "instruction_max_bytes"],
                "revision": GLOBAL_REVISION,
            },
            {
                "path": "",
                "scope": "virtual",
                "keys": ["username"],
                "revision": "v" * 64,
            },
        ]
        # Every commit the stub accepted, so a test can assert nothing was written when
        # it should not have been.
        self.commits = []
        # When set, the next preview/commit is refused with this message, so the refusal
        # path is reachable without a broken server.
        self.refuse_next = None

    def read_payload(self):
        return {"values": dict(self.values), "sources": [dict(s) for s in self.sources]}

    def sync_source_revisions(self):
        """Make the global source report the CURRENT revision.

        A real document's revision is the digest of its bytes, so it changes when the
        document changes. A stub whose source list kept a hardcoded revision would hand
        back a guard that is already stale after its own commit - which is a defect in
        the STUB, not in a client that trusts the read.
        """
        for source in self.sources:
            if source["scope"] == "global":
                source["revision"] = self.revision

    def location_payload(self, data):
        return {
            "location": {"directory": "/stub/project", "workspaceID": None, "project": None},
            "data": data,
        }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ycoding-config-stub"

    def log_message(self, fmt, *args):
        pass

    # -- plumbing -----------------------------------------------------------

    def _authorized(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8")
        except Exception:
            return False
        return decoded == "%s:%s" % (AUTH_USERNAME, self.server.password)

    def _require_auth(self):
        if self._authorized():
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", WWW_AUTHENTICATE)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            return None
        return body if isinstance(body, dict) else None

    # -- routing ------------------------------------------------------------

    def do_GET(self):
        if not self._require_auth():
            return
        url = urlparse(self.path)
        state = self.server.state
        if url.path == "/api/config":
            if state.refuse_next:
                message = state.refuse_next
                state.refuse_next = None
                return self._json(400, {"message": message, "_tag": "ConfigInvalidError"})
            state.sync_source_revisions()
            return self._json(200, state.location_payload(state.read_payload()))
        self._json(404, {"message": "Not found"})

    def do_POST(self):
        if not self._require_auth():
            return
        url = urlparse(self.path)
        state = self.server.state
        if url.path == "/api/config/preview":
            return self._preview_or_commit(state, commit=False)
        self._json(404, {"message": "Not found"})

    def do_PUT(self):
        if not self._require_auth():
            return
        url = urlparse(self.path)
        state = self.server.state
        if url.path == "/api/config":
            return self._preview_or_commit(state, commit=True)
        self._json(404, {"message": "Not found"})

    def _preview_or_commit(self, state, commit):
        body = self._read_json()
        if body is None:
            return self._json(400, {"message": "Invalid JSON body", "_tag": "ConfigInvalidError"})
        if state.refuse_next:
            message = state.refuse_next
            state.refuse_next = None
            return self._json(400, {"message": message, "_tag": "ConfigInvalidError"})
        scope = body.get("scope")
        # The contract: scope is `global` or `project` only.
        if scope not in ("global", "project"):
            return self._json(
                400,
                {
                    "message": "Scope %r has no configuration document to write." % scope,
                    "_tag": "ConfigInvalidError",
                },
            )
        patch = body.get("patch")
        if not isinstance(patch, dict):
            return self._json(400, {"message": "patch is required", "_tag": "ConfigInvalidError"})
        expected = body.get("expectedRevision")
        if expected is not None and expected != state.revision:
            return self._json(
                400,
                {
                    "message": "Configuration changed since revision %s; re-read and retry."
                    % str(expected)[:12],
                    "path": "/stub/global/ycoding.jsonc",
                    "_tag": "ConfigInvalidError",
                },
            )
        changes = [{"key": k, "value": v} for k, v in patch.items()]
        if not commit:
            return self._json(
                200,
                state.location_payload(
                    {
                        "scope": scope,
                        "path": "/stub/global/ycoding.jsonc",
                        "revision": state.revision,
                        "result": "r" * 64,
                        "changes": changes,
                    }
                ),
            )
        state.commits.append({"scope": scope, "patch": patch, "expected": expected})
        for key, value in patch.items():
            if value is None:
                state.values.pop(key, None)
            else:
                state.values[key] = value
        state.revision = "c" * 64
        state.sync_source_revisions()
        return self._json(
            200,
            state.location_payload(
                {
                    "scope": scope,
                    "path": "/stub/global/ycoding.jsonc",
                    "revision": state.revision,
                    "changes": changes,
                    "unsettled": [],
                    "read": state.read_payload(),
                }
            ),
        )


def serve(password="", port=0):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.password = password
    httpd.state = ConfigState()
    return httpd


def selftest():
    import urllib.error

    httpd = serve(password="stub-pass")
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    auth = base64.b64encode(b"ycoding:stub-pass").decode()

    def call(method, path, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(base + path, data=data, method=method)
        request.add_header("Authorization", "Basic " + auth)
        request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode())

    failures = []
    status, body = call("GET", "/api/config")
    if status != 200 or "location" not in body or "data" not in body:
        failures.append("read is not wrapped as {location, data}")
    if body.get("data", {}).get("values", {}).get("username") != REDACTED:
        failures.append("a withheld value is not reported as redacted")

    status, _ = call("POST", "/api/config/preview", {"patch": {"shell": "/bin/sh"}, "scope": "session"})
    if status != 400:
        failures.append("a session scope was not refused")

    status, body = call("POST", "/api/config/preview", {"patch": {"shell": "/bin/sh"}, "scope": "global"})
    if status != 200 or body.get("data", {}).get("revision") != GLOBAL_REVISION:
        failures.append("preview did not report the validated revision")

    status, _ = call("PUT", "/api/config", {"patch": {"shell": "/bin/sh"}, "scope": "global",
                                            "expectedRevision": "stale"})
    if status != 400:
        failures.append("a stale revision was not refused")
    if httpd.state.commits:
        failures.append("a refused commit was recorded as written")

    status, body = call("PUT", "/api/config", {"patch": {"shell": "/bin/sh"}, "scope": "global",
                                               "expectedRevision": GLOBAL_REVISION})
    if status != 200 or body.get("data", {}).get("read", {}).get("values", {}).get("shell") != "/bin/sh":
        failures.append("a commit did not return the settled readback")
    if len(httpd.state.commits) != 1:
        failures.append("the accepted commit was not recorded once")

    # After a write the reported revision must CHANGE, and a fresh read must hand back the
    # NEW one. A stub whose source list kept the original revision would give a client a
    # guard that is stale the moment it commits - the defect this case exists to catch.
    status, body = call("GET", "/api/config")
    sources = body.get("data", {}).get("sources", [])
    global_revision = next((s.get("revision") for s in sources if s.get("scope") == "global"), None)
    if global_revision != "c" * 64:
        failures.append("a read after a commit still reports the OLD revision (%r)" % global_revision)
    status, body = call("PUT", "/api/config", {"patch": {"share": "auto"}, "scope": "global",
                                               "expectedRevision": global_revision})
    if status != 200:
        failures.append("a commit guarded by the revision a fresh read reported was refused")

    httpd.shutdown()
    if failures:
        print("SELFTEST FAILED:")
        for failure in failures:
            print("  " + failure)
        return 1
    print("SELFTEST PASSED: read/preview/commit, redaction, scope refusal, stale revision.")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--password", default="")
    parser.add_argument("--selftest", action="store_true")
    options = parser.parse_args()
    if options.selftest:
        sys.exit(selftest())
    server = serve(options.password, options.port)
    print("config stub listening on http://127.0.0.1:%d" % server.server_address[1], flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass