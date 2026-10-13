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
        DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, parse_json, session,
        session_event,
    },
    ycoding_store::{
        KeyPart,
        session::{self as tables, NewEvent, SessionTable},
        tuple_key,
    },
};
use ycoding_protocol::{decode_strict, v5};
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
    assert_eq!(expected.len(), 51);
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
            let reply = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"Think\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).as_bytes()).await.unwrap();
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
        let runner = Local::new(Services {
            snapshots: None,
            store: Service::new(world().store.clone()), events: world().core.events.clone(), location: session.location,
            models: Arc::new(model::Resolver::new(catalog)), agents: Arc::new(agent::Service::new(vec![agent::empty("build".into())])),
            credentials: credential::Service::new(world().store.clone()), tools: registry,
            attachments: Arc::new(attachment_store::Store::new(root.join("attachments")).unwrap()), instructions: Vec::new(), analysis: None,
            clock: Arc::new(WallClock), executor: Arc::new(Executor::new(Executor::http_client().unwrap())),
            compaction: Default::default(), guardrails: location.guardrails.clone(), helpers: Default::default(), cursor: None, skill_resolver: None, claude: None, auth: None,
            configuration: None, image_analyzer: None, extensions: Vec::new(),
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
            assert!(ephemerals.iter().any(|event| matches!(event, Kind::SessionDiagnosticsUpdated(value) if value.data.diagnostics.context_breakdown.as_ref().is_some_and(|breakdown| breakdown.user > 0) && value.data.diagnostics.generation_speed.is_none())));
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
