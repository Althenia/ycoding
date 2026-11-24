include!("tool_fixture.rs");
use std::time::Duration;
use ycoding_core::extension::{Configuration, Extension, Host, Launch, Options, ToolGrant, v5};

const UNTRUSTED: &str = r#"
import struct, sys
def varint(v):
    out = bytearray()
    while v > 127:
        out.append((v & 127) | 128); v >>= 7
    out.append(v); return bytes(out)
def field(tag, value):
    if isinstance(value, str): value = value.encode()
    return varint((tag << 3) | 2) + varint(len(value)) + value
def number(tag, value): return varint(tag << 3) + varint(value)
def send(payload):
    sys.stdout.buffer.write(struct.pack("<I", len(payload)) + payload); sys.stdout.buffer.flush()
def read():
    size = struct.unpack("<I", sys.stdin.buffer.read(4))[0]
    return sys.stdin.buffer.read(size)
def fields(data):
    offset, out = 0, {}
    def num(o):
        v = s = 0
        while True:
            b = data[o]; o += 1; v |= (b & 127) << s; s += 7
            if b < 128: return v, o
    while offset < len(data):
        key, offset = num(offset)
        if key & 7 == 0: value, offset = num(offset)
        else:
            n, offset = num(offset); value = data[offset:offset + n]; offset += n
        out.setdefault(key >> 3, []).append(value)
    return out
frame = fields(read())
generation = frame[1][0].decode()
hello = fields(frame[2][0])
identity = hello[2][0].decode()
send(field(1, generation) + field(2, number(1, 5) + field(2, identity) + field(3, generation)))
text = field(1, "Echo")
schema = field(6, field(1, field(1, field(1, "type")) + field(2, field(4, field(1, "object")))))
tool = field(1, "demo") + field(2, "echo") + field(3, text) + field(4, schema) + field(5, schema) + number(6, 1) + number(7, 0)
send(field(1, generation) + field(3, field(1, tool)))
send(field(1, generation) + field(16, number(1, 1) + field(2, b"")))
sys.stdin.buffer.read()
"#;

#[tokio::test]
async fn generic_children_cannot_claim_plugin_calls_and_are_closed() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let script = fixture.root.join("untrusted.py");
    std::fs::write(&script, UNTRUSTED).unwrap();
    let extension = Extension::start(
        Configuration {
            identity: "untrusted".into(),
            executable: "/usr/bin/python3".into(),
            args: vec![script.to_str().unwrap().into()],
            directory: fixture.root.clone(),
            grants: vec![ToolGrant {
                namespace: "demo".into(),
                tools: vec!["echo".into()],
                action: "extension.echo".into(),
                resources: vec!["demo".into()],
            }],
            families: vec![],
            registration_order: 0,
        },
        Options {
            startup: Duration::from_secs(5),
            execution: Duration::from_secs(5),
            cleanup: Duration::from_secs(2),
            shutdown: Duration::from_secs(2),
            write: Duration::from_secs(5),
        },
        &registry,
        fixture.policy.clone(),
        &Launch::default(),
        Host::default(),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(60), extension.closed())
        .await
        .unwrap();
    assert!(
        extension
            .diagnostics()
            .contains(&v5::DiagnosticCode::ProtocolRejected)
    );
    fixture.cleanup();
}
