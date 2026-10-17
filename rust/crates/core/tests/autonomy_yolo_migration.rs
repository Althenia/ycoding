use ycoding_core::session::autonomy::{Service, YoloLevel};
use ycoding_schema::{JsonValue, parse_json, session};
use ycoding_store::{KeyPart, Store, session::SessionTable, tuple_key};

#[path = "autonomy_support/mod.rs"]
mod support;

const GOAL: &str = r#"{"text":"Finish safely","rawText":"Finish safely","iteration":2,"noProgress":1,"maxNoProgress":3,"status":"active"}"#;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn raw(level: &str) -> String {
    format!(
        r#"{{"mode":"normal","yolo":{level},"autoAnswer":true,"guardrailDecision":true,"sleep":{{"priorGuardrailDecision":true}},"goal":{GOAL},"extra":{{"kept":[1,"two",null]}}}}"#
    )
}

fn insert(store: &Store, rows: Vec<(String, Option<String>, Option<i64>)>) {
    store
        .submit(move |tx| {
            for (name, autonomy, archived) in rows {
                let mut row = support::record(&name);
                row.autonomy = autonomy.map(|json| parse_json(&json).unwrap());
                row.autonomy_revision = 5;
                row.time_updated = 11;
                row.time_archived = archived;
                SessionTable::insert(tx, &row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn row(store: &Store, name: &str) -> ycoding_store::session::Session {
    store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&name.into())]))
        .unwrap()
        .unwrap()
}

fn fixture() -> Store {
    let store = support::store();
    insert(
        &store,
        vec![
            ("ses_three".into(), Some(raw("3")), None),
            ("ses_archived".into(), Some(raw("3")), Some(12)),
            (
                "ses_legacy_mode".into(),
                Some(r#"{"mode":"yolo","yolo":3}"#.into()),
                None,
            ),
            ("ses_two_kept".into(), Some(raw("2")), None),
            ("ses_four".into(), Some(raw("4")), None),
            ("ses_text".into(), Some(raw(r#""3""#)), None),
            ("ses_boolean".into(), Some(raw("true")), None),
            ("ses_fraction".into(), Some(raw("3.5")), None),
            ("ses_array".into(), Some("[3]".into()), None),
            ("ses_empty".into(), None, None),
        ],
    );
    store
}

#[tokio::test]
async fn stored_level_three_becomes_two_once_and_every_other_value_is_kept() {
    let store = fixture();
    let before = |name: &str| row(&store, name);
    let untouched = [
        "ses_one",
        "ses_two",
        "ses_two_kept",
        "ses_four",
        "ses_text",
        "ses_boolean",
        "ses_fraction",
        "ses_array",
        "ses_empty",
    ]
    .map(before);
    let service = Service::new(store.client());

    assert_eq!(service.migrate_stored_yolo().await.unwrap(), 3);

    for name in ["ses_three", "ses_archived"] {
        let migrated = row(&store, name);
        assert_eq!(
            migrated.autonomy,
            Some(parse_json(&raw("2")).unwrap()),
            "{name}"
        );
        assert_eq!(migrated.autonomy_revision, 6, "{name}");
        assert_eq!(migrated.time_updated, 11, "{name}");
        let mut expected = support::record(name);
        expected.autonomy = migrated.autonomy.clone();
        expected.autonomy_revision = 6;
        expected.time_updated = 11;
        expected.time_archived = (name == "ses_archived").then_some(12);
        assert_eq!(migrated, expected, "{name}");
    }
    let legacy = row(&store, "ses_legacy_mode");
    assert_eq!(
        legacy.autonomy,
        Some(parse_json(r#"{"mode":"yolo","yolo":2}"#).unwrap())
    );
    assert_eq!(legacy.autonomy_revision, 6);
    for previous in &untouched {
        assert_eq!(&row(&store, previous.id.as_str().unwrap()), previous);
    }

    let state = service.get(&id("ses_three")).unwrap();
    assert_eq!(state.yolo, YoloLevel::GUARDRAILS);
    assert_eq!(state.auto_answer, Some(true));
    assert!(state.goal.is_some_and(|goal| goal.is_active()));

    assert_eq!(service.migrate_stored_yolo().await.unwrap(), 0);
    assert_eq!(row(&store, "ses_three").autonomy_revision, 6);
    assert_eq!(row(&store, "ses_legacy_mode").autonomy_revision, 6);
}

#[tokio::test]
async fn every_stored_level_three_is_migrated_across_bounded_batches() {
    let store = support::store();
    insert(
        &store,
        (0..1205)
            .map(|index| {
                (
                    format!("ses_bulk_{index:04}"),
                    Some(r#"{"mode":"normal","yolo":3}"#.to_owned()),
                    None,
                )
            })
            .collect(),
    );
    let service = Service::new(store.client());
    assert_eq!(service.migrate_stored_yolo().await.unwrap(), 1205);
    let snapshot = store.snapshot().unwrap();
    let rows = snapshot
        .scan::<SessionTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            usize::MAX,
        )
        .unwrap();
    let bulk = rows
        .iter()
        .filter(|row| row.id.as_str().unwrap().starts_with("ses_bulk_"))
        .collect::<Vec<_>>();
    assert_eq!(bulk.len(), 1205);
    for row in bulk {
        assert_eq!(
            row.autonomy,
            Some(parse_json(r#"{"mode":"normal","yolo":2}"#).unwrap())
        );
        assert_eq!(row.autonomy_revision, 6);
    }
    assert_eq!(service.migrate_stored_yolo().await.unwrap(), 0);
}

#[test]
fn a_raw_level_three_read_before_migration_is_not_level_two() {
    let stored: JsonValue = parse_json(&raw("3")).unwrap();
    assert_eq!(
        ycoding_core::session::autonomy::State::read(Some(&stored)).yolo,
        YoloLevel::OFF
    );
}
