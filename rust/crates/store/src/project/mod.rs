mod tables;
use crate::session::codec;
pub use tables::*;

use crate::{Error, TableDeclaration, TableSpec, Write};
use std::ops::Bound;
use ycoding_schema::LosslessString;

pub const TABLES: &[TableDeclaration] = &[
    TableDeclaration::of::<ProjectTable>(),
    TableDeclaration::of::<WorkspaceTable>(),
    TableDeclaration::of::<DirectoryTable>(),
    TableDeclaration::of::<PermissionTable>(),
];

pub fn delete(tx: &mut Write<'_>, id: &LosslessString) -> Result<bool, Error> {
    let key = codec::key(id);
    if tx.get::<ProjectTable>(&key)?.is_none() {
        return Ok(false);
    }
    if !tx
        .index::<crate::artifacts::ProjectScopeTable>(
            "project_artifact_project_scope_project_id_idx",
            &key,
            None,
            1,
        )?
        .is_empty()
    {
        return Err(tx.reject(Error::Domain {
            kind: "restrict",
            message: "project artifact scope still references project",
        }));
    }
    loop {
        let sessions =
            tx.index::<crate::session::SessionTable>("session_project_idx", &key, None, 128)?;
        if sessions.is_empty() {
            break;
        }
        for session in sessions {
            crate::session::delete(tx, &session.id)?;
        }
    }
    remove_children::<WorkspaceTable>(tx, |r| &r.project_id == id)?;
    remove_children::<DirectoryTable>(tx, |r| &r.project_id == id)?;
    remove_children::<PermissionTable>(tx, |r| &r.project_id == id)?;
    remove_children::<crate::artifacts::TerminalTable>(tx, |r| &r.project_id == id)?;
    crate::resources::source_changed(tx, "project", key.clone(), true)?;
    tx.delete::<ProjectTable>(&key)
}

pub(crate) fn remove_children<T: TableSpec>(
    tx: &mut Write<'_>,
    matches: impl Fn(&T::Record) -> bool,
) -> Result<(), Error> {
    let mut after: Option<Vec<u8>> = None;
    loop {
        let rows = tx.scan::<T>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if rows.is_empty() {
            return Ok(());
        }
        after = rows.last().map(T::primary_key);
        for row in rows.into_iter().filter(&matches) {
            tx.delete::<T>(&T::primary_key(&row))?;
        }
    }
}
