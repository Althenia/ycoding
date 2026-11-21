use std::path::Path;
use ycoding_core::resources::{
    agent::{self, Service},
    config::Entry,
};
use ycoding_schema::{DomainEncode, JsonValue, parse_json};

#[test]
fn empty_agent_defaults_allow_worktree_and_an_empty_service_has_no_builtin_catalog() {
    let info = agent::empty("god".into());
    assert_eq!(
        ycoding_core::tools::policy::evaluate(
            &"worktree".into(),
            &"/data/worktrees/repo_abc/feature".into(),
            &info.permissions,
        )
        .effect,
        ycoding_schema::permission::Effect("allow".into())
    );
    let service = Service::new(Vec::new());
    assert!(service.get(&"god".into()).is_none());
    assert!(service.get(&"btw".into()).is_none());
}

#[test]
fn agent_selection_defaults_and_explicit_selection_preserve_unknown_identity() {
    let mut service = Service::new(Vec::new());
    assert_eq!(service.select(None).id, "god".into());
    assert!(service.select(None).info.is_none());
    service.update("hidden".into(), |a| a.hidden = true);
    service.update("sub".into(), |a| a.mode = "subagent".into());
    service.update("btw".into(), |_| {});
    service.update("first".into(), |_| {});
    service.update("god".into(), |_| {});
    service.set_default(Some("hidden".into()));
    assert_eq!(service.default().unwrap().id, "god".into());
    service.set_default(Some("first".into()));
    assert_eq!(service.list()[0].id, "first".into());
    assert_eq!(service.select(Some("unknown".into())).id, "unknown".into());
    assert!(service.select(Some("unknown".into())).info.is_none());
    assert_eq!(
        service.resolve(Some(&"sub".into())).unwrap().mode,
        "subagent".into()
    );
    assert!(agent::is_autocomplete_selectable(
        service.get(&"sub".into()).unwrap()
    ));
    assert!(!agent::is_selectable(service.get(&"sub".into()).unwrap()));
    assert!(!agent::is_autocomplete_selectable(
        service.get(&"btw".into()).unwrap()
    ));
    service.update("first".into(), |a| a.id = "cannot-change-id".into());
    assert_eq!(service.get(&"first".into()).unwrap().id, "first".into());
    service.remove(&"first".into());
    assert_eq!(service.default().unwrap().id, "god".into());
}

#[test]
fn agent_documents_append_all_global_permissions_before_specific_and_shallow_merge_requests() {
    let entries = vec![
        Entry::Document { path: Some("/repo/ycoding.json".into()), info: parse_json(r#"{"permissions":[{"action":"read","resource":"~/private/**","effect":"deny"}],"agents":{"review":{"model":{"providerID":"p","model":"m","variant":"high","profile":"Work"},"mode":"primary","request":{"body":{"nested":{"a":1},"a":1}},"permissions":[{"action":"shell","resource":"$HOME/raw","effect":"deny"}]}}}"#).unwrap() },
        Entry::Document { path: None, info: parse_json(r#"{"default_agent":"review","permissions":[{"action":"edit","resource":"$HOME\\cache","effect":"allow"}],"agents":{"review":{"description":"","hidden":false,"request":{"body":{"nested":{"b":2},"b":2},"headers":{"X-Example":"value"}},"permissions":[{"action":"external_directory","resource":"$HOME/lib","effect":"ask"}]},"disabled":{"disabled":true}}}"#).unwrap() },
    ];
    let service = Service::from_documents(
        &entries,
        Path::new("/home/test"),
        vec![agent::empty("disabled".into())],
    )
    .unwrap();
    let a = service.get(&"review".into()).unwrap();
    assert_eq!(service.list()[0].id, "review".into());
    assert_eq!(a.name, "review".into());
    assert_eq!(a.description, Some("".into()));
    assert_eq!(
        a.permissions
            .iter()
            .map(|r| r.resource.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        [
            "*",
            "*",
            "/home/test/private/**",
            "/home/test\\cache",
            "$HOME/raw",
            "/home/test/lib"
        ]
    );
    let JsonValue::Object(request) = a.request.encode() else {
        panic!()
    };
    assert_eq!(
        request.get(&"body".into()),
        Some(&parse_json(r#"{"nested":{"b":2},"a":1,"b":2}"#).unwrap())
    );
    assert_eq!(a.model.as_ref().unwrap().id, "m".into());
    assert_eq!(a.model.as_ref().unwrap().variant, Some("high".into()));
    assert_eq!(
        a.locations.as_ref().unwrap()[0].as_lossless(),
        &"/repo/ycoding.json".into()
    );
    assert!(service.get(&"disabled".into()).is_none());
}
