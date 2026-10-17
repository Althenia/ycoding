use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use ycoding_ai::route::Executor;
use ycoding_core::{
    resources::{
        agent,
        catalog::{Catalog, models_dev},
        credential, decision, model,
    },
    session::{
        autonomy::Goal,
        goal,
        pending::Request,
        prompt_generator::{Input, Mode},
        store::Service,
        title,
    },
    tools::{
        code_mode::Cancellation,
        policy::helper::{Models, Settings, TitleMode},
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, ObjectEncoder, parse_json, session, session_message, session_pending,
    stringify_json, usage_anchor,
};
use ycoding_store::{
    IndexOrder, Store,
    session::{Append, NewEvent, append},
};

#[path = "session_support/generation.rs"]
mod generation;
#[path = "session_support/mod.rs"]
mod support;

use generation::{Fixture, Options, Reply};

type Ledger = ycoding_store::resources::Request;

const PROMPT: &str = "Fix failing build";
const DECISION: &str = r#"{"provider":"agent","request":{"state":{"action":"read"},"questions":[{"type":"choice","name":"route","instructions":"Choose based on evidence","choices":[{"value":"keep-current"},{"value":"review"}]}]}}"#;

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("operation did not finish within 30 seconds")
}

fn anchor(session: &str, input: &str) -> JsonValue {
    parse_json(&format!(
        r#"{{"sessionID":"{session}","inputID":"{input}"}}"#
    ))
    .unwrap()
}

fn ledger(store: &Store, session: &str, source: &str) -> Ledger {
    ycoding_store::resources::requests(
        &store.snapshot().unwrap(),
        &session.into(),
        IndexOrder::Ascending,
        None,
        100,
    )
    .unwrap()
    .into_iter()
    .map(|entry| entry.record)
    .find(|record| record.source.as_str() == Some(source))
    .unwrap_or_else(|| panic!("no {source} request recorded"))
}

fn recorded_anchor(record: &Ledger) -> Option<JsonValue> {
    record
        .usage_anchor
        .as_ref()
        .map(|anchor| anchor.value().clone())
}

async fn scripted(
    reply: (u16, String),
) -> (
    String,
    mpsc::UnboundedReceiver<JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (send, receive) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        let (status, reply) = reply;
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        let boundary = loop {
            let read = stream.read(&mut buffer).await.unwrap();
            assert!(read > 0);
            request.extend_from_slice(&buffer[..read]);
            if let Some(boundary) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                break boundary + 4;
            }
        };
        let header = std::str::from_utf8(&request[..boundary]).unwrap();
        let length = header
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|value| value.trim().parse::<usize>().unwrap())
            })
            .unwrap();
        while request.len() - boundary < length {
            let read = stream.read(&mut buffer).await.unwrap();
            assert!(read > 0);
            request.extend_from_slice(&buffer[..read]);
        }
        let body = parse_json(std::str::from_utf8(&request[boundary..boundary + length]).unwrap())
            .unwrap();
        send.send(body).unwrap();
        let response = format!(
            "HTTP/1.1 {status} Response\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
            reply.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    (address, receive, task)
}

fn reply(text: &str) -> (u16, String) {
    (
        200,
        format!(
            "data: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{}}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":3,\"completion_tokens\":2}}}}\n\ndata: [DONE]\n\n",
            stringify_json(&JsonValue::String(text.into()))
        ),
    )
}

#[derive(Clone, Copy)]
enum First {
    Admitted,
    CausedByAnotherSession,
    SeededWithoutAdmission,
}

struct World {
    store: Store,
    sessions: Service,
    title: title::Service,
    decision: decision::Service,
    requests: mpsc::UnboundedReceiver<JsonValue>,
    server: tokio::task::JoinHandle<()>,
}

