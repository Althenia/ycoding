import json
import os
import sys
import time


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


configuration = sys.argv[1]
if os.environ.get("MCP_TABLE_MARKER"):
    with open(os.environ["MCP_TABLE_MARKER"], "w") as marker:
        marker.write("started")

for line in sys.stdin:
    request = json.loads(line)
    identity = request.get("id")
    method = request.get("method")
    with open(configuration) as source:
        table = json.load(source)
    params = request.get("params") or {}
    with open(table["log"], "a") as log:
        log.write(json.dumps({"method": method, "params": params}) + "\n")
    if identity is None:
        continue
    if method == "initialize":
        result = {"protocolVersion": params["protocolVersion"], "capabilities": table["capabilities"], "serverInfo": {"name": "table", "version": "1.0.0"}}
        send({"jsonrpc": "2.0", "id": identity, "result": result})
        continue
    if method == "tools/call":
        for notification in table.get("notify", []):
            send({"jsonrpc": "2.0", "method": notification})
        call = table.get("calls", {}).get(params.get("name"), {})
        time.sleep(call.get("delay", 0))
        send({"jsonrpc": "2.0", "id": identity, "result": call.get("result", {"content": []})})
        continue
    responses = table.get("responses", {}).get(method)
    key = params.get("cursor") or params.get("uri") or ""
    if responses is not None and key in responses:
        send({"jsonrpc": "2.0", "id": identity, "result": responses[key]})
    elif responses is not None:
        send({"jsonrpc": "2.0", "id": identity, "error": {"code": -32602, "message": "Unknown resource"}})
    else:
        send({"jsonrpc": "2.0", "id": identity, "error": {"code": -32601, "message": "Method not found"}})
