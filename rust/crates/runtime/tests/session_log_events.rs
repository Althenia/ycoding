#![allow(dead_code)]

#[path = "../src/convert.rs"]
mod convert;
#[path = "../src/log.rs"]
mod log;
#[path = "../src/message.rs"]
mod message;
mod support;
mod dispatch {
    pub use ycoding_runtime::Failure;
}

use prost::{Message, Name};
use std::{collections::BTreeSet, sync::Arc, time::Duration};
use support::{Client, session_scope, start, success, text, units, world};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
};
use ycoding_core::{
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        credential, model,
    },
    session::{
        log::Entry,
        run_coordinator::Coordinator,
        runner::{Executor, Local, Services, WallClock},
        store::Service,
    },
    tools::registry::Registry,
    ycoding_schema::{
        DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, ObjectEncoder,
        parse_json, session, session_event,
    },
    ycoding_store::{
        KeyPart,
        session::{self as tables, NewEvent, SessionTable},
        tuple_key,
    },
};
use ycoding_protocol::{
    decode_strict,
    domain_json::{self, Domain},
    v5,
};
use ycoding_runtime::{LocalAuth, standard};

static SERIAL: Mutex<()> = Mutex::const_new(());

fn global() -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Global(v5::Empty {})),
    }
}
const SESSION: &str = "ses_wire_events";

fn hex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn fixtures() -> JsonValue {
    parse_json(include_str!("session_log_events/expectations.json")).unwrap()
}

fn string(value: &JsonValue) -> String {
    let JsonValue::String(text) = value else {
        panic!("expected string")
    };
    text.to_utf8().unwrap()
}

fn cases() -> Vec<(String, Entry, Vec<u8>, Vec<u8>)> {
    let fixtures = fixtures();
    message::J(&fixtures)
        .field("cases")
        .unwrap()
        .items()
        .unwrap()
        .iter()
        .map(|value| {
            let value = message::J(value);
            let event =
                session_event::DurableEvent::decode(value.field("event").unwrap().0).unwrap();
            let durable = event.0.durable.as_ref().unwrap();
            let entry = Entry {
                seq: durable.seq.get(),
                version: durable.version.get(),
                event,
            };
            (
                string(value.field("name").unwrap().0),
                entry,
                hex(&string(value.field("hex").unwrap().0)),
                hex(&string(value.field("streamHex").unwrap().0)),
            )
        })
        .collect()
}

#[test]
fn ts_encoder_cases_cover_every_public_durable_variant_and_preserve_envelopes() {
    let cases = cases();
    let id = session::Id::new(SESSION).unwrap();
    let epoch = LosslessString::from("source-epoch-test");
    let expected = session_event::public_durable_definitions()
        .into_iter()
        .map(|event| event.event_type)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        cases
            .iter()
            .map(|(_, entry, _, _)| entry.event.0.event_type.clone())
            .collect::<BTreeSet<_>>(),
        expected
    );
    assert_eq!(expected.len(), 74);
    assert!(!expected.contains(&"session.tool.progress".into()));
    assert!(log::excluded("session.tool.progress.1"));
    for (name, entry, expected, _) in cases {
        let record =
            log::record(&entry, &id, &epoch).unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert_eq!(record.item.encode_to_vec(), expected, "TS bytes/{name}");
        let expected = decode_strict::<v5::SessionLogItem>(&expected).unwrap();
        assert_eq!(record.item, expected, "{name}");
        assert_eq!(
            record.item.encode_to_vec(),
            expected.encode_to_vec(),
            "{name}"
        );
        assert_eq!(record.event_id, "evt_wire_fixture", "{name}");
        assert_eq!(record.created_ms, 42, "{name}");
        assert_eq!(record.seq, entry.seq as u64, "{name}");
        assert_eq!(record.version, entry.version as u32, "{name}");
    }
}

#[test]
fn coordination_permission_assessments_keep_every_optional_coordination_field_distinct() {
    let id = session::Id::new(SESSION).unwrap();
    let epoch = LosslessString::from("source-epoch-test");
    let project = |name: &str| {
        let (_, entry, expected, _) = cases()
            .into_iter()
            .find(|(case, _, _, _)| case == name)
            .unwrap_or_else(|| panic!("missing {name}"));
        let record = log::record(&entry, &id, &epoch).unwrap();
        assert_eq!(record.item.encode_to_vec(), expected, "{name}");
        let Some(v5::session_log_item::Kind::Value62(item)) = record.item.kind else {
            panic!("{name}: permission assessment expected")
        };
        item.data
    };
    let full = project("session.permission.assessed/coordination");
    assert_eq!((full.actor, full.confidence), (Some(1), Some(0.75)));
    assert_eq!(
        units(full.coordinator_session_id.as_ref().unwrap()),
        "ses_coordinator"
    );
    assert!(full.group_id.is_some() && full.rationale.is_some());
    let actor = project("session.permission.assessed/coordination-actor-only");
    assert_eq!(actor.actor, Some(1));
    assert!(actor.coordinator_session_id.is_some());
    assert!(actor.group_id.is_none() && actor.rationale.is_none() && actor.confidence.is_none());
    let group = project("session.permission.assessed/coordination-group-only");
    assert_eq!(units(group.group_id.as_ref().unwrap()), "grp_fixture");
    assert!(
        group.actor.is_none()
            && group.coordinator_session_id.is_none()
            && group.rationale.is_none()
    );
    let rationale = project("session.permission.assessed/coordination-rationale-only");
    assert_eq!(units(rationale.rationale.as_ref().unwrap()).len(), 500);
    assert!(rationale.actor.is_none() && rationale.group_id.is_none());
}

