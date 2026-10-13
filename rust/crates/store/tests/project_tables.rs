use ycoding_schema::LosslessString;
use ycoding_store::{
    Catalog, Error, KeyPart, Metadata, Options, Store, TableDeclaration, TableSpec, project,
    tuple_key,
};

const CATALOG: Catalog = Catalog::new(
    1,
    &[
        TableDeclaration::of::<project::ProjectTable>(),
        TableDeclaration::of::<project::WorkspaceTable>(),
        TableDeclaration::of::<project::DirectoryTable>(),
        TableDeclaration::of::<project::PermissionTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::ArtifactTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::ScopeTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::ProjectScopeTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::GlobalScopeTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::VersionTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::TrashTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::OperationTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::ActivationTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::ObservationTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::TerminalTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::FeedbackTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::WriteTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::LegacyCleanupTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::MigrationTable>(),
        TableDeclaration::of::<ycoding_store::artifacts::DatabaseFormatTable>(),
        TableDeclaration::of::<ycoding_store::resources::CredentialTable>(),
        TableDeclaration::of::<ycoding_store::resources::KvTable>(),
        TableDeclaration::of::<ycoding_store::resources::ShellTable>(),
        TableDeclaration::of::<ycoding_store::resources::ConsentTable>(),
        TableDeclaration::of::<ycoding_store::resources::MigrationTable>(),
        TableDeclaration::of::<ycoding_store::resources::SequenceTable>(),
        TableDeclaration::of::<ycoding_store::resources::ContinuationGenerationTable>(),
        TableDeclaration::of::<ycoding_store::resources::ContinuationTable>(),
        TableDeclaration::of::<ycoding_store::resources::StateBlobTable>(),
        TableDeclaration::of::<ycoding_store::resources::StateLinkTable>(),
        TableDeclaration::of::<ycoding_store::resources::RequestTable>(),
        TableDeclaration::of::<ycoding_store::resources::UsageTable>(),
        TableDeclaration::of::<ycoding_store::resources::LatencyTable>(),
        TableDeclaration::of::<ycoding_store::analytics::DeliveryTable>(),
        TableDeclaration::of::<ycoding_store::analytics::IntentTable>(),
    ],
);

fn root() -> project::Project {
    project::Project {
        id: "p".into(),
        worktree: "/p".into(),
        vcs: None,
        name: None,
        icon_url: None,
        icon_url_override: None,
        icon_color: None,
        time_created: i64::MIN,
        time_updated: i64::MAX,
        time_initialized: None,
        sandboxes: vec![LosslessString::from_utf16(vec![0, 0xd800, 0xdc00, 0xdfff])],
        commands: None,
    }
}
fn permission(id: &str) -> project::Permission {
    project::Permission {
        id: id.into(),
        project_id: "p".into(),
        action: "read".into(),
        resource: "*".into(),
        time_created: -1,
        time_updated: 0,
    }
}
fn store() -> Store {
    Store::disposable(Options::core(), CATALOG, Metadata::new([1; 16], 1)).unwrap()
}

#[test]
fn permission_identity_rejects_different_owner_and_rolls_back_batch() {
    let store = store();
    store
        .submit(|tx| {
            project::ProjectTable::insert(tx, &root())?;
            project::PermissionTable::insert(tx, &permission("one"))
        })
        .unwrap()
        .wait()
        .unwrap();
    let failed = store
        .submit(|tx| {
            project::PermissionTable::put(
                tx,
                &project::Permission {
                    action: "write".into(),
                    ..permission("extra")
                },
            )?;
            project::PermissionTable::insert(tx, &permission("two"))
        })
        .unwrap()
        .wait();
    assert!(matches!(
        failed,
        Err(Error::UniqueViolation {
            index: "permission_project_action_resource_idx"
        })
    ));
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<project::PermissionTable>(&tuple_key(&[KeyPart::String(&"extra".into())]))
            .unwrap()
            .is_none()
    );
}

#[test]
fn project_record_codec_preserves_odd_strings_and_integer_nulls() {
    let record = root();
    assert_eq!(
        project::ProjectTable::decode(&project::ProjectTable::encode(&record).unwrap()).unwrap(),
        record
    );
    assert!(project::ProjectTable::decode(&[1]).is_err());
    let mut encoded = project::ProjectTable::encode(&record).unwrap();
    encoded.push(0);
    assert!(project::ProjectTable::decode(&encoded).is_err());
}

#[test]
fn project_child_requires_parent_even_if_rejection_is_caught() {
    let store = store();
    let failed = store
        .submit(|tx| {
            let _ = project::PermissionTable::put(tx, &permission("one"));
            project::ProjectTable::put(tx, &root())?;
            Ok(())
        })
        .unwrap()
        .wait();
    assert!(matches!(
        failed,
        Err(Error::Domain {
            kind: "foreign_reference",
            ..
        })
    ));
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<project::ProjectTable>(&project::ProjectTable::primary_key(&root()))
            .unwrap()
            .is_none()
    );
}

