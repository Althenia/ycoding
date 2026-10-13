mod document;
mod erasure;
mod operations;
mod tables;

use crate::session::codec;
use crate::{Catalog, Error, Metadata, Options, Store, TableDeclaration};
use std::path::{Path, PathBuf};

pub use erasure::{ErasurePhase, MeetingStore};
pub use operations::{
    approvals, checkpoints, clear_optional_fields, correct_segment, create_meeting, delete_meeting,
    findings, get_meeting, jobs, list_meetings, next_sequence, next_sequence_tx, plan, proposals,
    put_approval, put_checkpoint, put_finding, put_job, put_plan, put_proposal, put_reference,
    put_segment, recover, references, retain, segments, update_meeting,
};
pub use tables::{
    ApprovalTable, CheckpointTable, FindingTable, JobTable, Meeting, MeetingTable, PlanTable,
    ProposalTable, Record, Reference, ReferenceTable, Segment, SegmentTable,
};

pub const TABLES: &[TableDeclaration] = &[
    TableDeclaration::of::<MeetingTable>(),
    TableDeclaration::of::<SegmentTable>(),
    TableDeclaration::of::<ReferenceTable>(),
    TableDeclaration::of::<FindingTable>(),
    TableDeclaration::of::<CheckpointTable>(),
    TableDeclaration::of::<ProposalTable>(),
    TableDeclaration::of::<PlanTable>(),
    TableDeclaration::of::<ApprovalTable>(),
    TableDeclaration::of::<JobTable>(),
    TableDeclaration::of::<crate::import::ProvenanceTable>(),
];
pub const CATALOG: Catalog = Catalog::new(1, TABLES);

pub fn directory(
    location: &Path,
    xdg_data_home: Option<&Path>,
    home: &Path,
) -> Result<PathBuf, Error> {
    let location = std::fs::canonicalize(location)?;
    let location = location
        .to_str()
        .ok_or(Error::Rejected("Meeting Location is not UTF-8"))?;
    let mut digest = crate::import::digest::Digest::new();
    digest.update(location.as_bytes());
    let key = digest.finish();
    Ok(xdg_data_home
        .map_or_else(|| home.join(".local/share"), Path::to_path_buf)
        .join("ycoding/meeting")
        .join(&key[..32]))
}

pub fn initialize(path: impl AsRef<Path>, metadata: Metadata) -> Result<Store, Error> {
    private_parent(path.as_ref())?;
    let store = Store::initialize(path.as_ref(), Options::meeting(), CATALOG, metadata)?;
    private_file(path.as_ref())?;
    Ok(store)
}

pub fn open(path: impl AsRef<Path>) -> Result<Store, Error> {
    private_parent(path.as_ref())?;
    private_file(path.as_ref())?;
    let store = Store::open(path.as_ref(), Options::meeting(), CATALOG)?;
    Ok(store)
}

pub(crate) fn private_parent(path: &Path) -> Result<(), Error> {
    if path.as_os_str().is_empty() || path == Path::new(":memory:") {
        return Err(Error::Rejected("Meeting requires a separate file"));
    }
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn private_file(path: &Path) -> Result<(), Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
