import atexit
import json
import os
import runpy
import signal
import struct
import subprocess
import sys
import threading
import time
import traceback

evidence_path = sys.argv[1]
spec = json.load(open(sys.argv[2]))
log = open(evidence_path, "a")
with open(evidence_path + ".pid", "w") as pid_file:
    pid_file.write(str(os.getpid()))


def note(text):
    log.write(text + "\n")
    log.flush()


class Tee:
    def __init__(self, real):
        self.real = real
        self.kept = 0

    def write(self, text):
        self.real.write(text)
        self.real.flush()
        if self.kept < 8192:
            note("stderr: " + text[:512])
            self.kept += len(text)

    def flush(self):
        self.real.flush()


sys.stderr = Tee(sys.stderr)
note("start pid=%d at=%f argv=%s" % (os.getpid(), time.time(), sys.argv[2:]))
atexit.register(lambda: note("exit"))


def on_signal(number, _frame):
    note("signal=%d" % number)
    signal.signal(number, signal.SIG_DFL)
    os.kill(os.getpid(), number)


for number in (signal.SIGTERM, signal.SIGHUP):
    signal.signal(number, on_signal)

if "delegate" in spec:
    delegate = spec["delegate"]
    sys.argv = [delegate["script"], delegate["mode"]] + delegate.get("extra", [])
    runpy.run_path(delegate["script"], run_name="__main__")
    sys.exit(0)


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
        return field(4, field(1, data))
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


def effect(text):
    with open(spec["effects"], "a") as effects:
        effects.write(text + "\n")


def mark(name):
    with open(os.path.join(os.path.dirname(evidence_path), name), "w") as marker:
        marker.write("1")


def wait_for(name):
    path = os.path.join(os.path.dirname(evidence_path), name)
    while not os.path.exists(path):
        time.sleep(0.01)


def flood():
    chunk = b"S" * 65536
    left = spec["flood"]
    while left > 0:
        os.write(2, chunk[:min(left, len(chunk))])
        left -= len(chunk)
    mark("flooded")


hello = fields(read()[2][0])
gen = hello[3][0]
identity = hello[2][0]
for name in spec.get("dump_env", []):
    sys.stderr.write(os.environ.get(name, "") + "\n")
if "flood" in spec:
    threading.Thread(target=flood, daemon=True).start()