#[test]
fn project_children_preserve_codecs_primary_identity_and_parent_references() {
    let store = store();
    let workspace = project::Workspace {
        id: "w".into(),
        type_: "git".into(),
        name: LosslessString::from_utf16(vec![0, 0xd800]),
        branch: None,
        directory: Some("/p".into()),
        extra: Some(ycoding_schema::parse_json("{\"key\\udfff\":null}").unwrap()),
        project_id: "p".into(),
        time_used: i64::MIN,
    };
    let directory = project::Directory {
        project_id: "p".into(),
        directory: "/p".into(),
        type_: None,
        strategy: Some(LosslessString::from_utf16(vec![0xdc00])),
        time_created: i64::MAX,
    };
    assert_eq!(
        project::WorkspaceTable::decode(&project::WorkspaceTable::encode(&workspace).unwrap())
            .unwrap(),
        workspace
    );
    assert_eq!(
        project::DirectoryTable::decode(&project::DirectoryTable::encode(&directory).unwrap())
            .unwrap(),
        directory
    );
    assert_eq!(
        project::PermissionTable::decode(
            &project::PermissionTable::encode(&permission("one")).unwrap()
        )
        .unwrap(),
        permission("one")
    );
    for failed in [
        store
            .submit({
                let workspace = workspace.clone();
                move |tx| project::WorkspaceTable::put(tx, &workspace)
            })
            .unwrap()
            .wait(),
        store
            .submit({
                let directory = directory.clone();
                move |tx| project::DirectoryTable::put(tx, &directory)
            })
            .unwrap()
            .wait(),
    ] {
        assert!(matches!(
            failed,
            Err(Error::Domain {
                kind: "foreign_reference",
                ..
            })
        ));
    }
    let put_workspace = workspace.clone();
    let put_directory = directory.clone();
    store
        .submit(move |tx| {
            project::ProjectTable::put(tx, &root())?;
            project::WorkspaceTable::insert(tx, &put_workspace)?;
            project::DirectoryTable::insert(tx, &put_directory)?;
            project::PermissionTable::insert(tx, &permission("one"))
        })
        .unwrap()
        .wait()
        .unwrap();
    let duplicate_workspace = workspace.clone();
    let duplicate_directory = directory.clone();
    assert!(matches!(
        store
            .submit(move |tx| project::WorkspaceTable::insert(tx, &duplicate_workspace))
            .unwrap()
            .wait(),
        Err(Error::Domain {
            kind: "primary_key",
            ..
        })
    ));
    assert!(matches!(
        store
            .submit(move |tx| project::DirectoryTable::insert(tx, &duplicate_directory))
            .unwrap()
            .wait(),
        Err(Error::Domain {
            kind: "primary_key",
            ..
        })
    ));
    assert!(matches!(
        store
            .submit(|tx| project::ProjectTable::insert(tx, &root()))
            .unwrap()
            .wait(),
        Err(Error::Domain {
            kind: "primary_key",
            ..
        })
    ));
    assert!(matches!(
        store
            .submit(|tx| project::PermissionTable::insert(tx, &permission("one")))
            .unwrap()
            .wait(),
        Err(Error::Domain {
            kind: "primary_key",
            ..
        })
    ));
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .get::<project::WorkspaceTable>(&project::WorkspaceTable::primary_key(&workspace))
            .unwrap()
            .unwrap(),
        workspace
    );
    assert_eq!(
        project::DirectoryTable::primary_key(&directory),
        tuple_key(&[KeyPart::String(&"p".into()), KeyPart::String(&"/p".into())])
    );
}

#[test]
fn project_children_and_permission_unique_index_survive_file_reopen() {
    let path = std::env::temp_dir().join(format!(
        "ycoding-project-catalog-{}-{}.redb",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let store =
        Store::initialize(&path, Options::core(), CATALOG, Metadata::new([6; 16], 1)).unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::put(tx, &root())?;
            project::PermissionTable::put(tx, &permission("one"))?;
            project::WorkspaceTable::put(
                tx,
                &project::Workspace {
                    id: "w".into(),
                    type_: "git".into(),
                    name: "".into(),
                    branch: None,
                    directory: None,
                    extra: None,
                    project_id: "p".into(),
                    time_used: 0,
                },
            )?;
            project::DirectoryTable::put(
                tx,
                &project::Directory {
                    project_id: "p".into(),
                    directory: "/p".into(),
                    type_: None,
                    strategy: None,
                    time_created: 0,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    let store = Store::open(&path, Options::core(), CATALOG).unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .get::<project::ProjectTable>(&project::ProjectTable::primary_key(&root()))
            .unwrap()
            .unwrap(),
        root()
    );
    assert_eq!(
        snapshot
            .index::<project::PermissionTable>(
                "permission_project_action_resource_idx",
                &tuple_key(&[
                    KeyPart::String(&"p".into()),
                    KeyPart::String(&"read".into()),
                    KeyPart::String(&"*".into())
                ]),
                None,
                1
            )
            .unwrap(),
        vec![permission("one")]
    );
    assert!(
        snapshot
            .get::<project::WorkspaceTable>(&tuple_key(&[KeyPart::String(&"w".into())]))
            .unwrap()
            .is_some()
    );
    assert!(
        snapshot
            .get::<project::DirectoryTable>(&tuple_key(&[
                KeyPart::String(&"p".into()),
                KeyPart::String(&"/p".into())
            ]))
            .unwrap()
            .is_some()
    );
    drop(snapshot);
    store.shutdown().unwrap();
    std::fs::remove_file(path).unwrap();
}
