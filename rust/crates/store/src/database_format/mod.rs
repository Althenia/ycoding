mod codec;
mod tables;
pub use tables::*;

use crate::TableDeclaration;

pub const TABLES: &[TableDeclaration] = &[
    TableDeclaration::of::<MigrationTable>(),
    TableDeclaration::of::<DatabaseFormatTable>(),
];
