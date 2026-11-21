import json
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import sys
import time

launch = json.loads(Path(sys.argv[1]).read_text())
directory = Path(launch["controlDirectory"])
assert launch["action"] == "service"
assert stat.S_IMODE(directory.stat().st_mode) == 0o700
assert stat.S_IMODE(Path(sys.argv[1]).stat().st_mode) == 0o600
os.kill(launch["ownerPID"], 0)
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(str(directory / "computer-use.sock"))
listener.listen(8)
pid = directory / "pid"
pid.write_text(str(os.getpid()))
pid.chmod(0o600)
behavior = sys.argv[2]

def receive(connection, count):
    data = bytearray()
    while len(data) < count:
        chunk = connection.recv(count - len(data))
        if not chunk:
            return None
        data.extend(chunk)
    return data

while True:
    connection, _ = listener.accept()
    if sys.platform == "darwin":
        peer = struct.unpack("i", connection.getsockopt(0, 2, 4))[0]
    else:
        peer = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0]
    assert peer == launch["ownerPID"]
    with connection:
        while True:
            header = receive(connection, 4)
            if header is None:
                break
            length = struct.unpack("<I", header)[0]
            assert 0 < length <= 8 * 1024 * 1024
            message = json.loads(receive(connection, length))
            assert message["jsonrpc"] == "2.0"
            if message["method"] == "ping":
                assert message["params"]["clientApiVersion"] == 1
                result = {"serverApiVersion": 2 if behavior == "version" else 1}
            elif message["method"] == "shutdown":
                result = "ok"
            else:
                assert message["method"] == "request"
                assert message["params"]["deadlineUnixMilliseconds"] > time.time() * 1000
                if behavior == "timeout":
                    signal.pause()
                    raise AssertionError("Unanswered service must be terminated")
                request = message["params"]["request"]
                result = {"status": "ok", "action": request["action"], "revision": "rev"}
            body = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}).encode()
            connection.sendall(struct.pack("<I", len(body)) + body)
            if message["method"] == "shutdown":
                sys.exit(0)
            if behavior == "version":
                signal.pause()
                raise AssertionError("Version-mismatched service must be terminated")
