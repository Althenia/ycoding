mod support;

use prost::Message;
use std::time::Duration;
use support::{Client, services, session_scope, start, world};
use ycoding_core::event_feed::{Data, Ephemeral};
use ycoding_core::ycoding_schema::DomainDecode;
use ycoding_core::ycoding_schema::{
    JsonObject, JsonValue, LosslessString, ObjectDecoder, location, parse_json,
};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn fixtures() -> Vec<(Ephemeral, v5::PublicEvent)> {
    let fixture = parse_json(include_str!("ephemeral_events/expectations.json")).unwrap();
    let path = Default::default();
    ObjectDecoder::new(&fixture, &path)
        .unwrap()
        .field::<Vec<JsonValue>>("cases")
        .unwrap()
        .into_iter()
        .map(|case| {
            let case = ObjectDecoder::new(&case, &path).unwrap();
            let event = case.field::<JsonValue>("event").unwrap();
            let event = ObjectDecoder::new(&event, &path).unwrap();
            let kind = case.field::<LosslessString>("type").unwrap();
            let data = Data::decode(
                kind.as_str().unwrap(),
                &event.field::<JsonValue>("data").unwrap(),
            )
            .unwrap();
            let input = Ephemeral {
                id: event.field("id").unwrap(),
                created: 42,
                session: data.session().unwrap(),
                data,
                location: event.optional::<location::Ref>("location").unwrap(),
                metadata: event.optional::<JsonObject>("metadata").unwrap(),
            };
            let expected = case.field::<LosslessString>("hex").unwrap();
            let bytes = expected
                .as_str()
                .unwrap()
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect::<Vec<_>>();
            (input, v5::PublicEvent::decode(bytes.as_slice()).unwrap())
        })
        .collect()
}

async fn subscribe(client: &mut Client, scope: v5::Scope) -> String {
    let request = client
        .send(
            "event.subscribe",
            global(),
            v5::EventSubscribeRequest {
                scope: scope.clone(),
            }
            .encode_to_vec(),
        )
        .await;
    client.subscribe_events(&request, scope).await
}

fn global() -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Global(v5::Empty {})),
    }
}

async fn until(client: &mut Client, done: impl Fn(&Client) -> bool) {
    while !done(client) {
        client.step().await;
    }
}

