use ycoding_core::resources::credential::{Error, Service};
use ycoding_schema::{DomainEncode, credential, model};
use ycoding_store::{
    Catalog, Metadata, Options, Store, TableDeclaration, project, resources, session,
};

#[tokio::test]
async fn durable_binding_rehydrates_and_replacement_requires_explicit_reselection() {
    let tables = resources::TABLES
        .iter()
        .chain(project::TABLES)
        .chain(session::TABLES)
        .copied()
        .chain([
            TableDeclaration::of::<ycoding_store::analytics::DeliveryTable>(),
            TableDeclaration::of::<ycoding_store::analytics::IntentTable>(),
        ])
        .collect::<Vec<TableDeclaration>>();
    let tables = Box::leak(tables.into_boxed_slice());
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, tables),
        Metadata::new([9; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::put(
                tx,
                &project::Project {
                    id: "p".into(),
                    worktree: "/fixture".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 0,
                    time_updated: 0,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            session::SessionTable::put(
                tx,
                &session::Session {
                    id: "s".into(),
                    project_id: "p".into(),
                    workspace_id: None,
                    parent_id: None,
                    fork_session_id: None,
                    fork_message_id: None,
                    fork_seq: None,
                    directory: "/fixture".into(),
                    path: None,
                    title: "Fixture".into(),
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
                    model: Some(session::Document::from_domain(&model::Ref {
                        id: "model".into(),
                        provider_id: ycoding_schema::provider::Id("provider".into()),
                        variant: None,
                        profile: Some(model::ProfileName("Work".into())),
                    })?),
                    profile_binding: None,
                    daybreak: None,
                    time_created: 0,
                    time_updated: 0,
                    time_archived: None,
                    time_active: None,
                    time_pinned: None,
                    time_suspended: None,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    let service = Service::new(store.client());
    let secret = resources::Secret::new(
        credential::Value::Key(credential::Key {
            key: "fixture-secret".into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap();
    let stored = service
        .create(
            "c".into(),
            "integration".into(),
            Some("Work".into()),
            secret.clone(),
            1,
        )
        .await
        .unwrap();
    let (_, binding) = service
        .resolve_session(&"s".into(), &"integration".into(), false)
        .unwrap()
        .unwrap();
    service
        .publish_binding("s".into(), "evt-one".into(), Some(binding), 2)
        .await
        .unwrap();
    let service = Service::new(store.client());
    assert_eq!(
        service
            .resolve_session(&"s".into(), &"integration".into(), false)
            .unwrap()
            .unwrap()
            .0
            .id(),
        stored.id()
    );
    service
        .create(
            "unused".into(),
            "integration".into(),
            Some("Work".into()),
            secret,
            3,
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .resolve_session(&"s".into(), &"integration".into(), false)
            .unwrap_err(),
        Error::ProfileUnavailable
    );
    let (_, binding) = service
        .resolve_session(&"s".into(), &"integration".into(), true)
        .unwrap()
        .unwrap();
    service
        .publish_binding("s".into(), "evt-two".into(), Some(binding), 4)
        .await
        .unwrap();
    assert!(
        service
            .resolve_session(&"s".into(), &"integration".into(), false)
            .unwrap()
            .is_some()
    );
    let row = store
        .client()
        .snapshot()
        .unwrap()
        .get::<session::SessionTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"s".into()),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(
        row.profile_binding
            .unwrap()
            .domain()
            .unwrap()
            .account_generation
            .get(),
        1
    );
    assert_eq!(
        session::latest_sequence(&store.client().snapshot().unwrap(), &"s".into()).unwrap(),
        1
    );
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}
