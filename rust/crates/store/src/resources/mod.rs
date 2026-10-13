use crate::session::codec;
mod operations;
mod records;
pub use operations::*;
pub(crate) use operations::{remove_revision_children, remove_session_children};
pub use records::*;

use crate::{Error, TableDeclaration, Write, analytics};

pub const TABLES: &[TableDeclaration] = &[
    TableDeclaration::of::<CredentialTable>(),
    TableDeclaration::of::<KvTable>(),
    TableDeclaration::of::<ShellTable>(),
    TableDeclaration::of::<ConsentTable>(),
    TableDeclaration::of::<MigrationTable>(),
    TableDeclaration::of::<SequenceTable>(),
    TableDeclaration::of::<ContinuationGenerationTable>(),
    TableDeclaration::of::<ContinuationTable>(),
    TableDeclaration::of::<StateBlobTable>(),
    TableDeclaration::of::<StateLinkTable>(),
    TableDeclaration::of::<RequestTable>(),
    TableDeclaration::of::<UsageTable>(),
    TableDeclaration::of::<LatencyTable>(),
];

pub(crate) fn source_changed(
    tx: &mut Write<'_>,
    source: &'static str,
    identity: Vec<u8>,
    delete: bool,
) -> Result<(), Error> {
    analytics::record(
        tx,
        analytics::Change {
            source,
            identity,
            delete,
        },
    )?;
    Ok(())
}
