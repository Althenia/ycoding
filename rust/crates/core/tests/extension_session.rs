include!("tool_fixture.rs");
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use ycoding_core::extension::{
    Configuration, Extension, FamilyGrant, Host, Options, SessionHost, ToolGrant, v5,
};
use ycoding_core::session::{
    execution::{Execution, Locations, Runner},
    run_coordinator::Error,
    store::Service,
};
use ycoding_schema::{location, parse_json, session, stringify_json};

#[path = "session_support/mod.rs"]
mod support;

struct NoPlacement;
impl Locations for NoPlacement {
    fn get(&self, _: &location::Ref) -> Result<Arc<dyn Runner>, Error> {
        Err(Error::Closed)
    }
}

fn configuration(fixture: &ToolFixture, scopes: &[&str]) -> Configuration {
    Configuration {
        identity: "fixture".into(),
        executable: "/usr/bin/python3".into(),
        args: vec![
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/extension_child.py").into(),
            "session_ops".into(),
        ],
        directory: fixture.root.clone(),
        registration_order: 0,
        grants: vec![ToolGrant {
            namespace: "demo".into(),
            tools: vec!["echo".into()],
            action: "extension.echo".into(),
            resources: vec!["demo".into()],
        }],
        families: vec![FamilyGrant {
            family: v5::CapabilityFamily::Session,
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            action: "extension.session".into(),
            resources: vec!["sessions".into()],
        }],
    }
}
async fn summary(fixture: &ToolFixture, scopes: &[&str], host: Host) -> Value {
    let registry = fixture.registry();
    let extension = Extension::start(
        configuration(fixture, scopes),
        Options {
            startup: Duration::from_secs(1),
            execution: Duration::from_secs(10),
            cleanup: Duration::from_millis(100),
            shutdown: Duration::from_millis(100),
            write: Duration::from_millis(500),
        },
        &registry,
        fixture.policy.clone(),
        &fixture.context(),
        host,
    )
    .await
    .unwrap();
    let settlement = registry
        .materialize(&[])
        .invoke("demo_echo", parse_json("{}").unwrap(), fixture.context())
        .await
        .unwrap();
    assert!(settlement.error.is_none());
    extension.shutdown().await;
    serde_json::from_str(&stringify_json(&settlement.output.unwrap().structured)).unwrap()
}

#[tokio::test]
async fn session_calls_stay_inside_the_hosts_location_and_follow_durable_admission() {
    let store = support::store();
    let mut far = support::record("ses_far");
    far.directory = "/elsewhere".into();
    store
        .submit(move |tx| ycoding_store::session::SessionTable::insert(tx, &far))
        .unwrap()
        .wait()
        .unwrap();
    let sessions = Service::new(store.client());
    Execution::install(
        sessions.clone(),
        Arc::new(NoPlacement),
        ycoding_core::job::Jobs::new(),
        None,
    )
    .unwrap();
    let id = |value: &str| session::Id::new(value).unwrap();
    let host = || Host {
        sessions: Some(SessionHost {
            store: sessions.clone(),
            location: sessions.get(&id("ses_one")).unwrap().unwrap().location,
        }),
        ..Host::default()
    };

    let fixture = ToolFixture::new();
    let all = summary(&fixture, &["get", "prompt", "interrupt"], host()).await;
    assert_eq!(all["get"]["value"]["title"], "Test");
    for rejected in ["foreign", "missing", "reuse", "far_prompt", "far_interrupt"] {
        assert_eq!(all[rejected]["failure"], 1, "{rejected}");
    }
    assert_eq!(all["prompt"]["value"]["id"], "msg_child");
    assert_eq!(
        all["retry"], all["prompt"],
        "the first admission wins on retry"
    );
    assert!(all["interrupt"]["value"].is_null());
    assert_eq!(sessions.pending_list(&id("ses_one")).unwrap().len(), 1);
    for other in ["ses_two", "ses_far"] {
        assert!(sessions.pending_list(&id(other)).unwrap().is_empty());
    }
    fixture.cleanup();

    let fixture = ToolFixture::new();
    let get_only = summary(&fixture, &["get"], host()).await;
    assert_eq!(get_only["get"]["value"]["title"], "Test");
    for rejected in ["prompt", "retry", "interrupt"] {
        assert_eq!(
            get_only[rejected]["failure"], 1,
            "{rejected} requires its own scope"
        );
    }
    fixture.cleanup();

    let fixture = ToolFixture::new();
    let hostless = summary(&fixture, &["get", "prompt", "interrupt"], Host::default()).await;
    for rejected in ["get", "prompt", "interrupt"] {
        assert_eq!(hostless[rejected]["failure"], 1, "{rejected}");
    }
    fixture.cleanup();
    store.shutdown().unwrap();
}

#[test]
fn session_scopes_are_the_three_operations() {
    let fixture = ToolFixture::new();
    for (scopes, valid) in [
        (&["get", "prompt", "interrupt"][..], true),
        (&["create"][..], false),
        (&["get", "get"][..], false),
    ] {
        assert_eq!(configuration(&fixture, scopes).validate().is_ok(), valid);
    }
    fixture.cleanup();
}
