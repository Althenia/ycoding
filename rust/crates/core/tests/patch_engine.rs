use ycoding_core::platform::patch::{
    Error, FileUpdate, Hunk, UpdateFileChunk, derive, join_bom, parse,
};

#[test]
fn parses_add_update_delete_move_and_heredoc_patches() {
    assert_eq!(
        parse(
            "*** Begin Patch\n*** Add File: add.txt\n+added\n*** Update File: update.txt\n@@ section\n-old\n+new\n*** Delete File: delete.txt\n*** End Patch"
        )
        .unwrap(),
        vec![
            Hunk::Add {
                path: "add.txt".into(),
                contents: "added".into(),
            },
            Hunk::Update {
                path: "update.txt".into(),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    old_lines: vec!["old".into()],
                    new_lines: vec!["new".into()],
                    change_context: Some("section".into()),
                    end_of_file: false,
                }],
            },
            Hunk::Delete {
                path: "delete.txt".into(),
            },
        ]
    );
    assert_eq!(
        parse("*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch").unwrap(),
        vec![Hunk::Update {
            path: "old.txt".into(),
            move_path: Some("new.txt".into()),
            chunks: vec![UpdateFileChunk {
                old_lines: vec!["old".into()],
                new_lines: vec!["new".into()],
                change_context: None,
                end_of_file: false,
            }],
        }]
    );
    for input in [
        "cat <<'EOF'\n*** Begin Patch\n*** Add File: add.txt\n+added\n*** End Patch\nEOF",
        "<<EOF\n*** Begin Patch\n*** Add File: add.txt\n+added\n*** End Patch\nEOF",
    ] {
        assert_eq!(
            parse(input).unwrap(),
            vec![Hunk::Add {
                path: "add.txt".into(),
                contents: "added".into(),
            }]
        );
    }
}

#[test]
fn rejects_invalid_and_empty_patch_markers() {
    assert_eq!(
        parse("This is not a valid patch"),
        Err(Error(
            "Invalid patch format: missing Begin/End markers".into()
        ))
    );
    assert_eq!(parse("*** Begin Patch\n*** End Patch").unwrap(), Vec::new());
}

#[test]
fn derives_fuzzy_multiple_and_contextual_line_updates() {
    assert_eq!(
        derive(
            "update.txt",
            &[UpdateFileChunk {
                old_lines: vec!["  old   ".into()],
                new_lines: vec!["new".into()],
                change_context: None,
                end_of_file: false,
            }],
            "\u{feff}old\n",
        )
        .unwrap(),
        FileUpdate {
            content: "new\n".into(),
            bom: true,
        }
    );
    let chunks = [
        UpdateFileChunk {
            old_lines: vec!["line 2".into()],
            new_lines: vec!["LINE 2".into()],
            change_context: None,
            end_of_file: false,
        },
        UpdateFileChunk {
            old_lines: vec!["line 4".into()],
            new_lines: vec!["LINE 4".into()],
            change_context: None,
            end_of_file: false,
        },
    ];
    assert_eq!(
        derive("update.txt", &chunks, "line 1\nline 2\nline 3\nline 4\n")
            .unwrap()
            .content,
        "line 1\nLINE 2\nline 3\nLINE 4\n"
    );
    assert_eq!(
        derive(
            "update.txt",
            &[UpdateFileChunk {
                old_lines: vec!["x=10".into()],
                new_lines: vec!["x=11".into()],
                change_context: Some("fn b".into()),
                end_of_file: false,
            }],
            "fn a\nx=10\nfn b\nx=10\n",
        )
        .unwrap()
        .content,
        "fn a\nx=10\nfn b\nx=11\n"
    );
}

#[test]
fn derives_empty_unterminated_and_normalized_punctuation_lines() {
    assert_eq!(
        derive(
            "empty.txt",
            &[UpdateFileChunk {
                old_lines: vec![],
                new_lines: vec!["First line".into()],
                change_context: None,
                end_of_file: false,
            }],
            "",
        )
        .unwrap()
        .content,
        "First line\n"
    );
    assert_eq!(
        derive(
            "no-newline.txt",
            &[UpdateFileChunk {
                old_lines: vec!["old".into()],
                new_lines: vec!["new".into()],
                change_context: None,
                end_of_file: false,
            }],
            "old",
        )
        .unwrap()
        .content,
        "new\n"
    );
    for (original, old, new, expected) in [
        ("  line\n", "line", "next", "next\n"),
        ("line  \n", "line", "next", "next\n"),
        (
            "He said “hello”\n",
            "He said \"hello\"",
            "He said \"hi\"",
            "He said \"hi\"\n",
        ),
    ] {
        assert_eq!(
            derive(
                "line.txt",
                &[UpdateFileChunk {
                    old_lines: vec![old.into()],
                    new_lines: vec![new.into()],
                    change_context: None,
                    end_of_file: false,
                }],
                original,
            )
            .unwrap()
            .content,
            expected
        );
    }
}

#[test]
fn honors_eof_anchor_and_joins_bom_once() {
    assert_eq!(
        derive(
            "update.txt",
            &[UpdateFileChunk {
                old_lines: vec!["marker".into(), "end".into()],
                new_lines: vec!["marker changed".into(), "end".into()],
                change_context: None,
                end_of_file: true,
            }],
            "marker\nmiddle\nmarker\nend\n",
        )
        .unwrap()
        .content,
        "marker\nmiddle\nmarker changed\nend\n"
    );
    assert_eq!(join_bom("\u{feff}value", true), "\u{feff}value");
    assert_eq!(join_bom("value", false), "value");
}

#[test]
fn ignores_malformed_hunk_body_lines_like_typescript() {
    assert_eq!(
        parse("*** Begin Patch\n*** Add File: add.txt\nmissing plus\n*** End Patch").unwrap(),
        vec![Hunk::Add {
            path: "add.txt".into(),
            contents: String::new(),
        }]
    );
    assert_eq!(
        parse("*** Begin Patch\n*** Update File: update.txt\n*** End Patch").unwrap(),
        vec![Hunk::Update {
            path: "update.txt".into(),
            move_path: None,
            chunks: Vec::new(),
        }]
    );
    assert_eq!(
        parse("*** Begin Patch\n*** Delete File: delete.txt\nunexpected body\n*** End Patch")
            .unwrap(),
        vec![Hunk::Delete {
            path: "delete.txt".into(),
        }]
    );
}
