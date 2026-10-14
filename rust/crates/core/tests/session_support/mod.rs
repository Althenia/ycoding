use ycoding_store::{
    Catalog, Metadata, Options, Store, TableDeclaration, analytics, project, session,
};

const CATALOG: Catalog = Catalog::new(
    1,
    &[
        TableDeclaration::of::<project::ProjectTable>(),
        TableDeclaration::of::<project::WorkspaceTable>(),
        TableDeclaration::of::<project::PermissionTable>(),
        TableDeclaration::of::<session::SequenceTable>(),
        TableDeclaration::of::<session::EventTable>(),
        TableDeclaration::of::<session::SessionTable>(),
        TableDeclaration::of::<session::MessageTable>(),
        TableDeclaration::of::<session::TodoTable>(),
        TableDeclaration::of::<session::TodoStateTable>(),
        TableDeclaration::of::<session::PendingTable>(),
        TableDeclaration::of::<session::TaskTable>(),
        TableDeclaration::of::<session::NotificationTable>(),
        TableDeclaration::of::<session::RevisionTable>(),
        TableDeclaration::of::<session::ContextStateTable>(),
        TableDeclaration::of::<session::InstructionEntryTable>(),
        TableDeclaration::of::<session::InstructionBlobTable>(),
        TableDeclaration::of::<session::InstructionStateTable>(),
        TableDeclaration::of::<ycoding_store::resources::CredentialTable>(),
        TableDeclaration::of::<ycoding_store::resources::ConsentTable>(),
        TableDeclaration::of::<ycoding_store::resources::RequestTable>(),
        TableDeclaration::of::<ycoding_store::resources::SequenceTable>(),
        TableDeclaration::of::<session::FileChangeTable>(),
        TableDeclaration::of::<ycoding_store::resources::UsageTable>(),
        TableDeclaration::of::<ycoding_store::resources::ContinuationGenerationTable>(),
        TableDeclaration::of::<ycoding_store::resources::ContinuationTable>(),
        TableDeclaration::of::<ycoding_store::resources::StateBlobTable>(),
        TableDeclaration::of::<ycoding_store::resources::StateLinkTable>(),
        TableDeclaration::of::<session::ManifestTable>(),
        TableDeclaration::of::<session::JobTable>(),
        TableDeclaration::of::<session::ExclusionTable>(),
        TableDeclaration::of::<analytics::DeliveryTable>(),
        TableDeclaration::of::<analytics::IntentTable>(),
    ],
);

mod record;
pub use record::record;

pub fn store() -> Store {
    let store = Store::disposable(Options::core(), CATALOG, Metadata::new([7; 16], 1)).unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_one".into(),
                    worktree: "/project".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            session::SessionTable::insert(tx, &record("ses_one"))?;
            session::SessionTable::insert(tx, &record("ses_two"))
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}
