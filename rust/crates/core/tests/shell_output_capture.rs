#![cfg(unix)]
mod shell_temp;

use shell_temp::Temp;
use std::{fs, time::Duration};
use ycoding_core::{
    platform::shell::{Shell, paging::Page},
    resources::config::{Configuration, LoadOptions, Roots},
};
use ycoding_schema::{
    DomainDecode, JsonValue,
    shell::{CreateInput, Id, Status},
};

struct World {
    dir: Temp,
    _store: ycoding_store::Store,
    shell: Shell,
    config: Configuration,
}
impl World {
    async fn new() -> Self {
        let dir = Temp::new("shell-capture");
        let roots = Roots::development(dir.path()).unwrap();
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
            ycoding_store::Metadata::new([11; 16], 1),
        )
        .unwrap();
        let config = Configuration::load(LoadOptions {
            directory: dir.path().to_path_buf(),
            roots: roots.clone(),
            project: false,
            content: Some(r#"{"shell":"/bin/sh","shell_sandbox":"disabled"}"#.into()),
            file: None,
            env: Default::default(),
        })
        .unwrap();
        let shell = Shell::new(&roots, dir.path().to_path_buf(), "project", store.client())
            .await
            .unwrap();
        Self {
            dir,
            _store: store,
            shell,
            config,
        }
    }
    fn fixture(&self, name: &str, bytes: &[u8]) -> String {
        let file = self.dir.path().join(name);
        fs::write(&file, bytes).unwrap();
        file.display().to_string()
    }
    async fn create(&self, command: &str) -> Id {
        let mut value = ycoding_schema::JsonObject::new();
        value.insert("command".into(), JsonValue::String(command.into()));
        value.insert("timeout".into(), JsonValue::Number(0.0));
        let input = CreateInput::decode(&JsonValue::Object(value)).unwrap();
        let mut prepared = self.shell.prepare(input, &self.config).unwrap();
        self.shell.create(&mut prepared).await.unwrap().id
    }
    async fn settled_capture(&self, bytes: &[u8]) -> Id {
        let file = self.fixture("capture.bin", bytes);
        let id = self.create(&format!("cat '{file}'")).await;
        self.shell.wait(&id).await.unwrap();
        id
    }
    async fn pages(&self, id: &Id, start: usize, limit: usize) -> Vec<Page> {
        let mut pages = Vec::new();
        let mut cursor = start;
        loop {
            let page = self.shell.output(id, cursor, limit).await.unwrap();
            assert!(page.cursor <= page.size);
            let done = page.cursor >= page.size;
            if !done {
                assert!(
                    page.cursor > cursor,
                    "page did not advance: {} of {}",
                    page.cursor,
                    page.size
                );
            }
            cursor = page.cursor;
            pages.push(page);
            if done {
                return pages;
            }
            assert!(pages.len() < 8_192, "paging did not terminate");
        }
    }
}

fn joined(pages: &[Page]) -> String {
    pages.iter().map(|page| page.output.as_str()).collect()
}

fn boundary_fixture() -> Vec<u8> {
    [
        "line one\n".as_bytes(),
        "é€😀".as_bytes(),
        &[0xe2, 0x41, 0xc3, 0xa9],
        &[0xe2, 0x82],
        &[0xac],
        &[0xf0, 0x9f, 0x41, 0xf0, 0x90, 0x80, 0x80],
        &[
            0x80, 0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xf5, 0x80, 0x80, 0x80, 0x80,
        ],
        &[0xe0, 0x80, 0xaf, 0xc1, 0xbf, 0xef, 0xbf, 0xbd],
        "done\n".as_bytes(),
    ]
    .concat()
}

