mod provenance;

pub use provenance::{IMPORTER_VERSION, ProvenanceTable, Report, TableSummary};

use crate::{
    Catalog, TableDeclaration, analytics, coordination, database_format, mcp_events,
    model_incident, project, resources, session,
};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatabaseKind {
    Core,
    Bootstrap,
    Meeting,
}

pub fn catalog(kind: DatabaseKind) -> Catalog {
    if kind == DatabaseKind::Meeting {
        return crate::meeting::CATALOG;
    }
    static CORE: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
    const BOOTSTRAP: &[TableDeclaration] = &[
        TableDeclaration::of::<database_format::MigrationTable>(),
        TableDeclaration::of::<database_format::DatabaseFormatTable>(),
        TableDeclaration::of::<ProvenanceTable>(),
    ];
    if kind == DatabaseKind::Bootstrap {
        return Catalog::new(1, BOOTSTRAP);
    }
    Catalog::new(
        5,
        CORE.get_or_init(|| {
            project::TABLES
                .iter()
                .chain(session::TABLES)
                .chain(coordination::TABLES)
                .chain(crate::usage_cells::TABLES)
                .chain(database_format::TABLES)
                .chain(resources::TABLES)
                .chain(model_incident::TABLES)
                .chain(mcp_events::TABLES)
                .copied()
                .chain([
                    TableDeclaration::of::<analytics::DeliveryTable>(),
                    TableDeclaration::of::<analytics::IntentTable>(),
                    TableDeclaration::of::<ProvenanceTable>(),
                ])
                .collect()
        }),
    )
}
