use ycoding_core::platform::shell::paging::page;

#[test]
fn exact_budget_zero_and_cursor_edges() {
    assert_eq!(page(b"abcdef", 0, 3, true).cursor, 3);
    assert_eq!(page(b"abcdef", 2, 0, true).cursor, 2);
    assert_eq!(page(b"abcdef", 99, 1, true).cursor, 6);
    assert_eq!(page("éa".as_bytes(), 1, 1, true).output, "�");
}

#[tokio::test]
async fn file_snapshot_holds_live_append_and_flushes_only_complete_capture() {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };
    use ycoding_core::platform::shell::paging::read;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "ycoding-wp009-page-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&path, [0xe2, 0x82]).unwrap();
    let held = read(&path, 0, 1, 2, false).await.unwrap();
    assert_eq!(held.cursor, 0);
    fs::write(&path, [0xe2, 0x82, 0xac]).unwrap();
    assert_eq!(read(&path, 0, 1, 2, false).await.unwrap().cursor, 0);
    assert_eq!(
        read(&path, held.cursor, 1, 3, true).await.unwrap().output,
        "€"
    );
    fs::write(&path, [0xf0, 0x9f, 0x98]).unwrap();
    assert_eq!(read(&path, 0, 1, 3, true).await.unwrap().output, "�");
    fs::remove_file(path).unwrap();
}

#[test]
fn live_utf8_boundary_hold_and_settled_flush() {
    let held = page(&[b'a', 0xe2, 0x82], 0, 2, false);
    assert_eq!((held.output.as_str(), held.cursor), ("a", 1));
    assert_eq!(page(&[0xe2, 0x82], 0, 1, false).cursor, 0);
    assert_eq!(page(&[0xe2, 0x82], 0, 1, true).output, "�");
    assert_eq!(page(&[0xe2, 0x82, 0xac], 0, 1, false).output, "€");
}

#[test]
fn bounded_pages_join_to_standard_decoder_for_valid_and_malformed_bytes() {
    let mut bytes = "é€😀x".repeat(18000).into_bytes();
    bytes.extend([
        0xe2, b'A', 0xc3, 0xa9, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80,
    ]);
    bytes.extend((0..65536).map(|n| ((n * 73 + 19) % 256) as u8));
    bytes.extend([0xf0, 0x9f, 0x98]);
    for limit in [1, 2, 3, 4, 5, 13, 65536] {
        let mut cursor = 0;
        let mut joined = String::new();
        while cursor < bytes.len() {
            let output = page(&bytes, cursor, limit, true);
            assert!(output.cursor > cursor);
            assert!(output.cursor - cursor <= limit + 3);
            cursor = output.cursor;
            joined.push_str(&output.output);
        }
        assert!(
            joined == String::from_utf8_lossy(&bytes),
            "decoder mismatch at limit {limit}"
        );
    }
    for width in ["é", "€", "😀"] {
        for phase in 1..width.len() {
            let bytes = format!("{}{}z", "a".repeat(65536 - phase), width).into_bytes();
            let first = page(&bytes, 0, 65536, true);
            let second = page(&bytes, first.cursor, 65536, true);
            assert_eq!(
                first.output + &second.output,
                String::from_utf8_lossy(&bytes)
            );
        }
    }
}
