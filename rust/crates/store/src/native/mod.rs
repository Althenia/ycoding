mod provenance;

pub use provenance::{IMPORTER_VERSION, ProvenanceTable, Report, TableSummary};

use crate::{
    Catalog, TableDeclaration, analytics, artifacts, coordination, mcp_events, model_incident,
    project, resources, session,
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
        TableDeclaration::of::<artifacts::MigrationTable>(),
        TableDeclaration::of::<artifacts::DatabaseFormatTable>(),
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
                .chain(artifacts::TABLES)
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
