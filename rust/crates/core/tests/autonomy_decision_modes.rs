use ycoding_core::session::autonomy::{DecisionChange, DecisionMode, Error, Service, State};
use ycoding_schema::{parse_json, session};
use ycoding_store::{
    Store,
    session::{Document, Task, TaskTable},
};

#[path = "autonomy_support/mod.rs"]
mod support;

use DecisionMode::{Auto, Manual, Yolo};

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn family(depth: usize) -> Store {
    let store = support::store();
    let names = ["ses_root", "ses_child", "ses_grand"];
    store
        .submit(move |tx| {
            for index in 0..depth {
                let mut row = support::record(names[index]);
                row.parent_id = (index > 0).then(|| names[index - 1].into());
                ycoding_store::session::SessionTable::insert(tx, &row)?;
                if index == 0 {
                    continue;
                }
                TaskTable::insert(
                    tx,
                    &Task {
                        session_id: names[index].into(),
                        parent_id: names[index - 1].into(),
                        parent_assistant_message_id: "msg_parent".into(),
                        tool_call_id: format!("call_{index}").as_str().into(),
                        input_id: format!("msg_input_{index}").as_str().into(),
                        description: "Work".into(),
                        agent: "test".into(),
                        model: Document::<ycoding_schema::model::Ref>::new(
                            parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap(),
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
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}

#[tokio::test]
async fn autonomy_changes_reach_managed_descendants_without_session_family_edges() {
    let store = family(3);
    store
        .submit(|tx| {
            for name in ["ses_child", "ses_grand"] {
                let key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&name.into())]);
                let mut row = tx
                    .get::<ycoding_store::session::SessionTable>(&key)?
                    .unwrap();
                row.parent_id = None;
                tx.put::<ycoding_store::session::SessionTable>(&row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    let mut changes = service.changes();
    assign(&service, "ses_root", Yolo, Manual, Yolo).await;
    let mut notified = std::collections::BTreeSet::new();
    for _ in 0..3 {
        let changed = tokio::time::timeout(std::time::Duration::from_secs(5), changes.next())
            .await
            .unwrap()
            .unwrap();
        assert!(notified.insert(changed.as_lossless().clone()));
    }
    assert_eq!(
        notified,
        ["ses_root", "ses_child", "ses_grand"]
            .map(ycoding_schema::LosslessString::from)
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
    );
    assert_eq!(service.effective(&id("ses_grand")).unwrap().answers, Yolo);
}

async fn assign(
    service: &Service,
    name: &str,
    permissions: DecisionMode,
    guardrails: DecisionMode,
    answers: DecisionMode,
) {
    service
        .set_decisions(
            &id(name),
            DecisionChange::new(Some(permissions), Some(guardrails), Some(answers)).unwrap(),
        )
        .await
        .unwrap();
}

fn source(value: &Option<ycoding_schema::LosslessString>) -> Option<&str> {
    value.as_ref().and_then(|value| value.as_str())
}

#[tokio::test]
async fn a_new_session_resolves_every_category_to_manual_without_inheritance() {
    let store = family(3);
    let service = Service::new(store.client());
    for name in ["ses_root", "ses_child", "ses_grand"] {
        let resolved = service.resolve(&id(name)).unwrap();
        assert_eq!(
            (
                resolved.effective.permissions,
                resolved.effective.guardrails,
                resolved.effective.answers
            ),
            (Manual, Manual, Manual),
            "{name}"
        );
        assert_eq!(source(&resolved.inherited.permissions), None, "{name}");
        assert_eq!(source(&resolved.inherited.answers), None, "{name}");
        assert_eq!(service.get(&id(name)).unwrap(), State::default(), "{name}");
    }
    assert_eq!(
        source(
            &service
                .resolve(&id("ses_root"))
                .unwrap()
                .inherited
                .guardrails
        ),
        None
    );
    for name in ["ses_child", "ses_grand"] {
        assert_eq!(
            source(&service.resolve(&id(name)).unwrap().inherited.guardrails),
            Some("ses_root"),
            "{name}"
        );
    }
}

#[tokio::test]
async fn permissions_resolve_yolo_over_auto_over_manual_with_the_local_session_winning_ties() {
    let store = family(3);
    let service = Service::new(store.client());
    let cases = [
        (Yolo, Manual, Manual, Yolo, Some("ses_root")),
        (Yolo, Auto, Manual, Yolo, Some("ses_root")),
        (Auto, Yolo, Manual, Yolo, None),
        (Auto, Auto, Manual, Auto, None),
        (Yolo, Yolo, Manual, Yolo, None),
        (Manual, Manual, Manual, Manual, None),
        (Manual, Yolo, Manual, Yolo, None),
    ];
    for (root, child, _, expected, from) in cases {
        assign(&service, "ses_root", root, Manual, Manual).await;
        assign(&service, "ses_child", child, Manual, Manual).await;
        let resolved = service.resolve(&id("ses_child")).unwrap();
        assert_eq!(
            resolved.effective.permissions, expected,
            "{root:?} {child:?}"
        );
        assert_eq!(
            source(&resolved.inherited.permissions),
            from,
            "{root:?} {child:?}"
        );
        assert_eq!(
            service.effective(&id("ses_child")).unwrap(),
            resolved.effective
        );
    }
    assign(&service, "ses_root", Auto, Manual, Manual).await;
    assign(&service, "ses_child", Yolo, Manual, Manual).await;
    assign(&service, "ses_grand", Manual, Manual, Manual).await;
    let grand = service.resolve(&id("ses_grand")).unwrap();
    assert_eq!(grand.effective.permissions, Yolo);
    assert_eq!(source(&grand.inherited.permissions), Some("ses_child"));
    assign(&service, "ses_root", Yolo, Manual, Manual).await;
    assign(&service, "ses_child", Yolo, Manual, Manual).await;
    let grand = service.resolve(&id("ses_grand")).unwrap();
    assert_eq!(grand.effective.permissions, Yolo);
    assert_eq!(source(&grand.inherited.permissions), Some("ses_child"));
}

#[tokio::test]
async fn guardrails_always_follow_the_root_family_choice() {
    let store = family(3);
    let service = Service::new(store.client());
    for root in [Manual, Yolo, Auto] {
        for local in [Manual, Yolo, Auto] {
            assign(&service, "ses_root", Manual, root, Manual).await;
            assign(&service, "ses_child", Manual, local, Manual).await;
            assign(&service, "ses_grand", Manual, local, Manual).await;
            for name in ["ses_child", "ses_grand"] {
                let resolved = service.resolve(&id(name)).unwrap();
                assert_eq!(
                    resolved.effective.guardrails, root,
                    "{name} {root:?} {local:?}"
                );
                assert_eq!(source(&resolved.inherited.guardrails), Some("ses_root"));
            }
            assert_eq!(
                service
                    .resolve(&id("ses_root"))
                    .unwrap()
                    .effective
                    .guardrails,
                root
            );
        }
    }
}

#[tokio::test]
async fn answers_take_local_or_ancestor_yolo_before_local_auto_and_ancestor_auto_never_propagates()
{
    let store = family(3);
    let service = Service::new(store.client());
    let cases = [
        (Yolo, Manual, Yolo, Some("ses_root")),
        (Auto, Manual, Manual, None),
        (Auto, Yolo, Yolo, None),
        (Yolo, Auto, Yolo, Some("ses_root")),
        (Auto, Auto, Auto, None),
        (Manual, Auto, Auto, None),
        (Manual, Yolo, Yolo, None),
        (Yolo, Yolo, Yolo, None),
        (Manual, Manual, Manual, None),
    ];
    for (root, child, expected, from) in cases {
        assign(&service, "ses_root", Manual, Manual, root).await;
        assign(&service, "ses_child", Manual, Manual, child).await;
        let resolved = service.resolve(&id("ses_child")).unwrap();
        assert_eq!(resolved.effective.answers, expected, "{root:?} {child:?}");
        assert_eq!(
            source(&resolved.inherited.answers),
            from,
            "{root:?} {child:?}"
        );
        assert_eq!(
            resolved.effective.can_auto_answer(),
            expected == Auto,
            "{root:?} {child:?}"
        );
    }
    assign(&service, "ses_root", Manual, Manual, Yolo).await;
    assign(&service, "ses_child", Manual, Manual, Auto).await;
    assign(&service, "ses_grand", Manual, Manual, Manual).await;
    let grand = service.resolve(&id("ses_grand")).unwrap();
    assert_eq!(grand.effective.answers, Yolo);
    assert_eq!(source(&grand.inherited.answers), Some("ses_root"));
}

#[tokio::test]
async fn categories_resolve_independently_of_each_other() {
    let store = family(2);
    let service = Service::new(store.client());
    assign(&service, "ses_root", Yolo, Auto, Yolo).await;
    assign(&service, "ses_child", Manual, Manual, Manual).await;
    let child = service.resolve(&id("ses_child")).unwrap().effective;
    assert_eq!(
        (child.permissions, child.guardrails, child.answers),
        (Yolo, Auto, Yolo)
    );
    assert!(child.can_yolo_permission() && !child.can_auto_permission());
    assert!(child.can_auto_guardrail() && !child.can_yolo_guardrail());
    assert!(child.can_yolo_answer() && !child.can_auto_answer());
}

#[tokio::test]
async fn a_partial_write_changes_only_the_selected_categories_in_one_revision() {
    let store = support::store();
    let service = Service::new(store.client());
    let before = service.snapshot(&id("ses_one")).unwrap();
    let state = service
        .set_decisions(
            &id("ses_one"),
            DecisionChange::new(Some(Auto), None, Some(Yolo)).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        (state.permissions, state.guardrails, state.answers),
        (Auto, Manual, Yolo)
    );
    let after = service.snapshot(&id("ses_one")).unwrap();
    assert_eq!(after.sequence, before.sequence + 1);
    assert_eq!(after.state, state);

    let repeated = service
        .set_decisions(
            &id("ses_one"),
            DecisionChange::new(Some(Auto), None, Some(Yolo)).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(repeated, state);
    assert_eq!(service.snapshot(&id("ses_one")).unwrap(), after);

    let guardrails = service
        .set_decisions(
            &id("ses_one"),
            DecisionChange::new(None, Some(Yolo), None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        (
            guardrails.permissions,
            guardrails.guardrails,
            guardrails.answers
        ),
        (Auto, Yolo, Yolo)
    );
    assert_eq!(
        service.snapshot(&id("ses_one")).unwrap().sequence,
        after.sequence + 1
    );
    assert_eq!(service.get(&id("ses_two")).unwrap(), State::default());
}

#[tokio::test]
async fn an_empty_change_is_unrepresentable_and_an_unknown_session_is_not_found() {
    assert_eq!(DecisionChange::new(None, None, None), None);
    let store = support::store();
    let service = Service::new(store.client());
    assert!(matches!(
        service
            .set_decisions(
                &id("ses_missing"),
                DecisionChange::new(Some(Auto), None, None).unwrap()
            )
            .await,
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        service.resolve(&id("ses_missing")),
        Err(Error::NotFound(_))
    ));
}

#[tokio::test]
async fn decision_writes_keep_the_goal_and_the_goal_writes_keep_the_decisions() {
    let store = support::store();
    let service = Service::new(store.client());
    assign(&service, "ses_one", Auto, Yolo, Auto).await;
    let goal = ycoding_core::session::autonomy::Goal::new("Finish safely", None, None);
    let state = service.set_goal(&id("ses_one"), goal).await.unwrap();
    assert_eq!(
        (state.permissions, state.guardrails, state.answers),
        (Auto, Yolo, Auto)
    );
    let changed = service
        .set_decisions(
            &id("ses_one"),
            DecisionChange::new(Some(Manual), None, None).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(changed.goal, state.goal);
    let effective = service.effective(&id("ses_one")).unwrap();
    assert!(effective.goal_active);
    assert!(!effective.can_auto_permission() && effective.can_yolo_guardrail());
}