fn publications(client: &Client, subscription: &str) -> Vec<v5::public_event::Kind> {
    client
        .batches
        .iter()
        .filter(|batch| batch.subscription_id == subscription)
        .flat_map(|batch| &batch.events)
        .filter(|record| record.durable.is_none())
        .map(|record| {
            v5::PublicEvent::decode(record.event.payload.as_slice())
                .unwrap()
                .kind
                .unwrap()
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn all_ephemerals_cross_real_subscription_with_global_and_session_filtering() {
    let _serial = SERIAL.lock().await;
    tokio::time::timeout(Duration::from_secs(60), async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let global = subscribe(&mut client, global()).await;
        let own = subscribe(&mut client, session_scope("ses_prompt")).await;
        let fixtures = fixtures();
        let own_count = fixtures
            .iter()
            .filter(|(input, _)| input.session.is_some())
            .count();
        for (input, _) in &fixtures {
            world().core.events.publish(input.clone());
        }
        until(&mut client, |client| {
            client
                .batches
                .iter()
                .filter(|batch| batch.subscription_id == global)
                .map(|batch| batch.events.len())
                .sum::<usize>()
                == fixtures.len()
                && client
                    .batches
                    .iter()
                    .filter(|batch| batch.subscription_id == own)
                    .map(|batch| batch.events.len())
                    .sum::<usize>()
                    == own_count
        })
        .await;
        for (subscription, own_only) in [(&global, false), (&own, true)] {
            let records = client
                .batches
                .iter()
                .filter(|batch| &batch.subscription_id == subscription)
                .flat_map(|batch| &batch.events)
                .collect::<Vec<_>>();
            let expected = fixtures
                .iter()
                .filter(|(input, _)| !own_only || input.session.is_some())
                .collect::<Vec<_>>();
            assert_eq!(records.len(), expected.len());
            for (record, (input, expected)) in records.iter().zip(expected) {
                assert_eq!(record.event_id, input.id.as_str().unwrap());
                assert_eq!(record.created_ms, 42);
                assert!(record.durable.is_none());
                let public = v5::PublicEvent::decode(record.event.payload.as_slice()).unwrap();
                assert_eq!(
                    std::mem::discriminant(public.kind.as_ref().unwrap()),
                    std::mem::discriminant(expected.kind.as_ref().unwrap()),
                    "{}",
                    input.data.name()
                );
            }
        }
        let request = client
            .send(
                "event.unsubscribe",
                self::global(),
                v5::EventUnsubscribeRequest {
                    subscription_id: global.clone(),
                }
                .encode_to_vec(),
            )
            .await;
        assert!(matches!(
            client.settle(&request).await,
            ycoding_protocol::connection::Outcome::Success { .. }
        ));
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quota_pace_milestones_cross_the_real_wire_without_becoming_session_events() {
    let _serial = SERIAL.lock().await;
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let global = subscribe(&mut client, global()).await;
        let own = subscribe(&mut client, session_scope("ses_prompt")).await;
        let milestones = [
            (
                "almost-out",
                "Almost out",
                "Less than 10% of this quota remains.",
            ),
            (
                "cutting-it-close",
                "Cutting it close",
                "Projected quota use exceeds 90% of its limit at reset.",
            ),
            (
                "will-run-out",
                "Will run out",
                "Quota use is at its limit or projected to exceed it before reset.",
            ),
        ];
        for (milestone, title, body) in milestones {
            let mut data = JsonObject::new();
            for (key, value) in [
                ("providerID", JsonValue::String("anthropic".into())),
                ("windowID", JsonValue::String("five-hour".into())),
                ("milestone", JsonValue::String(milestone.into())),
                ("resetAt", JsonValue::Number(1_800_000_300_000.0)),
                ("title", JsonValue::String(title.into())),
                ("body", JsonValue::String(body.into())),
            ] {
                data.insert(key.into(), value);
            }
            world()
                .core
                .events
                .emit(
                    Data::decode("provider.quota.pace", &JsonValue::Object(data)).unwrap(),
                    None,
                )
                .unwrap();
        }
        until(&mut client, |client| {
            publications(client, &global)
                .iter()
                .filter(|event| matches!(event, v5::public_event::Kind::ProviderQuotaPace(_)))
                .count()
                == milestones.len()
        })
        .await;
        let events = publications(&client, &global)
            .into_iter()
            .filter_map(|event| match event {
                v5::public_event::Kind::ProviderQuotaPace(event) => Some(event),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(events.len(), milestones.len());
        for (index, event) in events.iter().enumerate() {
            assert!(event.location.is_none());
            assert_eq!(support::units(&event.data.provider_id), "anthropic");
            assert_eq!(support::units(&event.data.window_id), "five-hour");
            assert_eq!(event.data.milestone, index as i32 + 1);
            assert_eq!(event.data.reset_at, 1_800_000_300_000);
            assert_eq!(support::units(&event.data.title), milestones[index].1);
            assert_eq!(support::units(&event.data.body), milestones[index].2);
        }
        assert!(publications(&client, &own).is_empty());
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resource_owner_transitions_publish_to_the_real_wire_before_returning() {
    let _serial = SERIAL.lock().await;
    use ycoding_core::resources::{agent, catalog, command, skill};
    use ycoding_core::ycoding_schema::{
        model,
        schema::AbsolutePath,
        skill::{DirectorySource, Source},
    };
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let global = subscribe(&mut client, global()).await;
        let own = subscribe(&mut client, session_scope("ses_prompt")).await;
        let location = location::Ref {
            directory: AbsolutePath::new("/project").unwrap(),
            workspace_id: None,
        };
        let mut agents = agent::Service::new(vec![agent::empty("build".into())]);
        agents
            .event_source
            .bind(world().core.events.clone(), Some(location.clone()))
            .unwrap();
        agents.update("build".into(), |info| {
            info.description = Some("updated".into())
        });
        let mut commands = command::Service::default();
        commands
            .event_source
            .bind(world().core.events.clone(), Some(location.clone()))
            .unwrap();
        commands.update("fixture".into(), |info| info.template = "updated".into());
        let mut skills = skill::Service::new(std::path::Path::new("/project/cache"));
        skills
            .event_source
            .bind(world().core.events.clone(), Some(location.clone()))
            .unwrap();
        skills.source(Source::Directory(DirectorySource {
            path: AbsolutePath::new("/project/skills").unwrap(),
        }));
        let mut catalog = catalog::Catalog::default();
        catalog
            .event_source
            .bind(world().core.events.clone(), Some(location.clone()))
            .unwrap();
        catalog.set_default(Some(model::Ref {
            provider_id: ycoding_core::ycoding_schema::provider::Id("fixture".into()),
            id: "fixture".into(),
            variant: None,
            profile: None,
        }));
        let integration = ycoding_core::resources::auth::integration::Registry::new(
            world().core.credentials.clone(),
            Default::default(),
        );
        integration
            .bind_events(world().core.events.clone(), None)
            .unwrap();
        integration.reload().unwrap();
        let mut references = ycoding_core::resources::reference::Service::from_infos(Vec::new());
        references
            .event_source
            .bind(world().core.events.clone(), Some(location.clone()))
            .unwrap();
        references.replace(Vec::new()).unwrap();
        let registration = integration
            .transform(|draft| {
                draft.method(
                    "ephemeral-fixture".into(),
                    ycoding_core::ycoding_schema::integration::Method::Key(
                        ycoding_core::ycoding_schema::integration::KeyMethod {
                            label: Some("Key".into()),
                        },
                    ),
                )
            })
            .unwrap();
        integration
            .login_key(
                "ephemeral-fixture".into(),
                None,
                "synthetic-test-key".into(),
                42,
            )
            .await
            .unwrap();
        until(&mut client, |client| {
            publications(client, &global).len() >= 9
        })
        .await;
        let kinds = client
            .batches
            .iter()
            .filter(|batch| batch.subscription_id == global)
            .flat_map(|batch| &batch.events)
            .map(|record| {
                assert!(record.durable.is_none());
                v5::PublicEvent::decode(record.event.payload.as_slice())
                    .unwrap()
                    .kind
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert!(
            kinds
                .iter()
                .any(|kind| matches!(kind, v5::public_event::Kind::AgentUpdated(_)))
        );
        assert!(
            kinds
                .iter()
                .any(|kind| matches!(kind, v5::public_event::Kind::CommandUpdated(_)))
        );
        assert!(
            kinds
                .iter()
                .any(|kind| matches!(kind, v5::public_event::Kind::SkillUpdated(_)))
        );
        assert!(
            kinds
                .iter()
                .any(|kind| matches!(kind, v5::public_event::Kind::CatalogUpdated(_)))
        );
        assert!(
            kinds
                .iter()
                .any(|kind| matches!(kind, v5::public_event::Kind::IntegrationUpdated(_)))
        );
        assert!(
            kinds
                .iter()
                .any(|kind| matches!(kind, v5::public_event::Kind::ReferenceUpdated(_)))
        );
        let v5::public_event::Kind::IntegrationConnectionUpdated(connection) = &kinds[7] else {
            panic!("connection change precedes registry update");
        };
        assert_eq!(
            support::units(&connection.data.integration_id),
            "ephemeral-fixture"
        );
        assert!(connection.location.is_none());
        assert!(publications(&client, &own).is_empty());
        drop(registration);
        integration.shutdown().await.unwrap();
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policy_producers_deliver_ordered_session_events_and_location_owned_global_forms() {
    let _serial = SERIAL.lock().await;
    use ycoding_core::ycoding_schema::{form, guardrail, permission, question, session};
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let global = subscribe(&mut client, global()).await;
        let own = subscribe(&mut client, session_scope("ses_prompt")).await;
        let other = subscribe(&mut client, session_scope("ses_other")).await;
        let session = session::Id::new("ses_prompt").unwrap();
        let (_, services) = world().core.locations.session(&session).unwrap();
        let request = permission::Request::decode(&parse_json(r#"{"id":"per_ephemeral_producer","sessionID":"ses_prompt","action":"fixture","resources":["resource"]}"#).unwrap()).unwrap();
        let admission = services.permissions.ask(request.clone(), None).unwrap();
        services.permissions.reply(&request.id, permission::Reply("once".into()), None).unwrap();
        admission.wait.unwrap().await.unwrap().unwrap();
        for (id, reject) in [("que_ephemeral_answer", false), ("que_ephemeral_reject", true)] {
            let request = question::Request::decode(&parse_json(&format!(r#"{{"id":"{id}","sessionID":"ses_prompt","questions":[{{"question":"Continue?","header":"Fixture","options":[{{"label":"Yes","description":"Continue"}}]}}]}}"#)).unwrap()).unwrap();
            let admission = services.questions.ask(request.clone()).unwrap();
            if reject { services.questions.reject(&request.id).unwrap(); }
            if !reject { services.questions.reply(&request.id, vec![vec!["Yes".into()]]).unwrap(); }
            let ycoding_core::tools::policy::questions::Admission::Pending(wait) = admission else { panic!("manual question must wait"); };
            assert_eq!(wait.await.unwrap().is_err(), reject);
        }
        for (id, owner, cancel) in [("frm_ephemeral_answer", "ses_prompt", false), ("frm_ephemeral_cancel", "ses_prompt", true), ("frm_ephemeral_global", "global", false)] {
            let input = form::Info::decode(&parse_json(&format!(r#"{{"id":"{id}","sessionID":"{owner}","title":"Fixture","fields":[{{"key":"ok","type":"boolean"}}]}}"#)).unwrap()).unwrap();
            let wait = services.forms.ask(input.clone()).unwrap();
            if cancel { services.forms.cancel(&input.id).unwrap(); }
            if !cancel { services.forms.reply(&input.id, form::Answer::decode(&parse_json(r#"{"ok":true}"#).unwrap()).unwrap()).unwrap(); }
            wait.await.unwrap();
        }
        let input = |resources| ycoding_core::process::guardrails::Input { session_id: session.clone(), action: "shell".into(), resources, metadata: None, skip_review: false, holder: None, source: None };
        let allowed = services.guardrails.assert(input(vec!["pwd".into()])).unwrap();
        allowed.reservation.unwrap().release();
        let review = services.guardrails.assert(input(vec!["rm -rf /project".into()])).unwrap();
        let request = review.request.unwrap();
        services.guardrails.reply(&session, &request.id, guardrail::Reply::Reject).unwrap();
        assert!(review.wait.unwrap().await.unwrap().is_err());
        until(&mut client, |client| publications(client, &global).len() == 15 && publications(client, &own).len() == 13).await;
        assert!(publications(&client, &other).is_empty());
        let events = publications(&client, &global);
        use v5::public_event::Kind;
        assert!(matches!(&events[0], Kind::PermissionAsked(event) if event.data.id == support::text("per_ephemeral_producer") && event.location.as_ref().is_some_and(|location| support::units(&location.directory) == "/project")));
        assert!(matches!(&events[1], Kind::PermissionReplied(event) if event.data.reply == 1));
        assert!(matches!(&events[2], Kind::QuestionAsked(_)));
        assert!(matches!(&events[3], Kind::QuestionReplied(event) if support::units(&event.data.answers.items[0].items[0]) == "Yes"));
        assert!(matches!(&events[5], Kind::QuestionRejected(_)));
        assert!(matches!(&events[6], Kind::FormCreated(_)));
        assert!(matches!(&events[7], Kind::FormReplied(_)));
        assert!(matches!(&events[9], Kind::FormCancelled(_)));
        assert!(matches!(&events[10], Kind::FormCreated(event) if support::units(&event.data.form.session_id) == "global" && event.location.as_ref().is_some_and(|location| support::units(&location.directory) == "/project")));
        assert!(matches!(&events[11], Kind::FormReplied(event) if support::units(&event.data.session_id) == "global"));
        assert!(matches!(&events[12], Kind::GuardrailDecided(event) if event.data.decision == 1));
        assert!(matches!(&events[13], Kind::GuardrailAsked(event) if event.data.hard_review == Some(true)));
        assert!(matches!(&events[14], Kind::GuardrailReplied(event) if event.data.reply == 3));
        server.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_platform_and_models_producers_cross_global_and_session_subscriptions() {
    let _serial = SERIAL.lock().await;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use ycoding_core::ycoding_schema::{pty::UpdateInput, schema::AbsolutePath};
    use ycoding_core::{
        platform::{filesystem::watcher, git, pty, shell},
        resources::{
            catalog::models_dev,
            config::{Configuration, LoadOptions, Roots},
        },
    };
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let global = subscribe(&mut client, global()).await;
        let own = subscribe(&mut client, session_scope("ses_prompt")).await;
        let root = std::env::temp_dir().join(format!("ycoding-ephemeral-native-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let roots = Roots::development(&root).unwrap();
        let location = location::Ref { directory: AbsolutePath::new(root.to_str().unwrap()).unwrap(), workspace_id: None };
        let mut config = Configuration::load(LoadOptions { directory: root.clone(), roots: roots.clone(), project: false, file: None, content: Some(r#"{"shell":"/bin/sh"}"#.into()), env: Default::default() }).unwrap();
        config.event_source.bind(world().core.events.clone(), Some(location.clone())).unwrap();
        config.reload().unwrap();
        let shell = shell::Shell::new(&roots, root.clone(), "prj_ephemeral", world().store.clone()).await.unwrap();
        shell.event_source.bind(world().core.events.clone(), Some(location.clone())).unwrap();
        let mut prepared = shell.prepare(ycoding_core::ycoding_schema::shell::CreateInput::decode(&parse_json(r#"{"command":"printf native","timeout":0}"#).unwrap()).unwrap(), &config).unwrap();
        let created = shell.create(&mut prepared).await.unwrap();
        assert!(created.pid.is_some());
        let settled = shell.wait(&created.id).await.unwrap();
        assert_eq!(settled.status, ycoding_core::ycoding_schema::shell::Status::Exited);
        assert_eq!(settled.exit.map(|exit| exit.get()), Some(0.0));
        shell.remove(&created.id).await.unwrap();
        let pty = pty::Pty::new(root.clone());
        pty.event_source.bind(world().core.events.clone(), Some(location.clone())).unwrap();
        let created = pty.create(ycoding_core::ycoding_schema::pty::CreateInput::decode(&parse_json(r#"{"sessionID":"ses_prompt","command":"/bin/sh","args":["-c","printf pty"]}"#).unwrap()).unwrap(), Some(&config)).await.unwrap();
        let updated = pty.update(&created.id, UpdateInput::decode(&parse_json(&format!(r#"{{"sessionID":"ses_prompt","generation":{},"expectedFence":{},"actor":"agent","title":"Updated"}}"#, created.generation.get(), created.control.fence.get())).unwrap()).unwrap()).await.unwrap();
        assert_eq!(updated.title.as_str(), Some("Updated"));
        pty.wait(&created.id, &created.session_id).await.unwrap();
        pty.remove(&created.id, &created.session_id).await.unwrap();
        let native_watcher = watcher::Service::new(true);
        let mut watched = watcher::LocationWatcher::start(&native_watcher, &git::Service::new(1024 * 1024), &root, &root.join("home"), "darwin", true, &[]).unwrap();
        watched.event_source.bind(world().core.events.clone(), Some(location.clone())).unwrap();
        let path = root.join("visible.txt");
        std::fs::write(&path, "native").unwrap();
        loop { if watched.recv().await.unwrap().file.as_str() == path.to_str() { break; } }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let provider = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(stream.read(&mut bytes).await.unwrap() > 0);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
        });
        let models = models_dev::Service::new(models_dev::Options { source: endpoint, cache: root.join("models.json"), file: None, bundled: None, fetch: false, user_agent: "ycoding/test".into() }).unwrap();
        models.event_source.bind(world().core.events.clone(), None).unwrap();
        assert!(models.refresh(true).await.unwrap());
        provider.await.unwrap();
        until(&mut client, |client| publications(client, &global).iter().any(|event| matches!(event, v5::public_event::Kind::ModelsDevRefreshed(_))) && publications(client, &own).len() == 2).await;
        use v5::public_event::Kind;
        let events = publications(&client, &global);
        assert!(matches!(events[0], Kind::ConfigUpdated(_)));
        assert!(matches!(&events[1], Kind::ShellCreated(event) if event.data.info.pid.is_some() && event.location.as_ref().is_some_and(|info| support::units(&info.directory) == root.to_str().unwrap())));
        assert!(matches!(&events[2], Kind::ShellExited(event) if event.data.status == 2 && event.data.exit == Some(0.0)));
        assert!(matches!(events[3], Kind::ShellDeleted(_)));
        assert!(events.iter().any(|event| matches!(event, Kind::PtyExited(value) if value.data.exit_code == 0 && value.data.reason == 1)));
        assert!(events.iter().any(|event| matches!(event, Kind::PtyDeleted(_))));
        assert!(events.iter().any(|event| matches!(event, Kind::FilesystemChanged(value) if support::units(&value.data.file) == path.to_str().unwrap() && value.data.event == 1)));
        assert!(matches!(&publications(&client, &own)[0], Kind::PtyCreated(_)));
        assert!(matches!(&publications(&client, &own)[1], Kind::PtyUpdated(value) if support::units(&value.data.info.title) == "Updated"));
        drop(watched);
        pty.shutdown().await.unwrap();
        shell.shutdown().await.unwrap();
        server.shutdown().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_lifecycle_publishes_status_resources_and_command_updates_on_the_real_wire() {
    let _serial = SERIAL.lock().await;
    use ycoding_core::resources::mcp::{Service, client::Hooks};
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let global = subscribe(&mut client, global()).await;
        let own = subscribe(&mut client, session_scope("ses_prompt")).await;
        let root = std::env::temp_dir().join(format!("ycoding-ephemeral-mcp-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let location = location::Ref::decode(&parse_json(r#"{"directory":"/project"}"#).unwrap()).unwrap();
        let source = ycoding_core::event_feed::EventSource::default();
        source.bind(world().core.events.clone(), Some(location.clone())).unwrap();
        let script = "import sys,json\nfor line in sys.stdin:\n q=json.loads(line)\n if 'id' not in q: continue\n m=q['method']\n r={'protocolVersion':'2025-11-25','capabilities':{'tools':{},'prompts':{},'resources':{}},'serverInfo':{'name':'fixture','version':'1'}} if m=='initialize' else {'tools':[]} if m=='tools/list' else {'prompts':[]} if m=='prompts/list' else {'resources':[]} if m=='resources/list' else {}\n print(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':r}),flush=True)\n";
        let entries = [ycoding_core::resources::config::Entry::Document { path: None, info: parse_json(&format!(r#"{{"mcp":{{"servers":{{"fixture":{{"type":"local","command":["/usr/bin/python3","-u","-c",{}]}}}}}}}}"#, ycoding_core::ycoding_schema::stringify_json(&JsonValue::String(script.into())))).unwrap() }];
        let service = Service::new(&entries, root.clone(), "fixture".into(), Default::default(), Hooks { event_source: source, ..Hooks::default() }).unwrap();
        service.bind_events(world().core.events.clone(), Some(location.clone())).unwrap();
        service.bind_events(world().core.events.clone(), Some(location)).unwrap();
        assert!(service.bind_events(world().core.events.clone(), None).is_err());
        assert!(service.tools().await.unwrap().is_empty());
        until(&mut client, |client| publications(client, &global).iter().any(|event| matches!(event, v5::public_event::Kind::CommandUpdated(_)))).await;
        let connected = publications(&client, &global);
        assert!(connected.iter().any(|event| matches!(event, v5::public_event::Kind::McpStatusChanged(value) if support::units(&value.data.server) == "fixture" && value.location.as_ref().is_some_and(|location| support::units(&location.directory) == "/project"))));
        assert!(connected.iter().any(|event| matches!(event, v5::public_event::Kind::McpResourcesChanged(value) if support::units(&value.data.server) == "fixture")));
        service.disconnect("fixture").await.unwrap();
        until(&mut client, |client| publications(client, &global).len() > connected.len()).await;
        assert!(publications(&client, &own).is_empty());
        service.shutdown().await.unwrap();
        server.shutdown().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_directory_forget_publishes_after_storage_change_and_only_to_global_scope() {
    let _serial = SERIAL.lock().await;
    use ycoding_core::ycoding_store::project::{Directory, DirectoryTable};
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let global = subscribe(&mut client, global()).await;
        let own = subscribe(&mut client, session_scope("ses_prompt")).await;
        world().store.submit(|tx| tx.put::<DirectoryTable>(&Directory {
            project_id: "prj_one".into(), directory: "/project/ephemeral-forget".into(), type_: Some("copy".into()), strategy: None, time_created: 42,
        })).unwrap().await.unwrap();
        let request = v5::ProjectForgetRequest { params: v5::ProjectForgetRequestParams { project_id: support::text("prj_one") }, payload: v5::ProjectForgetRequestPayload { directory: support::text("/project/ephemeral-forget") } };
        let _: v5::ProjectForgetResult = support::wire::ask(&mut client, "project.forget", support::machine(), request.clone()).await;
        until(&mut client, |client| !publications(client, &global).is_empty()).await;
        let events = publications(&client, &global);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], v5::public_event::Kind::ProjectDirectoriesUpdated(value) if support::units(&value.data.project_id) == "prj_one" && value.location.is_none()));
        assert!(publications(&client, &own).is_empty());
        let _: v5::ProjectForgetResult = support::wire::ask(&mut client, "project.forget", support::machine(), request).await;
        assert_eq!(publications(&client, &global).len(), 1);
        server.shutdown().await.unwrap();
    }).await.unwrap();
}