fn pseudo_random(length: usize) -> Vec<u8> {
    let mut state = 0x9e37_79b9_u32;
    (0..length)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 24) as u8
        })
        .collect()
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_immediately_exiting_shell_exposes_every_captured_byte_once_it_reports_terminal() {
    let world = World::new().await;
    let id = world.create("printf 'fast shell output\\n'").await;
    for _ in 0..1_500 {
        if world.shell.get(&id).await.unwrap().status != Status::Running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let bytes = b"fast shell output\n";
    let page = world.shell.output(&id, 0, 65_536).await.unwrap();
    assert_eq!((page.size, page.cursor), (bytes.len(), bytes.len()));
    assert_eq!(page.output, lossy(bytes));
}

#[tokio::test(flavor = "multi_thread")]
async fn every_page_joins_to_the_standard_decoding_of_the_captured_bytes() {
    let world = World::new().await;
    let bytes = boundary_fixture();
    let id = world.settled_capture(&bytes).await;
    for limit in (1..=32).chain([65_536]) {
        let pages = world.pages(&id, 0, limit).await;
        let last = pages.last().unwrap();
        assert_eq!((last.size, last.cursor), (bytes.len(), bytes.len()));
        assert_eq!(joined(&pages), lossy(&bytes), "limit={limit}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn bytes_after_a_malformed_sequence_survive_a_page_ending_inside_it() {
    let world = World::new().await;
    let bytes = [b"aaaaaaaaaa".as_slice(), &[0xe2, 0x41, 0xc3, 0xa9], b"z"].concat();
    let id = world.settled_capture(&bytes).await;
    for limit in [11, 12, 13] {
        let output = joined(&world.pages(&id, 0, limit).await);
        assert_eq!(output, lossy(&bytes), "limit={limit}");
        assert!(output.contains("Aéz"));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_capture_larger_than_the_default_limit_pages_without_corrupting_either_region() {
    let world = World::new().await;
    let bytes = [
        "é€😀x".repeat(4_000).into_bytes(),
        boundary_fixture(),
        pseudo_random(24_000),
    ]
    .concat();
    let id = world.settled_capture(&bytes).await;
    for limit in [65_536, 4_096, 13] {
        let pages = world.pages(&id, 0, limit).await;
        assert_eq!(pages.last().unwrap().size, bytes.len());
        assert_eq!(joined(&pages), lossy(&bytes), "limit={limit}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_character_straddling_the_default_limit_is_completed_inside_the_three_byte_allowance() {
    let world = World::new().await;
    for (width, character) in [(2_usize, "é"), (3, "€"), (4, "😀")] {
        for phase in 1..width {
            let bytes = format!(
                "{}{character}{}\n",
                "a".repeat(65_536 - phase),
                character.repeat(51)
            )
            .into_bytes();
            let id = world.settled_capture(&bytes).await;
            let pages = world.pages(&id, 0, 65_536).await;
            assert_eq!(pages.last().unwrap().size, bytes.len());
            assert_eq!(
                pages[0].cursor,
                65_536 + (width - phase),
                "width={width} phase={phase}"
            );
            assert_eq!(joined(&pages), lossy(&bytes));
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_incomplete_live_character_is_held_without_advancing_until_it_completes() {
    let world = World::new().await;
    let first = world.fixture("live-first.bin", &[b"live-".as_slice(), &[0xc3]].concat());
    let second = world.fixture("live-second.bin", &[[0xa9].as_slice(), b"-done\n"].concat());
    let id = world
        .create(&format!("cat '{first}'; sleep 2; cat '{second}'"))
        .await;
    let mut held = None;
    for _ in 0..750 {
        let page = world.shell.output(&id, 0, 65_536).await.unwrap();
        if page.size == 6 && page.output == "live-" {
            held = Some(page);
            break;
        }
        assert_eq!(world.shell.get(&id).await.unwrap().status, Status::Running);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let held = held.expect("the held page was never served");
    assert_eq!((held.cursor, held.size, held.truncated), (5, 6, false));
    let again = world.shell.output(&id, held.cursor, 65_536).await.unwrap();
    assert_eq!(
        (again.output.as_str(), again.cursor, again.size),
        ("", 5, 6)
    );
    world.shell.wait(&id).await.unwrap();
    let rest = world.pages(&id, held.cursor, 65_536).await;
    assert_eq!(format!("{}{}", held.output, joined(&rest)), "live-é-done\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_completable_trailing_prefix_is_never_flushed_as_replacement_while_the_capture_settles() {
    let world = World::new().await;
    for round in 0..8 {
        let prefix = world.fixture(&format!("settle-prefix-{round}.bin"), b"ready-");
        let lead = world.fixture(&format!("settle-lead-{round}.bin"), &[0xc3]);
        let tail = world.fixture(
            &format!("settle-tail-{round}.bin"),
            &[0xa9, b'd', b'o', b'n', b'e', b'\n'],
        );
        let gate = world.dir.path().join(format!("settle-gate-{round}"));
        let id = world
            .create(&format!(
                "cat '{prefix}' '{lead}'; while [ ! -f '{}' ]; do sleep 0.01; done; cat '{tail}'",
                gate.display()
            ))
            .await;
        for _ in 0..500 {
            if world.shell.output(&id, 0, 0).await.unwrap().size >= 7 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let release = tokio::spawn({
            let gate = gate.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(round * 3)).await;
                fs::write(gate, "").unwrap();
            }
        });
        let mut pages = Vec::new();
        let mut cursor = 0;
        loop {
            let page = world.shell.output(&id, cursor, 7).await.unwrap();
            assert!(
                !page.output.contains('\u{fffd}'),
                "round {round}: {:?}",
                page.output
            );
            cursor = page.cursor;
            let finished = page.cursor >= page.size
                && world.shell.get(&id).await.unwrap().status != Status::Running;
            pages.push(page);
            if finished {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        release.await.unwrap();
        assert_eq!(joined(&pages), "ready-édone\n", "round {round}");
        assert_eq!(pages.last().unwrap().cursor, 13);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_incomplete_trailing_sequence_decodes_once_the_capture_has_settled() {
    let world = World::new().await;
    for (index, bytes) in [
        [b"ok\n".as_slice(), &[0xc3]].concat(),
        [b"ok\n".as_slice(), &[0xf0, 0x9f, 0x98]].concat(),
        vec![0x80],
    ]
    .into_iter()
    .enumerate()
    {
        let id = world.settled_capture(&bytes).await;
        let pages = world.pages(&id, 0, 8).await;
        assert_eq!(pages.last().unwrap().cursor, bytes.len(), "{index}");
        assert_eq!(joined(&pages), lossy(&bytes), "{index}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_budget_that_lands_on_a_boundary_returns_exactly_that_many_bytes() {
    let world = World::new().await;
    let id = world.settled_capture(&[b'x'; 64]).await;
    for limit in [1, 7, 13, 64] {
        let page = world.shell.output(&id, 0, limit).await.unwrap();
        assert_eq!((page.output, page.cursor), ("x".repeat(limit), limit));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_zero_limit_reads_nothing_and_a_cursor_past_the_end_clamps_to_the_captured_size() {
    let world = World::new().await;
    let id = world.create("echo ycoding").await;
    world.shell.wait(&id).await.unwrap();
    let size = "ycoding\n".len();
    let zero = world.shell.output(&id, 0, 0).await.unwrap();
    assert_eq!(
        (zero.output.as_str(), zero.cursor, zero.size, zero.truncated),
        ("", 0, size, false)
    );
    let held = world.shell.output(&id, 3, 0).await.unwrap();
    assert_eq!(
        (held.output.as_str(), held.cursor, held.size),
        ("", 3, size)
    );
    for cursor in [size, size + 10] {
        let page = world.shell.output(&id, cursor, 65_536).await.unwrap();
        assert_eq!(
            (page.output.as_str(), page.cursor, page.size),
            ("", size, size)
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mid_character_cursor_advances_with_replacement_characters() {
    let world = World::new().await;
    let bytes = "€x€".as_bytes();
    let id = world.settled_capture(bytes).await;
    let mid = world.shell.output(&id, 1, 65_536).await.unwrap();
    assert_eq!(mid.size, bytes.len());
    assert!(mid.cursor > 1);
    assert!(mid.output.contains('\u{fffd}'));
    let pages = world.pages(&id, mid.cursor, 1).await;
    assert_eq!(pages.last().unwrap().cursor, bytes.len());
}
