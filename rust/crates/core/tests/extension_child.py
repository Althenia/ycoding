import os
import struct
import sys
import time
import json

mode = sys.argv[1]
with open("extension-child.pid", "w") as pid_file:
    pid_file.write(str(os.getpid()))


def varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def integer(tag, value):
    return varint(tag << 3) + varint(value)


def field(tag, value):
    if isinstance(value, str):
        value = value.encode()
    return varint((tag << 3) | 2) + varint(len(value)) + value


def fields(data):
    def number(offset):
        value = 0
        shift = 0
        while True:
            byte = data[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value, offset
            shift += 7

    offset = 0
    result = {}
    while offset < len(data):
        key, offset = number(offset)
        if key & 7 == 0:
            value, offset = number(offset)
        elif key & 7 == 1:
            value = data[offset:offset + 8]
            offset += 8
        elif key & 7 == 2:
            count, offset = number(offset)
            value = data[offset:offset + count]
            offset += count
        else:
            raise ValueError("fixture wire type")
        result.setdefault(key >> 3, []).append(value)
    return result


def read():
    header = sys.stdin.buffer.read(4)
    if not header:
        sys.exit(0)
    count = struct.unpack("<I", header)[0]
    return fields(sys.stdin.buffer.read(count))


def send(tag, body, generation=None):
    data = field(1, generation or gen) + field(tag, body)
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def value(data):
    if data is None:
        return field(1, b"")
    if isinstance(data, bool):
        return integer(2, int(data))
    if isinstance(data, (int, float)):
        return varint(3 << 3 | 1) + struct.pack("<d", data)
    if isinstance(data, str):
        try:
            text = field(1, data)
        except UnicodeEncodeError:
            text = field(2, data.encode("utf-16-le", "surrogatepass"))
        return field(4, text)
    if isinstance(data, list):
        return field(5, b"".join(field(1, value(item)) for item in data))
    return field(6, b"".join(field(1, field(1, fields(value(key))[4][0]) + field(2, value(item))) for key, item in data.items()))


def read_value(data):
    data = fields(data)
    if 1 in data:
        return None
    if 2 in data:
        return bool(data[2][0])
    if 3 in data:
        return struct.unpack("<d", data[3][0])[0]
    if 4 in data:
        text = fields(data[4][0])
        return text[1][0].decode() if 1 in text else text[2][0].decode("utf-16-le", "surrogatepass")
    if 5 in data:
        return [read_value(item) for item in fields(data[5][0]).get(1, [])]
    result = {}
    for entry in fields(data[6][0]).get(1, []):
        entry = fields(entry)
        result[read_value(field(4, entry[1][0]))] = read_value(entry[2][0])
    return result


def host_call(call, request, tag, body):
    send(13, field(1, call) + integer(2, request) + field(tag, body))
    while True:
        frame = read()
        if 8 in frame:
            reply = fields(frame[8][0])
            if 3 in reply:
                return {"value": read_value(reply[3][0])}
            return {"failure": fields(reply[4][0])[1][0]}


def oauth_credential(access):
    return {"type": "oauth", "methodID": "acme-login", "refresh": "refresh-token", "access": access, "expires": 9000000}


hello = fields(read()[2][0])
gen = hello[3][0]
identity = hello[2][0]
if mode.startswith("lifecycle"):
    with open(sys.argv[2], "a") as journal:
        journal.write(json.dumps({"event": "start", "id": identity.decode(), "pid": os.getpid()}) + "\n")
    if mode == "lifecycle_once":
        marker = sys.argv[2] + ".once"
        if os.path.exists(marker):
            sys.exit(1)
        with open(marker, "w") as file:
            file.write("started")
    if mode == "lifecycle_gate":
        import socket
        with socket.socket(socket.AF_UNIX) as gate:
            gate.connect(sys.argv[3])
            gate.sendall(b"started")
            gate.recv(1)
if mode == "startup_timeout":
    time.sleep(30)
if mode == "oversized":
    sys.stdout.buffer.write(struct.pack("<I", 1048577))
    sys.stdout.buffer.flush()
    time.sleep(30)
if mode == "truncated":
    sys.stdout.buffer.write(struct.pack("<I", 100) + b"\x0a\x01x")
    sys.stdout.buffer.flush()
    sys.exit(0)
if mode == "malformed":
    sys.stdout.buffer.write(struct.pack("<I", 1) + b"\x80")
    sys.stdout.buffer.flush()
    sys.exit(0)
if mode == "secret":
    sys.stderr.write("SYNTHETIC_SECRET_DO_NOT_EXPOSE\n")
    sys.stderr.flush()
send(2, integer(1, 4 if mode in ["mismatch", "lifecycle_fail"] else 5) + field(2, identity) + field(3, gen))
schema = field(6, field(1, field(1, field(1, "type")) + field(2, field(4, field(1, "object")))))
name = "unauthorized" if mode == "unauthorized" else "echo"
tool = field(1, identity if mode.startswith("lifecycle") else "demo") + field(2, name) + field(3, field(1, "Fixture tool")) + field(4, schema) + field(5, schema) + integer(6, 1) + integer(7, 1)
if mode == "bad_schema":
    tool = field(1, "demo") + field(2, name) + field(3, field(1, "Fixture tool")) + field(4, field(1, b"")) + field(5, schema) + integer(6, 1) + integer(7, 1)
batch = field(1, tool) + (field(1, tool) if mode == "duplicate_registration" else b"")
family_mode = mode.startswith("family")
if family_mode:
    with open(sys.argv[2]) as records_file:
        records = json.load(records_file)
    for stage in [1, 2, 3, 4, 5, 6, 7, 8, 9]:
        batch += field(2, field(1, f"stage-{stage}") + integer(2, stage))
    for record in records:
        batch += field(3, integer(1, record["domain"]) + field(2, record["key"]) + field(3, value(record["value"])))
    subscription_count = 9 if mode == "family_nine_subscriptions" else 8 if mode == "family_quota" else 1
    for subscription in range(1, subscription_count + 1):
        batch += field(4, integer(1, subscription) + field(2, "credential.changed" if mode == "family_bad_subscription" else "agent.updated"))
if mode.startswith("auth"):
    registered = "other" if mode == "auth_ungranted" else "acme"
    method = {"type": "oauth", "id": "acme-login", "label": "Acme"}
    batch += field(5, field(1, registered) + field(2, value(method)) + integer(3, 1) + integer(4, 1))
send(3, batch)
if mode == "auth_unknown_reply":
    send(14, integer(1, 999) + field(5, b""))
if mode == "mcp_unowned_call":
    unowned = integer(1, 777) + field(2, "ses_tool") + field(3, "msg_tool") + field(4, field(1, "call_tool")) + field(5, "test")
    send(13, field(1, unowned) + integer(2, 1) + field(3, b""))
if mode == "unsolicited":
    send(6, field(1, integer(1, 777) + field(2, "ses_tool") + field(3, "msg_tool") + field(4, field(1, "call_tool")) + field(5, "test")))
if mode == "family_unsubscribe":
    send(11, integer(1, 1))
if mode == "family_unknown_unsubscribe":
    send(11, integer(1, 99))
if mode == "family_late_subscribe":
    send(10, integer(1, 2) + field(2, "agent.updated"))
if mode == "family_late_subscribe_ungranted":
    send(10, integer(1, 2) + field(2, "session.created"))
if mode == "family_unsolicited":
    call = integer(1, 777) + field(2, "ses_tool") + field(3, "msg_tool") + field(4, field(1, "call_tool")) + field(5, "test")
    send(9, field(1, call) + integer(2, 1) + integer(3, 0) + field(4, value({"items": []})))

events_seen = 0
pending_callback = None
submitted = False
host_requests = 0
while True:
    frame = read()
    if 3 in frame:
        execute = fields(frame[3][0])
        call = execute[1][0]
        if mode == "mcp_calls":
            summary = {
                "servers": host_call(call, 1, 3, b""),
                "tools": host_call(call, 2, 4, b""),
                "resource": host_call(call, 3, 5, field(1, "docs") + field(2, "test://slow")),
                "tool": host_call(call, 4, 6, field(1, "docs") + field(2, "slow") + field(3, value({}))),
                "ungranted": host_call(call, 5, 6, field(1, "other") + field(2, "slow") + field(3, value({}))),
                "hidden_resource": host_call(call, 6, 5, field(1, "other") + field(2, "test://slow")),
            }
            send(4, field(1, call) + field(2, field(1, value(summary)) + field(2, field(1, field(1, "done")))))
            continue
        if mode == "mcp_oversized":
            def sized(request, size):
                return host_call(call, request, 6, field(1, "docs") + field(2, "big") + field(3, value({"size": size})))
            summary = {"small": sized(1, "small"), "big": sized(2, "big"), "after": sized(3, "small")}
            send(4, field(1, call) + field(2, field(1, value(summary)) + field(2, field(1, field(1, "done")))))
            continue
        if mode == "session_ops":
            def prompt(session, message):
                data = {"type": "user", "data": {"text": "hello"}, "delivery": "steer"}
                return field(1, session) + field(2, message) + field(3, value(data)) + integer(4, 0)
            summary = {
                "get": host_call(call, 1, 7, field(1, "ses_one")),
                "foreign": host_call(call, 2, 7, field(1, "ses_far")),
                "missing": host_call(call, 3, 7, field(1, "ses_missing")),
                "prompt": host_call(call, 4, 8, prompt("ses_one", "msg_child")),
                "retry": host_call(call, 5, 8, prompt("ses_one", "msg_child")),
                "reuse": host_call(call, 6, 8, prompt("ses_two", "msg_child")),
                "far_prompt": host_call(call, 7, 8, prompt("ses_far", "msg_far")),
                "interrupt": host_call(call, 8, 9, field(1, "ses_one")),
                "far_interrupt": host_call(call, 9, 9, field(1, "ses_far")),
            }
            send(4, field(1, call) + field(2, field(1, value(summary)) + field(2, field(1, field(1, "done")))))
            continue
        if mode == "session_request":
            request = read_value(execute[4][0])
            operation = request["op"]
            session = request.get("session", "ses_one")
            message = request.get("message", "msg_new")
            if operation == "create":
                body = field(1, session)
                if "parent" in request:
                    body += field(2, request["parent"])
                if "agent" in request:
                    body += field(3, field(1, request["agent"]))
                if "model" in request:
                    body += field(4, value(request["model"]))
                if "ceiling" in request:
                    body += field(6, value(request["ceiling"]))
                tag = 10
            elif operation == "generate":
                body = field(1, session) + field(2, field(1, "Generate only"))
                tag = 11
            elif operation == "command":
                data = request.get("input", {"type": "user", "data": {"text": ""}, "delivery": "queue"})
                body = field(1, session) + field(2, message) + field(3, field(1, request.get("command", "test"))) + field(4, field(1, "value")) + field(5, value(data)) + integer(8, 0)
                tag = 12
            elif operation == "synthetic":
                data = request.get("input", {"type": "synthetic", "data": {"text": "Observation", "description": "Observed", "metadata": {"source": "fixture"}}, "delivery": "queue"})
                body = field(1, session) + field(2, message) + field(3, value(data)) + integer(4, 0)
                tag = 13
            else:
                raise ValueError(operation)
            if request.get("placement"):
                body += field(127, "/elsewhere")
            host_requests += 1
            result = host_call(call, host_requests, tag, body)
            send(4, field(1, call) + field(2, field(1, value(result)) + field(2, field(1, field(1, "done")))))
            continue
        if mode == "mcp_flood":
            for request in range(1, 10):
                send(13, field(1, call) + integer(2, request) + field(6, field(1, "docs") + field(2, "slow") + field(3, value({}))))
            accepted = 0
            for _ in range(9):
                reply = None
                while reply is None:
                    frame = read()
                    if 8 in frame:
                        reply = fields(frame[8][0])
                accepted += 1 if 3 in reply else 0
            summary = {"accepted": accepted, "rejected": 9 - accepted}
            send(4, field(1, call) + field(2, field(1, value(summary)) + field(2, field(1, field(1, "done")))))
            continue
        if mode == "mcp_duplicate_request":
            send(13, field(1, call) + integer(2, 1) + field(3, b""))
            send(13, field(1, call) + integer(2, 1) + field(3, b""))
            continue
        if mode == "mcp_relabelled_call":
            parsed = fields(call)
            relabelled = integer(1, parsed[1][0]) + field(2, parsed[2][0]) + field(3, "msg_other") + field(4, parsed[4][0]) + field(5, parsed[5][0])
            send(13, field(1, relabelled) + integer(2, 1) + field(3, b""))
            continue
        if mode in ["mcp_cancel", "mcp_call_while_cancelling"]:
            if mode == "mcp_cancel":
                send(13, field(1, call) + integer(2, 1) + field(6, field(1, "docs") + field(2, "slow") + field(3, value({}))))
            send(5, field(1, call) + field(2, field(1, field(6, b""))))
            while True:
                cancel = read()
                if 4 in cancel:
                    break
            if mode == "mcp_call_while_cancelling":
                send(13, field(1, call) + integer(2, 1) + field(3, b""))
            else:
                send(6, field(1, call))
            continue
        if mode == "crash":
            os._exit(7)
        if mode == "malformed_call":
            sys.stdout.buffer.write(struct.pack("<I", 1) + b"\x80")
            sys.stdout.buffer.flush()
            continue
        if mode == "truncated_call":
            sys.stdout.buffer.write(struct.pack("<I", 100) + b"\x80")
            sys.stdout.buffer.flush()
            os._exit(0)
        if mode in ["timeout", "cancel_ignore", "cancel", "drop"]:
            send(5, field(1, call) + field(2, field(1, field(6, b""))))
            continue
        if mode == "stale":
            send(4, field(1, call) + field(2, field(1, field(6, b""))), b"old_generation")
            continue
        if mode == "failure":
            send(4, field(1, call) + field(3, integer(1, 2)))
            continue
        if mode == "family_after_failure":
            send(4, field(1, call) + field(3, integer(1, 2)))
            continue
        if mode == "unknown":
            send(4, field(1, call) + field(3, integer(1, 3)))
            continue
        if mode == "invalid_output":
            send(4, field(1, call) + field(2, field(1, field(4, field(1, "wrong type")))))
            continue
        if mode == "wrong_call":
            parsed = fields(call)
            call = integer(1, parsed[1][0]) + field(2, "ses_other") + field(3, parsed[3][0]) + field(4, parsed[4][0]) + field(5, parsed[5][0])
        text = "x" * 200000 if mode == "large_output" else "child output"
        structured = execute[4][0]
        if family_mode:
            structured = read_value(structured)
            structured["events"] = events_seen
            structured = value(structured)
        output = field(1, structured) + field(2, field(1, field(1, text)))
        send(5, field(1, call) + field(2, field(1, field(6, b""))))
        send(4, field(1, call) + field(2, output))
        if mode == "mcp_after_result":
            send(13, field(1, call) + integer(2, 1) + field(3, b""))
        if mode == "duplicate":
            send(4, field(1, call) + field(2, output))
    elif 6 in frame:
        transform = fields(frame[6][0])
        stage = transform[3][0]
        revision = transform[4][0]
        if mode == "family_wrong_revision":
            revision += 1
        draft = read_value(transform[5][0])
        if mode == "family_fail_context" and stage == 6:
            send(9, field(1, transform[1][0]) + integer(2, stage) + integer(3, revision) + field(5, integer(1, 2)))
            continue
        if mode == "family_context_requires_tools" and stage == 6 and not draft["tools"][0]["description"].endswith("BB"):
            send(9, field(1, transform[1][0]) + integer(2, stage) + integer(3, revision) + field(5, integer(1, 1)))
            continue
        marker = "A" if mode == "familyA" else "B"
        if stage == 7:
            draft["input"]["trace"] = draft["input"].get("trace", "") + marker
        elif stage == 8:
            previous_result = draft["result"]
            if "output" in draft:
                draft["output"]["structured"]["after"] = draft["output"]["structured"].get("after", "") + marker
                draft["output"]["content"] = [{"type": "text", "text": "y" * 80000}]
                draft["result"] = {"type": "text", "value": "y" * 80000}
            if mode == "family_after_invalid":
                draft["output"]["structured"] = "not an object"
            elif mode == "family_after_failure":
                draft["result"] = {"type": "json", "value": {"success": True}}
            elif mode == "family_after_result_only":
                draft["output"]["structured"].pop("after", None)
                draft["output"]["content"] = [{"type": "text", "text": "child output"}]
            elif mode == "family_after_output_only":
                draft["result"] = previous_result
        elif stage == 6:
            draft["system"].append({"text": "system-" + marker})
            if mode == "family_context_tools":
                for item in draft["tools"]:
                    item["description"] += "-context"
                    item["input"] = {"type": "object", "properties": {"z": {"type": "string"}, "a": {"type": "string"}}}
                    item["native"] = {"forged": True}
                draft["tools"].append({"name": "forged", "description": "Unregistered", "input": {"type": "object"}})
                draft["tools"].append({"name": "demo_echo", "description": "Forbidden resurrection", "input": {"type": "object"}})
            elif mode == "family_context_omit_tools":
                draft["tools"] = []
            if mode == "family_context_idless":
                draft["messages"].append({"role": "user", "content": [], "volatile": False})
            elif mode == "family_context_role":
                draft["messages"][0]["role"] = "assistant"
            elif mode == "family_context_duplicate":
                draft["messages"].append(draft["messages"][0])
            elif mode == "family_context_strip_origin":
                draft["messages"][0].pop("origin", None)
        elif stage == 9:
            for item in draft["items"]:
                item["description"] += marker
        elif stage == 1:
            for item in draft["items"]:
                item["description"] = item.get("description", "") + marker
        elif stage == 2:
            for item in draft["items"]:
                item["description"] = item.get("description", "") + marker
        elif stage == 5:
            for item in draft["items"]:
                item["provider"]["name"] += marker
        send(9, field(1, transform[1][0]) + integer(2, stage) + integer(3, revision) + field(4, value(draft)), b"old" if mode == "family_stale" else None)
    elif 7 in frame:
        events_seen += 1
        if mode not in ["family_event_stall", "family_quota"]:
            send(12, integer(1, fields(frame[7][0])[1][0]))
    elif 4 in frame:
        if mode != "cancel_ignore":
            send(6, field(1, fields(frame[4][0])[1][0]))
    elif 9 in frame:
        auth = fields(frame[9][0])
        request = auth[1][0]
        if 2 in auth:
            if mode == "auth_silent":
                continue
            if mode == "auth_wrong_kind":
                send(14, integer(1, request) + field(3, value({})))
            else:
                authorization = field(1, field(1, "https://acme.test/authorize")) + field(2, field(1, "Paste the code")) + integer(4, 2 if mode == "auth_code" else 1) + integer(5, 1 if mode == "auth_auto_pending" else 0)
                send(14, integer(1, request) + field(2, authorization))
        elif 3 in auth:
            callback = fields(auth[3][0])
            code = fields(callback[2][0])[1][0].decode() if 2 in callback else None
            if mode == "auth_code" and code != "good-code":
                send(14, integer(1, request) + field(6, integer(1, 1)))
            elif mode == "auth_auto_pending" and not submitted:
                pending_callback = request
            else:
                send(14, integer(1, request) + field(3, value(oauth_credential("first-access"))))
        elif 4 in auth:
            submitted = True
            send(14, integer(1, request) + field(5, b""))
            if pending_callback is not None:
                send(14, integer(1, pending_callback) + field(3, value(oauth_credential("first-access"))))
        elif 5 in auth:
            send(14, integer(1, request) + field(3, value(oauth_credential("refreshed-access"))))
        elif 6 in auth:
            send(14, integer(1, request) + field(4, field(1, "acme-user")))
    elif 10 in frame:
        preq = fields(frame[10][0])
        request = preq[1][0]
        attempt = fields(preq[2][0])
        body = read_value(attempt[4][0])
        if mode == "provider_slow":
            time.sleep(1.0)
        chunks = [
            {"choices": [{"index": 0, "delta": {"content": "Hello"}, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "get_weather", "arguments": "{\"city\":\"Paris\"}"}}]}, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}},
        ]
        send(15, integer(1, request) + field(2, value(chunks)))
    elif 11 in frame:
        pass
    elif 8 in frame:
        with open("reply-after-cancel", "w") as marker:
            marker.write("x")
    elif 5 in frame:
        if mode.startswith("lifecycle"):
            with open(sys.argv[2], "a") as journal:
                journal.write(json.dumps({"event": "stop", "id": identity.decode(), "pid": os.getpid()}) + "\n")
        if mode == "shutdown_ignore":
            time.sleep(30)
        send(7, b"")
        sys.exit(0)
