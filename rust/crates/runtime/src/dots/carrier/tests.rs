use super::{state::Store, test_support::HostFixture};

#[tokio::test]
async fn installation_identity_is_atomic_private_and_stable_across_loaders() {
    let fixture = HostFixture::new().await;
    let path = fixture.state_path();
    let first = Store::new(path.clone());
    let second = Store::new(path.clone());
    let (first, second) = tokio::join!(first.load(), second.load());
    let first = first.unwrap();
    assert_eq!(first, second.unwrap());
    assert!(!first.installation_id.is_empty());
    assert!(first.enrollments.is_empty());
    assert_eq!(Store::new(path.clone()).load().await.unwrap(), first);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn loading_preserves_legacy_enrollments_and_never_replaces_invalid_identity() {
    let fixture = HostFixture::new().await;
    let path = fixture.state_path();
    let legacy = r#"{"installationID":"installation-existing","enrollments":{"legacy-account":{"serverID":"server-existing","environmentID":"environment-existing","serverName":"Fixture","remoteControlEnabled":false,"updatedAt":42}},"futureField":true}"#;
    std::fs::write(&path, legacy).unwrap();
    let loaded = Store::new(path.clone()).load().await.unwrap();
    assert_eq!(loaded.installation_id, "installation-existing");
    assert_eq!(
        loaded.enrollments["legacy-account"].server_id,
        "server-existing"
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
    for invalid in ["{", r#"{"installationID":""}"#, r#"{"enrollments":{}}"#] {
        std::fs::write(&path, invalid).unwrap();
        assert!(Store::new(path.clone()).load().await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), invalid);
    }
}