async fn world(first: First) -> World {
    let store = support::store();
    let sessions = Service::new(store.client());
    let (endpoint, requests, server) = scripted(reply("Fix build")).await;
    let source =
        include_str!("../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json");
    let mut catalog = Catalog::new(models_dev::normalize(&parse_json(source).unwrap()).unwrap());
    catalog
        .configure(&[parse_json(&format!(
            r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#
        ))
        .unwrap()])
        .unwrap();
    let mut title_agent = agent::empty("title".into());
    title_agent.hidden = true;
    title_agent.system = Some("Generate one title".into());
    let mut decision_agent = agent::empty("decision".into());
    decision_agent.hidden = true;
    decision_agent.system = Some("Judge".into());
    let agents = Arc::new(agent::Service::new(vec![title_agent, decision_agent]));
    let models = Arc::new(Models {
        models: Arc::new(model::Resolver::new(catalog)),
        credentials: credential::Service::new(store.client()),
        auth: Default::default(),
        cursor: None,
        claude: None,
        store: sessions.clone(),
        settings: Settings {
            title_mode: TitleMode::Model,
            ..Default::default()
        },
    });
    let executor = Arc::new(Executor::new(Executor::http_client().unwrap()));
    let world = World {
        title: title::Service::new(
            sessions.clone(),
            agents.clone(),
            models.clone(),
            executor.clone(),
        ),
        decision: decision::Service {
            store: sessions.clone(),
            agents,
            models,
            executor,
        },
        store,
        sessions,
        requests,
        server,
    };
    world.first_prompt(first).await;
    world
}

