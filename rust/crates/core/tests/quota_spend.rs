use ycoding_core::resources::model::quota::{LocalSpendRow, local_spend_snapshots};
use ycoding_schema::provider;
#[path = "report_support/mod.rs"]
mod report_support;

#[test]
fn local_spend_uses_local_calendar_day_filters_invalid_costs_and_never_invents_totals() {
    let Ok(tz) = std::env::var("YCODING_SPEND_CHILD") else {
        for tz in ["UTC", "America/New_York", "Asia/Bangkok"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","local_spend_uses_local_calendar_day_filters_invalid_costs_and_never_invents_totals","--nocapture"]).env("TZ",tz).env("YCODING_SPEND_CHILD",tz).output().unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    };
    let (now, start, end) = match tz.as_str() {
        "UTC" => (1772971200000, 1772928000000, 1773014400000),
        "America/New_York" => (1772971200000, 1772946000000, 1773028800000),
        "Asia/Bangkok" => (1772971200000, 1772902800000, 1772989200000),
        _ => unreachable!(),
    };
    let row = |provider: &str, cost, time_created| LocalSpendRow {
        provider_id: provider::Id(provider.into()),
        cost,
        time_created,
    };
    let snapshots = local_spend_snapshots(
        &[
            row("openai", Some(1.0), start),
            row("openai", Some(2.0), end - 1),
            row("openai", Some(100.0), end),
            row("openai", Some(100.0), start - 1),
            row("anthropic", None, now),
            row("anthropic", Some(-1.0), now),
            row("anthropic", Some(f64::NAN), now),
            row("anthropic", Some(0.0), now),
            row("opencode-go", Some(0.0), now),
            row(
                ycoding_core::resources::model::DROPPED_UPSTREAM_PROVIDER_ID,
                Some(10.0),
                now,
            ),
            row("xai", Some(10.0), now),
            row("meta", Some(2.0), now),
        ],
        now,
    )
    .unwrap();
    assert_eq!(snapshots.len(), 2);
    assert_eq!(snapshots[0].provider_id.0, "anthropic".into());
    assert_eq!(snapshots[0].label, "Claude".into());
    assert_eq!(snapshots[0].windows[0].used, Some(0.0));
    assert_eq!(snapshots[1].provider_id.0, "openai".into());
    assert_eq!(snapshots[1].windows[0].used, Some(3.0));
    assert_eq!(snapshots[1].source, "local_session".into());
    assert_eq!(snapshots[1].profile, Some("YCoding local".into()));
    assert!(
        snapshots
            .iter()
            .all(|s| s.windows[0].remaining.is_none() && s.windows[0].limit.is_none())
    );
}

#[test]
fn local_spend_reads_real_request_rows_without_mutating_session_or_request_data() {
    use ycoding_store::{project, resources, session};
    let tables = Box::leak(
        project::TABLES
            .iter()
            .chain(session::TABLES)
            .chain(resources::TABLES)
            .copied()
            .chain([
                ycoding_store::TableDeclaration::of::<ycoding_store::analytics::DeliveryTable>(),
                ycoding_store::TableDeclaration::of::<ycoding_store::analytics::IntentTable>(),
            ])
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );
    let store = ycoding_store::Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::Catalog::new(1, tables),
        ycoding_store::Metadata::new([12; 16], 1),
    )
    .unwrap();
    store.submit(|tx| {
        project::ProjectTable::insert(tx,&project::Project { id: "p".into(),worktree: "".into(),vcs: None,name: None,icon_url: None,icon_url_override: None,icon_color: None,time_created: 0,time_updated: 0,time_initialized: None,sandboxes: vec![],commands: None })?;
        session::SessionTable::insert(tx,&session::Session { id: "s".into(),project_id: "p".into(),workspace_id: None,parent_id: None,fork_session_id: None,fork_message_id: None,fork_seq: None,directory: "".into(),path: None,title: "".into(),cost: 0.0,tokens_input: 0,tokens_output: 0,tokens_reasoning: 0,tokens_cache_read: 0,tokens_cache_write: 0,revert: None,permission: None,autonomy: None,autonomy_revision: 0,orchestration_revision: 0,agent: None,model: None,profile_binding: None,daybreak: None,time_created: 0,time_updated: 0,time_archived: None,time_active: None,time_pinned: None,time_suspended: None, usage_pruned_through: None })?;
        for (index,(provider,cost)) in [("openai",Some(1.0)),("openai",Some(2.0)),("openai",None),("openai",Some(-1.0)),("anthropic",Some(0.0)),("opencode-go",Some(10.0)),(ycoding_core::resources::model::DROPPED_UPSTREAM_PROVIDER_ID,Some(10.0)),("xai",Some(10.0))].into_iter().enumerate() {
            resources::RequestTable::insert(tx,&resources::Request { id: format!("request-{index}").into(),session_id: "s".into(),input_id: None,assistant_message_id: None,connection_identity_digest: None,source: "step".into(),agent: "fixture".into(),model: session::Document::from_domain(&ycoding_schema::model::Ref { id: "m".into(),provider_id: provider::Id(provider.into()),variant: None,profile: None })?,route_id: "fixture".into(),prompt_cache_key: "fixture-private-cache".into(),system_digest: "fixture-private-system".into(),tool_digest: "fixture-private-tools".into(),request: index as i64,attempts: 1,invalidation: "none".into(),continuation: "none".into(),cache_read_reported: None,timing: None,cost,tokens: session::Document::new(ycoding_schema::parse_json(r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#).unwrap())?,time_created: 1790598896000, usage_anchor: None })?;
        }
        Ok(())
    }).unwrap().wait().unwrap();
    let before = store
        .snapshot()
        .unwrap()
        .scan::<session::SessionTable>(std::ops::Bound::Unbounded, std::ops::Bound::Unbounded, 1)
        .unwrap();
    let requests = store
        .snapshot()
        .unwrap()
        .scan::<resources::RequestTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            128,
        )
        .unwrap();
    let _reports = report_support::start(store.client());
    let result = ycoding_core::resources::model::quota::local_spend_from_store(
        &store.client(),
        1790598896000,
    )
    .unwrap();
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].provider_id.0, "anthropic".into());
    assert_eq!(result[0].windows[0].used, Some(0.0));
    assert_eq!(result[1].provider_id.0, "openai".into());
    assert_eq!(result[1].windows[0].used, Some(3.0));
    assert!(!format!("{result:?}").contains("fixture-private"));
    let after = store
        .snapshot()
        .unwrap()
        .scan::<session::SessionTable>(std::ops::Bound::Unbounded, std::ops::Bound::Unbounded, 1)
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<resources::RequestTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                128
            )
            .unwrap(),
        requests
    );
}
