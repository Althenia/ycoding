use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_core::{
    resources::config::{Configuration, LoadOptions, Roots},
    session::{read_instructions::Service, store::Service as SessionStore},
};
use ycoding_schema::{DomainEncode, JsonValue, session, session_message};
use ycoding_store::session::{Message, MessageTable, Sequence, SequenceTable};

#[path = "session_support/mod.rs"]
mod support;

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "read_instructions_{}_{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn setup(max_bytes: Option<usize>) -> (ycoding_store::Store, TempDir, Arc<Configuration>) {
    let store = support::store();
    let root = TempDir::new();
    let config = Arc::new(
        Configuration::load(LoadOptions {
            directory: root.path().to_owned(),
            roots: Roots::development(root.path()).unwrap(),
            project: true,
            file: None,
            content: Some(match max_bytes {
                Some(bytes) => format!(r#"{{"instruction_max_bytes":{bytes}}}"#),
                None => "{}".into(),
            }),
            env: BTreeMap::new(),
        })
        .unwrap(),
    );
    (store, root, config)
}

fn loader(store: &ycoding_store::Store, root: &Path, config: Arc<Configuration>) -> Service {
    Service::new(SessionStore::new(store.client()), root.to_owned(), config)
}

fn id() -> session::Id {
    session::Id::new("ses_one").unwrap()
}