impl World {
    async fn first_prompt(&self, first: First) {
        let id = session::Id::new("ses_one").unwrap();
        match first {
            First::SeededWithoutAdmission => {
                self.store
                    .submit(|tx| {
                        ycoding_store::session::MessageTable::insert(
                            tx,
                            &ycoding_store::session::Message {
                                id: "msg_first".into(),
                                session_id: "ses_one".into(),
                                type_: "user".into(),
                                seq: 1,
                                time_created: 1,
                                time_updated: 1,
                                data: parse_json(&format!(
                                    r#"{{"text":"{PROMPT}","time":{{"created":1,"consumed":1}}}}"#
                                ))
                                .unwrap(),
                            },
                        )
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
                return;
            }
            First::CausedByAnotherSession => {
                self.sessions
                    .admit_input(request("ses_two", "msg_origin", "evt_origin"))
                    .await
                    .unwrap();
            }
            First::Admitted => {}
        }
        let cause = matches!(first, First::CausedByAnotherSession)
            .then(|| usage_anchor::Ref::decode(&anchor("ses_two", "msg_origin")).unwrap());
        self.sessions
            .admit_input_attributed(request("ses_one", "msg_first", "evt_first"), cause)
            .await
            .unwrap();
        self.sessions.promote_steers(&id, 2).await.unwrap();
    }

    async fn title(&mut self) -> Ledger {
        let id = session::Id::new("ses_one").unwrap();
        let info = self.sessions.get(&id).unwrap().unwrap();
        within(
            self.title
                .generate_for_first_prompt(&info, &Cancellation::default()),
        )
        .await
        .unwrap();
        within(self.requests.recv()).await.unwrap();
        ledger(&self.store, "ses_one", "title")
    }

    async fn decision(&mut self) -> Ledger {
        let id = session::Id::new("ses_one").unwrap();
        let _ = within(self.decision.evaluate(
            &parse_json(DECISION).unwrap(),
            decision::Invocation {
                session_id: &id,
                input_id: None,
                attribution: ycoding_core::session::usage_attribution::Attribution::Unset,
                cancellation: &Cancellation::default(),
            },
        ))
        .await;
        within(self.requests.recv()).await.unwrap();
        ledger(&self.store, "ses_one", "decision")
    }
}

fn request(session: &str, input: &str, event: &str) -> Request {
    Request {
        id: session_message::Id::new(input).unwrap(),
        session_id: session::Id::new(session).unwrap(),
        input: session_pending::Message::decode(
            &ObjectEncoder::new()
                .field("type", "user")
                .field("data", &ObjectEncoder::new().field("text", PROMPT).finish())
                .field("delivery", "steer")
                .finish(),
        )
        .unwrap(),
        event_id: ycoding_schema::event::Id::new(event).unwrap(),
        created: 1,
    }
}

#[tokio::test]
async fn a_title_request_is_attributed_to_the_resolved_first_prompt() {
    for (first, expected) in [
        (First::Admitted, Some(anchor("ses_one", "msg_first"))),
        (
            First::CausedByAnotherSession,
            Some(anchor("ses_two", "msg_origin")),
        ),
        (First::SeededWithoutAdmission, None),
    ] {
        let mut world = world(first).await;
        assert_eq!(recorded_anchor(&world.title().await), expected);
        within(world.server).await.unwrap();
    }
}

#[tokio::test]
async fn a_decision_request_is_attributed_to_the_sessions_current_prompt_or_to_none() {
    for (first, expected) in [
        (First::Admitted, Some(anchor("ses_one", "msg_first"))),
        (
            First::CausedByAnotherSession,
            Some(anchor("ses_two", "msg_origin")),
        ),
        (First::SeededWithoutAdmission, None),
    ] {
        let mut world = world(first).await;
        assert_eq!(recorded_anchor(&world.decision().await), expected);
        within(world.server).await.unwrap();
    }
}

fn admit_seeded_user(f: &Fixture) {
    f.store
        .submit(|tx| {
            let appended = append(
                tx,
                &NewEvent {
                    id: "evt_anchor_user".into(),
                    aggregate_id: generation::SESSION.into(),
                    created: 5,
                    type_: "session.input.admitted.1".into(),
                    data: ObjectEncoder::new()
                        .field("sessionID", generation::SESSION)
                        .field("inputID", "msg_user")
                        .field(
                            "input",
                            &session_pending::Message::decode(
                                &parse_json(
                                    r#"{"type":"user","data":{"text":"Seeded"},"delivery":"steer"}"#,
                                )
                                .unwrap(),
                            )
                            .unwrap(),
                        )
                        .finish(),
                },
                None,
            )?;
            match appended {
                Append::Appended(_) => Ok(()),
                _ => Err(ycoding_store::Error::Rejected("duplicate admitted event")),
            }
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prediction_and_prompt_requests_are_attributed_at_entry() {
    within(async {
        for admitted in [false, true] {
            let expected = admitted.then(|| anchor("ses_one", "msg_user"));

            let f = Fixture::new(Options::default()).await;
            f.provider
                .reply(Reply::Text("Run the focused tests".into()));
            if admitted {
                admit_seeded_user(&f);
            }
            assert!(
                f.prediction()
                    .request(&f.id, ycoding_core::session::prediction::Input::default())
                    .await
                    .is_some()
            );
            assert_eq!(
                recorded_anchor(&ledger(&f.store, "ses_one", "prediction")),
                expected
            );

            let f = Fixture::new(Options::default()).await;
            f.provider.reply(Reply::Text(
                "Fix the build, keep the API, and run the tests.".into(),
            ));
            if admitted {
                admit_seeded_user(&f);
            }
            assert!(
                f.prompts()
                    .request(
                        &f.id,
                        Input {
                            mode: Mode::Steer,
                            intent: "Cover the regression".into(),
                            memory: vec![],
                        },
                    )
                    .await
                    .is_some()
            );
            assert_eq!(
                recorded_anchor(&ledger(&f.store, "ses_one", "prompt")),
                expected
            );
        }
    })
    .await;
}

#[tokio::test]
async fn a_goal_request_is_attributed_at_entry() {
    within(async {
        for admitted in [false, true] {
            let f = Fixture::new(Options {
                goal: true,
                ..Options::default()
            })
            .await;
            f.provider
                .reply(Reply::Text("Inspect the migration next.".into()));
            if admitted {
                admit_seeded_user(&f);
            }
            let agents = Arc::new(agent::Service::new(vec![goal::agent()]));
            let generate = Arc::new(generation::local_with_settings(
                &f.store,
                &f.provider.address,
                Settings::default(),
            ));
            let serving = f.dependencies.location.clone();
            let service = goal::Service::new(
                f.sessions.clone(),
                Arc::new(move |location| {
                    (location == &serving).then(|| goal::Environment {
                        location: serving.clone(),
                        agents: agents.clone(),
                        generate: generate.clone(),
                    })
                }),
            );
            let session = f.sessions.get(&f.id).unwrap().unwrap();
            service
                .start(
                    &session,
                    &Goal::new("Finish the migration", None, None),
                    &Cancellation::default(),
                )
                .await
                .unwrap();
            assert_eq!(
                recorded_anchor(&ledger(&f.store, "ses_one", "goal")),
                admitted.then(|| anchor("ses_one", "msg_user"))
            );
        }
    })
    .await;
}
