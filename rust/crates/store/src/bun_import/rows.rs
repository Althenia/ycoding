use crate::{
    Error, TableSpec, Write,
    digest::Digest,
    native::{IMPORTER_VERSION, ProvenanceTable, Report, TableSummary},
    project, resources, session,
    session::Document,
};
use rusqlite::{Connection, Row};
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, LosslessString};

pub(super) fn import(
    db: &Connection,
    tx: &mut Write<'_>,
    source_fingerprint: String,
    source_bytes: i64,
) -> Result<(), Error> {
    macro_rules! copy {
        ($module:ident::$table:ident, $record:ident, $order:literal, $($field:ident $(=> $column:literal)?),+ $(,)?) => {{
            let columns = [$(column!($field $(=> $column)?)),+];
            table::<$module::$table>(db, &columns, $order, |row| {
                let record = $module::$record { $($field: field(row, column!($field $(=> $column)?))?),+ };
                $module::$table::insert(tx, &record)?;
                Ok(record)
            })?
        }};
    }
    macro_rules! column {
        ($field:ident) => {
            stringify!($field)
        };
        ($field:ident => $column:literal) => {
            $column
        };
    }

    let tables = vec![
        copy!(
            project::ProjectTable,
            Project,
            "id",
            id,
            worktree,
            vcs,
            name,
            icon_url,
            icon_url_override,
            icon_color,
            time_created,
            time_updated,
            time_initialized,
            sandboxes,
            commands
        ),
        copy!(project::WorkspaceTable, Workspace, "id", id, type_ => "type", name, branch, directory, extra,
            project_id, time_used),
        copy!(project::DirectoryTable, Directory, "project_id,directory", project_id, directory, type_ => "type",
            strategy, time_created),
        copy!(
            project::PermissionTable,
            Permission,
            "id",
            id,
            project_id,
            action,
            resource,
            time_created,
            time_updated
        ),
        copy!(
            session::SessionTable,
            Session,
            "id",
            id,
            project_id,
            workspace_id,
            parent_id,
            fork_session_id,
            fork_message_id,
            fork_seq,
            directory,
            path,
            title,
            cost,
            tokens_input,
            tokens_output,
            tokens_reasoning,
            tokens_cache_read,
            tokens_cache_write,
            revert,
            permission,
            autonomy,
            autonomy_revision,
            orchestration_revision,
            agent,
            model,
            profile_binding,
            daybreak,
            time_created,
            time_updated,
            time_archived,
            time_active,
            time_pinned,
            time_suspended,
            usage_pruned_through,
            origin,
            scope
        ),
        copy!(
            session::SequenceTable,
            Sequence,
            "aggregate_id",
            aggregate_id,
            seq,
            owner_id
        ),
        copy!(session::EventTable, Event, "aggregate_id,seq", id, aggregate_id, seq, created, type_ => "type", data),
        copy!(session::MessageTable, Message, "session_id,seq", id, session_id, type_ => "type", seq,
            time_created, time_updated, data),
        copy!(session::PendingTable, Pending, "session_id,admitted_seq", id, session_id, type_ => "type", data,
            delivery, admitted_seq, time_created),
        copy!(
            session::TodoTable,
            Todo,
            "session_id,position",
            session_id,
            content,
            status,
            priority,
            position,
            time_created,
            time_updated
        ),
        copy!(
            session::TodoStateTable,
            TodoState,
            "session_id",
            session_id,
            revision,
            digest,
            time_updated
        ),
        copy!(
            session::FileChangeTable,
            FileChange,
            "session_id,path",
            session_id,
            path,
            patch,
            additions,
            deletions,
            latest_seq
        ),
        copy!(
            session::ManifestTable,
            Manifest,
            "digest",
            digest,
            schema_version,
            content,
            input_tokens,
            retained_tokens,
            time_created
        ),
        copy!(
            session::RevisionTable,
            Revision,
            "session_id,revision",
            session_id,
            revision,
            parent_revision,
            manifest_digest,
            covered_through_message_id,
            covered_through_seq,
            activation_event_id,
            activation_sequence,
            time_created
        ),
        copy!(
            session::ContextStateTable,
            ContextState,
            "session_id",
            session_id,
            status,
            revision,
            manifest_digest,
            covered_through_message_id,
            covered_through_seq,
            activated_event_id,
            time_activated,
            error_code
        ),
        copy!(
            session::ExclusionTable,
            Exclusion,
            "session_id,context_revision,target_key",
            session_id,
            context_revision,
            target_key,
            target_kind,
            target_selector,
            dependency_group,
            reason,
            manifest_digest
        ),
        copy!(
            resources::KvTable,
            Kv,
            "key",
            key,
            value,
            time_created,
            time_updated
        ),
        copy!(
            resources::ConsentTable,
            Consent,
            "id",
            id,
            enabled,
            notice_version,
            decided_at
        ),
    ];
    tx.put::<ProvenanceTable>(&Report {
        source_fingerprint,
        source_bytes,
        importer_version: IMPORTER_VERSION,
        tables,
        latency_high_water: None,
    })
}

