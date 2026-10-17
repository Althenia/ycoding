include!("policy_fixture.rs");
use ycoding_core::tools::policy::{
    Effect,
    permissions::{Error, SavedPermissions},
};
use ycoding_schema::{LosslessString, permission, project_id::ProjectId};

fn request(
    session: &ycoding_schema::session_id::SessionId,
    name: &str,
    resource: &str,
) -> permission::Request {
    permission::Request {
        id: permission::Id::new(name).unwrap(),
        session_id: session.clone(),
        action: "read".into(),
        resources: vec![resource.into()],
        save: Some(vec!["public/*".into()]),
        metadata: None,
        source: None,
    }
}

#[tokio::test]
async fn permission_requests_reply_rejection_and_saved_rules_use_real_store() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let other = fixture.session("ses_other", None, 0, false, None);
    let service = fixture.permissions();
    let first = service
        .ask(request(&root, "per_first", "public/x"), None)
        .unwrap();
    let second = service
        .ask(request(&other, "per_second", "public/y"), None)
        .unwrap();
    service
        .reply(&first.id, permission::Reply("always".into()), None)
        .unwrap();
    first.wait.unwrap().await.unwrap().unwrap();
    second.wait.unwrap().await.unwrap().unwrap();
    assert!(service.list().is_empty());
    let saved = SavedPermissions {
        store: fixture.store.client(),
    };
    let project = ProjectId::new("project").unwrap();
    let rows = saved.list(Some(&project)).unwrap();
    assert_eq!(rows.len(), 1);
    saved
        .add(
            &project,
            &"read".into(),
            &["public/*".into(), "public/*".into()],
        )
        .unwrap();
    assert_eq!(saved.list(None).unwrap().len(), 1);
    fixture.rules.lock().unwrap().push(permission::Rule {
        action: "read".into(),
        resource: "public/*".into(),
        effect: permission::Effect("deny".into()),
    });
    assert_eq!(
        service
            .ask(request(&root, "per_denied", "public/x"), None)
            .unwrap()
            .effect,
        Effect::Deny
    );
    saved.remove(&rows[0].id).unwrap();
    assert!(saved.list(None).unwrap().is_empty());
    let first = service
        .ask(request(&root, "per_reject", "private/x"), None)
        .unwrap();
    let second = service
        .ask(request(&root, "per_sibling", "private/y"), None)
        .unwrap();
    let third = service
        .ask(request(&other, "per_other", "private/z"), None)
        .unwrap();
    service
        .reply(
            &first.id,
            permission::Reply("reject".into()),
            Some("Use another path".into()),
        )
        .unwrap();
    assert!(matches!(
        first.wait.unwrap().await.unwrap(),
        Err(Error::Corrected(_))
    ));
    assert!(matches!(
        second.wait.unwrap().await.unwrap(),
        Err(Error::Declined)
    ));
    assert_eq!(service.for_session(&other).len(), 1);
    service
        .reply(&third.id, permission::Reply("once".into()), None)
        .unwrap();
    third.wait.unwrap().await.unwrap().unwrap();
}

#[tokio::test]
async fn ask_retains_pending_assert_cancellation_and_agent_switch_clear_it() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = fixture.permissions();
    let input = request(&root, "per_ask", "private/x");
    let admission = service.ask(input.clone(), None).unwrap();
    drop(admission);
    assert_eq!(service.list().len(), 1);
    service.agent_selected(&root, &"changed".into()).unwrap();
    assert!(service.list().is_empty());
    let mut future = Box::pin(service.assert(input, None));
    assert!(matches!(
        std::future::poll_fn(|context| std::task::Poll::Ready(std::future::Future::poll(
            future.as_mut(),
            context
        )))
        .await,
        std::task::Poll::Pending
    ));
    assert_eq!(service.list().len(), 1);
    drop(future);
    assert!(service.list().is_empty());
}

#[test]
fn saved_allows_and_goals_cannot_escalate_child_ceiling() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, true, None);
    let denied = vec![permission::Rule {
        action: "read".into(),
        resource: "private/*".into(),
        effect: permission::Effect("deny".into()),
    }];
    let child = fixture.session("ses_child", Some("ses_root"), 2, true, Some(denied));
    fixture.rules.lock().unwrap().push(permission::Rule {
        action: "*".into(),
        resource: "*".into(),
        effect: permission::Effect("allow".into()),
    });
    let service = fixture.permissions();
    assert_eq!(
        service
            .ask(request(&child, "per_child", "private/x"), None)
            .unwrap()
            .effect,
        Effect::Deny
    );
    assert_eq!(
        service
            .evaluate_effective(&root, None, &"read".into(), &"private/x".into())
            .unwrap(),
        Effect::Allow
    );
    assert_eq!(
        service
            .evaluate_effective(&child, None, &"read".into(), &"private/x".into())
            .unwrap(),
        Effect::Deny
    );
    assert_eq!(
        service
            .evaluate_effective(
                &root,
                Some(&LosslessString::from("missing")),
                &"read".into(),
                &"private/x".into()
            )
            .unwrap(),
        Effect::Deny
    );
}

#[test]
fn pending_lists_preserve_admission_order_not_identifier_sort_order() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = fixture.permissions();
    service
        .ask(request(&root, "per_z", "private/x"), None)
        .unwrap();
    service
        .ask(request(&root, "per_a", "private/y"), None)
        .unwrap();
    assert_eq!(
        service
            .list()
            .iter()
            .map(|request| request.id.clone())
            .collect::<Vec<_>>(),
        vec![
            permission::Id::new("per_z").unwrap(),
            permission::Id::new("per_a").unwrap()
        ]
    );
    service.shutdown();
}

#[test]
fn malformed_goal_without_text_does_not_grant_automation() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(root.as_lossless())]);
    fixture
        .store
        .submit(move |tx| {
            let mut session = tx
                .get::<ycoding_store::session::SessionTable>(&key)?
                .unwrap();
            session.autonomy = Some(
                ycoding_schema::parse_json(
                    r#"{"mode":"normal","yolo":0,"goal":{"status":"active"}}"#,
                )
                .unwrap(),
            );
            tx.put::<ycoding_store::session::SessionTable>(&session)
        })
        .unwrap()
        .wait()
        .unwrap();
    let current = fixture.authority().session(&root, None).unwrap().autonomy;
    assert!(!current.can_auto_permission());
    assert!(!current.can_auto_answer());
}

#[test]
fn authority_reads_session_and_root_autonomy_through_the_session_autonomy_state() {
    use ycoding_core::session::autonomy::State;
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 2, true, None);
    let child = fixture.session("ses_child", Some("ses_root"), 0, false, None);
    let stored = |id: &ycoding_schema::session_id::SessionId| {
        State::read(
            fixture
                .store
                .snapshot()
                .unwrap()
                .get::<ycoding_store::session::SessionTable>(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(id.as_lossless()),
                ]))
                .unwrap()
                .unwrap()
                .autonomy
                .as_ref(),
        )
        .effective()
    };
    let authority = fixture.authority().session(&child, None).unwrap();
    assert_eq!(authority.autonomy, stored(&child));
    assert_eq!(authority.root_autonomy, stored(&root));
    assert!(authority.root_autonomy.goal_active);
    assert_eq!(authority.root_autonomy.yolo.get(), 2);
    assert!(!authority.autonomy.can_auto_permission());
}
