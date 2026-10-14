mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use prost::{Message, Name};
use remote_derived_support::{Fixture, now, owned_shell, world};
use std::sync::Arc;
use support::{machine, operation, session_scope, text, units, wire::location_scope};
use ycoding_core::{
    resources::model::quota,
    ycoding_schema::{DomainDecode, DomainEncode, JsonValue, form, parse_json, provider, session},
    ycoding_store::{KeyPart, session::SessionTable, tuple_key},
};
use ycoding_protocol::{decode_strict, v5};
use ycoding_runtime::{
    Environment, ProviderUsageServices, Settled,
    connector::{Credential, Enrolled, Peer},
    standard,
};

async fn request<Q: Message>(
    environment: Arc<Environment>,
    name: &str,
    scope: v5::Scope,
    query: Q,
    remote: bool,
) -> v5::TypedPayload {
    let dispatcher = standard().unwrap();
    let request = v5::Request {
        request_id: "placement-request".into(),
        operation_id: operation(name).operation_id,
        scope,
        payload: query.encode_to_vec(),
    };
    let settled = if remote {
        let peer = Peer::authenticate(
            &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
            &Credential::new(
                "placement-test".into(),
                now() + 60_000,
                "https://relay.invalid".into(),
                "device-a".into(),
            ),
            now(),
        )
        .unwrap();
        dispatcher
            .invoke_remote(environment, "placement-connection".into(), &peer, request)
            .await
    } else {
        dispatcher
            .invoke(environment, "placement-connection".into(), request)
            .await
    };
    let Some(Settled::Result(result)) = settled else {
        panic!("missing inline settlement for {name}")
    };
    match result.outcome.unwrap() {
        v5::result::Outcome::Success(payload) | v5::result::Outcome::Error(payload) => payload,
        _ => panic!("unexpected asset"),
    }
}

fn success<R: Message + Name + Default>(payload: v5::TypedPayload) -> R {
    assert_eq!(
        payload.type_name,
        R::full_name(),
        "{:?}",
        v5::InvalidRequestError::decode(payload.payload.as_slice())
    );
    decode_strict(&payload.payload).unwrap()
}

fn denied(name: &str, payload: v5::TypedPayload) {
    assert!(operation(name).error_types.contains(&payload.type_name));
    assert_ne!(payload.type_name, operation(name).result_type);
}

fn shell_id(id: &ycoding_core::ycoding_schema::shell::Id) -> v5::LosslessString {
    let JsonValue::String(id) = id.encode() else {
        panic!("invalid shell ID")
    };
    text(id.as_str().unwrap())
}

fn find(location: Option<v5::FsFindRequestQueryLocation>) -> v5::FsFindRequest {
    v5::FsFindRequest {
        query: v5::FsFindRequestQuery {
            location,
            query: text("needle"),
            r#type: None,
            limit: Some(20),
        },
    }
}

fn workspace(id: &v5::LosslessString) -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Workspace(units(id))),
    }
}

async fn advertised(fixture: &Fixture) -> v5::LosslessString {
    let page: v5::WorkspaceListResult = success(
        request(
            fixture.environment(true),
            "workspace.list",
            machine(),
            v5::WorkspaceListRequest::default(),
            true,
        )
        .await,
    );
    page.data
        .items
        .into_iter()
        .find(|item| units(&item.directory) == fixture.directory)
        .unwrap()
        .id
}

