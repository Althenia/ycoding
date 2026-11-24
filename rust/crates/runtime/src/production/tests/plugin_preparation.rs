use super::{alive, fixture};
use axum::{body::Bytes, extract::State, routing::post};
use std::{os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
use tokio::sync::mpsc;
use ycoding_core::{
    session::{pending, run_coordinator::Coordinator},
    ycoding_schema::{
        DomainDecode, JsonValue, event, parse_json, provider, session, session_message,
        session_pending, stringify_json,
    },
};

const MODULE: &str = r#"import { appendFileSync } from "node:fs"
export default {
  id: "fixture.preparation-module",
  setup: async (context) => {
    appendFileSync(new URL("./module-setup.log", import.meta.url), "setup\n")
    await context.session.hook("context", (event) => {
      event.system.push({ text: "genuine-module-context" })
    })
    await context.catalog.transform((draft) => {
      draft.provider.update("openai", (provider) => {
        provider.name = "Module prepared"
      })
    })
  },
}
"#;

const TOOL: &str = "data: {\"id\":\"preparation\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_preparation\",\"type\":\"function\",\"function\":{\"name\":\"demo_echo\",\"arguments\":\"{\\\"value\\\":\\\"original\\\"}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"preparation\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
const FINAL: &str = "data: {\"id\":\"prepared\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Mixed preparation completed\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"prepared\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

fn field<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    let JsonValue::Object(object) = value else {
        panic!("expected object for {key}")
    };
    object.get(&key.into()).unwrap()
}