fn table<T: TableSpec>(
    db: &Connection,
    columns: &[&str],
    order: &str,
    mut insert: impl FnMut(&Row<'_>) -> Result<T::Record, Error>,
) -> Result<TableSummary, Error> {
    let kind: String = db
        .query_one(
            "SELECT type FROM sqlite_schema WHERE name = ?1",
            [T::NAME],
            |row| row.get(0),
        )
        .map_err(super::sqlite)?;
    if kind != "table" {
        return Err(Error::Rejected("Bun SQLite source record is not a table"));
    }
    let columns = columns
        .iter()
        .map(|name| format!("source.\"{name}\""))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT {columns} FROM \"{}\" AS source ORDER BY {order}",
        T::NAME
    );
    let mut statement = db.prepare(&sql).map_err(super::sqlite)?;
    let mut rows = statement.query([]).map_err(super::sqlite)?;
    let mut count = 0i64;
    let mut digest = Digest::new();
    while let Some(row) = rows.next().map_err(super::sqlite)? {
        let record = insert(row)?;
        let bytes = T::encode(&record)?;
        digest.update(&(bytes.len() as u64).to_be_bytes());
        digest.update(&bytes);
        count += 1;
    }
    Ok(TableSummary {
        name: T::NAME.to_owned(),
        rows: count,
        digest: digest.finish(),
    })
}

fn field<T: Field>(row: &Row<'_>, column: &str) -> Result<T, Error> {
    Field::read(row, column)
}

trait Field: Sized {
    fn read(row: &Row<'_>, column: &str) -> Result<Self, Error>;
}

impl Field for i64 {
    fn read(row: &Row<'_>, column: &str) -> Result<Self, Error> {
        row.get(column).map_err(super::sqlite)
    }
}

impl Field for f64 {
    fn read(row: &Row<'_>, column: &str) -> Result<Self, Error> {
        row.get(column).map_err(super::sqlite)
    }
}

impl Field for LosslessString {
    fn read(row: &Row<'_>, column: &str) -> Result<Self, Error> {
        row.get::<_, String>(column)
            .map(Into::into)
            .map_err(super::sqlite)
    }
}

impl<T: Field> Field for Option<T> {
    fn read(row: &Row<'_>, column: &str) -> Result<Self, Error> {
        if matches!(
            row.get_ref(column).map_err(super::sqlite)?,
            rusqlite::types::ValueRef::Null
        ) {
            Ok(None)
        } else {
            T::read(row, column).map(Some)
        }
    }
}

impl Field for JsonValue {
    fn read(row: &Row<'_>, column: &str) -> Result<Self, Error> {
        let text: String = row.get(column).map_err(super::sqlite)?;
        ycoding_schema::parse_json(&text)
            .map_err(|_| Error::Rejected("Bun SQLite contains invalid JSON"))
    }
}

impl<T: DomainDecode + DomainEncode> Field for Document<T> {
    fn read(row: &Row<'_>, column: &str) -> Result<Self, Error> {
        Self::new(field(row, column)?)
            .map_err(|_| Error::Rejected("Bun SQLite contains an unsupported document"))
    }
}

impl Field for Vec<LosslessString> {
    fn read(row: &Row<'_>, column: &str) -> Result<Self, Error> {
        Self::decode(&field(row, column)?)
            .map_err(|_| Error::Rejected("Bun SQLite contains an invalid path list"))
    }
}
