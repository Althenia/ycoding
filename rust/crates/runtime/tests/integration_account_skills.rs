mod support;

use support::{wire::*, *};
use ycoding_core::ycoding_store::session::SessionTable;
use ycoding_protocol::v5;

fn request(
    integration: &str,
    session: Option<&str>,
    agent: Option<&str>,
) -> v5::IntegrationAccountSkillsReadRequest {
    v5::IntegrationAccountSkillsReadRequest {
        params: v5::IntegrationAccountSkillsReadRequestParams {
            integration_id: text(integration),
        },
        query: v5::IntegrationAccountSkillsQuery {
            location: None,
            session_id: session.map(text),
            agent: agent.map(text),
            profile: None,
            id: None,
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn account_skills_preserves_provenance_error_kinds_over_the_real_v5_dispatcher() {
    let (server, mut client) = open().await;
    for (integration, session, agent, directory, workspace, supplied_agent, kind) in [
        (
            "other",
            None,
            None,
            "/project",
            None,
            None,
            "unsupported_integration",
        ),
        (
            "openai",
            None,
            None,
            "/project",
            None,
            None,
            "missing_provenance",
        ),
        (
            "openai",
            Some("ses_skills_missing"),
            None,
            "/project",
            None,
            None,
            "session_not_found",
        ),
        (
            "openai",
            Some("ses_skills_cross_location"),
            Some("build"),
            "/project/other",
            None,
            None,
            "cross_location_session",
        ),
        (
            "openai",
            Some("ses_skills_cross_workspace"),
            Some("build"),
            "/project",
            Some("wrk_other"),
            None,
            "cross_location_session",
        ),
        (
            "openai",
            Some("ses_skills_no_agent"),
            None,
            "/project",
            None,
            None,
            "missing_session_agent",
        ),
        (
            "openai",
            Some("ses_skills_agent_mismatch"),
            Some("build"),
            "/project",
            None,
            Some("other"),
            "agent_mismatch",
        ),
    ] {
        if let Some(id) = session.filter(|id| *id != "ses_skills_missing") {
            let mut row = record(id);
            row.agent = agent.map(Into::into);
            row.directory = directory.into();
            row.workspace_id = workspace.map(Into::into);
            world()
                .store
                .submit(move |tx| {
                    SessionTable::insert(tx, &row)?;
                    Ok(())
                })
                .unwrap()
                .wait()
                .unwrap();
        }
        let error: v5::InvalidRequestError = refuse(
            &mut client,
            "integration.accountSkills.read",
            location_scope("/project"),
            request(integration, session, supplied_agent),
        )
        .await;
        assert_eq!(error.kind, Some(text(kind)));
        assert!(error.field.is_none());
    }
    drop(client);
    server.shutdown().await.unwrap();
}
