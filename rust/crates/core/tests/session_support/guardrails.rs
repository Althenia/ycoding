use std::sync::Arc;
use ycoding_core::{
    process::guardrails::{Guardrails, Limits, Paths, Settings},
    tools::policy::{Authority, Publisher, permissions::Permissions},
};

pub fn guardrails(store: &ycoding_store::Store) -> Guardrails {
    let authority = Authority {
        store: store.client(),
        agents: Arc::new(|agent| {
            Some((agent.cloned().unwrap_or_else(|| "build".into()), Vec::new()))
        }),
    };
    let publisher: Publisher = Arc::new(|_| Ok(()));
    Guardrails::new(
        authority.clone(),
        Permissions::new(
            authority,
            ycoding_schema::project_id::ProjectId::new("prj_one").unwrap(),
            publisher.clone(),
        ),
        Settings {
            paths: Paths {
                workdir: "/project".into(),
                project: "/project".into(),
                home: "/home/operator".into(),
                tmpdir: None,
                trusted_paths: vec![],
            },
            global_roots: vec![],
            custom: Arc::new(Vec::new),
            enabled: true,
            limits: Limits::default(),
            decide_reviews: false,
            decide_hard_reviews: true,
        },
        publisher,
    )
}