#[tokio::test]
async fn remote_find_resolves_session_and_advertised_workspace_without_local_location() {
    let mut fixture = Fixture::new().await;
    std::fs::write(fixture.path.join("needle.txt"), "root").unwrap();
    std::fs::write(fixture.path.join("child/needle-child.txt"), "child").unwrap();
    for (platform, path) in [
        (&mut fixture.platform, fixture.path.clone()),
        (&mut fixture.child_platform, fixture.path.join("child")),
    ] {
        Arc::get_mut(platform).unwrap().search = Arc::new(
            ycoding_core::platform::filesystem::search::Service::new(
                &path,
                ycoding_core::platform::filesystem::search::Backend::Ripgrep {
                    binary: "rg".into(),
                },
            )
            .unwrap(),
        );
        assert!(platform.search.wait_for_scan(support::WAIT));
    }
    let id = advertised(&fixture).await;
    for (scope, expected) in [
        (session_scope(&fixture.root), "needle.txt"),
        (session_scope(&fixture.child), "needle-child.txt"),
        (workspace(&id), "needle.txt"),
    ] {
        let page: v5::FsFindResult = success(
            request(
                fixture.environment(true),
                "fs.find",
                scope,
                find(None),
                true,
            )
            .await,
        );
        assert!(page.location.is_none());
        assert!(
            page.data
                .items
                .iter()
                .any(|item| units(&item.path) == expected)
        );
        assert!(page.data.items.iter().all(|item| {
            let uri = url::Url::parse(&units(item.uri.as_ref().unwrap())).unwrap();
            uri.to_file_path().unwrap().is_file()
        }));
    }
    fixture.close().await;
}

