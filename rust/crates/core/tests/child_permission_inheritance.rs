include!("policy_fixture.rs");

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use ycoding_core::tools::policy::{Authority, Effect, permissions::Permissions};
use ycoding_schema::{permission, project_id::ProjectId, session_id::SessionId};

fn request(session: &SessionId, name: &str, resource: &str) -> permission::Request {
    permission::Request {
        id: permission::Id::new(name).unwrap(),
        session_id: session.clone(),
        action: "read".into(),
        resources: vec![resource.into()],
        save: None,
        metadata: None,
        source: None,
    }
}

fn managed_child(fixture: &Fixture, parent: &str, child: &str) -> SessionId {
    managed_child_with(fixture, parent, child, None)
}

fn managed_child_with(
    fixture: &Fixture,
    parent: &str,
    child: &str,
    ceiling: Option<permission::Ruleset>,
) -> SessionId {
    let id = fixture.session(child, Some(parent), 0, false, ceiling);
    let parent = parent.to_owned();
    let child = child.to_owned();
    fixture
        .store
        .submit(move |tx| {
            ycoding_store::session::TaskTable::insert(
                tx,
                &ycoding_store::session::Task {
                    session_id: child.as_str().into(),
                    parent_id: parent.as_str().into(),
                    parent_assistant_message_id: "msg_parent".into(),
                    tool_call_id: format!("call_{child}").as_str().into(),
                    input_id: format!("msg_input_{child}").as_str().into(),
                    description: "Work".into(),
                    agent: "test".into(),
                    model: ycoding_store::session::Document::<ycoding_schema::model::Ref>::new(
                        ycoding_schema::parse_json(r#"{"providerID":"local","id":"test"}"#)
                            .unwrap(),
                    )?,
                    prompt_digest: "0".repeat(64).as_str().into(),
                    background: 1,
                    delivery: "steer".into(),
                    state: "running".into(),
                    progress: None,
                    progress_time: None,
                    question_id: None,
                    question: None,
                    question_data: None,
                    question_time: None,
                    usage_anchor: None,
                    attempt_started: 0,
                    owner_pid: None,
                    owner_started: None,
                    revision: 0,
                    time_created: 1,
                    time_updated: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    id
}

fn rules(fixture: &Fixture) {
    *fixture.rules.lock().unwrap() = vec![
        permission::Rule {
            action: "read".into(),
            resource: "*".into(),
            effect: permission::Effect("ask".into()),
        },
        permission::Rule {
            action: "read".into(),
            resource: "private/*".into(),
            effect: permission::Effect("deny".into()),
        },
    ];
}

#[test]
fn a_managed_child_inherits_its_parents_permission_approval_level() {
    let fixture = Fixture::default();
    rules(&fixture);
    fixture.session("ses_root", None, 1, false, None);
    let child = managed_child(&fixture, "ses_root", "ses_child");
    let grandchild = managed_child(&fixture, "ses_child", "ses_grandchild");
    let service = fixture.permissions();
    for (session, name) in [(&child, "per_child"), (&grandchild, "per_grandchild")] {
        let admission = service
            .ask(request(session, name, "public/notes"), None)
            .unwrap();
        assert_eq!(admission.effect, Effect::Allow, "{name}");
        assert!(service.list().is_empty(), "{name}");
    }
}

#[test]
fn an_inherited_level_never_lifts_an_explicit_deny() {
    let fixture = Fixture::default();
    rules(&fixture);
    fixture.session("ses_root", None, 2, false, None);
    let child = managed_child(&fixture, "ses_root", "ses_child");
    let service = fixture.permissions();
    assert_eq!(
        service
            .ask(request(&child, "per_denied", "private/key"), None)
            .unwrap()
            .effect,
        Effect::Deny
    );
    assert!(service.list().is_empty());
}

#[test]
fn a_child_under_a_manual_parent_or_a_parent_goal_still_asks() {
    for (yolo, goal) in [(0, false), (0, true)] {
        let fixture = Fixture::default();
        rules(&fixture);
        fixture.session("ses_root", None, yolo, goal, None);
        let child = managed_child(&fixture, "ses_root", "ses_child");
        let service = fixture.permissions();
        let admission = service
            .ask(request(&child, "per_manual", "public/notes"), None)
            .unwrap();
        assert_eq!(admission.effect, Effect::Ask, "goal {goal}");
        assert_eq!(service.list().len(), 1, "goal {goal}");
    }
}

fn read(effect: &str) -> permission::Ruleset {
    vec![permission::Rule {
        action: "read".into(),
        resource: "*".into(),
        effect: permission::Effect(effect.into()),
    }]
}

#[test]
fn one_permission_decision_never_mixes_a_stale_ceiling_with_a_newer_inherited_level() {
    let fixture = Fixture::default();
    rules(&fixture);
    fixture.session("ses_root", None, 0, false, None);
    let child = managed_child_with(&fixture, "ses_root", "ses_child", Some(read("ask")));
    let client = fixture.store.client();
    let changed = Arc::new(AtomicBool::new(false));
    let fired = changed.clone();
    let configured = fixture.rules.lock().unwrap().clone();
    let authority = Authority {
        store: fixture.store.client(),
        agents: Arc::new(move |agent| {
            if !fired.swap(true, Ordering::AcqRel) {
                client
                    .submit(|tx| {
                        for (session, yolo, ceiling) in
                            [("ses_root", 1, None), ("ses_child", 0, Some(read("deny")))]
                        {
                            let mut row = tx
                                .get::<ycoding_store::session::SessionTable>(
                                    &ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(
                                        &session.into(),
                                    )]),
                                )?
                                .unwrap();
                            row.autonomy = Some(
                                ycoding_schema::parse_json(&format!(
                                    r#"{{"mode":"normal","yolo":{yolo}}}"#
                                ))
                                .unwrap(),
                            );
                            row.permission = ceiling.map(|rules| {
                                ycoding_store::session::Document::from_domain(&rules).unwrap()
                            });
                            tx.put::<ycoding_store::session::SessionTable>(&row)?;
                        }
                        Ok(())
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
            }
            (agent.is_none_or(|agent| agent.as_str() == Some("test")))
                .then(|| ("test".into(), configured.clone()))
        }),
    };
    let service = Permissions::new(
        authority,
        ProjectId::new("project").unwrap(),
        fixture.publisher(),
    );
    let admission = service
        .ask(request(&child, "per_interleaved", "public/notes"), None)
        .unwrap();
    assert!(changed.load(Ordering::Acquire), "the interleaving ran");
    assert_ne!(
        admission.effect,
        Effect::Allow,
        "an old ask ceiling combined with a newer parent level approved a request neither state allows"
    );
    match admission.effect {
        Effect::Ask => assert_eq!(service.list().len(), 1),
        Effect::Deny => assert!(service.list().is_empty()),
        Effect::Allow => unreachable!(),
    }
}
