use ycoding_schema::{LosslessString, parse_json};
use ycoding_store::{
    Error, KeyPart, Metadata, Options, Store, TableSpec,
    coordination::{self, Group, GroupTable, Member, MemberTable},
    native::{self, DatabaseKind},
    project, session, tuple_key,
};

fn key(id: &str) -> Vec<u8> {
    tuple_key(&[KeyPart::String(&id.into())])
}
fn group(id: &str, master: &str) -> Group {
    Group {
        id: id.into(),
        name: "Synthetic".into(),
        revision: 0,
        master_session_id: master.into(),
        concurrency: None,
        delegated_decisions: None,
        time_created: 1,
        time_updated: 1,
    }
}
fn member(group: &str, id: &str, owner: Option<&str>) -> Member {
    Member {
        group_id: group.into(),
        session_id: id.into(),
        owner_session_id: owner.map(Into::into),
    }
}
fn row(id: &str) -> session::Session {
    session::Session {
        id: id.into(),
        project_id: "prj_coord".into(),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: "/synthetic".into(),
        path: None,
        title: id.into(),
        cost: 0.0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: None,
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 1,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
        usage_pruned_through: None,
        origin: None,
        scope: "bound".into(),
    }
}
fn store() -> Store {
    let store = Store::disposable(
        Options::core(),
        native::catalog(DatabaseKind::Core),
        Metadata::new([21; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_coord".into(),
                    worktree: "/synthetic".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            for id in [
                "ses_master",
                "ses_member",
                "ses_owner",
                "ses_other",
                "ses_retained",
            ] {
                session::SessionTable::insert(tx, &row(id))?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}

#[test]
fn scalar_codec_one_preserves_nullable_fields_odd_strings_and_strict_policy() {
    let mut row = group("cgrp_codec", "ses_master");
    row.name = LosslessString::from_utf16(vec![0xd800, 0, 0xdfff]);
    row.concurrency = Some(3);
    row.delegated_decisions = Some(
        session::Document::new(
            parse_json(r#"{"categories":["question"],"actions":["read"],"expiresAt":12}"#).unwrap(),
        )
        .unwrap(),
    );
    let bytes = GroupTable::encode(&row).unwrap();
    assert_eq!(bytes[0], 1);
    assert_eq!(GroupTable::decode(&bytes).unwrap(), row);
    for invalid in [&bytes[..bytes.len() - 1], &[2][..]] {
        assert!(GroupTable::decode(invalid).is_err());
    }
    let mut trailing = bytes;
    trailing.push(0);
    assert!(GroupTable::decode(&trailing).is_err());
    let member = member("cgrp_codec", "ses_member", Some("ses_owner"));
    assert_eq!(
        MemberTable::decode(&MemberTable::encode(&member).unwrap()).unwrap(),
        member
    );
    let policy = session::Document::<ycoding_schema::coordination::DelegatedDecisions>::new(
        parse_json(r#"{"categories":[],"unknown":true}"#).unwrap(),
    )
    .unwrap();
    let mut unknown = row.clone();
    unknown.delegated_decisions = Some(policy);
    assert!(GroupTable::encode(&unknown).is_err());
    for revision in [-1, 9_007_199_254_740_992] {
        let mut invalid = row.clone();
        invalid.revision = revision;
        assert!(GroupTable::encode(&invalid).is_err());
    }
    let mut invalid = row;
    invalid.concurrency = Some(0);
    assert!(GroupTable::encode(&invalid).is_err());
}

#[test]
fn indexes_enforce_unique_masters_and_members_and_roll_back_failed_batch() {
    let store = store();
    store
        .submit(|tx| {
            GroupTable::insert(tx, &group("cgrp_first", "ses_master"))?;
            GroupTable::insert(tx, &group("cgrp_second", "ses_other"))?;
            MemberTable::insert(tx, &member("cgrp_first", "ses_member", Some("ses_owner")))
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(matches!(
        store
            .submit(|tx| GroupTable::insert(tx, &group("cgrp_duplicate", "ses_master")))
            .unwrap()
            .wait(),
        Err(Error::UniqueViolation {
            index: "coordination_group_master_idx"
        })
    ));
    assert!(matches!(
        store
            .submit(|tx| {
                MemberTable::insert(tx, &member("cgrp_second", "ses_retained", None))?;
                MemberTable::insert(tx, &member("cgrp_second", "ses_member", None))
            })
            .unwrap()
            .wait(),
        Err(Error::UniqueViolation {
            index: "coordination_member_session_idx"
        })
    ));
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .index::<GroupTable>("coordination_group_master_idx", &key("ses_master"), None, 2)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        snapshot
            .index::<MemberTable>("coordination_member_owner_idx", &key("ses_owner"), None, 2)
            .unwrap()
            .len(),
        1
    );
    assert!(
        snapshot
            .index::<MemberTable>(
                "coordination_member_session_idx",
                &key("ses_retained"),
                None,
                2
            )
            .unwrap()
            .is_empty()
    );
}

#[test]
fn stored_put_retains_archived_sessions_and_checks_foreign_keys() {
    let store = store();
    store
        .submit(|tx| {
            let mut archived = row("ses_member");
            archived.time_archived = Some(3);
            session::SessionTable::put(tx, &archived)?;
            let mut master = row("ses_master");
            master.time_archived = Some(3);
            session::SessionTable::put(tx, &master)?;
            GroupTable::insert(tx, &group("cgrp_archive", "ses_master"))?;
            MemberTable::insert(tx, &member("cgrp_archive", "ses_member", Some("ses_owner")))
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .submit(|tx| MemberTable::put(
                tx,
                &member("cgrp_archive", "ses_member", Some("ses_absent"))
            ))
            .unwrap()
            .wait()
            .is_err()
    );
    assert!(
        store
            .submit(|tx| GroupTable::put(tx, &group("cgrp_missing", "ses_absent")))
            .unwrap()
            .wait()
            .is_err()
    );
    assert_eq!(
        coordination::members(&store.snapshot().unwrap(), &"cgrp_archive".into()).unwrap(),
        vec![member("cgrp_archive", "ses_member", Some("ses_owner"))]
    );
}

#[test]
fn cleanup_matches_cascade_and_set_null_without_touching_group_version_or_events() {
    let store = store();
    store
        .submit(|tx| {
            GroupTable::insert(tx, &group("cgrp_doomed", "ses_master"))?;
            GroupTable::insert(tx, &group("cgrp_survives", "ses_other"))?;
            MemberTable::insert(tx, &member("cgrp_doomed", "ses_member", Some("ses_owner")))?;
            MemberTable::insert(
                tx,
                &member("cgrp_survives", "ses_retained", Some("ses_owner")),
            )?;
            coordination::remove_session(tx, &"ses_owner".into())?;
            assert!(
                coordination::members_in(tx, &"cgrp_survives".into())?[0]
                    .owner_session_id
                    .is_none()
            );
            coordination::remove_session(tx, &"ses_master".into())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<GroupTable>(&key("cgrp_doomed"))
            .unwrap()
            .is_none()
    );
    assert!(
        coordination::members(&snapshot, &"cgrp_doomed".into())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        snapshot.get::<GroupTable>(&key("cgrp_survives")).unwrap(),
        Some(group("cgrp_survives", "ses_other"))
    );
    assert_eq!(
        coordination::members(&snapshot, &"cgrp_survives".into()).unwrap(),
        vec![member("cgrp_survives", "ses_retained", None)]
    );
    assert!(
        snapshot
            .scan::<session::EventTable>(std::ops::Bound::Unbounded, std::ops::Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn cleanup_and_mutations_roll_back_as_one_writer_transaction() {
    let store = store();
    store
        .submit(|tx| {
            GroupTable::insert(tx, &group("cgrp_atomic", "ses_master"))?;
            MemberTable::insert(tx, &member("cgrp_atomic", "ses_member", Some("ses_owner")))
        })
        .unwrap()
        .wait()
        .unwrap();
    let failed = store
        .submit(|tx| {
            coordination::remove_session(tx, &"ses_master".into())?;
            Err::<(), _>(Error::Rejected("synthetic rollback"))
        })
        .unwrap()
        .wait();
    assert!(failed.is_err());
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<GroupTable>(&key("cgrp_atomic"))
            .unwrap()
            .is_some()
    );
    assert_eq!(
        coordination::members(&snapshot, &"cgrp_atomic".into()).unwrap(),
        vec![member("cgrp_atomic", "ses_member", Some("ses_owner"))]
    );
}
