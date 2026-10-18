pub mod filesystem_fixture;
mod policy_fixture {
    include!("policy_fixture.rs");
}
use filesystem_fixture::Fixture;
use ycoding_core::{
    platform::filesystem::{Location, mutation::Service},
    tools::policy::permissions::Error,
};
use ycoding_schema::permission;

fn request(session: &ycoding_schema::session_id::SessionId, id: &str) -> permission::Request {
    permission::Request {
        id: permission::Id::new(id).unwrap(),
        session_id: session.clone(),
        action: "write".into(),
        resources: vec!["untrusted".into()],
        save: None,
        source: None,
        metadata: None,
    }
}

#[tokio::test]
async fn resolved_external_targets_require_policy_approval_before_write_and_remove() {
    let inside = Fixture::new();
    let outside = Fixture::new();
    // Anchor saved directory approvals here, independently of a repository above the temp root.
    outside.repository();
    let location = Location::new(&inside.0).unwrap();
    let policy = policy_fixture::Fixture::default();
    let session = policy.session("ses_mutation", None, 0, false, None);
    let permissions = policy.permissions();
    let path = outside.0.join("nested/external.txt");
    policy.rules.lock().unwrap().push(permission::Rule {
        action: "external_directory".into(),
        resource: "*".into(),
        effect: permission::Effect("deny".into()),
    });
    assert!(matches!(
        location
            .resolve_mutation_authorized(
                path.to_str().unwrap(),
                &permissions,
                request(&session, "per_denied"),
                None
            )
            .await,
        Err(
            ycoding_core::platform::filesystem::mutation::ResolveError::Permission(
                Error::Blocked { .. }
            )
        )
    ));
    assert!(!path.exists());
    policy.rules.lock().unwrap().clear();
    let resolution = location.resolve_mutation_authorized(
        path.to_str().unwrap(),
        &permissions,
        request(&session, "per_external"),
        None,
    );
    tokio::pin!(resolution);
    tokio::select! {
        result = &mut resolution => panic!("external mutation resolved without approval: {result:?}"),
        () = async { while permissions.list().is_empty() { tokio::task::yield_now().await; } } => (),
    }
    let pending = permissions.list().pop().unwrap();
    assert_eq!(pending.action, "external_directory".into());
    assert_eq!(
        pending.resources,
        vec![format!("{}/*", outside.0.display()).into()]
    );
    assert_eq!(pending.save, Some(pending.resources.clone()));
    permissions
        .reply(&pending.id, permission::Reply("once".into()), None)
        .unwrap();
    let target = resolution.await.unwrap();
    assert_eq!(target.canonical, path);
    assert_eq!(target.resource, path.to_str().unwrap());
    let service = Service::default();
    let result = service.write(&target, b"external").unwrap();
    assert!(!result.existed);
    assert_eq!(std::fs::read(&path).unwrap(), b"external");
    policy.rules.lock().unwrap().push(permission::Rule {
        action: "external_directory".into(),
        resource: "*".into(),
        effect: permission::Effect("allow".into()),
    });
    let target = location
        .resolve_mutation_authorized(
            path.to_str().unwrap(),
            &permissions,
            request(&session, "per_remove"),
            None,
        )
        .await
        .unwrap();
    assert!(service.remove(&target).unwrap().existed);
    assert!(!path.exists());
    let internal = location
        .resolve_mutation_authorized(
            "internal.txt",
            &permissions,
            request(&session, "per_internal"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(internal.resource, "internal.txt");
    assert!(permissions.list().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn internal_symlink_escape_is_never_an_authorizable_external_target() {
    let inside = Fixture::new();
    let outside = Fixture::new();
    std::os::unix::fs::symlink(&outside.0, inside.0.join("link")).unwrap();
    let policy = policy_fixture::Fixture::default();
    let session = policy.session("ses_escape", None, 2, false, None);
    let permissions = policy.permissions();
    let result = Location::new(&inside.0)
        .unwrap()
        .resolve_mutation_authorized(
            "link/missing",
            &permissions,
            request(&session, "per_escape"),
            None,
        )
        .await;
    assert!(
        matches!(result, Err(ycoding_core::platform::filesystem::mutation::ResolveError::Io(error)) if error.kind() == std::io::ErrorKind::PermissionDenied)
    );
    assert!(permissions.list().is_empty());
    assert!(!outside.0.join("missing").exists());
}