if spec.get("grandchild"):
    descendant = subprocess.Popen(
        ["/bin/sh", "-c", "trap '' TERM HUP; while :; do sleep 1; done"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    with open(spec["pidfile"], "w") as pids:
        json.dump({"child": os.getpid(), "grandchild": descendant.pid}, pids)
if spec.get("crash_before_ready"):
    os._exit(9)

send(2, integer(1, 5) + field(2, identity) + field(3, gen))
schema = field(6, field(1, field(1, field(1, "type")) + field(2, field(4, field(1, "object")))))
batch = b""
for tool in spec.get("tools", [{"namespace": "demo", "name": "echo"}]):
    batch += field(1, field(1, tool["namespace"]) + field(2, tool["name"]) + field(3, field(1, "Fixture tool")) + field(4, schema) + field(5, schema) + integer(6, 1) + integer(7, 1))
for transform in spec.get("transforms", []):
    batch += field(2, field(1, transform["id"]) + integer(2, transform["stage"]))
for record in spec.get("domains", []):
    batch += field(3, integer(1, record["domain"]) + field(2, record["key"]) + field(3, value(record["value"])))
for subscription in spec.get("subscriptions", []):
    batch += field(4, integer(1, subscription["id"]) + field(2, subscription["families"][0]))
for registration in spec.get("oauth", []):
    batch += field(5, field(1, registration["integration"]) + field(2, value(registration["method"])) + integer(3, int(registration.get("refresh", False))) + integer(4, int(registration.get("label", False))))
send(3, batch)
if spec.get("oversize_after_ready"):
    sys.stdout.buffer.write(struct.pack("<I", 1048577))
    sys.stdout.buffer.flush()
    time.sleep(30)

events_seen = 0
request_counter = 0
provider_calls = 0
transforms_held = 0
cancelled_calls = set()


def call_result(call, structured, text="done"):
    send(4, field(1, call) + field(2, field(1, value(structured)) + field(2, field(1, field(1, text)))))


def pending_input(operation, kind):
    text = operation.get("text", "hello")
    if kind == "user":
        return {"type": "user", "data": {"text": text}, "delivery": operation.get("delivery", "steer")}
    return {"type": "synthetic", "data": {"text": text, "description": "Observed"}, "delivery": operation.get("delivery", "queue")}


def operation_body(operation):
    kind = operation["op"]
    resume = integer(8 if kind == "command" else 4, int(operation["resume"])) if "resume" in operation else b""
    session = operation.get("session", "")
    message = operation.get("message", "msg_nested")
    if kind == "servers":
        return 3, b""
    if kind == "tools":
        return 4, b""
    if kind == "read":
        return 5, field(1, operation["server"]) + field(2, operation["uri"])
    if kind == "call":
        return 6, field(1, operation["server"]) + field(2, operation["tool"]) + field(3, value(operation.get("args", {})))
    if kind == "get":
        return 7, field(1, session)
    if kind == "prompt":
        return 8, field(1, session) + field(2, message) + field(3, value(pending_input(operation, "user"))) + resume
    if kind == "interrupt":
        return 9, field(1, session)
    if kind == "create":
        body = field(1, session)
        if "parent" in operation:
            body += field(2, operation["parent"])
        return 10, body
    if kind == "generate":
        return 11, field(1, session) + field(2, field(1, operation.get("prompt", "Generate only")))
    if kind == "command":
        return 12, field(1, session) + field(2, message) + field(3, field(1, operation.get("command", "test"))) + field(4, field(1, "value")) + field(5, value(pending_input(operation, "user"))) + resume
    if kind == "synthetic":
        return 13, field(1, session) + field(2, message) + field(3, value(pending_input(operation, "synthetic"))) + resume
    raise ValueError(kind)


def host_call(call, operation):
    global request_counter
    request_counter += 1
    request = request_counter
    tag, body = operation_body(operation)
    send(13, field(1, call) + integer(2, request) + field(tag, body))
    while True:
        frame = read()
        if 4 in frame:
            send(6, field(1, call))
            return {"cancelled": True}
        if 8 in frame:
            reply = fields(frame[8][0])
            if 3 in reply:
                return {"value": read_value(reply[3][0])}
            return {"failure": fields(reply[4][0])[1][0]}


def execute(frame):
    call = frame[1][0]
    given = read_value(frame[4][0])
    mode = spec.get("exec", "echo")
    if mode in ("effect", "effect_crash", "effect_exit"):
        effect("effect " + fields(call)[4][0].hex())
        if mode == "effect_crash":
            os._exit(7)
        if mode == "effect_exit":
            sys.exit(0)
        call_result(call, given)
    elif mode == "hold":
        send(5, field(1, call) + field(2, field(1, field(6, b""))))
        while True:
            cancel = read()
            if 4 in cancel:
                break
        reply = spec.get("cancel_reply", "cleanup")
        if reply == "cleanup":
            send(6, field(1, call))
        elif reply == "result":
            call_result(call, given)
    elif mode == "calls":
        summary = {}
        for index, operation in enumerate(given["calls"]):
            outcome = host_call(call, operation)
            summary[operation.get("name", str(index))] = outcome
            if outcome.get("cancelled"):
                return
        call_result(call, summary)
    elif mode == "big":
        body = value({"blob": "x" * spec["big_result"]})
        data = field(1, gen) + field(4, field(1, call) + field(2, field(1, body) + field(2, field(1, field(1, "big")))))
        packet = struct.pack("<I", len(data)) + data
        for start in range(0, len(packet), 4096):
            sys.stdout.buffer.write(packet[start:start + 4096])
            sys.stdout.buffer.flush()
        if "flood" in spec:
            wait_for("flooded")
    elif mode == "partial_hang":
        sys.stdout.buffer.write(struct.pack("<I", 100) + b"\x0a\x01x")
        sys.stdout.buffer.flush()
        time.sleep(60)
    elif mode == "oversize":
        sys.stdout.buffer.write(struct.pack("<I", 1048577))
        sys.stdout.buffer.flush()
        time.sleep(60)
    else:
        structured = given
        if spec.get("subscriptions"):
            structured = dict(given, events=events_seen)
        call_result(call, structured)


def transform(frame):
    global transforms_held
    call = frame[1][0]
    stage = frame[3][0]
    revision = frame[4][0]
    draft = read_value(frame[5][0])

    def respond(body):
        send(9, field(1, call) + integer(2, stage) + integer(3, revision) + body)

    if spec.get("hold_transform") and transforms_held == 0:
        transforms_held += 1
        mark("transform-held")
        while True:
            if 4 in read():
                break
        if spec.get("cancel_reply", "cleanup") == "cleanup":
            send(6, field(1, call))
        else:
            respond(field(4, value(draft)))
        return
    if stage == 7 and spec.get("hook7") == "fail":
        respond(field(5, integer(1, 2)))
        return
    if stage == 7 and spec.get("hook7") == "rename":
        draft["tool"] = "other_tool"
    for edit in spec.get("edits", {}).get(str(stage), []):
        items = draft["items"]
        if edit["op"] == "remove":
            draft["items"] = [item for item in items if item.get("id", item.get("name")) != edit["id"]]
        elif edit["op"] == "copy":
            source = next(item for item in items if item.get("id", item.get("name")) == edit["from"])
            copied = dict(source)
            copied["id" if "id" in copied else "name"] = edit["id"]
            items.append(copied)
        elif edit["op"] == "default":
            draft["default"] = edit["id"]
        elif edit["op"] == "duplicate_first":
            items.append(dict(items[0]))
        elif edit["op"] == "overflow":
            draft["items"] = [dict(items[0], id="agent_%d" % number) for number in range(257)]
        elif edit["op"] == "clear":
            draft["items"] = []
        elif edit["op"] == "garbage":
            draft["items"] = ["not an item"]
    respond(field(4, value(draft)))


def chunks(text):
    if spec["provider"].get("responses"):
        return [
            {"type": "response.output_text.delta", "item_id": "msg", "delta": text},
            {"type": "response.completed", "response": {"id": "resp_fixture", "status": "completed", "usage": {"input_tokens": 10, "output_tokens": 20}}},
        ]
    return [
        {"choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]},
        {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}},
    ]


def provider(frame):
    global provider_calls
    request = frame[1][0]
    attempt = fields(frame[2][0])
    with open(spec["provider"]["log"], "a") as requests:
        requests.write(json.dumps({"request": request, "package": attempt[1][0].decode()}) + "\n")
    outcomes = spec["provider"].get("outcomes", ["ok"])
    outcome = outcomes[min(provider_calls, len(outcomes) - 1)]
    provider_calls += 1
    if outcome == "hang":
        mark("provider-held")
        return
    if outcome == "stray":
        send(15, integer(1, 9999) + field(2, value([])))
        outcome = "ok"
    if outcome == "ok":
        send(15, integer(1, request) + field(2, value(chunks(spec["provider"].get("text", "Hello")))))
    elif outcome in ("reject", "exec", "unknown"):
        send(15, integer(1, request) + field(3, integer(1, {"reject": 1, "exec": 2, "unknown": 3}[outcome])))
    elif outcome == "malformed":
        send(15, integer(1, request))
    elif outcome == "garbage":
        send(15, integer(1, request) + field(2, value([{"nonsense": 1}])))
    elif outcome == "notarray":
        send(15, integer(1, request) + field(2, value("x")))


def credential(access):
    return {"type": "oauth", "methodID": "acme-login", "refresh": "refresh-token", "access": access, "expires": 9000000}


def auth(frame):
    auth_spec = spec["auth"]
    request = frame[1][0]
    if 2 in frame:
        authorization = field(1, field(1, "https://acme.test/authorize")) + field(2, field(1, "Paste")) + integer(4, 1) + integer(5, 0)
        send(14, integer(1, request) + field(2, authorization))
    elif 3 in frame:
        if auth_spec.get("callback") == "hold":
            mark("poll-held")
            return
        send(14, integer(1, request) + field(3, value(credential("first-access"))))
    elif 5 in frame:
        if auth_spec.get("refresh") == "hold":
            mark("refresh-held")
            wait_for("release-refresh")
        send(14, integer(1, request) + field(3, value(credential(auth_spec.get("access", "refreshed-access")))))
    elif 6 in frame:
        send(14, integer(1, request) + field(4, field(1, "acme-user")))


try:
    while True:
        frame = read()
        if 3 in frame:
            execute(fields(frame[3][0]))
        elif 4 in frame:
            pass
        elif 5 in frame:
            if spec.get("ignore_shutdown"):
                time.sleep(60)
            send(7, b"")
            sys.exit(0)
        elif 6 in frame:
            transform(fields(frame[6][0]))
        elif 7 in frame:
            events_seen += 1
            if not spec.get("stall"):
                send(12, integer(1, fields(frame[7][0])[1][0]))
        elif 9 in frame:
            auth(fields(frame[9][0]))
        elif 10 in frame:
            provider(fields(frame[10][0]))
except SystemExit:
    raise
except BaseException:
    traceback.print_exc()
    raise
