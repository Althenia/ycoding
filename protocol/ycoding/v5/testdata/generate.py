import hashlib
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[4]
source = root / "protocol"
target = Path(__file__).resolve().parent
digest = hashlib.sha256()
for file in sorted((source / "ycoding/v5").glob("*.proto")):
    digest.update(file.relative_to(source).as_posix().encode() + b"\0" + file.read_bytes())
digest_text = "".join(f"\\{byte:03o}" for byte in digest.digest())
windows = "receive_windows { normal_bytes: 1048576 event_bytes: 1048576 bulk_bytes: 524288 }"
header = 'revision: 5 connection_epoch: "epoch" delivery_ordinal: 1'
cases = [
    ("empty-string", "LosslessString", 'utf8: ""', 0),
    ("scalar-string", "LosslessString", 'utf8: "A\\357\\273\\277\\360\\237\\230\\200"', 0),
    ("lone-high", "LosslessString", 'utf16_le_units: "\\000\\330"', 0),
    ("lone-low", "LosslessString", 'utf16_le_units: "\\000\\334"', 0),
    ("mixed-units", "LosslessString", 'utf16_le_units: "A\\000\\376\\377\\377\\333\\377\\337\\000\\330"', 0),
    ("null", "Value", "null {}", 0),
    ("false", "Value", "boolean: false", 0),
    ("zero", "Value", "number: 0", 0),
    ("fraction", "Value", "number: -0.125", 0),
    ("bytes", "Value", 'bytes: "\\000\\377"', 0),
    ("value-string", "Value", 'string { utf16_le_units: "\\000\\330" }', 0),
    ("empty-list", "Value", "list {}", 0),
    ("empty-object", "Value", "object {}", 0),
    ("object-lone-key", "Value", 'object { entries { key { utf16_le_units: "\\000\\330" } value { boolean: false } } }', 0),
    ("clear", "ClearableString", "clear {}", 0),
    ("present-empty", "ClearableString", 'value { utf8: "" }', 0),
    ("present-false", "ClearableBool", "value: false", 0),
    ("bigint", "ClearableUint64", "value: 18446744073709551615", 0),
    ("present-empty-list", "StringList", "", 0),
    ("hello", "Frame", f'revision: 5 hello {{ revision: 5 contract_digest: "{digest_text}" role: LOCAL_CLIENT {windows} }}', 1),
    ("ready", "Frame", f'{header.replace("delivery_ordinal: 1", "")} ready {{ revision: 5 contract_digest: "{digest_text}" role: SERVER {windows} source_epoch: "source" connection_epoch: "epoch" }}', 5),
    ("request", "Frame", f'{header} ledger: NORMAL request {{ request_id: "r" operation_id: 1 scope {{ machine {{}} }} payload: "" }}', 1),
    ("result", "Frame", f'{header} ledger: NORMAL result {{ request_id: "r" operation_id: 1 settlement: COMPLETED success {{ type_name: "ycoding.v5.Empty" payload: "" }} }}', 5),
    ("error", "Frame", f'{header} ledger: NORMAL result {{ request_id: "r" operation_id: 1 settlement: DURABLY_ADMITTED error {{ type_name: "ycoding.v5.ProtocolFailure" payload: "\\010\\001" }} }}', 5),
    ("events", "Frame", f'{header} ledger: EVENT event_batch {{ subscription_id: "s" scope {{ session: "s" }} source_epoch: "source" events {{ event_id: "e" created_ms: -1 durable {{ aggregate_id: "s" sequence: 9007199254740993 version: 1 }} event {{ type_name: "ycoding.v5.Empty" payload: "" }} }} }}', 5),
    ("stream-end", "Frame", f'{header} ledger: EVENT stream_end {{ subscription_id: "s" }}', 5),
    ("bulk-start", "Frame", f'{header} ledger: NORMAL bulk_start {{ request_id: "r" transfer_id: "t" operation_id: 1 type_name: "ycoding.v5.Empty" content_kind: TYPED_MESSAGE byte_count: 0 chunk_count: 1 }}', 5),
    ("bulk-piece", "Frame", f'{header} ledger: BULK bulk_piece {{ transfer_id: "t" index: 0 offset: 0 data: "" }}', 5),
    ("bulk-end", "Frame", f'{header} ledger: NORMAL bulk_end {{ transfer_id: "t" byte_count: 0 success {{}} }}', 5),
    ("bulk-error", "Frame", f'{header} ledger: NORMAL bulk_end {{ transfer_id: "t" byte_count: 0 error {{ type_name: "ycoding.v5.ProtocolFailure" payload: "\\010\\001" }} }}', 5),
    ("descriptor", "OperationDescriptor", 'operation_id: 1 diagnostic_name: "foundation.test" request_type: "ycoding.v5.Empty" result_type: "ycoding.v5.Empty" error_types: "ycoding.v5.ProtocolFailure" roles: LOCAL_CLIENT scope: MACHINE mutation: READ settlement: COMPLETED paging: UNPAGED streaming: INLINE sensitivity: PRIVATE sensitive_fields { field_path: "input" sensitivity: SECRET }', 0),
    ("public-catalog", "PublicEvent", 'catalog_updated { id { utf8: "evt_catalog" } created: 0 type: PUBLICEVENT_CATALOG_UPDATED_TYPE_CATALOG_UPDATED data {} }', 0),
    ("public-text-delta", "PublicEvent", 'session_text_delta { id { utf8: "evt_delta" } created: 0 type: PUBLICEVENT_SESSION_TEXT_DELTA_TYPE_SESSION_TEXT_DELTA data { sessionID { utf8: "ses_a" } assistantMessageID { utf8: "msg_a" } ordinal: 0 delta { utf16_le_units: "\\000\\330" } } }', 0),
    ("public-durable", "PublicEvent", 'session_revert_cleared { id { utf8: "evt_clear" } created: 0 sourceEpoch { utf8: "source" } type: SESSIONLOGITEMVALUE50_TYPE_SESSION_REVERT_CLEARED durable { aggregateID { utf8: "ses_a" } seq: 1 version: 1 } data { sessionID { utf8: "ses_a" } } }', 0),
    ("upload-raw", "session_attachment_upload_Request_payload", 'uploadID { utf8: "00000000-0000-4000-8000-000000000001" } index: 0 last: true data: "\\000\\377" offset: 0', 0),
]
controls = [
    ("ping", "id: 0", 1), ("pong", "id: 0", 5), ("cancel", 'request_id: "r"', 1),
    ("credit", "ledger: NORMAL consumed_through: 1", 1),
    ("subscription_snapshot", 'client_id: "c" session_ids: "s"', 3),
    ("priority", "mode: INTERACTIVE", 1), ("inventory_invalidated", "", 5),
    ("status", 'running: "s" attention: "s" outstanding {} failed {} details {}', 5),
    ("completions", 'items { id: "e" sequence: 9007199254740993 created_ms: 0 session_id: "s" title { utf8: "title" } } more: false', 5),
    ("blocked", 'session_id: "s" title { utf16_le_units: "\\000\\330" }', 5),
    ("notice", "cleared {}", 3), ("resync_required", 'scope { session: "s" } source_epoch: "source"', 5),
    ("failure", "category: MALFORMED", 5),
]
for name, body, sender in controls:
    ledger = "TINY" if name in {"ping", "pong", "cancel", "credit"} else "NORMAL"
    cases.append((name, "Frame", f"{header} ledger: {ledger} control {{ {name} {{ {body} }} }}", sender))
