use std::{fs, path::PathBuf};
use ycoding_core::tools::builtin::read_filesystem::{self, Page, ReadError};
use ycoding_schema::{JsonValue, parse_json};

fn directory() -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "tool_read_{}_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn stops_decoding_after_requested_page_and_reports_offsets() {
    let root = directory();
    for (name, tail) in [("malformed.txt", 0x80), ("nul.txt", 0)] {
        let path = root.join(name);
        fs::write(&path, [b'o', b'n', b'e', b'\n', tail]).unwrap();
        let output = read_filesystem::read(
            &path,
            name,
            Page {
                offset: None,
                limit: Some(1),
            },
        )
        .unwrap();
        assert_eq!(output, parse_json(r#"{"type":"text-page","content":"one","mime":"text/plain","offset":1,"truncated":true,"next":2}"#).unwrap());
    }
    fs::write(root.join("short.txt"), "one\n").unwrap();
    assert_eq!(read_filesystem::read(&root.join("short.txt"), "short.txt", Page { offset: None, limit: Some(1) }).unwrap(), parse_json(r#"{"type":"text-page","content":"one","mime":"text/plain","offset":1,"truncated":false}"#).unwrap());
    assert_eq!(
        read_filesystem::read(
            &root.join("short.txt"),
            "short.txt",
            Page {
                offset: Some(2),
                limit: None
            }
        )
        .unwrap_err()
        .to_string(),
        "Offset 2 is out of range"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn detects_binary_malformed_and_media_ingestion_limits() {
    let root = directory();
    fs::write(root.join("archive.dat"), [0, 1, 2, 3]).unwrap();
    assert!(matches!(
        read_filesystem::read(&root.join("archive.dat"), "archive.dat", Page::default()),
        Err(ReadError::Binary(_))
    ));
    let mut malformed = vec![b'a'; 64 * 1024 + 1];
    malformed[64 * 1024] = 0x80;
    fs::write(root.join("malformed.txt"), malformed).unwrap();
    assert!(matches!(
        read_filesystem::read(
            &root.join("malformed.txt"),
            "malformed.txt",
            Page::default()
        ),
        Err(ReadError::MalformedUtf8(_))
    ));
    fs::write(
        root.join("oversized.png"),
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    )
    .unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(root.join("oversized.png"))
        .unwrap()
        .set_len(20 * 1024 * 1024 + 1)
        .unwrap();
    assert_eq!(
        read_filesystem::read(
            &root.join("oversized.png"),
            "oversized.png",
            Page::default()
        )
        .unwrap_err()
        .to_string(),
        "Media exceeds 20971520 byte ingestion limit: oversized.png"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn small_text_bom_paged_lines_and_lone_surrogate_truncation_match_ts() {
    let root = directory();
    fs::write(root.join("small.txt"), "\u{feff}hello\n").unwrap();
    let output =
        read_filesystem::read(&root.join("small.txt"), "small.txt", Page::default()).unwrap();
    let JsonValue::Object(output) = output else {
        panic!("content")
    };
    assert_eq!(
        output.get(&"content".into()),
        Some(&JsonValue::String("hello\n".into()))
    );
    fs::write(
        root.join("long.txt"),
        format!("{}😀z\r\nnext\n", "a".repeat(1999)),
    )
    .unwrap();
    let output = read_filesystem::read(
        &root.join("long.txt"),
        "long.txt",
        Page {
            offset: Some(1),
            limit: Some(1),
        },
    )
    .unwrap();
    let JsonValue::Object(output) = output else {
        panic!("page")
    };
    let Some(JsonValue::String(content)) = output.get(&"content".into()) else {
        panic!("text")
    };
    assert_eq!(content.code_units().nth(1999), Some(0xd83d));
    assert!(
        content.code_units().collect::<Vec<_>>().ends_with(
            &"... (line truncated to 2000 chars)"
                .encode_utf16()
                .collect::<Vec<_>>()
        )
    );
    fs::remove_dir_all(root).unwrap();
}