fn synthetics(store: &ycoding_store::Store) -> Vec<session_message::Synthetic> {
    SessionStore::new(store.client())
        .context(&id())
        .unwrap()
        .into_iter()
        .filter_map(|message| match message {
            session_message::Info::Synthetic(message) => Some(message),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn overlapping_concurrent_loads_publish_each_path_once_in_input_order() {
    let (store, root, config) = setup(None);
    fs::write(root.path().join("first.md"), "one").unwrap();
    fs::write(root.path().join("second.md"), "two").unwrap();
    let service = Arc::new(loader(&store, root.path(), config));
    let session_id = id();
    let (left, right) = tokio::join!(
        service.load(
            &session_id,
            vec![root.path().join("first.md"), root.path().join("second.md")]
        ),
        service.load(&session_id, vec![root.path().join("second.md")]),
    );
    left.unwrap();
    right.unwrap();
    let messages = synthetics(&store);
    assert_eq!(messages.len(), 1);
    let expected_text = format!(
        "Instructions from: {}\none\n\nInstructions from: {}\ntwo",
        root.path().join("first.md").display(),
        root.path().join("second.md").display()
    );
    assert_eq!(messages[0].text.as_str(), Some(expected_text.as_str()));
    assert_eq!(
        messages[0]
            .description
            .as_ref()
            .and_then(|text| text.as_str()),
        Some("Loaded first.md, second.md")
    );
    let expected_metadata = ycoding_schema::parse_json(&format!(
        "{{\"instruction\":{{\"paths\":[{},{}]}}}}",
        ycoding_schema::stringify_json(&JsonValue::String(
            root.path()
                .join("first.md")
                .to_string_lossy()
                .into_owned()
                .into()
        )),
        ycoding_schema::stringify_json(&JsonValue::String(
            root.path()
                .join("second.md")
                .to_string_lossy()
                .into_owned()
                .into()
        ))
    ))
    .unwrap();
    let JsonValue::Object(expected_metadata) = expected_metadata else {
        panic!()
    };
    assert_eq!(messages[0].metadata, Some(expected_metadata));
}

#[tokio::test]
async fn fresh_loader_uses_context_metadata_and_reinjects_only_after_context_compaction() {
    let (store, root, config) = setup(None);
    let path = root.path().join("nested/AGENTS.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "nested").unwrap();
    loader(&store, root.path(), config.clone())
        .load(&id(), vec![path.clone()])
        .await
        .unwrap();
    loader(&store, root.path(), config.clone())
        .load(&id(), vec![path.clone()])
        .await
        .unwrap();
    assert_eq!(synthetics(&store).len(), 1);
    assert!(
        synthetics(&store)[0]
            .metadata
            .as_ref()
            .unwrap()
            .get(&"instruction".into())
            .is_some()
    );
    let compacted = session_message::CompactionCompletedV1 {
        base: session_message::CompactionBase {
            id: session_message::Id::new("msg_compacted").unwrap(),
            metadata: None,
            time: session_message::BaseTime {
                created: ycoding_schema::schema::DateTimeUtcFromMillis::new(1.0).unwrap(),
            },
        },
        reason: "manual".into(),
        summary: "covered".into(),
        recent: "".into(),
        messages: None,
        tokens: None,
    }
    .encode();
    store
        .submit(|tx| {
            MessageTable::insert(
                tx,
                &Message {
                    id: "msg_compacted".into(),
                    session_id: "ses_one".into(),
                    type_: "compaction".into(),
                    seq: 1,
                    time_created: 1,
                    time_updated: 1,
                    data: compacted,
                },
            )?;
            SequenceTable::put(
                tx,
                &Sequence {
                    aggregate_id: "ses_one".into(),
                    seq: 1,
                    owner_id: None,
                },
            )?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(synthetics(&store).is_empty());
    let service = loader(&store, root.path(), config);
    service.load(&id(), vec![path]).await.unwrap();
    assert_eq!(synthetics(&store).len(), 1);
}

#[tokio::test]
async fn unreadable_paths_are_skipped_and_no_event_is_published_when_none_are_readable() {
    let (store, root, config) = setup(None);
    let missing = root.path().join("missing.md");
    loader(&store, root.path(), config.clone())
        .load(&id(), vec![missing.clone()])
        .await
        .unwrap();
    assert!(synthetics(&store).is_empty());
    fs::write(root.path().join("readable.md"), "readable").unwrap();
    loader(&store, root.path(), config)
        .load(&id(), vec![missing, root.path().join("readable.md")])
        .await
        .unwrap();
    assert_eq!(synthetics(&store).len(), 1);
    assert_eq!(
        synthetics(&store)[0].text.as_str().unwrap(),
        format!(
            "Instructions from: {}\nreadable",
            root.path().join("readable.md").display()
        )
    );
}

#[tokio::test]
async fn byte_limit_and_outside_root_description_match_read_rendering() {
    let (store, root, config) = setup(Some(3));
    let path = root.path().join("AGENTS.md");
    fs::write(&path, "four").unwrap();
    loader(&store, root.path(), config)
        .load(&id(), vec![path.clone()])
        .await
        .unwrap();
    let message = synthetics(&store).pop().unwrap();
    assert_eq!(
        message.text.as_str().unwrap().split_once('\n').unwrap().1,
        ycoding_core::resources::instruction_discovery::render_content(
            path.to_str().unwrap(),
            "four",
            Some(3),
            "read"
        )
        .content
    );
    assert_eq!(
        message.description.as_ref().unwrap().as_str(),
        Some("Loaded AGENTS.md")
    );
    let expected_metadata = ycoding_schema::parse_json(&format!(
        r#"{{"instruction":{{"paths":[{}]}}}}"#,
        ycoding_schema::stringify_json(&JsonValue::String(
            path.to_string_lossy().into_owned().into()
        ))
    ))
    .unwrap();
    let JsonValue::Object(expected_metadata) = expected_metadata else {
        panic!()
    };
    assert_eq!(message.metadata, Some(expected_metadata));
    let external = TempDir::new();
    let external_path = external.path().join("outside.md");
    fs::write(&external_path, "outside").unwrap();
    loader(
        &store,
        root.path(),
        Arc::new(
            Configuration::load(LoadOptions {
                directory: root.path().to_owned(),
                roots: Roots::development(root.path()).unwrap(),
                project: true,
                file: None,
                content: Some("{}".into()),
                env: BTreeMap::new(),
            })
            .unwrap(),
        ),
    )
    .load(&id(), vec![external_path.clone()])
    .await
    .unwrap();
    let outside = synthetics(&store).pop().unwrap();
    assert_eq!(
        outside.description.as_ref().unwrap().as_str(),
        Some(format!("Loaded {}", external_path.display()).as_str())
    );
}
