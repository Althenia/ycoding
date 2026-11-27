use super::codec::{key, table};
use crate::Error;
use ycoding_schema::LosslessString;

table!(MigrationTable, Migration, "migration", { id: LosslessString, time_completed: i64 }, r, key(&r.id), &[], index,
{ let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, { let _ = tx; });

table!(DatabaseFormatTable, DatabaseFormat, "database_format", { id: LosslessString, time_created: i64 }, r, key(&r.id), &[], index,
{ let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, { let _ = tx; });