#[test]
fn diagnostic_reasons_survive_guardrail_and_review_history_projection() {
    let id = session::Id::new(SESSION).unwrap();
    let epoch = LosslessString::from("source-epoch-test");
    for (kind, reasons) in [
        (
            "session.guardrail.escalated",
            &[
                ("unavailable", 1),
                ("invalid-request", 2),
                ("provider-failed", 3),
                ("timeout", 4),
                ("input-too-large", 5),
                ("invalid-output", 6),
                ("refused", 7),
                ("truncated-output", 8),
                ("unsupported-output", 9),
                ("escalated", 10),
                ("low_confidence", 11),
                ("conflicting_grades", 12),
            ][..],
        ),
        (
            "session.review.deferred",
            &[
                ("unavailable", 10),
                ("invalid-request", 11),
                ("provider-failed", 12),
                ("timeout", 7),
                ("input-too-large", 13),
                ("invalid-output", 14),
                ("refused", 3),
                ("truncated-output", 15),
                ("unsupported-output", 16),
                ("conflicting_grades", 17),
            ][..],
        ),
    ] {
        let mut entry = cases()
            .into_iter()
            .find(|(_, entry, _, _)| entry.event.0.event_type.as_str() == Some(kind))
            .unwrap()
            .1;
        for (reason, ordinal) in reasons {
            entry
                .event
                .0
                .data
                .0
                .insert("reason".into(), JsonValue::String((*reason).into()));
            let record = log::record(&entry, &id, &epoch)
                .unwrap_or_else(|error| panic!("{kind}/{reason}: {error:?}"));
            let actual = match record.item.kind.unwrap() {
                v5::session_log_item::Kind::Value54(item) => item.data.reason,
                v5::session_log_item::Kind::Value56(item) => Some(item.data.reason),
                _ => panic!("unexpected projected event"),
            };
            assert_eq!(actual, Some(*ordinal), "{kind}/{reason}");
        }
    }
}

#[test]
fn synced_empty_zero_and_safe_maximum_match_ts_encoder() {
    let fixtures = fixtures();
    for case in message::J(&fixtures)
        .field("synced")
        .unwrap()
        .items()
        .unwrap()
    {
        let case = message::J(case);
        let seq = match case.field("seq").unwrap().0 {
            JsonValue::Null => None,
            JsonValue::Number(number) => Some(*number as i64),
            _ => panic!("seq"),
        };
        assert_eq!(
            log::synced(
                &session::Id::new(SESSION).unwrap(),
                seq,
                &"source-epoch-test".into()
            )
            .encode_to_vec(),
            hex(&string(case.field("hex").unwrap().0))
        );
    }
}

#[test]
fn unknown_future_variants_versions_and_inconsistent_positions_are_rejected() {
    let id = session::Id::new(SESSION).unwrap();
    let epoch = LosslessString::from("source-epoch-test");
    let entry = cases().remove(0).1;
    let mut future = entry.clone();
    future.event.0.event_type = "session.future".into();
    assert!(log::record(&future, &id, &epoch).is_err());
    let mut version = entry.clone();
    version.version += 1;
    assert!(log::record(&version, &id, &epoch).is_err());
    let mut sequence = entry.clone();
    sequence.seq += 1;
    assert!(log::record(&sequence, &id, &epoch).is_err());
    assert!(log::record(&entry, &session::Id::new("ses_other").unwrap(), &epoch).is_err());
    let mut identifier = entry.clone();
    identifier.event.0.id =
        ycoding_core::ycoding_schema::event::Id::new(LosslessString::from_utf16(vec![
            101, 118, 116, 95, 0xd800,
        ]))
        .unwrap();
    assert!(log::record(&identifier, &id, &epoch).is_err());
    for excluded in [
        "session.profile.bound.1",
        "session.guardrail.approved.1",
        "session.usage.recorded.1",
        "session.provider.request.recorded.1",
        "session.compaction.admitted.1",
        "session.compaction.started.1",
        "session.compaction.ended.1",
        "session.compaction.failed.1",
        "session.compaction.replaced.1",
    ] {
        assert!(log::excluded(excluded), "{excluded}");
    }
    assert!(!log::excluded("session.profile.bound.2"));
    assert!(!log::excluded("session.future.1"));
}

async fn until(client: &mut Client, done: impl Fn(&Client) -> bool) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !done(client) {
            assert!(client.close.is_none(), "stream closed: {:?}", client.close);
            client.step().await;
        }
    })
    .await
    .expect("stream did not reach its deterministic boundary");
}

fn records(client: &Client, sub: &str) -> Vec<v5::EventRecord> {
    client
        .batches
        .iter()
        .filter(|batch| batch.subscription_id == sub)
        .flat_map(|batch| batch.events.iter())
        .cloned()
        .collect()
}

fn durable_records(client: &Client, sub: &str) -> Vec<v5::EventRecord> {
    records(client, sub)
        .into_iter()
        .filter(|record| record.durable.is_some())
        .map(|record| support::session_log_record(&record))
        .filter(|record| {
            !matches!(
                v5::SessionLogItem::decode(record.event.payload.as_slice())
                    .unwrap()
                    .kind,
                Some(v5::session_log_item::Kind::Value52(_))
            )
        })
        .collect()
}

async fn subscribe(
    client: &mut Client,
    id: &str,
    log: bool,
    after: Option<u64>,
    follow: bool,
) -> String {
    let scope = session_scope(id);
    let request = if log {
        client
            .send(
                "session.log",
                scope.clone(),
                v5::SessionLogRequest {
                    params: v5::SessionLogRequestParams {
                        session_id: text(id),
                    },
                    query: v5::SessionLogRequestQuery {
                        after,
                        follow: Some(follow),
                    },
                }
                .encode_to_vec(),
            )
            .await
    } else {
        client
            .send(
                "event.subscribe",
                v5::Scope {
                    target: Some(v5::scope::Target::Global(v5::Empty {})),
                },
                v5::EventSubscribeRequest {
                    scope: scope.clone(),
                }
                .encode_to_vec(),
            )
            .await
    };
    client.subscribe_events(&request, scope).await
}

async fn seed(id: &str) {
    let mut row = world()
        .store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&"ses_rich".into())]))
        .unwrap()
        .unwrap();
    row.id = id.into();
    world()
        .store
        .submit(move |tx| SessionTable::insert(tx, &row))
        .unwrap()
        .await
        .unwrap();
}