#[tokio::test]
async fn remote_quota_resolves_ts_default_machine_placement_and_keeps_location() {
    let fixture = Fixture::new().await;
    let quota = Arc::new(
        quota::Service::new(
            world().core.credentials.clone(),
            quota::Endpoints::default(),
        )
        .unwrap(),
    );
    let mut environment = fixture.environment(true);
    let expected = std::env::current_dir().unwrap();
    let directory = expected.to_str().unwrap().to_owned();
    let service = quota.clone();
    Arc::get_mut(&mut environment)
        .unwrap()
        .services
        .core
        .as_mut()
        .unwrap()
        .provider_usage = Some(Arc::new(move |location| {
        assert_eq!(
            location.directory.as_lossless().as_str(),
            Some(directory.as_str())
        );
        assert!(location.workspace_id.is_none());
        Ok(ProviderUsageServices {
            quota: service.clone(),
            providers: vec![provider::Id("muse".into())],
        })
    }));
    let result: v5::ProviderUsageListResult = success(
        request(
            environment.clone(),
            "providerUsage.list",
            machine(),
            v5::ProviderUsageListRequest::default(),
            true,
        )
        .await,
    );
    assert_eq!(
        units(&result.location.directory),
        expected.to_str().unwrap()
    );
    assert!(result.location.workspace_id.is_none());
    assert_eq!(units(&result.data.items[0].provider_id), "muse");
    assert!(result.data.items[0].windows.items.is_empty());
    for location in [
        v5::ProviderUsageQueryLocation::default(),
        v5::ProviderUsageQueryLocation {
            directory: Some(text(expected.to_str().unwrap())),
            workspace: None,
        },
    ] {
        denied(
            "providerUsage.list",
            request(
                environment.clone(),
                "providerUsage.list",
                machine(),
                v5::ProviderUsageListRequest {
                    query: v5::ProviderUsageQuery {
                        location: Some(location),
                        refresh: None,
                    },
                },
                true,
            )
            .await,
        );
    }
    quota.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn remote_scope_rejects_caller_location_and_unadvertised_workspace_but_local_is_unchanged() {
    let fixture = Fixture::new().await;
    std::fs::write(fixture.path.join("needle.txt"), "root").unwrap();
    for location in [
        v5::FsFindRequestQueryLocation::default(),
        v5::FsFindRequestQueryLocation {
            directory: Some(text(&fixture.directory)),
            workspace: None,
        },
        v5::FsFindRequestQueryLocation {
            directory: None,
            workspace: Some(text("wrk_injected")),
        },
    ] {
        denied(
            "fs.find",
            request(
                fixture.environment(true),
                "fs.find",
                session_scope(&fixture.root),
                find(Some(location)),
                true,
            )
            .await,
        );
    }
    for scope in [
        workspace(&text("wsp_unadvertised")),
        location_scope(&fixture.directory),
    ] {
        denied(
            "fs.find",
            request(
                fixture.environment(true),
                "fs.find",
                scope,
                find(None),
                true,
            )
            .await,
        );
    }
    let local: v5::FsFindResult = success(
        request(
            fixture.environment(true),
            "fs.find",
            location_scope(&fixture.directory),
            find(Some(v5::FsFindRequestQueryLocation {
                directory: Some(text(&fixture.directory)),
                workspace: None,
            })),
            false,
        )
        .await,
    );
    assert_eq!(units(&local.location.unwrap().directory), fixture.directory);
    assert!(local.data.items.iter().all(|item| item.uri.is_none()));
    denied(
        "fs.find",
        request(
            fixture.environment(true),
            "fs.find",
            session_scope(&fixture.root),
            find(None),
            false,
        )
        .await,
    );
    fixture.close().await;
}

#[tokio::test]
async fn remote_forms_use_real_session_owner_not_form_id_or_global_sentinel() {
    let fixture = Fixture::new().await;
    let (_, services) = world()
        .core
        .locations
        .session(&session::Id::new(fixture.child.as_str()).unwrap())
        .unwrap();
    let id = format!("frm_{}", fixture.child);
    services
        .forms
        .create(
            form::Info::decode(
                &parse_json(&format!(
                        r#"{{"id":"{id}","sessionID":"{}","title":"Owned form","fields":[{{"type":"string","key":"name"}}]}}"#,
                    fixture.child
                ))
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let result: v5::SessionFormListResult = success(
        request(
            fixture.environment(true),
            "session.form.list",
            support::wire::form_scope(&fixture.child),
            v5::SessionFormListRequest {
                params: v5::SessionFormListRequestParams {
                    session_id: text(&fixture.child),
                },
            },
            true,
        )
        .await,
    );
    assert_eq!(units(&result.data.items[0].id), id);
    for target in [id.as_str(), "global", fixture.root.as_str()] {
        denied(
            "session.form.list",
            request(
                fixture.environment(true),
                "session.form.list",
                support::wire::form_scope(target),
                v5::SessionFormListRequest {
                    params: v5::SessionFormListRequestParams {
                        session_id: text(&fixture.child),
                    },
                },
                true,
            )
            .await,
        );
    }
    fixture.close().await;
}

#[tokio::test]
async fn remote_deleted_unavailable_and_moved_placements_fail_closed() {
    let fixture = Fixture::new().await;
    let id = advertised(&fixture).await;
    world()
        .core
        .sessions
        .publish(ycoding_core::ycoding_store::session::NewEvent {
            id: format!("evt_delete_{}", fixture.other).into(),
            aggregate_id: fixture.other.as_str().into(),
            created: now(),
            type_: "session.deleted.2".into(),
            data: parse_json(&format!(r#"{{"sessionID":"{}"}}"#, fixture.other)).unwrap(),
        })
        .await
        .unwrap();
    denied(
        "fs.find",
        request(
            fixture.environment(true),
            "fs.find",
            session_scope(&fixture.other),
            find(None),
            true,
        )
        .await,
    );
    let child = fixture.child.clone();
    let unavailable = fixture.path.join("missing").to_str().unwrap().to_owned();
    world()
        .store
        .submit(move |tx| {
            let key = tuple_key(&[KeyPart::String(&child.as_str().into())]);
            let mut row = tx.get::<SessionTable>(&key)?.unwrap();
            row.directory = unavailable.as_str().into();
            tx.put::<SessionTable>(&row)
        })
        .unwrap()
        .await
        .unwrap();
    denied(
        "fs.find",
        request(
            fixture.environment(true),
            "fs.find",
            session_scope(&fixture.child),
            find(None),
            true,
        )
        .await,
    );
    std::fs::rename(&fixture.path, fixture.path.with_extension("moved")).unwrap();
    for scope in [session_scope(&fixture.root), workspace(&id)] {
        denied(
            "fs.find",
            request(
                fixture.environment(true),
                "fs.find",
                scope,
                find(None),
                true,
            )
            .await,
        );
    }
    std::fs::rename(fixture.path.with_extension("moved"), &fixture.path).unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn remote_shell_output_resolves_owner_and_omits_location() {
    let fixture = Fixture::new().await;
    let shell = owned_shell(
        &fixture.child_platform,
        Some(&fixture.child),
        "printf placement-output",
    )
    .await;
    fixture.child_platform.shell.wait(&shell.id).await.unwrap();
    let query = v5::ShellOutputRequest {
        params: v5::ShellOutputRequestParams {
            id: shell_id(&shell.id),
        },
        query: v5::ShellOutputRequestQuery::default(),
    };
    let page: v5::ShellOutputResult = success(
        request(
            fixture.environment(true),
            "shell.output",
            session_scope(&fixture.child),
            query.clone(),
            true,
        )
        .await,
    );
    assert_eq!(units(&page.data.output), "placement-output");
    assert!(page.location.is_none());
    let mut injected = query.clone();
    injected.query.location = Some(v5::ShellOutputRequestQueryLocation::default());
    denied(
        "shell.output",
        request(
            fixture.environment(true),
            "shell.output",
            session_scope(&fixture.child),
            injected,
            true,
        )
        .await,
    );
    for scope in [session_scope(&fixture.root), session_scope(&fixture.other)] {
        denied(
            "shell.output",
            request(
                fixture.environment(true),
                "shell.output",
                scope,
                query.clone(),
                true,
            )
            .await,
        );
    }
    let foreign = owned_shell(&fixture.platform, Some(&fixture.other), "printf foreign").await;
    fixture.platform.shell.wait(&foreign.id).await.unwrap();
    let query = v5::ShellOutputRequest {
        params: v5::ShellOutputRequestParams {
            id: shell_id(&foreign.id),
        },
        query: v5::ShellOutputRequestQuery::default(),
    };
    denied(
        "shell.output",
        request(
            fixture.environment(true),
            "shell.output",
            session_scope(&fixture.root),
            query,
            true,
        )
        .await,
    );
    fixture.close().await;
}

#[tokio::test]
async fn remote_create_uses_advertised_workspace_and_revalidates_reused_placement() {
    let fixture = Fixture::new().await;
    let id = advertised(&fixture).await;
    let query = v5::SessionCreateRequest {
        payload: v5::SessionCreateRequestPayload {
            id: Some(text(&format!("{}_created", fixture.root))),
            ..Default::default()
        },
    };
    let result: v5::SessionCreateResult = success(
        request(
            fixture.environment(true),
            "session.create",
            workspace(&id),
            query.clone(),
            true,
        )
        .await,
    );
    assert_eq!(units(&result.data.location.directory), fixture.directory);
    let mut injected = query.clone();
    injected.payload.location = Some(v5::LocationRef {
        directory: text(&fixture.directory),
        workspace_id: None,
    });
    denied(
        "session.create",
        request(
            fixture.environment(true),
            "session.create",
            workspace(&id),
            injected,
            true,
        )
        .await,
    );
    let mut child = query.clone();
    child.payload.parent_id = Some(text(&fixture.root));
    denied(
        "session.create",
        request(
            fixture.environment(true),
            "session.create",
            workspace(&id),
            child,
            true,
        )
        .await,
    );
    let child_workspace: v5::WorkspaceListResult = success(
        request(
            fixture.environment(true),
            "workspace.list",
            machine(),
            v5::WorkspaceListRequest::default(),
            true,
        )
        .await,
    );
    let child_id = child_workspace
        .data
        .items
        .iter()
        .find(|item| units(&item.directory) == fixture.child_directory)
        .unwrap()
        .id
        .clone();
    denied(
        "session.create",
        request(
            fixture.environment(true),
            "session.create",
            workspace(&child_id),
            query,
            true,
        )
        .await,
    );
    fixture.close().await;
}
