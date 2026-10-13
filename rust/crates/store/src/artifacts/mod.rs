mod codec;
mod operations;
mod tables;
pub use operations::*;
pub use tables::*;

use crate::TableDeclaration;

pub const TABLES: &[TableDeclaration] = &[
    TableDeclaration::of::<ArtifactTable>(),
    TableDeclaration::of::<ScopeTable>(),
    TableDeclaration::of::<ProjectScopeTable>(),
    TableDeclaration::of::<GlobalScopeTable>(),
    TableDeclaration::of::<VersionTable>(),
    TableDeclaration::of::<TrashTable>(),
    TableDeclaration::of::<OperationTable>(),
    TableDeclaration::of::<ActivationTable>(),
    TableDeclaration::of::<ObservationTable>(),
    TableDeclaration::of::<TerminalTable>(),
    TableDeclaration::of::<FeedbackTable>(),
    TableDeclaration::of::<WriteTable>(),
    TableDeclaration::of::<LegacyCleanupTable>(),
    TableDeclaration::of::<MigrationTable>(),
    TableDeclaration::of::<DatabaseFormatTable>(),
];