async fn append(event: NewEvent) {
    world()
        .store
        .submit(move |tx| tables::append(tx, &event, None))
        .unwrap()
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn both_wire_operations_deliver_every_ts_case_in_order_and_filter_only_internal_history() {
    let _serial = SERIAL.lock().await;
    tokio::time::timeout(Duration::from_secs(60), async {
        seed(SESSION).await;
        let server = start(support::services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let live = subscribe(&mut client, SESSION, false, None, true).await;
        let fixtures = cases();
        for (index, (_, entry, _, _)) in fixtures.iter().enumerate() {
            append(NewEvent { id: format!("evt_wire_stream_{index}").as_str().into(), aggregate_id: SESSION.into(), created: 42, type_: format!("{}.{}", entry.event.0.event_type.as_str().unwrap(), entry.version).as_str().into(), data: entry.event.0.data.encode() }).await;
        }
        for (index, (kind, data)) in [
            ("session.usage.recorded.1", r#"{"sessionID":"ses_wire_events","source":"title","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}"#),
            ("session.profile.bound.1", r#"{"sessionID":"ses_wire_events"}"#),
            ("session.compaction.admitted.1", r#"{"sessionID":"ses_wire_events","inputID":"msg_historical"}"#),
        ].into_iter().enumerate() {
            append(NewEvent { id: format!("evt_wire_internal_{index}").as_str().into(), aggregate_id: SESSION.into(), created: 42, type_: kind.into(), data: parse_json(data).unwrap() }).await;
        }
        world().core.events.publish(ycoding_core::event_feed::Ephemeral { id: "evt_wire_ephemeral".into(), created: 42, session: Some(session::Id::new(SESSION).unwrap()), metadata: None, location: None, data: ycoding_core::event_feed::Data::decode("session.prediction.updated", &parse_json(r#"{"sessionID":"ses_wire_events","sourceMessageID":"msg_fixture","text":"A prediction"}"#).unwrap()).unwrap() });
        let replay = subscribe(&mut client, SESSION, true, None, false).await;
        until(&mut client, |client| client.ended.contains(&replay) && durable_records(client, &live).len() >= fixtures.len()).await;
        for sub in [&live, &replay] {
            let records = durable_records(&client, sub);
            assert_eq!(records.len(), fixtures.len(), "{sub}");
            for (index, (record, (name, _, _, expected))) in records.iter().zip(fixtures.iter()).enumerate() {
                assert_eq!(record.event.type_name, v5::SessionLogItem::full_name());
                assert_eq!(record.event.payload, *expected, "{sub}/{name}");
                assert_eq!(record.event_id, format!("evt_wire_stream_{index}"));
                assert_eq!(record.created_ms, 42);
                assert_eq!(record.durable.as_ref().unwrap().sequence, index as u64);
            }
        }
        let replay_records = records(&client, &replay);
        let Some(v5::session_log_item::Kind::Value52(synced)) = v5::SessionLogItem::decode(replay_records.last().unwrap().event.payload.as_slice()).unwrap().kind else { panic!("missing terminal synced") };
        assert_eq!(synced.seq, Some(fixtures.len() as u64 + 2));
        assert_eq!(units(&synced.source_epoch), "source-epoch-test");
        assert!(client.resyncs.is_empty());
        server.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_durable_events_close_both_wire_streams_instead_of_advancing_silently() {
    let _serial = SERIAL.lock().await;
    tokio::time::timeout(Duration::from_secs(30), async {
        let id = "ses_wire_future";
        seed(id).await;
        let server = start(
            support::services(LocalAuth::disabled(), true),
            standard().unwrap(),
        )
        .await;
        let mut live = Client::open(server.address(), &[]).await.unwrap();
        subscribe(&mut live, id, false, None, true).await;
        let mut replay = Client::open(server.address(), &[]).await.unwrap();
        let replay_sub = subscribe(&mut replay, id, true, None, true).await;
        until(&mut replay, |client| {
            !records(client, &replay_sub).is_empty()
        })
        .await;
        replay.batches.clear();
        append(NewEvent {
            id: "evt_future".into(),
            aggregate_id: id.into(),
            created: 42,
            type_: "session.future.1".into(),
            data: ObjectEncoder::new().field("sessionID", id).finish(),
        })
        .await;
        while live.close.is_none() {
            live.step().await;
        }
        assert_eq!(live.close.as_ref().unwrap().0, 1002);
        while replay.close.is_none() {
            replay.step().await;
        }
        assert_eq!(replay.close.as_ref().unwrap().0, 1002);
        assert!(replay.batches.is_empty());
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reviewed_child_provenance_keeps_root_identity_and_independent_replay_cursors() {
    let _serial = SERIAL.lock().await;
    let root = "ses_provenance_root";
    let child = "ses_provenance_child";
    let sibling = "ses_provenance_sibling";
    for id in [root, child, sibling] {
        seed(id).await;
    }
    let server = start(
        support::services(LocalAuth::disabled(), true),
        standard().unwrap(),
    )
    .await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let live = subscribe(&mut client, root, false, None, true).await;
    let request = client
        .send(
            "event.subscribe",
            global(),
            v5::EventSubscribeRequest { scope: global() }.encode_to_vec(),
        )
        .await;
    let global_live = client.subscribe_events(&request, global()).await;
    for index in 0..4 {
        append(NewEvent {
            id: format!("evt_provenance_child_{index}").into(),
            aggregate_id: child.into(),
            created: 10 + index,
            type_: "session.renamed.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", child)
                .field("title", "Child")
                .finish(),
        })
        .await;
    }
    for (id, kind, created, data) in [
        (
            "evt_provenance_dismissed",
            "session.guardrail.dismissed.1",
            20,
            format!(
                r#"{{"sessionID":"{root}","reviewSessionID":"{child}","ruleID":"standard.review.outside-repository","confidence":0.95,"source":{{"messageID":"msg_provenance","callID":"call_provenance"}}}}"#
            ),
        ),
        (
            "evt_provenance_decided",
            "session.guardrail.decided.1",
            30,
            format!(
                r#"{{"sessionID":"{root}","reviewSessionID":"{child}","requestID":"grq_provenance","reply":"once","choice":"approve","confidence":0.91,"ruleIDs":["custom.review"],"source":{{"messageID":"msg_provenance","callID":"call_provenance"}}}}"#
            ),
        ),
    ] {
        append(NewEvent {
            id: id.into(),
            aggregate_id: root.into(),
            created,
            type_: kind.into(),
            data: parse_json(&data).unwrap(),
        })
        .await;
    }
    let root_replay = subscribe(&mut client, root, true, None, false).await;
    let child_replay = subscribe(&mut client, child, true, Some(2), false).await;
    let sibling_replay = subscribe(&mut client, sibling, true, None, false).await;
    until(&mut client, |client| {
        [&root_replay, &child_replay, &sibling_replay]
            .iter()
            .all(|subscription| client.ended.contains(*subscription))
            && durable_records(client, &live).len() == 2
            && durable_records(client, &global_live).len() >= 6
    })
    .await;
    let expected = durable_records(&client, &root_replay);
    assert_eq!(expected.len(), 2);
    assert_eq!(durable_records(&client, &live), expected);
    assert_eq!(
        durable_records(&client, &global_live)
            .into_iter()
            .filter(|record| record.durable.as_ref().unwrap().aggregate_id == root)
            .collect::<Vec<_>>(),
        expected,
    );
    for (index, record) in expected.iter().enumerate() {
        assert_eq!(record.durable.as_ref().unwrap().aggregate_id, root);
        assert_eq!(record.durable.as_ref().unwrap().sequence, index as u64);
        match v5::SessionLogItem::decode(record.event.payload.as_slice())
            .unwrap()
            .kind
            .unwrap()
        {
            v5::session_log_item::Kind::Value53(event) => {
                assert_eq!(units(&event.durable.aggregate_id), root);
                assert_eq!(units(&event.data.session_id), root);
                assert_eq!(units(&event.data.review_session_id), child);
                let source = event.data.source.unwrap();
                assert_eq!(units(&source.message_id), "msg_provenance");
                assert_eq!(units(&source.call_id), "call_provenance");
            }
            v5::session_log_item::Kind::Value55(event) => {
                assert_eq!(units(&event.durable.aggregate_id), root);
                assert_eq!(units(&event.data.session_id), root);
                assert_eq!(units(&event.data.review_session_id), child);
                assert_eq!(event.data.choice, Some(2));
            }
            _ => panic!("unexpected provenance branch"),
        }
    }
    let child_records = durable_records(&client, &child_replay);
    assert_eq!(child_records.len(), 1);
    assert_eq!(child_records[0].event_id, "evt_provenance_child_3");
    assert_eq!(child_records[0].durable.as_ref().unwrap().sequence, 3);
    assert!(durable_records(&client, &sibling_replay).is_empty());
    for (subscription, sequence) in [
        (&root_replay, Some(1)),
        (&child_replay, Some(3)),
        (&sibling_replay, None),
    ] {
        let terminal = records(&client, subscription);
        let Some(v5::session_log_item::Kind::Value52(synced)) =
            v5::SessionLogItem::decode(terminal.last().unwrap().event.payload.as_slice())
                .unwrap()
                .kind
        else {
            panic!("missing synced watermark")
        };
        assert_eq!(synced.seq, sequence);
    }
    let mut reconnected = Client::open(server.address(), &[]).await.unwrap();
    let resumed = subscribe(&mut reconnected, root, true, Some(0), false).await;
    until(&mut reconnected, |client| client.ended.contains(&resumed)).await;
    assert_eq!(durable_records(&reconnected, &resumed), expected[1..]);
    assert!(client.resyncs.is_empty());
    assert!(reconnected.resyncs.is_empty());
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_runner_flow_preserves_order_follow_watermark_cursor_and_full_values_on_both_operations()
 {
    let _serial = SERIAL.lock().await;
    tokio::time::timeout(Duration::from_secs(60), async {
        let id = "ses_wire_runner";
        seed(id).await;
        let provider = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", provider.local_addr().unwrap());
        let provider_task = tokio::spawn(async move {
            let (mut socket, _) = provider.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            let boundary = loop {
                let read = socket.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
                if let Some(boundary) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") { break boundary + 4; }
            };
            let length = std::str::from_utf8(&request[..boundary]).unwrap().lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap())).unwrap();
            while request.len() - boundary < length {
                let read = socket.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
            }
            let request = parse_json(std::str::from_utf8(&request[boundary..boundary + length]).unwrap()).unwrap();
            assert!(ycoding_core::ycoding_schema::stringify_json(&request).contains("Answer the prompt"));
            let first = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"Think\"},\"finish_reason\":null}]}\n\n";
            let rest = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{first}", first.len() + rest.len()).as_bytes()).await.unwrap();
            socket.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(1200)).await;
            socket.write_all(rest.as_bytes()).await.unwrap();
        });
        let mut catalog = Catalog::new(models_dev::normalize(&parse_json(include_str!("../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json")).unwrap()).unwrap());
        catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
        let root = std::env::temp_dir().join(format!("ycoding-wire-runner-{}", std::process::id()));
        let registry = Arc::new(Registry::new(
            Arc::new(ycoding_core::resources::tool_output_store::Store::new(&ycoding_core::resources::config::Roots::development(&root).unwrap())),
            None, Default::default(), Arc::new(|left, right| left.cmp(right)),
        ));
        let session_id = session::Id::new(id).unwrap();
        let (session, location) = world().core.locations.session(&session_id).unwrap();
        let clock: Arc<dyn ycoding_core::session::runner::Clock> = Arc::new(WallClock);
        let runner = Local::new(Services {
            generation: ycoding_core::generation_activity::Service::new(clock.now(), clock.nanos()),
            snapshots: None,
            store: Service::new(world().store.clone()), events: world().core.events.clone(), location: session.location,
            models: Arc::new(model::Resolver::new(catalog)), agents: ycoding_core::resources::domain_state::DomainState::new(agent::Service::new(vec![agent::empty("build".into())])),
            credentials: credential::Service::new(world().store.clone()), tools: registry,
            attachments: Arc::new(attachment_store::Store::new(root.join("attachments")).unwrap()), instructions: Vec::new(), analysis: None,
            clock, executor: Arc::new(Executor::new(Executor::http_client().unwrap())),
            compaction: Default::default(), guardrails: location.guardrails.clone(), helpers: Default::default(), cursor: None, skill_resolver: None, claude: None, auth: None,
            configuration: None, image_analyzer: None, extensions: Vec::new(), session_tools: None,
        });
        let coordinator = Coordinator::new(Arc::new(runner));
        let server = start(support::services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let live = subscribe(&mut client, id, false, None, true).await;
        let global_request = client.send("event.subscribe", global(), v5::EventSubscribeRequest { scope: global() }.encode_to_vec()).await;
        let global_live = client.subscribe_events(&global_request, global()).await;
        let follow = subscribe(&mut client, id, true, None, true).await;
        until(&mut client, |client| records(client, &follow).iter().any(|record| matches!(v5::SessionLogItem::decode(record.event.payload.as_slice()).unwrap().kind, Some(v5::session_log_item::Kind::Value52(_))))).await;
        let initial = records(&client, &follow);
        let Some(v5::session_log_item::Kind::Value52(synced)) = v5::SessionLogItem::decode(initial[0].event.payload.as_slice()).unwrap().kind else { panic!("initial watermark") };
        assert_eq!(synced.seq, None);
        let _: v5::SessionPromptResult = success(client.call("session.prompt", session_scope(id), v5::SessionPromptRequest {
            params: v5::SessionPromptRequestParams { session_id: text(id) }, payload: v5::SessionPromptRequestPayload {
                id: Some(text("msg_wire_runner_input")), text: text("Answer the prompt"), files: None, agents: None, metadata: None, delivery: Some(1), resume: Some(false),
},
        }.encode_to_vec()).await);
        coordinator.run(&session_id).await.unwrap();
        provider_task.await.unwrap();
        coordinator.shutdown().await.unwrap();
        let replay = subscribe(&mut client, id, true, None, false).await;
        until(&mut client, |client| client.ended.contains(&replay) && durable_records(client, &live).len() == durable_records(client, &replay).len() && durable_records(client, &follow).len() == durable_records(client, &replay).len()).await;
        let sequence = durable_records(&client, &replay);
        until(&mut client, |client| records(client, &global_live).iter().filter(|record| record.durable.is_none()).count() >= 4).await;
        for subscription in [&live, &global_live] {
            let live_records = records(&client, subscription);
            let ephemerals = live_records.iter().filter(|record| record.durable.is_none()).map(|record| v5::PublicEvent::decode(record.event.payload.as_slice()).unwrap().kind.unwrap()).collect::<Vec<_>>();
            use v5::public_event::Kind;
            assert!(ephemerals.iter().any(|event| matches!(event, Kind::SessionTextDelta(value) if units(&value.data.delta) == "Answer" && value.data.ordinal == 0 && units(&value.data.session_id) == id)));
            assert!(ephemerals.iter().any(|event| matches!(event, Kind::SessionReasoningDelta(value) if units(&value.data.delta) == "Think" && value.data.ordinal == 0)));
            assert!(ephemerals.iter().any(|event| matches!(event, Kind::SessionUsageUpdated(value) if value.data.tokens.input == 3.0 && value.data.tokens.output == 2.0)));
            assert!(ephemerals.iter().any(|event| matches!(event, Kind::SessionDiagnosticsUpdated(value) if value.data.diagnostics.context.total == 5 && value.data.diagnostics.tokens.uncached_input == 3 && value.data.diagnostics.tokens.output == 2 && !value.data.diagnostics.cache.read_reported)));
            assert!(ephemerals.iter().any(|event| matches!(event, Kind::SessionDiagnosticsUpdated(value) if value.data.diagnostics.context_breakdown.as_ref().is_some_and(|breakdown| breakdown.user > 0) && value.data.diagnostics.generation_speed.as_ref().is_some_and(|speed| speed.recent.items.len() == 1 && speed.recent.items[0].tokens == 2 && speed.recent.items[0].duration_ns > 0 && speed.recent.items[0].tokens_per_second == 2_f64 * 1e9 / speed.recent.items[0].duration_ns as f64 && speed.latest.as_ref() == speed.recent.items.first() && speed.model.as_ref().is_some_and(|model| units(&model.provider_id) == "openai" && units(&model.id) == "gpt-reasoning")))));
            let diagnostics = live_records.iter().position(|record| record.durable.is_none() && matches!(v5::PublicEvent::decode(record.event.payload.as_slice()).unwrap().kind, Some(Kind::SessionDiagnosticsUpdated(_)))).unwrap();
            let step_ended = live_records.iter().position(|record| record.durable.is_some() && matches!(v5::PublicEvent::decode(record.event.payload.as_slice()).unwrap().kind, Some(Kind::SessionStepEnded(_)))).unwrap();
            assert!(diagnostics < step_ended);
        }
        let kinds = sequence.iter().map(|record| {
            let bytes = &record.event.payload;
            let mut tag = 0u64;
            for (shift, byte) in bytes.iter().enumerate() {
                tag |= u64::from(byte & 127) << (shift * 7);
                if byte & 128 == 0 { break; }
            }
            tag >> 3
        }).collect::<Vec<_>>();
        assert_eq!(kinds, [15, 22, 14, 23, 30, 16, 35, 36, 33, 34, 31]);
        for sub in [&live, &follow] {
            assert_eq!(durable_records(&client, sub), sequence, "{sub}");
        }
        for (index, record) in sequence.iter().enumerate() {
            let durable = record.durable.as_ref().unwrap();
            assert_eq!(durable.aggregate_id, id);
            assert_eq!(durable.sequence, index as u64);
            match v5::SessionLogItem::decode(record.event.payload.as_slice()).unwrap().kind.unwrap() {
                v5::session_log_item::Kind::Value34(event) => assert_eq!(units(&event.data.text), "Answer"),
                v5::session_log_item::Kind::Value36(event) => assert_eq!(units(&event.data.text), "Think"),
                _ => {},
            }
        }
        let terminal = records(&client, &replay);
        let Some(v5::session_log_item::Kind::Value52(watermark)) = v5::SessionLogItem::decode(terminal.last().unwrap().event.payload.as_slice()).unwrap().kind else { panic!("terminal watermark") };
        assert_eq!(watermark.seq, Some(sequence.len() as u64));
        let resumed = subscribe(&mut client, id, true, Some(5), false).await;
        until(&mut client, |client| client.ended.contains(&resumed)).await;
        assert_eq!(durable_records(&client, &resumed), sequence[6..]);
        assert!(client.resyncs.is_empty());
        server.shutdown().await.unwrap();
    }).await.unwrap();
}

fn dots_cases(session: &str) -> Vec<(&'static str, String)> {
    let fingerprint = "a".repeat(64);
    let principal = r#"{"ownerID":"owner","deviceID":"device","clientID":"client","grantID":"grant","epoch":"epoch"}"#;
    let target =
        r#"{"profile":"work","dotID":"dot","threadID":"thread","generation":"g1","label":"Dot"}"#;
    let exchange = |extra: &str| {
        format!(
            r#"{{"exchangeID":"ex","sessionID":"$S","targetSessionID":"ses_target","inputID":"msg_task","expectedAttachment":{target},"accountDigest":"digest","fingerprint":"$F","source":{{"requestID":"req","principal":{{"ownerID":"owner","deviceID":"device","clientID":"client"}},"epoch":"epoch"}},"grantID":"grant","scope":{{"rootSessionID":"ses_target"{extra}}}}}"#
        )
    };
    let routine = r#","routine":{"delegation":{"id":"del","revision":2},"taskInputID":"msg_task","instruction":{"operation":"presentation","preferences":{"format":"bullets","detail":"concise"}}}"#;
    let delegated = r#","delegated":{"delegation":{"id":"del","revision":1},"instruction":{"operation":"decision","target":{"kind":"permission","requestID":"per_fixture","fingerprint":"$F"},"reply":"once"}}"#;
    let envelope = |kind: &str| {
        format!(
            r#"{{"coordinator":{{"ownerID":"owner","deviceID":"device","clientID":"client"}},"scope":{{"epoch":"epoch","grantID":"grant"}},"exchangeID":"ex","messageID":"msg_report","kind":"{kind}","origin":"agent","sourceSessionID":"ses_target","replyToMessageID":"msg_task"}}"#
        )
    };
    let delegation_source = r#"{"kind":"dots-delegation","anchorSessionID":"ses_anchor","delegationID":"del","revision":1,"exchangeID":"ex"}"#;
    let client_source = format!(
        r#"{{"kind":"dots-client","anchorSessionID":"ses_anchor","bindingID":"binding","delegationID":"del","revision":1,"exchangeID":"ex","principal":{principal}}}"#
    );
    let native_source = r#"{"kind":"dots-native","profile":"fixture","credentialID":"credential","accountID":"account","accountGeneration":0,"environmentID":"environment","connectionID":"connection","clientID":"client","streamID":"stream","rootSessionID":"ses_anchor","accessRevision":3,"requestID":"request"}"#;
    let settled = |source: &str, target: &str, reply: &str| {
        format!(r#"{{"sessionID":"$S","source":{source},"target":{target},"reply":{reply}}}"#)
    };
    let unreplied = |source: &str, target: &str| {
        format!(r#"{{"sessionID":"$S","source":{source},"target":{target}}}"#)
    };
    let grant = r#"{"id":"delegation","revision":1,"basis":"device","anchorSessionID":"$S","bindingID":"binding","principal":PRINCIPAL,"scope":{"target":"device","operations":["task","decision"]},"expiresAt":9007199254740991,"active":true}"#.replace("PRINCIPAL", principal);
    let permission = r#"{"kind":"permission","requestID":"per_fixture","fingerprint":"$F"}"#;
    let review = r#"{"kind":"review","itemID":"rvw_fixture","fingerprint":"$F"}"#;
    [
        ("session.dots.exchange.created", exchange("")),
        (
            "session.dots.exchange.created",
            exchange(r#","groupID":"grp_fixture","ownerSessionID":"ses_owner""#),
        ),
        ("session.dots.exchange.created", exchange("").replacen("}}", &format!("}}{routine}}}"), 1)),
        ("session.dots.exchange.created", exchange("").replacen("}}", &format!("}}{delegated}}}"), 1)),
        (
            "session.dots.instruction.rejected",
            r#"{"sessionID":"$S","inputID":"msg_task","anchorSessionID":"ses_anchor","exchangeID":"ex","delegationID":"del","reason":"delegation_invalid"}"#.into(),
        ),
        (
            "session.dots.report.recorded",
            format!(
                r#"{{"sessionID":"$S","deliveryID":"delivery","messageID":"msg_report","text":"done","envelope":{},"callID":"call_report"}}"#,
                envelope("decision_request")
            ),
        ),
        (
            "session.tool.invocation-settled",
            r#"{"sessionID":"$S","assistantMessageID":"msg_wire_events","callID":"call_outer","invocation":{"id":"leaf_1","index":0,"name":"read","tool":"read","status":"completed"}}"#.into(),
        ),
        (
            "session.tool.invocation-settled",
            r#"{"sessionID":"$S","assistantMessageID":"msg_wire_events","callID":"call_outer","invocation":{"id":"leaf_2","index":4,"name":"shell","tool":"shell","status":"error","input":{"command":"false"},"structured":{"exit":1,"lines":[null,false,"x"]}}}"#.into(),
        ),
        ("session.dots.access.changed", r#"{"sessionID":"$S","enabled":true,"revision":7}"#.into()),
        (
            "session.dots.binding.bound",
            format!(r#"{{"sessionID":"$S","binding":{{"id":"binding","target":{target},"accountDigest":"digest"}}}}"#),
        ),
        ("session.dots.binding.unbound", r#"{"sessionID":"$S","bindingID":"binding"}"#.into()),
        (
            "session.dots.device-delegation.created",
            format!(r#"{{"sessionID":"$S","exchangeID":"exchange","fingerprint":"$F","grant":{grant}}}"#),
        ),
        (
            "session.dots.device-delegation.revoked",
            format!(r#"{{"sessionID":"$S","exchangeID":"exchange","fingerprint":"$F","delegationID":"delegation","revision":2,"principal":{principal}}}"#),
        ),
        ("session.dots.decision.settled", settled(delegation_source, permission, r#""once""#)),
        ("session.dots.decision.settled", settled(&client_source, r#"{"kind":"guardrail","requestID":"grq_fixture","fingerprint":"$F"}"#, r#""reject""#)),
        ("session.dots.decision.settled", unreplied(native_source, review)),
        ("session.dots.decision.settled", unreplied(native_source, r#"{"kind":"form","formID":"frm_fixture","fingerprint":"$F"}"#)),
        ("session.dots.decision.settled", unreplied(&client_source, r#"{"kind":"question","requestID":"que_fixture","fingerprint":"$F"}"#)),
        ("session.dots.decision.settled", unreplied(delegation_source, r#"{"kind":"subagent_question","questionID":"qst_fixture","fingerprint":"$F"}"#)),
    ]
    .into_iter()
    .map(|(kind, data)| (kind, data.replace("$S", session).replace("$F", &fingerprint)))
    .collect()
}

fn dots_entry(index: usize, session: &str, kind: &str, data: &str) -> Entry {
    let event = session_event::DurableEvent::decode(
        &parse_json(&format!(
            r#"{{"id":"evt_wire_dots_{index}","created":42,"type":"{kind}","durable":{{"aggregateID":"{session}","seq":{index},"version":1}},"data":{data}}}"#
        ))
        .unwrap(),
    )
    .unwrap_or_else(|error| panic!("{kind}: {error:?}"));
    Entry {
        seq: index as i64,
        version: 1,
        event,
    }
}

fn canonical(value: Domain) -> Domain {
    match value {
        Domain::List(items) => Domain::List(items.into_iter().map(canonical).collect()),
        Domain::Object(entries) => {
            let mut entries = entries
                .into_iter()
                .map(|(key, value)| (key, canonical(value)))
                .collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Domain::Object(entries)
        }
        other => other,
    }
}

#[test]
fn pending_controls_and_guardrail_closures_keep_their_durable_wire_fields() {
    for (kind, data, branch) in [
        (
            "session.input.withdrawn",
            r#"{"sessionID":"ses_controls","inputID":"msg_control"}"#,
            73,
        ),
        (
            "session.input.steered",
            r#"{"sessionID":"ses_controls","inputID":"msg_control"}"#,
            74,
        ),
        (
            "session.guardrail.decided",
            r#"{"sessionID":"ses_controls","reviewSessionID":"ses_controls","requestID":"grq_control","reply":"reject","ruleIDs":[],"reason":"cancelled"}"#,
            1,
        ),
        (
            "session.guardrail.decided",
            r#"{"sessionID":"ses_controls","reviewSessionID":"ses_controls","requestID":"grq_control","reply":"reject","ruleIDs":[],"reason":"expired"}"#,
            2,
        ),
    ] {
        let entry = dots_entry(1, "ses_controls", kind, data);
        let record = log::record(
            &entry,
            &session::Id::new("ses_controls").unwrap(),
            &"source-controls".into(),
        )
        .unwrap();
        match record.item.kind.unwrap() {
            v5::session_log_item::Kind::Value73(item) => {
                assert_eq!(branch, 73);
                assert_eq!(units(&item.data.session_id), "ses_controls");
                assert_eq!(units(&item.data.input_id), "msg_control");
            }
            v5::session_log_item::Kind::Value74(item) => {
                assert_eq!(branch, 74);
                assert_eq!(units(&item.data.session_id), "ses_controls");
                assert_eq!(units(&item.data.input_id), "msg_control");
            }
            v5::session_log_item::Kind::Value55(item) => assert_eq!(item.data.reason, Some(branch)),
            kind => panic!("unexpected projection: {kind:?}"),
        }
    }
}

fn projected_data(entry: &Entry, session: &str) -> (u32, String, Vec<u8>) {
    use v5::session_log_item::Kind;
    let record = log::record(
        entry,
        &session::Id::new(session).unwrap(),
        &LosslessString::from("source-epoch-test"),
    )
    .unwrap_or_else(|error| panic!("{:?}: {error:?}", entry.event.0.event_type));
    macro_rules! data {
        ($branch:literal, $item:ident, $data:ident) => {
            ($branch, v5::$data::full_name(), $item.data.encode_to_vec())
        };
    }
    match record.item.kind.expect("projected branch") {
        Kind::Value63(item) => data!(63, item, SessionLogItemValue63Data),
        Kind::Value64(item) => data!(64, item, SessionLogItemValue64Data),
        Kind::Value65(item) => data!(65, item, SessionLogItemValue65Data),
        Kind::Value66(item) => data!(66, item, SessionLogItemValue66Data),
        Kind::Value67(item) => data!(67, item, SessionLogItemValue67Data),
        Kind::Value68(item) => data!(68, item, SessionLogItemValue68Data),
        Kind::Value69(item) => data!(69, item, SessionLogItemValue69Data),
        Kind::Value70(item) => data!(70, item, SessionLogItemValue70Data),
        Kind::Value71(item) => data!(71, item, SessionLogItemValue71Data),
        Kind::Value72(item) => data!(72, item, SessionLogItemValue72Data),
        other => panic!("unexpected branch {other:?}"),
    }
}

#[test]
fn dots_and_invocation_events_project_every_source_variant_to_their_log_branch_without_loss() {
    let branches = [
        ("session.dots.exchange.created", 63),
        ("session.dots.instruction.rejected", 64),
        ("session.dots.report.recorded", 65),
        ("session.tool.invocation-settled", 66),
        ("session.dots.access.changed", 67),
        ("session.dots.binding.bound", 68),
        ("session.dots.binding.unbound", 69),
        ("session.dots.device-delegation.created", 70),
        ("session.dots.device-delegation.revoked", 71),
        ("session.dots.decision.settled", 72),
    ];
    let cases = dots_cases(SESSION);
    for (kind, _) in branches {
        assert!(cases.iter().any(|(name, _)| *name == kind), "{kind}");
    }
    for (index, (kind, data)) in cases.iter().enumerate() {
        let entry = dots_entry(index, SESSION, kind, data);
        let (branch, name, bytes) = projected_data(&entry, SESSION);
        assert_eq!(
            branch,
            branches.iter().find(|item| item.0 == *kind).unwrap().1,
            "{kind}"
        );
        assert_eq!(
            canonical(domain_json::decode(&name, &bytes).unwrap()),
            canonical(convert::json_domain(&entry.event.0.data.encode())),
            "{kind}/{index}"
        );
    }
}

fn without(entry: &mut Entry, key: &str) {
    let mut rebuilt = JsonObject::new();
    for (name, value) in entry.event.0.data.0.iter() {
        if name.as_str() != Some(key) {
            rebuilt.insert(name.clone(), value.clone());
        }
    }
    entry.event.0.data.0 = rebuilt;
}

fn within(entry: &mut Entry, outer: &str, key: &str, value: JsonValue) {
    let JsonValue::Object(mut inner) = entry.event.0.data.0.get(&outer.into()).unwrap().clone()
    else {
        panic!("{outer} must be an object")
    };
    inner.insert(key.into(), value);
    entry
        .event
        .0
        .data
        .0
        .insert(outer.into(), JsonValue::Object(inner));
}

#[test]
fn dots_and_invocation_events_reject_unmodeled_fields_and_values_instead_of_filtering_them() {
    let id = session::Id::new(SESSION).unwrap();
    let epoch = LosslessString::from("source-epoch-test");
    let cases = dots_cases(SESSION);
    let mutate = |kind: &str, change: &dyn Fn(&mut Entry)| {
        let index = cases.iter().position(|(name, _)| *name == kind).unwrap();
        let mut entry = dots_entry(index, SESSION, kind, &cases[index].1);
        assert!(log::record(&entry, &id, &epoch).is_ok(), "{kind}");
        change(&mut entry);
        assert!(log::record(&entry, &id, &epoch).is_err(), "{kind}");
    };
    for (kind, _) in &cases {
        if *kind != "session.tool.invocation-settled" {
            mutate(kind, &|entry| {
                entry
                    .event
                    .0
                    .data
                    .0
                    .insert("unmodeled".into(), JsonValue::Bool(true));
            });
        }
    }
    mutate("session.dots.instruction.rejected", &|entry| {
        entry
            .event
            .0
            .data
            .0
            .insert("reason".into(), JsonValue::String("other".into()));
    });
    mutate("session.dots.decision.settled", &|entry| {
        entry
            .event
            .0
            .data
            .0
            .insert("reply".into(), JsonValue::String("later".into()));
    });
    mutate("session.tool.invocation-settled", &|entry| {
        within(
            entry,
            "invocation",
            "status",
            JsonValue::String("pending".into()),
        );
    });
    mutate("session.tool.invocation-settled", &|entry| {
        within(entry, "invocation", "index", JsonValue::Number(-1.0));
    });
    mutate("session.tool.invocation-settled", &|entry| {
        without(entry, "callID");
    });
    mutate("session.dots.access.changed", &|entry| {
        without(entry, "revision");
    });
    mutate("session.dots.device-delegation.created", &|entry| {
        within(entry, "grant", "revision", JsonValue::Number(0.0));
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dots_and_invocation_events_reach_both_wire_operations_instead_of_closing_the_stream() {
    let _serial = SERIAL.lock().await;
    tokio::time::timeout(Duration::from_secs(60), async {
        let id = "ses_wire_dots";
        seed(id).await;
        let entries = dots_cases(id)
            .into_iter()
            .enumerate()
            .map(|(index, (kind, data))| dots_entry(index, id, kind, &data))
            .collect::<Vec<_>>();
        let epoch = LosslessString::from("source-epoch-test");
        let expected = entries
            .iter()
            .map(|entry| {
                log::record(entry, &session::Id::new(id).unwrap(), &epoch)
                    .unwrap()
                    .item
                    .encode_to_vec()
            })
            .collect::<Vec<_>>();
        let server = start(
            support::services(LocalAuth::disabled(), true),
            standard().unwrap(),
        )
        .await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let live = subscribe(&mut client, id, false, None, true).await;
        for (index, entry) in entries.iter().enumerate() {
            append(NewEvent {
                id: format!("evt_wire_dots_{index}").as_str().into(),
                aggregate_id: id.into(),
                created: 42,
                type_: format!(
                    "{}.{}",
                    entry.event.0.event_type.as_str().unwrap(),
                    entry.version
                )
                .as_str()
                .into(),
                data: entry.event.0.data.encode(),
            })
            .await;
        }
        let replay = subscribe(&mut client, id, true, None, false).await;
        until(&mut client, |client| {
            client.ended.contains(&replay) && durable_records(client, &live).len() >= entries.len()
        })
        .await;
        assert!(client.close.is_none(), "stream closed: {:?}", client.close);
        for sub in [&live, &replay] {
            let records = durable_records(&client, sub);
            assert_eq!(records.len(), entries.len(), "{sub}");
            for (index, (record, payload)) in records.iter().zip(expected.iter()).enumerate() {
                assert_eq!(record.event.type_name, v5::SessionLogItem::full_name());
                assert_eq!(record.event.payload, *payload, "{sub}/{index}");
                assert_eq!(record.event_id, format!("evt_wire_dots_{index}"));
                assert_eq!(record.durable.as_ref().unwrap().sequence, index as u64);
            }
        }
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