rows = []
encoded = {}
for name, message, text, sender in cases:
    result = subprocess.run([os.environ.get("PROTOC", "/opt/homebrew/bin/protoc"), f"--proto_path={source}", f"--encode=ycoding.v5.{message}", *[file.relative_to(source).as_posix() for file in sorted((source / "ycoding/v5").glob("*.proto"))]], input=text.encode(), capture_output=True, check=True)
    encoded[name] = result.stdout
    rows.append(f"{name}\tycoding.v5.{message}\tvalid\t{sender}\t{result.stdout.hex()}")

def varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)

def blob(tag, value):
    return varint(tag * 8 + 2) + varint(len(value)) + value

deep = b"\x0a\x00"
for _ in range(64):
    deep = blob(6, blob(1, deep))
negatives = [
    ("bad-utf8", "LosslessString", b"\x0a\x02\xc0\x80", 0),
    ("surrogate-utf8", "LosslessString", b"\x0a\x03\xed\xa0\x80", 0),
    ("odd-utf16", "LosslessString", b"\x12\x01\x00", 0),
    ("paired-only", "LosslessString", b"\x12\x04\x00\xd8\x00\xdc", 0),
    ("both-branches", "LosslessString", b"\x0a\x00\x12\x02\x00\xd8", 0),
    ("neither-branch", "LosslessString", b"", 0),
    ("duplicate-singular", "LosslessString", b"\x0a\x00\x0a\x00", 0),
    ("unknown-command", "Frame", encoded["hello"] + b"\xa0\x01\x01", 1),
    ("hello-epoch", "Frame", encoded["hello"] + blob(2, b"fake"), 1),
    ("hello-ledger", "Frame", encoded["hello"] + b"\x18\x01", 1),
    ("hello-inner-epoch", "Hello", b"\x08\x05\x32\x00", 0),
    ("before-ready", "Frame", encoded["request"], 1),
    ("depth-overflow", "Value", deep, 0),
    ("field-overflow", "ValueList", b"\x0a\x02\x0a\x00" * 32769, 0),
    ("duplicate-key", "Value", blob(7, blob(1, blob(1, b"\x0a\x00") + blob(2, b"\x0a\x00")) * 2), 0),
    ("nan", "Value", b"\x19\x00\x00\x00\x00\x00\x00\xf8\x7f", 0),
    ("infinity", "Value", b"\x19\x00\x00\x00\x00\x00\x00\xf0\x7f", 0),
    ("bad-bool", "Value", b"\x10\x02", 0),
    ("bad-varint", "Value", b"\x10" + b"\x80" * 10, 0),
    ("bad-length", "LosslessString", b"\x0a\x7f", 0),
    ("wrong-wire", "LosslessString", b"\x08\x00", 0),
    ("concatenated-frame", "Frame", encoded["hello"] * 2, 1),
    ("duplicate-command", "Frame", encoded["hello"] + b"\x08\x05", 1),
    ("unknown-control", "Control", blob(1, b"\x08\x00") + b"\x70\x01", 0),
    ("missing-command-field", "Request", b"\x0a\x01r", 0),
    ("missing-frame-body", "Frame", b"\x08\x05", 1),
    ("both-frame-bodies", "Frame", encoded["hello"] + blob(11, b""), 1),
    ("unknown-enum", "Credit", b"\x08\x09\x10\x01", 0),
    ("tiny-credit", "Credit", b"\x08\x04\x10\x01", 0),
    ("zero-credit", "Credit", b"\x08\x01\x10\x00", 0),
    ("stream-end-client", "Frame", encoded["stream-end"], 1),
    ("stream-end-duplicate", "Frame", encoded["stream-end"] + blob(19, b"\x0a\x01s"), 5),
    ("public-event-empty", "PublicEvent", b"", 0),
    ("public-event-duplicate", "PublicEvent", encoded["public-catalog"] + encoded["public-text-delta"], 0),
    ("ephemeral-durable", "PublicEvent_catalog_updated", encoded["public-catalog"][2:] + blob(8, b""), 0),
    ("upload-empty", "session_attachment_upload_Request_payload", encoded["upload-raw"].replace(blob(4, b"\x00\xff"), blob(4, b"")), 0),
]
for name, message, data, sender in negatives:
    rows.append(f"{name}\tycoding.v5.{message}\tinvalid\t{sender}\t{data.hex()}")
(target / "manifest.tsv").write_text("\n".join(rows) + "\n")
print(f"golden vectors: {len(cases)}, negative vectors: {len(negatives)}, digest: {digest.hexdigest()}")
