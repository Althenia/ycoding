mod mcp_events_support;

use mcp_events_support::{
    DAY, Fixture, NOW, ROTATED, Reply, SECRET, context, decode, encoded, failure, subscription,
};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};
use ycoding_core::{
    event_feed::{Feed, Scope},
    mcp_events::{
        Cancellation, Dependencies, HttpResponse, Secrets, Service, secret_box::SecretBox,
    },
};
use ycoding_schema::{
    DomainDecode,
    mcp_events::{Subscribe, Unsubscribe},
};
use ycoding_store::{TableSpec, mcp_events::SubscriptionTable};

#[tokio::test]
async fn discovery_contains_exactly_the_seven_released_names_and_no_sensitive_data() {
    let fixture = Fixture::new();
    assert!(fixture.service.status().await);
    let list = encoded(&fixture.service.list());
    assert_eq!(
        list["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "session.guardrail.changed",
            "session.permission.changed",
            "session.question.changed",
            "session.form.changed",
            "session.progress",
            "session.completed",
            "session.error",
        ]
    );
    for row in list["events"].as_array().unwrap() {
        assert_eq!(row["delivery"], json!(["webhook"]));
        assert_eq!(row["inputSchema"]["additionalProperties"], false);
    }
    assert!(!list.to_string().contains(SECRET));
    assert!(fixture.subscriptions().is_empty());
}

