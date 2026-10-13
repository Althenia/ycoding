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

pub fn record(id: &str) -> session::Session {
    session::Session {
        id: id.into(),
        project_id: "prj_one".into(),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: "/project".into(),
        path: None,
        title: "Test".into(),
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
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 1,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
    }
}

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