async fn completion(
    State(requests): State<mpsc::UnboundedSender<JsonValue>>,
    body: Bytes,
) -> ([(&'static str, &'static str); 1], &'static str) {
    let request = parse_json(std::str::from_utf8(&body).unwrap()).unwrap();
    let JsonValue::Array(messages) = field(&request, "messages") else {
        panic!("provider messages must be an array")
    };
    let completed = messages
        .iter()
        .any(|message| field(message, "role") == &JsonValue::String("tool".into()));
    requests.send(request).unwrap();
    (
        [("content-type", "text/event-stream")],
        if completed { FINAL } else { TOOL },
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_process_callbacks_run_without_importing_legacy_modules() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let (requests, mut received) = mpsc::unbounded_channel::<JsonValue>();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new()
                .route("/v1/chat/completions", post(completion))
                .with_state(requests),
        )
        .await
        .unwrap();
    });
    let mut f = fixture(
        &format!(
            r#"{{"default_agent":"god","model":{{"providerID":"openai","model":"gpt-runtime"}},"efficiency":{{"title":"off"}},"providers":{{"openai":{{"name":"Fixture OpenAI","package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"baseURL":"{endpoint}","apiKey":"synthetic-key"}}}}}},"permissions":[{{"action":"extension.family","resource":"demo","effect":"allow"}},{{"action":"extension.echo","resource":"demo","effect":"allow"}}]}}"#
        ),
        "{}",
    );
    let directory = f.directory();
    let starts = directory.join("process-starts.log");
    let records = directory.join("callback-records.json");
    let frontend = f.roots.data.join("plugin-frontend");
    std::fs::write(&records, "[]").unwrap();
    std::fs::write(directory.join("mixed.mjs"), MODULE).unwrap();
    let launched = directory.join("frontend-launched");
    std::fs::write(
        &frontend,
        format!(
            "#!/bin/sh\nprintf started > '{}'\nexit 1\n",
            launched.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&frontend, std::fs::Permissions::from_mode(0o755)).unwrap();
    Arc::get_mut(&mut f.factory).unwrap().options.env.insert(
        crate::launch::FRONTEND_EXECUTABLE_KEY.into(),
        frontend.to_str().unwrap().into(),
    );
    let args = vec![
        "-c".to_owned(),
        "journal=$1; shift; printf '%s\\n' \"$$\" >> \"$journal\"; exec /usr/bin/python3 \"$@\""
            .to_owned(),
        "callback-process".to_owned(),
        starts.to_str().unwrap().to_owned(),
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../core/tests/extension_child.py"
        )
        .to_owned(),
        "family_callbacks_only".to_owned(),
        records.to_str().unwrap().to_owned(),
    ];
    let args = JsonValue::Array(
        args.into_iter()
            .map(|argument| JsonValue::String(argument.into()))
            .collect(),
    );
    std::fs::write(
        directory.join("ycoding.json"),
        r#"{"plugins":["./mixed.mjs"],"extensions":[{"identity":"callback-process","executable":"/bin/sh","args":__ARGS__,"grants":[{"family":"tools","namespace":"demo","tools":["echo"],"action":"extension.echo","resources":["demo"]},{"family":"hooks","scopes":["tool.execute.before","tool.execute.after","session.context"],"action":"extension.family","resources":["demo"]},{"family":"transforms","scopes":["agents","commands","references","skills","catalog","tools"],"action":"extension.family","resources":["demo"]},{"family":"registrations","scopes":["agents","commands","skills","catalog"],"action":"extension.family","resources":["demo"]},{"family":"events","scopes":["agent.updated"],"action":"extension.family","resources":["demo"]}]}]}"#
            .replace("__ARGS__", &stringify_json(&args)),
    )
    .unwrap();
    let locations = f.locations();
    let id = session::Id::new("ses_one").unwrap();
    let services = match locations.session(&id) {
        Ok((_, services)) => services,
        Err(error) => {
            locations.close().unwrap();
            f.factory.globals.close().await.unwrap();
            server.abort();
            assert!(server.await.unwrap_err().is_cancelled());
            panic!("mixed private preparation rejected: {error:?}");
        }
    };
    let composed = services.production.as_ref().unwrap();
    let diagnostics = format!("{:?}", composed.extension_diagnostics);
    let config_diagnostics = format!("{:?}", composed.configuration.diagnostics);
    let provider_name = composed
        .models
        .catalog()
        .provider(&provider::Id("openai".into()))
        .unwrap()
        .name
        .to_utf8()
        .unwrap();
    let starts_before = std::fs::read_to_string(&starts).unwrap();
    let pid = std::fs::read_to_string(directory.join("extension-child.pid"))
        .unwrap()
        .parse::<u32>()
        .unwrap();
    assert!(alive(pid));
    let input_event = event::Id::new("evt_mixed_preparation").unwrap();
    f.sessions()
        .admit_input(pending::Request {
            id: session_message::Id::from_event(&input_event),
            session_id: id.clone(),
            input: session_pending::Message::decode(
                &parse_json(r#"{"type":"user","delivery":"steer","data":{"text":"Execute the configured process echo once"}}"#).unwrap(),
            ).unwrap(),
            event_id: input_event,
            created: crate::ids::now_millis(),
        })
        .await
        .unwrap();
    let coordinator = Coordinator::new(Arc::new(composed.runner.clone()));
    let ran = tokio::time::timeout(Duration::from_secs(60), coordinator.run(&id)).await;
    let transcript = f.sessions().transcript(&id).unwrap();
    let bodies = std::iter::from_fn(|| received.try_recv().ok()).collect::<Vec<_>>();
    let starts_after = std::fs::read_to_string(&starts).unwrap();
    coordinator.shutdown().await.unwrap();
    composed.activation.close().await;
    drop(services);
    locations.close().unwrap();
    f.factory.globals.close().await.unwrap();
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
    ran.unwrap().unwrap();
    assert_eq!(diagnostics, "[]");
    assert_eq!(config_diagnostics, "[]");
    assert_eq!(provider_name, "Fixture OpenAI");
    assert!(!launched.exists());
    assert!(!directory.join("module-setup.log").exists());
    assert_eq!(starts_before, format!("{pid}\n"));
    assert_eq!(starts_after, starts_before);
    assert!(!alive(pid));
    assert_eq!(bodies.len(), 2, "one tool turn and one final turn");
    for body in &bodies {
        let messages = stringify_json(field(body, "messages"));
        assert!(!messages.contains("genuine-module-context"), "{messages}");
        assert!(messages.contains("system-B"), "{messages}");
        let JsonValue::Array(tools) = field(body, "tools") else {
            panic!("provider tools must be an array")
        };
        let definition = tools
            .iter()
            .map(|tool| field(tool, "function"))
            .find(|tool| field(tool, "name") == &JsonValue::String("demo_echo".into()))
            .unwrap();
        assert_eq!(
            field(definition, "description"),
            &JsonValue::String("Fixture toolB".into())
        );
    }
    let tools = transcript
        .iter()
        .filter_map(|message| match message {
            session_message::Info::Assistant(assistant) => Some(&assistant.content),
            _ => None,
        })
        .flatten()
        .filter_map(|part| match part {
            session_message::AssistantContent::Tool(tool) => Some(tool),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name.as_str(), Some("demo_echo"));
    assert_eq!(tools[0].id.as_str(), Some("call_preparation"));
    let session_message::ToolState::Completed(state) = &tools[0].state else {
        panic!("actual process tool did not complete: {:?}", tools[0].state)
    };
    assert_eq!(
        state.input.get(&"value".into()),
        Some(&JsonValue::String("original".into()))
    );
    assert_eq!(
        state.structured.get(&"value".into()),
        Some(&JsonValue::String("original".into()))
    );
    assert_eq!(
        state.structured.get(&"trace".into()),
        Some(&JsonValue::String("B".into()))
    );
    assert_eq!(
        state.structured.get(&"after".into()),
        Some(&JsonValue::String("B".into()))
    );
    assert!(transcript.iter().any(|message| match message {
        session_message::Info::Assistant(assistant) => assistant.content.iter().any(|part| {
            matches!(part, session_message::AssistantContent::Text(text) if text.text.as_str() == Some("Mixed preparation completed"))
        }),
        _ => false,
    }));
}