#[tokio::test]
async fn subscribe_resolves_the_outer_request_and_refresh_preserves_identity_and_creation_time() {
    let fixture = Fixture::new();
    let first = fixture.subscribe("session.progress").await;
    assert_eq!(
        fixture.authority.resolves.lock().unwrap().as_slice(),
        [context()]
    );
    let initial = fixture.subscriptions().pop().unwrap();
    assert_eq!(initial.grant_id.as_str(), Some("grant_synthetic"));
    assert_eq!(initial.epoch.as_str(), Some("epoch_synthetic"));
    assert_eq!(initial.expires_at, NOW + DAY);
    assert!(!initial.secret_ciphertext.as_str().unwrap().contains(SECRET));
    assert!(
        !initial
            .secret_ciphertext
            .as_str()
            .unwrap()
            .contains("whsec_")
    );
    fixture.clock.store(NOW + 1000, Ordering::Release);
    let second = fixture.subscribe("session.progress").await;
    assert_eq!(first.id, second.id);
    let refreshed = fixture.subscriptions().pop().unwrap();
    assert_eq!(refreshed.time_created, NOW);
    assert_eq!(refreshed.time_updated, NOW + 1000);
    assert_eq!(refreshed.expires_at, NOW + 1000 + DAY);
    assert_eq!(fixture.callback.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn every_principal_filter_and_delivery_dimension_has_an_independent_identity() {
    let fixture = Fixture::new();
    fixture.subscribe("session.progress").await;
    for field in ["ownerID", "deviceID", "clientID"] {
        let mut cx = encoded(&context());
        cx["principal"][field] = json!(format!("other_{field}"));
        fixture
            .service
            .subscribe(
                decode(cx),
                subscription("session.progress", false),
                Cancellation::default(),
            )
            .await
            .unwrap();
    }
    let mut epoch = encoded(&context());
    epoch["epoch"] = json!("epoch_other");
    fixture
        .service
        .subscribe(
            decode(epoch),
            subscription("session.progress", false),
            Cancellation::default(),
        )
        .await
        .unwrap();
    for (key, value) in [
        ("name", json!("session.completed")),
        ("arguments", json!({"session_id":"ses_child"})),
        (
            "arguments",
            json!({"session_id":"ses_root","include_descendants":true}),
        ),
        (
            "delivery",
            json!({"mode":"webhook","url":"https://other.invalid/events","secret":SECRET}),
        ),
    ] {
        let mut input = encoded(&subscription("session.progress", false));
        input[key] = value;
        fixture
            .service
            .subscribe(context(), decode(input), Cancellation::default())
            .await
            .unwrap();
    }
    fixture.authority.grant.lock().unwrap().0 = "grant_replacement".into();
    fixture.subscribe("session.progress").await;
    let rows = fixture.subscriptions();
    assert_eq!(rows.len(), 10);
    assert_eq!(
        rows.iter()
            .map(|row| &row.identity_hash)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        10
    );
}

#[tokio::test]
async fn ttl_is_finite_clamped_and_capped_by_the_exact_grant() {
    for (ttl, expected) in [
        (Value::Null, DAY),
        (json!(0), 60_000),
        (json!(1), 60_000),
        (json!(60_000), 60_000),
        (json!(9 * DAY), 7 * DAY),
    ] {
        let fixture = Fixture::new();
        let mut input = encoded(&subscription("session.completed", false));
        input["ttlMs"] = ttl;
        fixture
            .service
            .subscribe(context(), decode(input), Cancellation::default())
            .await
            .unwrap();
        assert_eq!(fixture.subscriptions()[0].expires_at, NOW + expected);
    }
    let fixture = Fixture::new();
    fixture.authority.grant.lock().unwrap().1 = NOW + 500;
    fixture.subscribe("session.completed").await;
    assert_eq!(fixture.subscriptions()[0].expires_at, NOW + 500);
}

#[tokio::test]
async fn invalid_requests_unknown_sessions_and_unavailable_authority_never_activate_subscriptions()
{
    for value in [
        json!({"name":"unknown","arguments":{"session_id":"ses_root"},"delivery":{"mode":"webhook","url":"https://callback.invalid","secret":SECRET}}),
        json!({"name":"session.progress","arguments":{"session_id":"ses_root","grantID":"forged"},"delivery":{"mode":"webhook","url":"https://callback.invalid","secret":SECRET}}),
        json!({"name":"session.progress","arguments":{"session_id":"ses_root"},"delivery":{"mode":"webhook","url":"https://callback.invalid","secret":SECRET},"ttlMs":-1}),
    ] {
        assert!(
            Subscribe::decode(&ycoding_schema::parse_json(&value.to_string()).unwrap()).is_err()
        );
    }
    for input in [
        json!({"arguments":{"session_id":"ses_missing"}}),
        json!({"delivery":{"mode":"webhook","url":"http://callback.invalid","secret":SECRET}}),
        json!({"delivery":{"mode":"webhook","url":"https://user:pass@callback.invalid","secret":SECRET}}),
        json!({"delivery":{"mode":"webhook","url":"https://callback.invalid","secret":"whsec_invalid"}}),
        json!({"cursor":"cur_forged.invalid"}),
    ] {
        let fixture = Fixture::new();
        let mut request = encoded(&subscription("session.progress", false));
        request
            .as_object_mut()
            .unwrap()
            .extend(input.as_object().unwrap().clone());
        assert!(
            fixture
                .service
                .subscribe(context(), decode(request), Cancellation::default())
                .await
                .is_err()
        );
        assert!(fixture.subscriptions().is_empty());
    }
    let fixture = Fixture::new();
    fixture.authority.available.store(0, Ordering::Release);
    assert!(!fixture.service.status().await);
    assert!(
        fixture
            .service
            .subscribe(
                context(),
                subscription("session.progress", false),
                Cancellation::default()
            )
            .await
            .is_err()
    );
    assert!(fixture.callback.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn attention_and_terminal_events_are_sanitized_and_idle_does_not_mean_work_completion() {
    let fixture = Fixture::new();
    for name in [
        "session.guardrail.changed",
        "session.permission.changed",
        "session.question.changed",
        "session.form.changed",
        "session.progress",
        "session.completed",
        "session.error",
    ] {
        fixture.subscribe(name).await;
    }
    let cases = [
        (
            "guardrail.asked",
            json!({"sessionID":"ses_root","id":"grq_synthetic","command":"private-command"}),
        ),
        (
            "permission.asked",
            json!({"sessionID":"ses_root","id":"per_synthetic","action":"shell","resource":"/private"}),
        ),
        (
            "question.asked",
            json!({"sessionID":"ses_root","id":"que_synthetic","question":"private-question"}),
        ),
        (
            "form.created",
            json!({"form":{"sessionID":"ses_root","id":"frm_synthetic","fields":["private-field"]}}),
        ),
        (
            "session.execution.succeeded.1",
            json!({"sessionID":"ses_root"}),
        ),
        ("session.work.completed.1", json!({"sessionID":"ses_root"})),
        (
            "session.execution.failed.1",
            json!({"sessionID":"ses_root","error":{"type":"rate_limit","message":"private-error"}}),
        ),
    ];
    for (at, (kind, data)) in cases.into_iter().enumerate() {
        fixture
            .capture(kind, &format!("evt_source_{at}"), data)
            .await;
    }
    for kind in [
        "session.tool.progress",
        "session.message.updated",
        "mcp.tools.changed",
    ] {
        fixture
            .capture(
                kind,
                "evt_ignored",
                json!({"sessionID":"ses_root","text":"private-delta"}),
            )
            .await;
    }
    assert_eq!(fixture.outbox().len(), 7);
    fixture.dispatch().await;
    let deliveries = fixture.callback.deliveries();
    assert_eq!(deliveries.len(), 7);
    let mut completed = 0;
    for request in deliveries {
        assert!(!request.body.contains("private-"));
        let body: Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(body["data"]["root_session_id"], "ses_root");
        if body["name"] == "session.completed" {
            completed += 1;
        }
        assert_eq!(
            body["cursor"].is_null(),
            body["name"].as_str().unwrap().ends_with(".changed")
        );
    }
    assert_eq!(completed, 1);
}

#[tokio::test]
async fn current_ancestry_includes_future_descendants_without_cross_session_leakage() {
    let fixture = Fixture::new();
    fixture.subscribe("session.error").await;
    fixture
        .service
        .subscribe(
            context(),
            subscription("session.error", true),
            Cancellation::default(),
        )
        .await
        .unwrap();
    fixture
        .capture(
            "session.execution.failed.1",
            "evt_child",
            json!({"sessionID":"ses_grandchild","error":{"type":"provider"}}),
        )
        .await;
    fixture
        .capture(
            "session.execution.failed.1",
            "evt_other",
            json!({"sessionID":"ses_other","error":{"type":"provider"}}),
        )
        .await;
    assert_eq!(fixture.outbox().len(), 1);
    assert_eq!(
        fixture.outbox()[0].session_id.as_str(),
        Some("ses_grandchild")
    );
    assert_eq!(
        fixture.outbox()[0].root_session_id.as_str(),
        Some("ses_root")
    );
}

#[tokio::test]
async fn dedupe_and_progress_coalescing_keep_identity_and_the_exact_thirty_second_boundary() {
    let fixture = Fixture::new();
    fixture.subscribe("session.progress").await;
    fixture
        .capture(
            "session.execution.started.1",
            "evt_first",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    fixture
        .capture(
            "session.execution.started.1",
            "evt_first",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    fixture.clock.store(NOW + 29_999, Ordering::Release);
    fixture
        .capture(
            "session.execution.started.1",
            "evt_second",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    assert_eq!(fixture.outbox().len(), 1);
    fixture.clock.store(NOW + 30_000, Ordering::Release);
    fixture
        .capture(
            "session.execution.started.1",
            "evt_third",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    assert_eq!(fixture.outbox().len(), 2);
    fixture
        .capture(
            "session.execution.interrupted.1",
            "evt_fourth",
            json!({"sessionID":"ses_root","reason":"user"}),
        )
        .await;
    assert_eq!(fixture.outbox().len(), 3);
}

#[tokio::test]
async fn retries_keep_event_bytes_and_order_while_refreshing_signatures_and_timestamp_headers() {
    let fixture = Fixture::new();
    fixture.subscribe("session.completed").await;
    for n in 0..2 {
        fixture
            .capture(
                "session.work.completed.1",
                &format!("source_{n}"),
                json!({"sessionID":"ses_root"}),
            )
            .await;
    }
    fixture
        .callback
        .replies
        .lock()
        .unwrap()
        .push_back(Reply::Status(503));
    fixture.dispatch().await;
    assert_eq!(fixture.callback.deliveries().len(), 1);
    let failed = fixture.outbox()[0].clone();
    assert_eq!(failed.attempts, 1);
    assert_eq!(failed.next_attempt_at, NOW + 5000);
    fixture.dispatch().await;
    assert_eq!(fixture.callback.deliveries().len(), 1);
    fixture.clock.store(NOW + 5000, Ordering::Release);
    fixture.dispatch().await;
    let attempts = fixture.callback.deliveries();
    assert_eq!(attempts.len(), 3);
    let signed = format!(
        "{}.{}.{}",
        attempts[0].headers["webhook-id"],
        attempts[0].headers["webhook-timestamp"],
        attempts[0].body
    );
    let signature = attempts[0].headers["webhook-signature"]
        .strip_prefix("v1,")
        .unwrap();
    let signature =
        ycoding_core::mcp_events::secret_box::decode_secret(&format!("whsec_{signature}")).unwrap();
    ring::hmac::verify(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &[0; 32]),
        signed.as_bytes(),
        &signature,
    )
    .unwrap();
    assert_eq!(
        attempts[0]
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("X-MCP-Subscription-Id"))
            .unwrap()
            .1,
        failed.subscription_id.as_str().unwrap()
    );
    assert_eq!(attempts[0].body, attempts[1].body);
    assert_eq!(
        attempts[0].headers["webhook-id"],
        attempts[1].headers["webhook-id"]
    );
    assert_ne!(
        attempts[0].headers["webhook-timestamp"],
        attempts[1].headers["webhook-timestamp"]
    );
    assert_ne!(
        attempts[0].headers["webhook-signature"],
        attempts[1].headers["webhook-signature"]
    );
    assert!(
        fixture
            .outbox()
            .iter()
            .all(|row| row.delivered_at.is_some())
    );
}

#[tokio::test]
async fn five_failures_exhaust_delivery_and_410_or_413_are_never_retried() {
    for status in [410, 413, 503] {
        let fixture = Fixture::new();
        fixture.subscribe("session.error").await;
        fixture
            .capture(
                "session.execution.failed.1",
                "source_fail",
                json!({"sessionID":"ses_root","error":{"type":"provider"}}),
            )
            .await;
        for _ in 0..5 {
            fixture
                .callback
                .replies
                .lock()
                .unwrap()
                .push_back(Reply::Status(status));
            fixture.dispatch().await;
            let row = fixture.outbox()[0].clone();
            if row.dead == 1 {
                break;
            }
            fixture.clock.store(row.next_attempt_at, Ordering::Release);
        }
        let row = fixture.outbox()[0].clone();
        assert_eq!(row.dead, 1);
        assert_eq!(row.attempts, if status == 503 { 5 } else { 1 });
        let count = fixture.callback.deliveries().len();
        fixture.dispatch().await;
        assert_eq!(fixture.callback.deliveries().len(), count);
    }
}

#[tokio::test]
async fn fresh_exact_grant_authorization_controls_each_attempt_and_unavailability_only_postpones() {
    for category in ["unavailable", "unauthorized"] {
        let fixture = Fixture::new();
        fixture.subscribe("session.completed").await;
        fixture
            .capture(
                "session.work.completed.1",
                "source_done",
                json!({"sessionID":"ses_root"}),
            )
            .await;
        *fixture.authority.rejection.lock().unwrap() = Some(failure(
            category,
            if category == "unavailable" {
                "authorization_unavailable"
            } else {
                "grant_revoked"
            },
        ));
        fixture.dispatch().await;
        assert!(fixture.callback.deliveries().is_empty());
        let row = fixture.outbox()[0].clone();
        if category == "unavailable" {
            assert_eq!(row.dead, 0);
            assert_eq!(row.attempts, 0);
            assert_eq!(row.next_attempt_at, NOW + 30_000);
        } else {
            assert_eq!(row.dead, 1);
            assert_eq!(fixture.subscriptions()[0].disabled, 1);
        }
        assert!(
            fixture
                .authority
                .checks
                .lock()
                .unwrap()
                .iter()
                .all(|principal| principal.grant_id.as_str() == Some("grant_synthetic"))
        );
    }
}

#[tokio::test]
async fn expiry_replacement_grants_and_cancelled_authority_never_start_a_callback() {
    for mode in ["expiry", "grant", "generation"] {
        let fixture = Fixture::new();
        fixture.subscribe("session.completed").await;
        fixture
            .capture(
                "session.work.completed.1",
                "source_done",
                json!({"sessionID":"ses_root"}),
            )
            .await;
        match mode {
            "expiry" => fixture.clock.store(NOW + DAY, Ordering::Release),
            "grant" => fixture.authority.grant.lock().unwrap().0 = "grant_replacement".into(),
            _ => fixture.authority.generation.lock().unwrap().cancel(),
        }
        fixture.dispatch().await;
        assert!(fixture.callback.deliveries().is_empty(), "{mode}");
    }
}

#[tokio::test]
async fn request_cancellation_does_not_own_subscription_but_current_authority_cancels_inflight_delivery()
 {
    let fixture = Fixture::new();
    let request = Cancellation::default();
    fixture
        .service
        .subscribe(
            context(),
            subscription("session.completed", false),
            request.clone(),
        )
        .await
        .unwrap();
    request.cancel();
    fixture
        .capture(
            "session.work.completed.1",
            "source_done",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    let started = Arc::new(tokio::sync::Notify::new());
    fixture
        .callback
        .replies
        .lock()
        .unwrap()
        .push_back(Reply::Wait(started.clone()));
    let service = fixture.service.clone();
    let task = tokio::spawn(async move { service.dispatch_once(Cancellation::default()).await });
    tokio::time::timeout(std::time::Duration::from_secs(3), started.notified())
        .await
        .unwrap();
    fixture.authority.generation.lock().unwrap().cancel();
    tokio::time::timeout(std::time::Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(fixture.callback.deliveries().len(), 1);
    assert!(fixture.outbox()[0].delivered_at.is_none());
    fixture.dispatch().await;
    assert_eq!(fixture.callback.deliveries().len(), 1);
}

#[tokio::test]
async fn rotation_verifies_before_replacement_and_dual_signatures_expire_at_two_minutes() {
    let fixture = Fixture::new();
    fixture.subscribe("session.completed").await;
    let mut rotated = encoded(&subscription("session.completed", false));
    rotated["delivery"]["secret"] = json!(ROTATED);
    let id = fixture
        .service
        .subscribe(context(), decode(rotated), Cancellation::default())
        .await
        .unwrap()
        .id;
    assert_eq!(fixture.subscriptions().len(), 1);
    assert_eq!(fixture.subscriptions()[0].id, id);
    assert!(
        fixture.subscriptions()[0]
            .previous_secret_ciphertext
            .is_some()
    );
    fixture
        .capture(
            "session.work.completed.1",
            "source_first",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    fixture.dispatch().await;
    assert_eq!(
        fixture.callback.deliveries()[0].headers["webhook-signature"]
            .split(' ')
            .count(),
        2
    );
    fixture.clock.store(NOW + 120_000, Ordering::Release);
    fixture
        .capture(
            "session.work.completed.1",
            "source_second",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    fixture.dispatch().await;
    assert_eq!(
        fixture.callback.deliveries()[1].headers["webhook-signature"]
            .split(' ')
            .count(),
        1
    );
    assert_eq!(
        fixture
            .callback
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.body.contains("\"verification\""))
            .count(),
        2
    );
}

#[tokio::test]
async fn replay_cursors_are_scoped_and_never_advance_past_pending_rows() {
    let fixture = Fixture::new();
    let initial = fixture.subscribe("session.completed").await;
    fixture
        .capture(
            "session.work.completed.1",
            "source_1",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    fixture
        .capture(
            "session.work.completed.1",
            "source_2",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    let mut replay = encoded(&subscription("session.completed", false));
    replay["cursor"] = encoded(&initial)["cursor"].clone();
    let pending = fixture
        .service
        .subscribe(context(), decode(replay.clone()), Cancellation::default())
        .await
        .unwrap();
    assert_eq!(encoded(&pending)["cursor"], encoded(&initial)["cursor"]);
    fixture.dispatch().await;
    fixture
        .service
        .subscribe(context(), decode(replay.clone()), Cancellation::default())
        .await
        .unwrap();
    assert!(
        fixture
            .outbox()
            .iter()
            .all(|row| row.delivered_at.is_none() && row.dead == 0)
    );
    replay["arguments"]["include_descendants"] = json!(true);
    assert!(
        fixture
            .service
            .subscribe(context(), decode(replay), Cancellation::default())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn retention_keeps_exact_cutoff_pending_rows_and_marks_old_cursors_truncated() {
    let fixture = Fixture::new();
    let initial = fixture.subscribe("session.completed").await;
    fixture
        .capture(
            "session.work.completed.1",
            "source_settled",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    fixture.dispatch().await;
    fixture.clock.store(NOW + 7 * DAY, Ordering::Release);
    fixture.dispatch().await;
    assert_eq!(fixture.outbox().len(), 1);
    fixture.clock.store(NOW + 7 * DAY + 1, Ordering::Release);
    fixture.dispatch().await;
    assert!(fixture.outbox().is_empty());
    assert!(fixture.subscriptions()[0].pruned_through > 0);
    let mut replay = encoded(&subscription("session.completed", false));
    replay["cursor"] = encoded(&initial)["cursor"].clone();
    let result = fixture
        .service
        .subscribe(context(), decode(replay), Cancellation::default())
        .await
        .unwrap();
    assert_eq!(encoded(&result)["truncated"], true);
}

#[tokio::test]
async fn unsubscribe_is_exact_identity_scoped_idempotent_and_kills_only_its_own_outbox() {
    let fixture = Fixture::new();
    fixture.subscribe("session.completed").await;
    fixture
        .service
        .subscribe(
            context(),
            subscription("session.completed", true),
            Cancellation::default(),
        )
        .await
        .unwrap();
    fixture
        .capture(
            "session.work.completed.1",
            "source_done",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    let input: Unsubscribe = decode(
        json!({"name":"session.completed","arguments":{"session_id":"ses_root"},"delivery":{"mode":"webhook","url":"https://callback.invalid/events"}}),
    );
    for _ in 0..2 {
        fixture
            .service
            .unsubscribe(context(), input.clone(), Cancellation::default())
            .await
            .unwrap();
    }
    assert_eq!(
        fixture
            .subscriptions()
            .iter()
            .filter(|row| row.disabled == 1)
            .count(),
        1
    );
    assert_eq!(
        fixture.outbox().iter().filter(|row| row.dead == 1).count(),
        1
    );
    fixture.dispatch().await;
    assert_eq!(fixture.callback.deliveries().len(), 1);
}

#[tokio::test]
async fn restart_cancels_only_unresolved_ephemeral_attention_not_durable_deferred_reviews() {
    let fixture = Fixture::new();
    fixture.subscribe("session.question.changed").await;
    fixture
        .capture(
            "question.asked",
            "source_question",
            json!({"sessionID":"ses_root","id":"que_pending"}),
        )
        .await;
    fixture
        .capture(
            "question.deferred",
            "source_deferred",
            json!({"sessionID":"ses_root","requestID":"que_deferred","itemID":"review_deferred"}),
        )
        .await;
    fixture.service.reconcile().await.unwrap();
    fixture.service.reconcile().await.unwrap();
    let rows = fixture.outbox();
    assert_eq!(
        rows.iter()
            .filter(|row| row.state.as_str() == Some("cancelled")
                && row.reason.as_ref().and_then(|value| value.as_str()) == Some("restart"))
            .count(),
        1
    );
    assert!(
        !rows
            .iter()
            .any(|row| row.state.as_str() == Some("cancelled")
                && row.item_id.as_ref().and_then(|value| value.as_str())
                    == Some("review_deferred"))
    );
}

#[tokio::test]
async fn feed_overflow_is_unavailable_and_cannot_be_used_as_a_replay_cursor() {
    let fixture = Fixture::new();
    let feed = Feed::attach_with(&fixture.store.client(), 2, 1);
    let subscriber = feed.subscribe(Scope::Global, None, || {}).unwrap();
    feed.publish(ycoding_core::event_feed::Ephemeral {
        id: "ephemeral_1".into(),
        created: NOW,
        session: None,
        location: None,
        metadata: None,
        data: ycoding_core::event_feed::Data::decode(
            "question.asked",
            &ycoding_schema::parse_json(r#"{"id":"que_1","sessionID":"ses_root","questions":[]}"#)
                .unwrap(),
        )
        .unwrap(),
    });
    feed.publish(ycoding_core::event_feed::Ephemeral {
        id: "ephemeral_2".into(),
        created: NOW,
        session: None,
        location: None,
        metadata: None,
        data: ycoding_core::event_feed::Data::decode(
            "question.asked",
            &ycoding_schema::parse_json(r#"{"id":"que_2","sessionID":"ses_root","questions":[]}"#)
                .unwrap(),
        )
        .unwrap(),
    });
    assert!(fixture.service.consume(&subscriber).await.is_err());
    assert!(!fixture.service.status().await);
}

#[tokio::test]
async fn failed_verification_keeps_previous_rotation_material_and_rechecks_grant_after_success() {
    for response in [
        HttpResponse {
            status: 403,
            body: String::new(),
        },
        HttpResponse {
            status: 200,
            body: r#"{"challenge":"wrong"}"#.into(),
        },
    ] {
        let fixture = Fixture::new();
        fixture.subscribe("session.completed").await;
        let before = fixture.subscriptions()[0].clone();
        fixture
            .callback
            .verification_replies
            .lock()
            .unwrap()
            .push_back(response);
        let mut rotated = encoded(&subscription("session.completed", false));
        rotated["delivery"]["secret"] = json!(ROTATED);
        assert!(
            fixture
                .service
                .subscribe(context(), decode(rotated), Cancellation::default())
                .await
                .is_err()
        );
        assert_eq!(fixture.subscriptions(), [before]);
    }
    let fixture = Fixture::new();
    fixture.subscribe("session.completed").await;
    assert_eq!(fixture.authority.checks.lock().unwrap().len(), 1);
    let fixture = Fixture::new();
    *fixture.callback.after_verification.lock().unwrap() = Some({
        let authority = fixture.authority.clone();
        Arc::new(move || {
            *authority.rejection.lock().unwrap() = Some(failure("unauthorized", "grant_revoked"));
        })
    });
    assert!(
        fixture
            .service
            .subscribe(
                context(),
                subscription("session.completed", false),
                Cancellation::default()
            )
            .await
            .is_err()
    );
    assert!(fixture.subscriptions().is_empty());
}

#[tokio::test]
async fn corrupt_ciphertext_fails_closed_without_replacing_secret_material_or_creating_a_delivery()
{
    let fixture = Fixture::new();
    fixture.subscribe("session.completed").await;
    let mut sub = fixture.subscriptions()[0].clone();
    sub.secret_ciphertext = "synthetic-corrupt-ciphertext".into();
    let key = SubscriptionTable::primary_key(&sub);
    fixture
        .store
        .submit(move |tx| SubscriptionTable::put(tx, &sub))
        .unwrap()
        .wait()
        .unwrap();
    fixture
        .capture(
            "session.work.completed.1",
            "source_done",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    fixture.dispatch().await;
    assert!(fixture.callback.deliveries().is_empty());
    let row = fixture
        .store
        .snapshot()
        .unwrap()
        .get::<SubscriptionTable>(&key)
        .unwrap()
        .unwrap();
    assert_eq!(
        row.secret_ciphertext.as_str(),
        Some("synthetic-corrupt-ciphertext")
    );
    assert_eq!(row.disabled, 1);
    assert_eq!(fixture.outbox()[0].dead, 1);
}

#[tokio::test]
async fn dispatch_is_bounded_to_one_hundred_rows_and_history_keeps_stable_event_bytes_across_service_recreation()
 {
    let fixture = Fixture::new();
    fixture.subscribe("session.completed").await;
    for n in 0..101 {
        fixture
            .capture(
                "session.work.completed.1",
                &format!("source_{n}"),
                json!({"sessionID":"ses_root"}),
            )
            .await;
    }
    fixture.dispatch().await;
    assert_eq!(fixture.callback.deliveries().len(), 100);
    assert_eq!(
        fixture
            .outbox()
            .iter()
            .filter(|row| row.delivered_at.is_none())
            .count(),
        1
    );
    let replacement = Service::new(Dependencies {
        store: fixture.store.client(),
        authorization: fixture.authority.clone(),
        transport: fixture.callback.clone(),
        secrets: Secrets::Memory(Arc::new(SecretBox::new([92; 32]))),
        clock: {
            let clock = fixture.clock.clone();
            Arc::new(move || clock.load(Ordering::Acquire))
        },
    });
    replacement
        .dispatch_once(Cancellation::default())
        .await
        .unwrap();
    assert_eq!(fixture.callback.deliveries().len(), 101);
    assert!(
        fixture
            .outbox()
            .iter()
            .all(|row| row.delivered_at.is_some())
    );
}

#[tokio::test]
async fn transient_transport_errors_retry_without_losing_the_original_outbox_identity() {
    let fixture = Fixture::new();
    fixture.subscribe("session.error").await;
    fixture
        .capture(
            "session.execution.failed.1",
            "source_fail",
            json!({"sessionID":"ses_root","error":{"type":"provider"}}),
        )
        .await;
    fixture
        .callback
        .replies
        .lock()
        .unwrap()
        .push_back(Reply::Failure(failure("callback_endpoint", "timeout")));
    let before = fixture.outbox()[0].clone();
    fixture.dispatch().await;
    let failed = fixture.outbox()[0].clone();
    assert_eq!(failed.id, before.id);
    assert_eq!(failed.seq, before.seq);
    assert_eq!(failed.attempts, 1);
    assert_eq!(failed.dead, 0);
    fixture
        .clock
        .store(failed.next_attempt_at, Ordering::Release);
    fixture.dispatch().await;
    assert_eq!(
        fixture.callback.deliveries()[0].body,
        fixture.callback.deliveries()[1].body
    );
}

#[tokio::test]
async fn review_settlement_uses_the_stored_form_payload_and_origin_when_the_live_event_omits_them()
{
    let fixture = Fixture::new();
    fixture.subscribe("session.form.changed").await;
    let deferred = json!({"sessionID":"ses_root","itemID":"rvw_synthetic_form","kind":"question","reason":"free_text","origin":{"requestID":"frm_synthetic"},"payload":{"type":"form","title":"Synthetic","fields":[{"key":"ok","type":"boolean"}]}});
    fixture
        .store
        .submit(move |tx| {
            ycoding_store::session::append(
                tx,
                &ycoding_store::session::NewEvent {
                    id: "evt_review_deferred".into(),
                    aggregate_id: "ses_root".into(),
                    created: NOW,
                    type_: "session.review.deferred.1".into(),
                    data: ycoding_schema::parse_json(&deferred.to_string()).unwrap(),
                },
                None,
            )?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    fixture
        .capture(
            "session.review.withdrawn.1",
            "evt_review_withdrawn",
            json!({"sessionID":"ses_root","itemID":"rvw_synthetic_form","reason":"reverted"}),
        )
        .await;
    let rows = fixture.outbox();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name.as_str(), Some("session.form.changed"));
    assert_eq!(rows[0].state.as_str(), Some("cancelled"));
    assert_eq!(
        rows[0].request_id.as_ref().and_then(|value| value.as_str()),
        Some("frm_synthetic")
    );
}

#[tokio::test]
async fn returned_watermark_stops_before_the_first_pending_event_and_cleanup_does_not_remove_pending_history()
 {
    let fixture = Fixture::new();
    fixture.subscribe("session.completed").await;
    fixture
        .capture(
            "session.work.completed.1",
            "source_pending",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    let row = fixture.outbox()[0].clone();
    let sub = fixture.subscriptions()[0].clone();
    let result = fixture.subscribe("session.completed").await;
    let cursor = encoded(&result)["cursor"].as_str().unwrap().to_owned();
    assert_eq!(
        SecretBox::new([92; 32]).decode_cursor(sub.identity_hash.as_str().unwrap(), &cursor),
        Some(row.seq - 1)
    );
    fixture.clock.store(NOW + 7 * DAY + 1, Ordering::Release);
    fixture.dispatch().await;
    assert_eq!(fixture.outbox().len(), 1);
    assert_eq!(fixture.outbox()[0].seq, row.seq);
    assert_eq!(fixture.subscriptions()[0].pruned_through, 0);
}

#[tokio::test]
async fn stored_subscription_hash_matches_the_released_canonical_json_and_exact_callback_bytes() {
    let fixture = Fixture::new();
    fixture.subscribe("session.progress").await;
    let canonical = r#"{"arguments":{"include_descendants":false,"session_id":"ses_root"},"name":"session.progress","principal":{"clientID":"client_synthetic","deviceID":"device_synthetic","epoch":"epoch_synthetic","grantID":"grant_synthetic","ownerID":"owner_synthetic"},"url":"https://callback.invalid/events"}"#;
    let digest = ring::digest::digest(&ring::digest::SHA256, canonical.as_bytes());
    let expected = digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let row = fixture.subscriptions().pop().unwrap();
    assert_eq!(row.identity_hash.as_str(), Some(expected.as_str()));
    assert_eq!(
        row.id.as_str(),
        Some(format!("sub_{}", &expected[..32]).as_str())
    );
    let mut explicit_port = encoded(&subscription("session.progress", false));
    explicit_port["delivery"]["url"] = json!("https://callback.invalid:443/events");
    fixture
        .service
        .subscribe(context(), decode(explicit_port), Cancellation::default())
        .await
        .unwrap();
    assert_eq!(fixture.subscriptions().len(), 2);
}

#[tokio::test]
async fn the_owned_worker_captures_the_native_feed_and_ignores_unrelated_usage_traffic() {
    let fixture = Fixture::new();
    fixture.subscribe("session.question.changed").await;
    let feed = Feed::attach_with(&fixture.store.client(), 2, 1);
    fixture.service.start(feed.clone()).unwrap();
    let usage=ycoding_core::event_feed::Data::decode("session.usage.updated",&ycoding_schema::parse_json(r#"{"sessionID":"ses_root","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}"#).unwrap()).unwrap();
    for n in 0..5000 {
        feed.publish(ycoding_core::event_feed::Ephemeral {
            id: format!("usage_{n}").into(),
            created: NOW,
            session: None,
            location: None,
            metadata: None,
            data: usage.clone(),
        });
    }
    let started = Arc::new(tokio::sync::Notify::new());
    fixture
        .callback
        .replies
        .lock()
        .unwrap()
        .push_back(Reply::Wait(started.clone()));
    feed.publish(ycoding_core::event_feed::Ephemeral {
        id: "evt_question_feed".into(),
        created: NOW,
        session: None,
        location: None,
        metadata: None,
        data: ycoding_core::event_feed::Data::decode(
            "question.asked",
            &ycoding_schema::parse_json(
                r#"{"id":"que_live","sessionID":"ses_root","questions":[]}"#,
            )
            .unwrap(),
        )
        .unwrap(),
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), started.notified())
        .await
        .unwrap();
    assert_eq!(fixture.outbox().len(), 1);
    assert_eq!(
        fixture.outbox()[0].name.as_str(),
        Some("session.question.changed")
    );
    assert!(fixture.service.status().await);
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        fixture.service.shutdown(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!fixture.service.status().await);
}

#[tokio::test]
async fn disabled_subscriptions_reject_refresh_without_reactivation_rotation_or_replay() {
    let fixture = Fixture::new();
    let initial = fixture.subscribe("session.completed").await;
    fixture
        .capture(
            "session.work.completed.1",
            "source_done",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    fixture
        .service
        .unsubscribe(
            context(),
            decode(
                json!({"name":"session.completed","arguments":{"session_id":"ses_root"},"delivery":{"mode":"webhook","url":"https://callback.invalid/events"}}),
            ),
            Cancellation::default(),
        )
        .await
        .unwrap();
    let subscriptions = fixture.subscriptions();
    let outbox = fixture.outbox();
    assert_eq!(subscriptions[0].disabled, 1);
    fixture.clock.store(NOW + 1000, Ordering::Release);
    for secret in [SECRET, ROTATED] {
        let mut refresh = encoded(&subscription("session.completed", false));
        refresh["delivery"]["secret"] = json!(secret);
        refresh["cursor"] = encoded(&initial)["cursor"].clone();
        assert_eq!(
            fixture
                .service
                .subscribe(context(), decode(refresh), Cancellation::default())
                .await
                .unwrap_err(),
            failure("unavailable", "authorization_unavailable")
        );
        assert_eq!(fixture.subscriptions(), subscriptions);
        assert_eq!(fixture.outbox(), outbox);
    }
    fixture.dispatch().await;
    assert!(fixture.callback.deliveries().is_empty());
}

#[tokio::test]
async fn failed_response_assembly_rolls_back_registration_rotation_and_replay() {
    let limit = chrono::DateTime::<chrono::Utc>::MAX_UTC.timestamp_millis();
    let fixture = Fixture::new();
    fixture.clock.store(limit - DAY / 2, Ordering::Release);
    fixture.authority.grant.lock().unwrap().1 = limit;
    let initial = fixture.subscribe("session.completed").await;
    fixture
        .capture(
            "session.work.completed.1",
            "source_done",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    fixture.dispatch().await;
    assert_eq!(fixture.callback.deliveries().len(), 1);
    let subscriptions = fixture.subscriptions();
    let outbox = fixture.outbox();
    assert!(outbox[0].delivered_at.is_some());
    fixture.authority.grant.lock().unwrap().1 = limit + DAY;
    let mut refresh = encoded(&subscription("session.completed", false));
    refresh["delivery"]["secret"] = json!(ROTATED);
    refresh["cursor"] = encoded(&initial)["cursor"].clone();
    assert_eq!(
        fixture
            .service
            .subscribe(context(), decode(refresh), Cancellation::default())
            .await
            .unwrap_err(),
        failure("unavailable", "service_unavailable")
    );
    assert_eq!(fixture.subscriptions(), subscriptions);
    assert_eq!(fixture.outbox(), outbox);
    fixture.dispatch().await;
    assert_eq!(fixture.callback.deliveries().len(), 1);
}

#[cfg(unix)]
const NATIVE_KEY: &str = "mcp-events-native.key";
#[cfg(unix)]
const STABLE_KEY: &str = "mcp-events.key";

#[cfg(unix)]
struct KeyDirectory(std::path::PathBuf);

#[cfg(unix)]
impl KeyDirectory {
    fn new(label: &str, native: Option<[u8; 32]>, stable: Option<[u8; 32]>) -> Self {
        use std::os::unix::fs::DirBuilderExt;
        let path = std::env::temp_dir().join(format!(
            "ycoding-mcp-events-key-{label}-{}",
            std::process::id()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        let directory = Self(path);
        for (name, bytes) in [(NATIVE_KEY, native), (STABLE_KEY, stable)] {
            if let Some(bytes) = bytes {
                directory.write(name, bytes);
            }
        }
        directory
    }

    fn write(&self, name: &str, bytes: [u8; 32]) {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.0.join(name))
            .unwrap();
        file.write_all(&bytes).unwrap();
        file.sync_all().unwrap();
    }

    fn read(&self, name: &str) -> Option<Vec<u8>> {
        match std::fs::read(self.0.join(name)) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => panic!("{error}"),
        }
    }

    fn files(&self) -> Vec<(String, Option<Vec<u8>>)> {
        [NATIVE_KEY, STABLE_KEY]
            .into_iter()
            .map(|name| (name.to_owned(), self.read(name)))
            .collect()
    }

    fn native(&self) -> std::path::PathBuf {
        self.0.join(NATIVE_KEY)
    }
}

#[cfg(unix)]
impl Drop for KeyDirectory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[cfg(unix)]
async fn imported(
    directory: &KeyDirectory,
    adjust: fn(&mut [ycoding_store::mcp_events::Subscription]),
) -> Fixture {
    let stable = Fixture::with_secrets(Secrets::Memory(Arc::new(SecretBox::new([5; 32]))));
    stable.subscribe("session.completed").await;
    stable
        .service
        .subscribe(
            context(),
            subscription("session.progress", false),
            Cancellation::default(),
        )
        .await
        .unwrap();
    let mut rows = stable.subscriptions();
    adjust(&mut rows);
    let fixture = Fixture::with_secrets(Secrets::File(directory.native()));
    fixture
        .store
        .submit(move |tx| {
            for row in &rows {
                SubscriptionTable::put(tx, row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    fixture
        .capture(
            "session.work.completed.1",
            "source_imported",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    fixture
}

#[cfg(unix)]
fn assert_signed(request: &ycoding_core::mcp_events::HttpRequest) {
    let signed = format!(
        "{}.{}.{}",
        request.headers["webhook-id"], request.headers["webhook-timestamp"], request.body
    );
    let signature = ycoding_core::mcp_events::secret_box::decode_secret(&format!(
        "whsec_{}",
        request.headers["webhook-signature"]
            .strip_prefix("v1,")
            .unwrap()
    ))
    .unwrap();
    ring::hmac::verify(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &[0; 32]),
        signed.as_bytes(),
        &signature,
    )
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn imported_active_subscriptions_fail_closed_on_missing_or_conflicting_native_and_stable_keys()
 {
    for (label, native, stable) in [
        ("absent", None, None),
        ("native-conflict", Some([6; 32]), None),
        ("stable-conflict", None, Some([6; 32])),
        ("native-differs", Some([5; 32]), Some([6; 32])),
        ("stable-differs", Some([6; 32]), Some([5; 32])),
    ] {
        let directory = KeyDirectory::new(label, native, stable);
        let files = directory.files();
        let fixture = imported(&directory, |_| {}).await;
        let subscriptions = fixture.subscriptions();
        let outbox = fixture.outbox();
        assert_eq!(outbox.len(), 1, "{label}");
        assert!(!fixture.service.status().await, "{label}");
        assert_eq!(
            fixture
                .service
                .dispatch_once(Cancellation::default())
                .await
                .unwrap_err(),
            failure("unavailable", "secure_storage_unavailable"),
            "{label}"
        );
        assert_eq!(
            fixture
                .service
                .subscribe(
                    context(),
                    subscription("session.error", false),
                    Cancellation::default()
                )
                .await
                .unwrap_err(),
            failure("unavailable", "secure_storage_unavailable"),
            "{label}"
        );
        assert!(
            fixture.callback.requests.lock().unwrap().is_empty(),
            "{label}"
        );
        assert_eq!(fixture.subscriptions(), subscriptions, "{label}");
        assert_eq!(fixture.outbox(), outbox, "{label}");
        assert_eq!(directory.files(), files, "{label}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_stable_or_native_key_that_authenticates_imported_secrets_signs_delivery_under_fresh_grants()
 {
    for (label, native, stable) in [
        ("native", Some([5; 32]), None),
        ("stable", None, Some([5; 32])),
        ("both", Some([5; 32]), Some([5; 32])),
    ] {
        let directory = KeyDirectory::new(label, native, stable);
        let files = directory.files();
        let fixture = imported(&directory, |_| {}).await;
        let subscriptions = fixture.subscriptions();
        assert!(fixture.service.status().await, "{label}");
        fixture
            .callback
            .replies
            .lock()
            .unwrap()
            .push_back(Reply::Status(503));
        fixture.dispatch().await;
        assert!(fixture.outbox()[0].delivered_at.is_none(), "{label}");
        assert_eq!(fixture.outbox()[0].attempts, 1, "{label}");
        fixture.clock.store(NOW + 5000, Ordering::Release);
        fixture.dispatch().await;
        let deliveries = fixture.callback.deliveries();
        assert_eq!(deliveries.len(), 2, "{label}");
        deliveries.iter().for_each(assert_signed);
        assert!(fixture.outbox()[0].delivered_at.is_some(), "{label}");
        let checks = fixture.authority.checks.lock().unwrap().clone();
        assert_eq!(checks.len(), 2, "{label}");
        assert!(
            checks
                .iter()
                .all(|principal| principal.grant_id.as_str() == Some("grant_synthetic")),
            "{label}"
        );
        assert_eq!(fixture.subscriptions(), subscriptions, "{label}");
        fixture.authority.grant.lock().unwrap().0 = "grant_replacement".into();
        fixture
            .capture(
                "session.work.completed.1",
                "source_after_revocation",
                json!({"sessionID":"ses_root"}),
            )
            .await;
        fixture.dispatch().await;
        assert_eq!(fixture.callback.deliveries().len(), 2, "{label}");
        assert!(fixture.outbox()[1].delivered_at.is_none(), "{label}");
        assert_eq!(directory.files(), files, "{label}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn inactive_imported_subscriptions_do_not_block_native_key_creation() {
    use std::os::unix::fs::MetadataExt;
    let directory = KeyDirectory::new("inactive", None, None);
    let fixture = imported(&directory, |rows| {
        rows[0].disabled = 1;
        rows[1].expires_at = NOW;
    })
    .await;
    let subscriptions = fixture.subscriptions();
    assert!(fixture.service.status().await);
    let metadata = std::fs::symlink_metadata(directory.native()).unwrap();
    assert!(metadata.is_file());
    assert_eq!(metadata.len(), 32);
    assert_eq!(metadata.mode() & 0o777, 0o600);
    assert_eq!(directory.read(STABLE_KEY), None);
    fixture
        .service
        .subscribe(
            context(),
            subscription("session.error", false),
            Cancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(fixture.subscriptions().len(), 3);
    assert!(
        subscriptions
            .iter()
            .all(|row| fixture.subscriptions().contains(row))
    );
}

#[derive(Clone, Default)]
struct Logs(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Logs {
    fn capture(&self) -> tracing::dispatcher::DefaultGuard {
        static STABLE_INTEREST: std::sync::Once = std::sync::Once::new();
        STABLE_INTEREST.call_once(|| {
            tracing::subscriber::set_global_default(
                tracing_subscriber::fmt()
                    .with_writer(std::io::sink)
                    .finish(),
            )
            .expect("the MCP Events tests own the global subscriber")
        });
        let logs = self.clone();
        tracing::dispatcher::set_default(&tracing::Dispatch::new(
            tracing_subscriber::fmt()
                .without_time()
                .with_ansi(false)
                .with_target(false)
                .with_writer(move || logs.clone())
                .finish(),
        ))
    }

    fn lines(&self) -> Vec<String> {
        String::from_utf8(self.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn assert_private(&self) {
        let text = self.lines().join("\n");
        for private in [
            "callback.invalid",
            SECRET,
            ROTATED,
            "whsec_",
            "forwarded_synthetic",
            "synthetic-corrupt-ciphertext",
        ] {
            assert!(!text.contains(private), "{private} leaked into {text}");
        }
    }
}

fn request_hash() -> String {
    ring::digest::digest(&ring::digest::SHA256, b"forwarded_synthetic").as_ref()[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[tokio::test]
async fn subscription_outcomes_log_a_request_hash_and_categorized_failures_without_private_material()
 {
    let logs = Logs::default();
    let _guard = logs.capture();
    let fixture = Fixture::new();
    let active = fixture.subscribe("session.completed").await;
    let mut missing = encoded(&subscription("session.completed", false));
    missing["arguments"]["session_id"] = json!("ses_missing");
    assert_eq!(
        fixture
            .service
            .subscribe(context(), decode(missing), Cancellation::default())
            .await
            .unwrap_err(),
        failure("invalid_params", "session_not_found")
    );
    let lines = logs.lines();
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(
        lines[0].contains("INFO MCP Events subscription active"),
        "{}",
        lines[0]
    );
    assert!(lines[0].contains(&format!("request_hash={}", request_hash())));
    assert!(lines[0].contains(&format!(
        "subscription_id={}",
        encoded(&active)["id"].as_str().unwrap()
    )));
    assert!(
        lines[1].contains("WARN MCP Events subscription failed"),
        "{}",
        lines[1]
    );
    assert!(lines[1].contains(&format!("request_hash={}", request_hash())));
    assert!(lines[1].contains("category=invalid_params"));
    assert!(lines[1].contains("reason=session_not_found"));
    logs.assert_private();
}

#[tokio::test]
async fn webhook_failures_and_disable_paths_log_bounded_outcomes_without_claiming_delivery() {
    let logs = Logs::default();
    let _guard = logs.capture();
    let fixture = Fixture::new();
    fixture.subscribe("session.completed").await;
    fixture
        .capture(
            "session.work.completed.1",
            "source_failed",
            json!({"sessionID":"ses_root"}),
        )
        .await;
    let row = fixture.outbox()[0].clone();
    let subscription_id = row.subscription_id.as_str().unwrap().to_owned();
    let event_id = row.id.as_str().unwrap().to_owned();
    fixture.callback.replies.lock().unwrap().extend([
        Reply::Status(503),
        Reply::Failure(failure("callback_endpoint", "endpoint_unreachable")),
    ]);
    fixture.dispatch().await;
    fixture.clock.store(NOW + 5000, Ordering::Release);
    fixture.dispatch().await;
    fixture.authority.grant.lock().unwrap().0 = "grant_replacement".into();
    fixture.clock.store(NOW + 15_000, Ordering::Release);
    fixture.dispatch().await;
    let lines = logs
        .lines()
        .into_iter()
        .filter(|line| !line.contains("subscription active"))
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 3, "{lines:?}");
    for line in &lines {
        assert!(line.contains("WARN MCP Events"), "{line}");
        assert!(
            line.contains(&format!("subscription_id={subscription_id}")),
            "{line}"
        );
        assert!(line.contains(&format!("event_id={event_id}")), "{line}");
    }
    assert!(lines[0].contains("MCP Events webhook failed"));
    assert!(lines[0].contains("attempt=1"));
    assert!(lines[0].contains("terminal=false"));
    assert!(lines[0].contains("http_status=503"));
    assert!(lines[1].contains("MCP Events webhook failed"));
    assert!(lines[1].contains("attempt=2"));
    assert!(lines[1].contains("category=callback_endpoint"));
    assert!(lines[1].contains("reason=endpoint_unreachable"));
    assert!(lines[2].contains("MCP Events subscription disabled"));
    assert!(lines[2].contains("category=unauthorized"));
    assert!(lines[2].contains("reason=grant_revoked"));
    assert_eq!(fixture.subscriptions()[0].disabled, 1);
    for mode in ["cancelled", "corrupt"] {
        let fixture = Fixture::new();
        fixture.subscribe("session.completed").await;
        if mode == "corrupt" {
            let mut sub = fixture.subscriptions()[0].clone();
            sub.secret_ciphertext = "synthetic-corrupt-ciphertext".into();
            fixture
                .store
                .submit(move |tx| SubscriptionTable::put(tx, &sub))
                .unwrap()
                .wait()
                .unwrap();
        } else {
            fixture.authority.generation.lock().unwrap().cancel();
        }
        fixture
            .capture(
                "session.work.completed.1",
                "source_disabled",
                json!({"sessionID":"ses_root"}),
            )
            .await;
        fixture.dispatch().await;
        let line = logs.lines().pop().unwrap();
        assert!(line.contains("MCP Events subscription disabled"), "{line}");
        assert!(line.contains("category=unavailable"), "{line}");
        assert!(
            line.contains(if mode == "corrupt" {
                "reason=secure_storage_unavailable"
            } else {
                "reason=authorization_unavailable"
            }),
            "{line}"
        );
        assert_eq!(fixture.subscriptions()[0].disabled, 1);
    }
    logs.assert_private();
}

#[tokio::test]
async fn cancellation_before_the_store_write_persists_nothing_and_releases_the_mutation_lane() {
    let fixture = Fixture::new();
    let request = Cancellation::default();
    *fixture.callback.after_verification.lock().unwrap() = Some({
        let request = request.clone();
        Arc::new(move || request.cancel())
    });
    assert_eq!(
        fixture
            .service
            .subscribe(context(), subscription("session.completed", false), request,)
            .await
            .unwrap_err(),
        failure("unavailable", "authorization_unavailable")
    );
    assert!(fixture.subscriptions().is_empty());
    assert!(fixture.outbox().is_empty());
    *fixture.callback.after_verification.lock().unwrap() = None;
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        fixture.subscribe("session.completed"),
    )
    .await
    .unwrap();
    assert_eq!(fixture.subscriptions().len(), 1);
}
