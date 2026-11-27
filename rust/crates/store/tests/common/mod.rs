#![allow(dead_code)]
use ycoding_store::{IndexDefinition, TableDeclaration};

pub const REMOVED: &[TableDeclaration] = &[
    TableDeclaration {
        name: "project_artifact_scope",
        indexes: &[
            IndexDefinition::unique("project_artifact_scope_id_type_unique"),
            IndexDefinition::unique("project_artifact_scope_storage_id_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_project_scope",
        indexes: &[IndexDefinition::unique(
            "project_artifact_project_scope_project_id_idx",
        )],
    },
    TableDeclaration {
        name: "project_artifact_global_scope",
        indexes: &[IndexDefinition::unique(
            "project_artifact_global_scope_singleton_idx",
        )],
    },
    TableDeclaration {
        name: "project_artifact",
        indexes: &[IndexDefinition::secondary(
            "project_artifact_scope_stage_kind_updated_idx",
        )],
    },
    TableDeclaration {
        name: "project_artifact_version",
        indexes: &[
            IndexDefinition::unique("project_artifact_version_owner_unique"),
            IndexDefinition::unique("project_artifact_version_digest_owner_unique"),
            IndexDefinition::unique("project_artifact_version_write_unique"),
            IndexDefinition::unique("project_artifact_version_scope_kind_id_digest_idx"),
            IndexDefinition::secondary("project_artifact_version_scope_kind_id_created_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_trash",
        indexes: &[
            IndexDefinition::unique("project_artifact_trash_scope_kind_id_idx"),
            IndexDefinition::secondary("project_artifact_trash_purge_after_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_operation",
        indexes: &[
            IndexDefinition::unique("project_artifact_operation_request_idx"),
            IndexDefinition::unique("project_artifact_operation_automatic_retry_idx"),
            IndexDefinition::unique("project_artifact_operation_active_artifact_idx"),
            IndexDefinition::secondary("project_artifact_operation_recovery_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_activation",
        indexes: &[
            IndexDefinition::unique("project_artifact_activation_identity_idx"),
            IndexDefinition::unique("project_artifact_activation_sessionless_identity_idx"),
            IndexDefinition::secondary("project_artifact_activation_session_open_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_observation",
        indexes: &[
            IndexDefinition::unique("project_artifact_observation_version_terminal_idx"),
            IndexDefinition::unique("project_artifact_observation_version_session_absent_idx"),
            IndexDefinition::unique("project_artifact_observation_sessionless_absent_idx"),
            IndexDefinition::secondary(
                "project_artifact_observation_version_eligible_observed_idx",
            ),
        ],
    },
    TableDeclaration {
        name: "project_artifact_terminal",
        indexes: &[
            IndexDefinition::unique("project_artifact_terminal_message_identity_idx"),
            IndexDefinition::unique("project_artifact_terminal_boundary_identity_idx"),
            IndexDefinition::secondary("project_artifact_terminal_cohort_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_feedback",
        indexes: &[IndexDefinition::secondary(
            "project_artifact_feedback_version_created_idx",
        )],
    },
    TableDeclaration {
        name: "project_artifact_write",
        indexes: &[
            IndexDefinition::secondary("project_artifact_write_scope_created_idx"),
            IndexDefinition::secondary("project_artifact_write_session_created_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_legacy_cleanup",
        indexes: &[],
    },
];

pub fn with_removed(tables: &[TableDeclaration]) -> Vec<TableDeclaration> {
    tables.iter().chain(REMOVED).copied().collect()
}

pub fn removed(name: &str) -> bool {
    REMOVED
        .iter()
        .any(|table| table.name == name || table.indexes.iter().any(|index| index.name == name))
}

pub fn retained<V>(dump: &std::collections::BTreeMap<String, V>) -> usize {
    dump.keys().filter(|name| !removed(name)).count()
}
