mod cleanup;
pub(crate) mod codec;
mod operations;
mod tables;
pub use cleanup::*;
pub use codec::Document;
pub use operations::*;
pub use tables::*;

use crate::TableDeclaration;

pub const TABLES: &[TableDeclaration] = &[
    TableDeclaration::of::<SequenceTable>(),
    TableDeclaration::of::<EventTable>(),
    TableDeclaration::of::<SessionTable>(),
    TableDeclaration::of::<MessageTable>(),
    TableDeclaration::of::<PendingTable>(),
    TableDeclaration::of::<TodoTable>(),
    TableDeclaration::of::<TodoStateTable>(),
    TableDeclaration::of::<FileChangeTable>(),
    TableDeclaration::of::<TaskTable>(),
    TableDeclaration::of::<NotificationTable>(),
    TableDeclaration::of::<ManifestTable>(),
    TableDeclaration::of::<JobTable>(),
    TableDeclaration::of::<RevisionTable>(),
    TableDeclaration::of::<ContextStateTable>(),
    TableDeclaration::of::<ExclusionTable>(),
    TableDeclaration::of::<InstructionEntryTable>(),
    TableDeclaration::of::<InstructionBlobTable>(),
    TableDeclaration::of::<InstructionStateTable>(),
];
