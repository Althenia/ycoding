import json
import sys


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    request = json.loads(line)
    identity = request.get("id")
    method = request.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": identity, "result": {"protocolVersion": request["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "oversized", "version": "1.0.0"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": identity, "result": {"tools": [{"name": "big", "inputSchema": {"type": "object"}}]}})
    elif method == "tools/call":
        size = request["params"].get("arguments", {}).get("size")
        send({"jsonrpc": "2.0", "id": identity, "result": {"content": [{"type": "text", "text": "x" * (1200000 if size == "big" else 10)}]}})
    elif identity is not None:
        send({"jsonrpc": "2.0", "id": identity, "error": {"code": -32601, "message": "Method not found"}})
