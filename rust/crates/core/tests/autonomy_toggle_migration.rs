use std::collections::BTreeSet;
use ycoding_core::session::autonomy::{DecisionMode, Service, State};
use ycoding_schema::{JsonValue, parse_json, session};
use ycoding_store::{
    KeyPart, Store, database_format, resources,
    session::{Session, SessionTable},
    tuple_key,
};

#[path = "autonomy_support/mod.rs"]
mod support;

const GOAL: &str =
    r#"{"text":"Finish","status":"active","iteration":1,"noProgress":0,"maxNoProgress":3}"#;
const STABLE_TOGGLE: &str = "20261020120000_session-yolo-toggle";
const LEDGER: &str = "session-yolo-toggle-v1";

fn insert(store: &Store, rows: Vec<(String, Option<String>, i64, Option<i64>)>) {
    store
        .submit(move |tx| {
            for (name, autonomy, revision, archived) in rows {
                let mut row = support::record(&name);
                row.autonomy = autonomy.map(|json| parse_json(&json).unwrap());
                row.autonomy_revision = revision;
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

fn stable_migration(store: &Store, id: &str) {
    let id = id.to_owned();
    store
        .submit(move |tx| {
            database_format::MigrationTable::put(
                tx,
                &database_format::Migration {
                    id: id.into(),
                    time_completed: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn row(store: &Store, name: &str) -> Session {
    store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&name.into())]))
        .unwrap()
        .unwrap()
}

fn json(value: &str) -> Option<JsonValue> {
    Some(parse_json(value).unwrap())
}

fn ledger_named(store: &Store, name: &str) -> bool {
    store
        .snapshot()
        .unwrap()
        .get::<resources::MigrationTable>(&tuple_key(&[KeyPart::String(&name.into())]))
        .unwrap()
        .is_some()
}

fn insert_ledger(store: &Store, name: &str) {
    let name = name.to_owned();
    store
        .submit(move |tx| {
            resources::MigrationTable::insert(
                tx,
                &resources::Migration {
                    name: name.into(),
                    time_completed: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn field(value: &Option<JsonValue>, key: &str) -> Option<JsonValue> {
    match value {
        Some(JsonValue::Object(object)) => object.get(&key.into()).cloned(),
        _ => None,
    }
}

fn keys(value: &Option<JsonValue>) -> BTreeSet<String> {
    match value {
        Some(JsonValue::Object(object)) => object
            .iter()
            .map(|(key, _)| key.to_utf8().unwrap())
            .collect(),
        _ => BTreeSet::new(),
    }
}

fn modes(store: &Store, name: &str) -> [String; 3] {
    let autonomy = row(store, name).autonomy;
    ["permissions", "guardrails", "answers"].map(|key| match field(&autonomy, key) {
        Some(JsonValue::String(mode)) => mode.to_utf8().unwrap(),
        other => panic!("{name} {key}: {other:?}"),
    })
}

fn assert_modes(store: &Store, name: &str, expected: [&str; 3]) {
    assert_eq!(modes(store, name), expected, "{name}");
    let autonomy = row(store, name).autonomy;
    assert_eq!(field(&autonomy, "mode"), json(r#""normal""#), "{name}");
    for retired in ["yolo", "autoPermission", "autoGuardrail", "autoAnswer"] {
        assert_eq!(field(&autonomy, retired), None, "{name} {retired}");
    }
}

fn legacy_rows() -> Vec<(String, Option<String>, i64, Option<i64>)> {
    [
        ("ses_absent", Some(r#"{"mode":"normal"}"#.to_owned()), 7, None),
        (
            "ses_bool_false",
            Some(r#"{"mode":"normal","yolo":false,"autoPermission":false}"#.to_owned()),
            4,
            None,
        ),
        ("ses_bool_true", Some(r#"{"mode":"yolo","yolo":true}"#.to_owned()), 4, None),
        (
            "ses_normal_true",
            Some(r#"{"mode":"normal","yolo":true,"autoAnswer":false}"#.to_owned()),
            2,
            None,
        ),
        ("ses_mode_yolo_absent", Some(r#"{"mode":"yolo"}"#.to_owned()), 1, None),
        (
            "ses_mode_yolo_false",
            Some(r#"{"mode":"yolo","yolo":false,"autoAnswer":true}"#.to_owned()),
            6,
            None,
        ),
        (
            "ses_mode_goal_one",
            Some(format!(r#"{{"mode":"goal","yolo":1,"goal":{GOAL},"sleep":{{}}}}"#)),
            3,
            None,
        ),
        (
            "ses_mode_goal_absent",
            Some(format!(r#"{{"mode":"goal","goal":{GOAL}}}"#)),
            3,
            None,
        ),
        ("ses_null", None, 0, None),
        (
            "ses_y0",
            Some(r#"{"mode":"normal","yolo":0,"autoAnswer":true}"#.to_owned()),
            3,
            None,
        ),
        ("ses_y1", Some(r#"{"mode":"normal","yolo":1}"#.to_owned()), 3, None),
        (
            "ses_y2_goal",
            Some(format!(
                r#"{{"mode":"normal","yolo":2,"goal":{GOAL},"sleep":{{}},"autoAnswer":true,"guardrailDecision":true,"extra":{{"kept":[1,"two",null]}}}}"#
            )),
            2,
            None,
        ),
        ("ses_y3", Some(r#"{"mode":"normal","yolo":3}"#.to_owned()), 5, Some(12)),
        ("ses_y7", Some(r#"{"mode":"normal","yolo":7}"#.to_owned()), 1, None),
        ("ses_yneg", Some(r#"{"mode":"normal","yolo":-1}"#.to_owned()), 1, None),
        ("ses_real", Some(r#"{"mode":"normal","yolo":1.5}"#.to_owned()), 1, None),
        ("ses_text", Some(r#"{"mode":"normal","yolo":"2"}"#.to_owned()), 1, None),
        ("ses_array", Some("[2]".to_owned()), 1, None),
    ]
    .into_iter()
    .map(|(name, autonomy, revision, archived)| (name.to_owned(), autonomy, revision, archived))
    .collect()
}

const LEDGERS: [&str; 2] = [LEDGER, "session-decision-modes-v1"];

#[tokio::test]
async fn legacy_rows_migrate_to_per_category_modes_once_and_every_other_value_is_kept() {
    let store = support::store();
    insert(&store, legacy_rows());
    let untouched = ["ses_one", "ses_two", "ses_null", "ses_array"].map(|name| row(&store, name));
    let service = Service::new(store.client());

    assert_eq!(service.migrate_stored_autonomy().await.unwrap(), 30);

    for (name, expected, revision) in [
        ("ses_absent", ["manual", "manual", "manual"], 8),
        ("ses_bool_false", ["manual", "manual", "manual"], 5),
        ("ses_bool_true", ["auto", "auto", "manual"], 6),
        ("ses_normal_true", ["auto", "auto", "manual"], 4),
        ("ses_mode_yolo_absent", ["auto", "auto", "manual"], 3),
        ("ses_mode_yolo_false", ["auto", "auto", "auto"], 8),
        ("ses_mode_goal_one", ["auto", "manual", "manual"], 5),
        ("ses_mode_goal_absent", ["manual", "manual", "manual"], 5),
        ("ses_y0", ["manual", "manual", "auto"], 5),
        ("ses_y1", ["auto", "manual", "manual"], 5),
        ("ses_y2_goal", ["auto", "auto", "auto"], 4),
        ("ses_y3", ["auto", "auto", "manual"], 7),
        ("ses_y7", ["manual", "manual", "manual"], 3),
        ("ses_yneg", ["manual", "manual", "manual"], 3),
        ("ses_real", ["manual", "manual", "manual"], 3),
        ("ses_text", ["manual", "manual", "manual"], 3),
    ] {
        assert_modes(&store, name, expected);
        let migrated = row(&store, name);
        assert_eq!(migrated.autonomy_revision, revision, "{name}");
        assert_eq!(migrated.time_updated, 11, "{name}");
    }
    assert_eq!(row(&store, "ses_y3").time_archived, Some(12));
    for previous in &untouched {
        assert_eq!(&row(&store, previous.id.as_str().unwrap()), previous);
    }
    for ledger in LEDGERS {
        assert!(ledger_named(&store, ledger), "{ledger}");
    }

    let goal_row = row(&store, "ses_y2_goal").autonomy;
    assert_eq!(field(&goal_row, "goal"), json(GOAL));
    assert_eq!(field(&goal_row, "sleep"), json("{}"));
    assert_eq!(
        field(&goal_row, "extra"),
        json(r#"{"kept":[1,"two",null]}"#)
    );
    assert_eq!(
        keys(&goal_row),
        [
            "mode",
            "permissions",
            "guardrails",
            "answers",
            "goal",
            "sleep",
            "guardrailDecision",
            "extra"
        ]
        .map(String::from)
        .into()
    );

    let goal = service
        .get(&session::Id::new("ses_y2_goal").unwrap())
        .unwrap();
    assert_eq!(
        (goal.permissions, goal.guardrails, goal.answers),
        (DecisionMode::Auto, DecisionMode::Auto, DecisionMode::Auto)
    );
    assert!(goal.goal.is_some_and(|goal| goal.is_active()));
    assert!(goal.defer);
    let sleeping = service
        .get(&session::Id::new("ses_mode_goal_one").unwrap())
        .unwrap();
    assert_eq!(sleeping.permissions, DecisionMode::Auto);
    assert!(sleeping.defer && sleeping.goal.is_some());

    let after = legacy_rows()
        .iter()
        .map(|(name, ..)| row(&store, name))
        .collect::<Vec<_>>();
    assert_eq!(service.migrate_stored_autonomy().await.unwrap(), 0);
    for previous in &after {
        assert_eq!(&row(&store, previous.id.as_str().unwrap()), previous);
    }
}

#[tokio::test]
async fn each_legacy_category_flag_wins_over_boolean_yolo_and_yolo_wins_over_manual() {
    let store = support::store();
    let cases = [
        (r#""yolo":false"#, ["manual", "manual", "manual"]),
        (r#""yolo":true"#, ["yolo", "yolo", "yolo"]),
        (
            r#""yolo":true,"autoPermission":true"#,
            ["auto", "yolo", "yolo"],
        ),
        (
            r#""yolo":true,"autoGuardrail":true"#,
            ["yolo", "auto", "yolo"],
        ),
        (r#""yolo":true,"autoAnswer":true"#, ["yolo", "yolo", "auto"]),
        (
            r#""yolo":true,"autoPermission":false,"autoGuardrail":false,"autoAnswer":false"#,
            ["yolo", "yolo", "yolo"],
        ),
        (
            r#""yolo":false,"autoPermission":true,"autoGuardrail":true,"autoAnswer":true"#,
            ["auto", "auto", "auto"],
        ),
        (
            r#""yolo":false,"autoPermission":false,"autoGuardrail":false,"autoAnswer":false"#,
            ["manual", "manual", "manual"],
        ),
        (r#""autoAnswer":true"#, ["manual", "manual", "auto"]),
    ];
    insert(
        &store,
        cases
            .iter()
            .enumerate()
            .map(|(index, (stored, _))| {
                (
                    format!("ses_case_{index}"),
                    Some(format!(r#"{{"mode":"normal",{stored}}}"#)),
                    1,
                    None,
                )
            })
            .collect(),
    );
    insert_ledger(&store, LEDGER);
    let service = Service::new(store.client());
    assert_eq!(
        service.migrate_stored_autonomy().await.unwrap(),
        cases.len()
    );
    for (index, (stored, expected)) in cases.iter().enumerate() {
        assert_modes(&store, &format!("ses_case_{index}"), *expected);
        assert_eq!(
            row(&store, &format!("ses_case_{index}")).autonomy_revision,
            2,
            "{stored}"
        );
    }
}

#[tokio::test]
async fn a_row_already_in_the_new_shape_is_never_rewritten() {
    let store = support::store();
    let stored = r#"{"mode":"normal","permissions":"auto","guardrails":"manual","answers":"yolo","sleep":{}}"#;
    insert(
        &store,
        vec![("ses_new".to_owned(), Some(stored.to_owned()), 9, None)],
    );
    let before = row(&store, "ses_new");
    let service = Service::new(store.client());
    assert_eq!(service.migrate_stored_autonomy().await.unwrap(), 0);
    assert_eq!(row(&store, "ses_new"), before);
    assert_eq!(row(&store, "ses_new").autonomy, json(stored));
    for ledger in LEDGERS {
        assert!(ledger_named(&store, ledger), "{ledger}");
    }
}

#[tokio::test]
async fn the_ledgers_protect_legacy_shaped_rows_written_after_the_migration() {
    let store = support::store();
    let service = Service::new(store.client());
    assert_eq!(service.migrate_stored_autonomy().await.unwrap(), 0);
    insert(
        &store,
        vec![(
            "ses_new".to_owned(),
            Some(r#"{"mode":"normal","yolo":true}"#.to_owned()),
            1,
            None,
        )],
    );
    assert_eq!(service.migrate_stored_autonomy().await.unwrap(), 0);
    assert_eq!(
        row(&store, "ses_new").autonomy,
        json(r#"{"mode":"normal","yolo":true}"#)
    );
    let read = service.get(&session::Id::new("ses_new").unwrap()).unwrap();
    assert_eq!(read, State::default());
}

#[tokio::test]
async fn a_stable_store_that_already_migrated_keeps_boolean_yolo_as_the_yolo_mode() {
    let store = support::store();
    stable_migration(&store, STABLE_TOGGLE);
    insert(
        &store,
        vec![
            (
                "ses_stable_yolo".to_owned(),
                Some(r#"{"mode":"normal","yolo":true,"autoAnswer":true}"#.to_owned()),
                3,
                None,
            ),
            (
                "ses_stable_flags".to_owned(),
                Some(r#"{"mode":"normal","yolo":false,"autoPermission":true}"#.to_owned()),
                3,
                None,
            ),
            (
                "ses_beta_level".to_owned(),
                Some(r#"{"mode":"normal","yolo":2,"autoAnswer":true}"#.to_owned()),
                3,
                None,
            ),
            (
                "ses_beta_one".to_owned(),
                Some(r#"{"mode":"normal","yolo":1}"#.to_owned()),
                3,
                None,
            ),
        ],
    );
    let service = Service::new(store.client());
    assert_eq!(service.migrate_stored_autonomy().await.unwrap(), 6);
    assert_modes(&store, "ses_stable_yolo", ["yolo", "yolo", "auto"]);
    assert_eq!(row(&store, "ses_stable_yolo").autonomy_revision, 4);
    assert_modes(&store, "ses_stable_flags", ["auto", "manual", "manual"]);
    assert_modes(&store, "ses_beta_level", ["auto", "auto", "auto"]);
    assert_eq!(row(&store, "ses_beta_level").autonomy_revision, 5);
    assert_modes(&store, "ses_beta_one", ["auto", "manual", "manual"]);
    let stable = service
        .get(&session::Id::new("ses_stable_yolo").unwrap())
        .unwrap();
    assert_eq!(
        (stable.permissions, stable.guardrails, stable.answers),
        (DecisionMode::Yolo, DecisionMode::Yolo, DecisionMode::Auto)
    );
}

#[tokio::test]
async fn an_unrelated_stable_migration_does_not_change_boolean_handling() {
    let store = support::store();
    stable_migration(&store, "20261017090000_session-yolo-level");
    insert(
        &store,
        vec![(
            "ses_legacy_true".to_owned(),
            Some(r#"{"mode":"normal","yolo":true}"#.to_owned()),
            1,
            None,
        )],
    );
    let service = Service::new(store.client());
    assert_eq!(service.migrate_stored_autonomy().await.unwrap(), 2);
    assert_modes(&store, "ses_legacy_true", ["auto", "auto", "manual"]);
}

#[tokio::test]
async fn every_level_is_migrated_across_bounded_batches() {
    let store = support::store();
    insert(
        &store,
        (0..1205)
            .map(|index| {
                (
                    format!("ses_bulk_{index:04}"),
                    Some(format!(r#"{{"mode":"normal","yolo":{}}}"#, index % 4)),
                    5,
                    None,
                )
            })
            .collect(),
    );
    let service = Service::new(store.client());
    assert_eq!(service.migrate_stored_autonomy().await.unwrap(), 2410);
    for index in [0, 1, 2, 3, 1203, 1204] {
        let name = format!("ses_bulk_{index:04}");
        let expected = match index % 4 {
            0 => ["manual", "manual", "manual"],
            1 => ["auto", "manual", "manual"],
            _ => ["auto", "auto", "manual"],
        };
        assert_modes(&store, &name, expected);
        assert_eq!(row(&store, &name).autonomy_revision, 7, "{index}");
    }
    assert_eq!(service.migrate_stored_autonomy().await.unwrap(), 0);
}

#[test]
fn a_legacy_shape_read_before_migration_grants_nothing() {
    for stored in [
        r#""yolo":0"#,
        r#""yolo":1"#,
        r#""yolo":2"#,
        r#""yolo":3"#,
        r#""yolo":true,"autoPermission":true,"autoGuardrail":true,"autoAnswer":true"#,
    ] {
        let stored = parse_json(&format!(r#"{{"mode":"normal",{stored},"goal":{GOAL}}}"#)).unwrap();
        let state = State::read(Some(&stored));
        assert_eq!(state, State::default(), "{stored:?}");
        let effective = state.effective();
        assert!(!effective.can_yolo_permission() && !effective.can_auto_permission());
        assert!(!effective.can_yolo_guardrail() && !effective.can_auto_guardrail());
        assert!(!effective.can_yolo_answer() && !effective.can_auto_answer());
    }
}
