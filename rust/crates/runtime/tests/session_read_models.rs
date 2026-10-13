mod support;

use prost::{Message, Name};
use std::time::Duration;
use support::*;
use tokio::time::timeout;
use ycoding_core::ycoding_schema::{model, parse_json, provider};
use ycoding_core::ycoding_store::{
    resources::{Request, RequestTable},
    session::{Document, Session, SessionTable},
};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn session_row(id: &str, parent: Option<&str>) -> Session {
    Session {
        id: id.into(),
        project_id: "prj_one".into(),
        workspace_id: None,
        parent_id: parent.map(Into::into),
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: "/project".into(),
        path: None,
        title: id.into(),
        cost: 0.0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: None,
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 1,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
    }
}

struct Usage {
    session: &'static str,
    id: &'static str,
    request: i64,
    model: &'static str,
    cost: f64,
    time: i64,
    timing: Option<&'static str>,
}

fn request(spec: &Usage) -> Request {
    Request {
        id: spec.id.into(),
        session_id: spec.session.into(),
        input_id: None,
        assistant_message_id: None,
        connection_identity_digest: None,
        source: "step".into(),
        agent: "build".into(),
        model: Document::from_domain(&model::Ref {
            id: spec.model.into(),
            provider_id: provider::Id("openai".into()),
            variant: None,
            profile: None,
        })
        .unwrap(),
        route_id: "test".into(),
        prompt_cache_key: format!("cachekey-{}", spec.id).as_str().into(),
        system_digest: "system".into(),
        tool_digest: "tools".into(),
        request: spec.request,
        attempts: 1,
        invalidation: "first-request".into(),
        continuation: "full".into(),
        cache_read_reported: Some(1),
        timing: spec
            .timing
            .map(|timing| Document::new(parse_json(timing).unwrap()).unwrap()),
        cost: Some(spec.cost),
        tokens: Document::new(
            parse_json(r#"{"input":100,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}"#)
                .unwrap(),
        )
        .unwrap(),
        time_created: spec.time,
    }
}

async fn seed_sessions(rows: Vec<Session>) {
    world()
        .store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| SessionTable::insert(tx, row))
        })
        .unwrap()
        .await
        .unwrap();
}

async fn seed_requests(rows: Vec<Request>) {
    world()
        .store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| RequestTable::insert(tx, row))
        })
        .unwrap()
        .await
        .unwrap();
}

fn usage_params(session: &str) -> v5::SessionUsageRequestParams {
    v5::SessionUsageRequestParams {
        session_id: text(session),
    }
}

fn report_query(
    group: v5::SessionUsageReportRequestQueryGroup,
) -> v5::SessionUsageReportRequestQuery {
    v5::SessionUsageReportRequestQuery {
        group: group as i32,
        time_zone: None,
        from: None,
        to: None,
        offset: None,
        limit: None,
        sort: None,
        order: None,
    }
}

