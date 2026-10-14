use super::mappings::{Mapping, load, reset, validate, verify};
use crate::meeting;

macro_rules! mapping {
    ($table:ident, $record:ident, $name:literal, {$($field:ident),*}) => {
        Mapping {
            name: $name,
            columns: &[$(stringify!($field)),*],
            reset: reset::<meeting::$table>,
            load: |db, store, progress| load::<meeting::$table>(db, store, progress, |row| Ok(meeting::$record { $($field: row.field(stringify!($field))?),* })),
            validate: |db, store, progress| validate::<meeting::$table>(db, store, progress, |row| Ok(meeting::$record { $($field: row.field(stringify!($field))?),* }), meeting::$table::put),
            verify: |db, snapshot, expected, progress| verify::<meeting::$table>(db, snapshot, expected, progress, |row| Ok(meeting::$record { $($field: row.field(stringify!($field))?),* })),
        }
    };
}
macro_rules! child_mapping {
    ($table:ident, $name:literal) => {
        Mapping {
            name: $name,
            columns: &["id", "meeting_id", "data"],
            reset: reset::<meeting::$table>,
            load: |db, store, progress| {
                load::<meeting::$table>(db, store, progress, |row| {
                    Ok(meeting::Record {
                        id: row.field("id")?,
                        meeting_id: row.field("meeting_id")?,
                        data: row.field("data")?,
                        position: row.field("_import_rowid")?,
                    })
                })
            },
            validate: |db, store, progress| {
                validate::<meeting::$table>(
                    db,
                    store,
                    progress,
                    |row| {
                        Ok(meeting::Record {
                            id: row.field("id")?,
                            meeting_id: row.field("meeting_id")?,
                            data: row.field("data")?,
                            position: row.field("_import_rowid")?,
                        })
                    },
                    meeting::$table::put,
                )
            },
            verify: |db, snapshot, expected, progress| {
                verify::<meeting::$table>(db, snapshot, expected, progress, |row| {
                    Ok(meeting::Record {
                        id: row.field("id")?,
                        meeting_id: row.field("meeting_id")?,
                        data: row.field("data")?,
                        position: row.field("_import_rowid")?,
                    })
                })
            },
        }
    };
}

pub(super) const TABLES: &[Mapping] = &[
    mapping!(MeetingTable, Meeting, "meetings", {id, data}),
    mapping!(SegmentTable, Segment, "segments", {id, meeting_id, sequence, state, original_text, data}),
    mapping!(ReferenceTable, Reference, "knowledge_references", {meeting_id, server, target, data}),
    child_mapping!(FindingTable, "findings"),
    child_mapping!(CheckpointTable, "checkpoints"),
    child_mapping!(ProposalTable, "proposals"),
    child_mapping!(PlanTable, "plans"),
    child_mapping!(ApprovalTable, "approvals"),
    child_mapping!(JobTable, "jobs"),
];
