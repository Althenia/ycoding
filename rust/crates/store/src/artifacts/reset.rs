use super::tables::{
    Activation, ActivationTable, Artifact, ArtifactTable, AutomaticWrite, Feedback, FeedbackTable,
    GlobalScope, GlobalScopeTable, LegacyCleanup, LegacyCleanupTable, Observation,
    ObservationTable, Operation, OperationTable, ProjectScope, ProjectScopeTable, Scope,
    ScopeTable, Terminal, TerminalTable, Trash, TrashTable, Version, VersionTable, WriteTable,
};
use crate::{Error, Write, project::remove_children};

pub fn reset(tx: &mut Write<'_>) -> Result<(), Error> {
    remove_children::<OperationTable>(tx, |_: &Operation| true)?;
    remove_children::<ActivationTable>(tx, |_: &Activation| true)?;
    remove_children::<ObservationTable>(tx, |_: &Observation| true)?;
    remove_children::<TerminalTable>(tx, |_: &Terminal| true)?;
    remove_children::<FeedbackTable>(tx, |_: &Feedback| true)?;
    remove_children::<WriteTable>(tx, |_: &AutomaticWrite| true)?;
    remove_children::<LegacyCleanupTable>(tx, |_: &LegacyCleanup| true)?;
    remove_children::<TrashTable>(tx, |_: &Trash| true)?;
    remove_children::<ArtifactTable>(tx, |_: &Artifact| true)?;
    remove_children::<VersionTable>(tx, |_: &Version| true)?;
    remove_children::<ProjectScopeTable>(tx, |_: &ProjectScope| true)?;
    remove_children::<GlobalScopeTable>(tx, |_: &GlobalScope| true)?;
    remove_children::<ScopeTable>(tx, |_: &Scope| true)
}