fn report_request(session: &str, query: v5::SessionUsageReportRequestQuery) -> Vec<u8> {
    v5::SessionUsageReportRequest {
        params: v5::SessionUsageReportRequestParams {
            session_id: text(session),
        },
        query,
    }
    .encode_to_vec()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usage_summarizes_the_root_family_and_scopes_a_child_to_itself() {
    bounded(async {
        seed_sessions(vec![
            session_row("ses_wire_usage_root", None),
            session_row("ses_wire_usage_child", Some("ses_wire_usage_root")),
            session_row("ses_wire_usage_empty", None),
        ])
        .await;
        seed_requests(vec![
            request(&Usage {
                session: "ses_wire_usage_root",
                id: "prq_wire_1",
                request: 1,
                model: "gpt",
                cost: 1.5,
                time: 1000,
                timing: None,
            }),
            request(&Usage {
                session: "ses_wire_usage_root",
                id: "prq_wire_2",
                request: 2,
                model: "other",
                cost: 0.5,
                time: 2000,
                timing: None,
            }),
            request(&Usage {
                session: "ses_wire_usage_child",
                id: "prq_wire_3",
                request: 1,
                model: "gpt",
                cost: 3.0,
                time: 3000,
                timing: Some(r#"{"firstOutputMs":12,"totalMs":34}"#),
            }),
        ])
        .await;
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let usage = |session: &str| {
            v5::SessionUsageRequest {
                params: usage_params(session),
            }
            .encode_to_vec()
        };

        let root: v5::SessionUsageResult = success(
            client
                .call("session.usage", session_scope("ses_wire_usage_root"), usage("ses_wire_usage_root"))
                .await,
        );
        let root = root.data;
        assert_eq!((root.logical, root.physical, root.helpers), (3, 3, 0));
        assert_eq!(root.cost, Some(5.0));
        assert_eq!(root.cache_read_reported, Some(true));
        assert_eq!(root.tokens.input, 300.0);
        let models = root.models.unwrap().items;
        assert_eq!(models.len(), 2);
        assert_eq!(units(&models[0].model.id), "gpt");
        assert_eq!(models[0].requests, 2);
        assert_eq!(models[0].cost, Some(4.5));
        assert_eq!(
            models[0].cost_provenance,
            Some(v5::ProviderRequestSummaryModelsItemCostProvenance::ProviderrequestSummaryModelsitemCostprovenanceRecorded as i32)
        );
        assert_eq!(units(&models[1].model.id), "other");
        assert_eq!(
            root.latest_invalidation,
            Some(v5::ProviderRequestSummaryLatestInvalidation::ProviderrequestSummaryLatestinvalidationFirstRequest as i32)
        );
        assert_eq!(root.latest_namespace.as_ref().map(units).as_deref(), Some("cachekey"));
        let timing = root.latest_timing.unwrap();
        assert_eq!((timing.first_output_ms, timing.total_ms), (Some(12), Some(34)));

        let child: v5::SessionUsageResult = success(
            client
                .call("session.usage", session_scope("ses_wire_usage_child"), usage("ses_wire_usage_child"))
                .await,
        );
        assert_eq!((child.data.logical, child.data.cost), (1, Some(3.0)));

        let empty: v5::SessionUsageResult = success(
            client
                .call("session.usage", session_scope("ses_wire_usage_empty"), usage("ses_wire_usage_empty"))
                .await,
        );
        assert_eq!(empty.data.logical, 0);
        assert_eq!(empty.data.cost, None);
        assert!(empty.data.models.is_none());

        let missing = rejected(
            client
                .call("session.usage", session_scope("ses_wire_usage_missing"), usage("ses_wire_usage_missing"))
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usage_report_groups_sorts_pages_and_rejects_unsupported_zones() {
    bounded(async {
        seed_sessions(vec![
            session_row("ses_wire_report_root", None),
            session_row("ses_wire_report_child", Some("ses_wire_report_root")),
        ])
        .await;
        seed_requests(vec![
            request(&Usage {
                session: "ses_wire_report_root",
                id: "prq_wire_r1",
                request: 1,
                model: "gpt",
                cost: 1.0,
                time: 1000,
                timing: None,
            }),
            request(&Usage {
                session: "ses_wire_report_child",
                id: "prq_wire_r2",
                request: 1,
                model: "other",
                cost: 3.0,
                time: 86_400_000,
                timing: Some(r#"{"firstOutputMs":7,"totalMs":9,"generatedTokens":10,"generationDurationNs":2000000000}"#),
            }),
        ])
        .await;
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let scope = || session_scope("ses_wire_report_root");

        let by_cost: v5::SessionUsageReportResult = success(
            client
                .call(
                    "session.usageReport",
                    scope(),
                    report_request(
                        "ses_wire_report_root",
                        v5::SessionUsageReportRequestQuery {
                            sort: Some(v5::SessionUsageReportRequestQuerySort::SessionUsagereportRequestQuerySortCost as i32),
                            order: Some(v5::SessionUsageReportRequestQueryOrder::SessionUsagereportRequestQueryOrderDesc as i32),
                            ..report_query(v5::SessionUsageReportRequestQueryGroup::SessionUsagereportRequestQueryGroupSession)
                        },
                    ),
                )
                .await,
        );
        let report = by_cost.data;
        assert_eq!(
            report.group,
            v5::ProviderRequestReportGroup::ProviderrequestReportGroupSession as i32
        );
        assert_eq!(report.row_count, 2);
        assert_eq!(report.next_offset, None);
        let keys = report.rows.items.iter().map(|row| units(&row.key)).collect::<Vec<_>>();
        assert_eq!(keys, ["ses_wire_report_child", "ses_wire_report_root"]);
        assert_eq!(report.rows.items[0].cost, Some(3.0));
        let speed = report.rows.items[0].speed.unwrap();
        assert_eq!(
            (speed.first_output_p50_ms, speed.total_p95_ms, speed.samples),
            (Some(7), Some(9), 1)
        );
        assert_eq!(speed.output_tokens_per_second, Some(5.0));
        assert!(report.rows.items[1].speed.is_none());
        assert_eq!(report.total.logical, 2);
        assert_eq!(report.total.cost, Some(4.0));

        let paged: v5::SessionUsageReportResult = success(
            client
                .call(
                    "session.usageReport",
                    scope(),
                    report_request(
                        "ses_wire_report_root",
                        v5::SessionUsageReportRequestQuery {
                            limit: Some(1),
                            ..report_query(v5::SessionUsageReportRequestQueryGroup::SessionUsagereportRequestQueryGroupDay)
                        },
                    ),
                )
                .await,
        );
        assert_eq!(paged.data.row_count, 2);
        assert_eq!(paged.data.next_offset, Some(1));
        assert_eq!(units(&paged.data.rows.items[0].key), "1970-01-01");

        let ranged: v5::SessionUsageReportResult = success(
            client
                .call(
                    "session.usageReport",
                    scope(),
                    report_request(
                        "ses_wire_report_root",
                        v5::SessionUsageReportRequestQuery {
                            from: Some(86_400_000),
                            ..report_query(v5::SessionUsageReportRequestQueryGroup::SessionUsagereportRequestQueryGroupModel)
                        },
                    ),
                )
                .await,
        );
        assert_eq!(ranged.data.row_count, 1);
        assert_eq!(units(&ranged.data.rows.items[0].key), "openai/other");

        let unsupported = rejected(
            client
                .call(
                    "session.usageReport",
                    scope(),
                    report_request(
                        "ses_wire_report_root",
                        v5::SessionUsageReportRequestQuery {
                            time_zone: Some(text("Asia/Kolkata")),
                            ..report_query(v5::SessionUsageReportRequestQueryGroup::SessionUsagereportRequestQueryGroupHour)
                        },
                    ),
                )
                .await,
        );
        assert_eq!(unsupported.type_name, v5::InvalidRequestError::full_name());

        let missing = rejected(
            client
                .call(
                    "session.usageReport",
                    session_scope("ses_wire_report_missing"),
                    report_request(
                        "ses_wire_report_missing",
                        report_query(v5::SessionUsageReportRequestQueryGroup::SessionUsagereportRequestQueryGroupModel),
                    ),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        server.shutdown().await.unwrap();
    })
    .await;
}

fn captured_request(session: &str, after: Option<u64>, limit: Option<u64>) -> Vec<u8> {
    v5::SessionCapturedInputsRequest {
        params: v5::SessionCapturedInputsRequestParams {
            session_id: text(session),
        },
        query: v5::SessionCapturedInputsRequestQuery { after, limit },
    }
    .encode_to_vec()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn captured_inputs_page_with_an_exclusive_cursor_and_preserve_patch_bytes() {
    bounded(async {
        seed_sessions(vec![session_row("ses_wire_captured", None)]).await;
        insert_message("ses_wire_captured", "msg_wire_user", "user", 0, r#"{"text":"private"}"#).await;
        insert_message(
            "ses_wire_captured",
            "msg_wire_edit",
            "assistant",
            1,
            r#"{"content":[{"type":"tool","id":"call_1","name":"edit","state":{"status":"completed","structured":{"files":[{"file":"a.ts","patch":"a\ud800b"}]}}}]}"#,
        )
        .await;
        insert_message(
            "ses_wire_captured",
            "msg_wire_ignored",
            "compaction",
            2,
            r#"{"status":"completed"}"#,
        )
        .await;
        insert_message(
            "ses_wire_captured",
            "msg_wire_note",
            "synthetic",
            3,
            r#"{"text":"private","metadata":{"kind":"answer","questionID":"question_1"}}"#,
        )
        .await;
        insert_message(
            "ses_wire_captured",
            "msg_wire_large",
            "assistant",
            4,
            &format!(
                r#"{{"content":[{{"type":"tool","name":"patch","state":{{"structured":{{"files":[{{"patch":"{}"}}]}}}}}}]}}"#,
                "x".repeat(300_000)
            ),
        )
        .await;
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let scope = || session_scope("ses_wire_captured");

        let first: v5::SessionCapturedInputsResult = success(
            client
                .call("session.capturedInputs", scope(), captured_request("ses_wire_captured", None, Some(2)))
                .await,
        );
        let first = first.data;
        assert_eq!(first.next, Some(1));
        let items = &first.data.items;
        assert_eq!(items.len(), 2);
        assert_eq!(units(&items[0].id), "msg_wire_user");
        assert_eq!(items[0].r#type, 1);
        assert!(items[0].metadata.is_none() && items[0].content.is_none());
        let tool = &items[1].content.as_ref().unwrap().items[0];
        assert_eq!(units(&tool.name), "edit");
        assert_eq!(tool.id.as_ref().map(units).as_deref(), Some("call_1"));
        let file = &tool.state.structured.as_ref().unwrap().files.as_ref().unwrap().items[0];
        assert_eq!(units(file.file.as_ref().unwrap()), "a.ts");
        let Some(v5::lossless_string::Encoding::Utf16LeUnits(units16)) = &file.patch.encoding else {
            panic!("a patch with an unpaired surrogate must stay code units");
        };
        assert_eq!(units16.as_slice(), [0x61, 0x00, 0x00, 0xD8, 0x62, 0x00]);

        let second: v5::SessionCapturedInputsResult = success(
            client
                .call("session.capturedInputs", scope(), captured_request("ses_wire_captured", Some(1), Some(1)))
                .await,
        );
        let note = &second.data.data.items[0];
        assert_eq!(units(&note.id), "msg_wire_note");
        assert_eq!(note.r#type, 2);
        let metadata = note.metadata.as_ref().unwrap();
        assert_eq!(metadata.kind.as_ref().map(units).as_deref(), Some("answer"));
        assert_eq!(second.data.next, Some(3));

        let large: v5::SessionCapturedInputsResult = success(
            client
                .call("session.capturedInputs", scope(), captured_request("ses_wire_captured", Some(3), None))
                .await,
        );
        let patch = &large.data.data.items[0].content.as_ref().unwrap().items[0]
            .state
            .structured
            .as_ref()
            .unwrap()
            .files
            .as_ref()
            .unwrap()
            .items[0]
            .patch;
        assert_eq!(units(patch).len(), 300_000);
        assert_eq!(large.data.next, None);

        let missing = rejected(
            client
                .call(
                    "session.capturedInputs",
                    session_scope("ses_wire_captured_missing"),
                    captured_request("ses_wire_captured_missing", None, None),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_list_reports_job_keyed_history_with_cumulative_totals() {
    bounded(async {
        seed_sessions(vec![
            session_row("ses_wire_compaction", None),
            session_row("ses_wire_compaction_empty", None),
        ])
        .await;
        let jobs = [
            (
                "cmp_wire1",
                10,
                r#""status":"completed","revision":0,"boundary":{"messageID":"msg_boundary","seq":0},"metrics":{"excludedMessages":3,"excludedParts":2,"inputTokens":900,"retainedTokens":100}"#,
            ),
            (
                "cmp_wire2",
                20,
                r#""status":"failed","code":"provider_failed","error":{"type":"provider","message":"failed"}"#,
            ),
            ("cmp_wire3", 30, r#""status":"pending""#),
        ];
        for (index, (job, created, fields)) in jobs.iter().enumerate() {
            insert_message(
                "ses_wire_compaction",
                &format!("msg_{job}"),
                "compaction",
                index as i64,
                &format!(
                    r#"{{"jobID":"{job}","trigger":"manual","time":{{"created":{created}}},{fields}}}"#
                ),
            )
            .await;
        }
        insert_message(
            "ses_wire_compaction",
            "msg_wire_legacy",
            "compaction",
            9,
            r#"{"reason":"auto","status":"completed","summary":"legacy","recent":"legacy","time":{"created":1}}"#,
        )
        .await;
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let list = |session: &str| {
            v5::SessionCompactionListRequest {
                params: v5::SessionCompactionListRequestParams {
                    session_id: text(session),
                },
            }
            .encode_to_vec()
        };

        let result: v5::SessionCompactionListResult = success(
            client
                .call("session.compaction.list", session_scope("ses_wire_compaction"), list("ses_wire_compaction"))
                .await,
        );
        let history = result.data;
        assert!(!history.truncated);
        assert_eq!(
            (history.completed_before, history.completed_count, history.total_saved_tokens),
            (0, 1, 800)
        );
        let items = &history.data.items;
        assert_eq!(
            items.iter().map(|job| units(&job.job_id)).collect::<Vec<_>>(),
            ["cmp_wire1", "cmp_wire2", "cmp_wire3"]
        );
        assert_eq!((items[0].trigger, items[0].status, items[0].created), (4, 3, 10));
        let metrics = items[0].metrics.unwrap();
        assert_eq!(
            (metrics.excluded_messages, metrics.excluded_parts, metrics.input_tokens, metrics.retained_tokens),
            (3, 2, 900, 100)
        );
        assert_eq!((items[1].status, items[1].code), (4, Some(7)));
        assert_eq!((items[2].status, items[2].metrics, items[2].code), (1, None, None));

        let empty: v5::SessionCompactionListResult = success(
            client
                .call(
                    "session.compaction.list",
                    session_scope("ses_wire_compaction_empty"),
                    list("ses_wire_compaction_empty"),
                )
                .await,
        );
        assert!(empty.data.data.items.is_empty());
        assert_eq!((empty.data.completed_count, empty.data.total_saved_tokens), (0, 0));

        let missing = rejected(
            client
                .call(
                    "session.compaction.list",
                    session_scope("ses_wire_compaction_missing"),
                    list("ses_wire_compaction_missing"),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        server.shutdown().await.unwrap();
    })
    .await;
}
