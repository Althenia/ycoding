include!("tool_fixture.rs");
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, path::Path, sync::Arc, time::Duration};
use ycoding_ai::{llm, route::Route};
use ycoding_core::extension::{Error, Extension, Host, Launch, Options, PluginRuntime, plugin};
use ycoding_schema::{DomainDecode, model, parse_json, provider};

const HOST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/cli/src/plugin-host/main.ts"
);
const WATCHDOG: Duration = Duration::from_secs(60);

fn runtime(root: &Path) -> PluginRuntime {
    let bun = String::from_utf8(
        std::process::Command::new("sh")
            .args(["-c", "command -v bun"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    assert!(!bun.is_empty(), "the plugin host integration requires bun");
    let executable = root.join("frontend");
    std::fs::write(
        &executable,
        format!("#!/bin/sh\nexec '{bun}' '{HOST}' \"$@\"\n"),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    PluginRuntime {
        executable,
        args: vec!["plugin-host".into()],
        cache: root.join("cache/ycoding/plugins"),
        setup: Duration::from_secs(30),
    }
}

async fn start(fixture: &ToolFixture, source: &str) -> Extension {
    let path = fixture.root.join("context-plugin.mjs");
    std::fs::write(&path, source).unwrap();
    let launched = plugin::launch(
        path.to_str().unwrap().to_owned(),
        parse_json("{}").unwrap(),
        fixture.root.clone(),
        &runtime(&fixture.root),
    );
    tokio::time::timeout(
        WATCHDOG,
        Extension::start_plugin(
            launched,
            Options {
                startup: Duration::from_secs(5),
                execution: Duration::from_secs(20),
                cleanup: Duration::from_secs(2),
                shutdown: Duration::from_secs(2),
                write: Duration::from_secs(5),
            },
            &fixture.registry(),
            fixture.policy.clone(),
            &Launch::default(),
            Host::default(),
        ),
    )
    .await
    .unwrap()
    .unwrap()
    .expect("an unrestricted plugin is admitted")
}

fn selection() -> model::Ref {
    model::Ref::decode(&parse_json(r#"{"providerID":"openai","id":"gpt-test"}"#).unwrap()).unwrap()
}

fn request(messages: Vec<llm::Message>) -> llm::Request {
    let mut request = llm::Request::new(llm::Model {
        id: "gpt-test".into(),
        provider: provider::Id("openai".into()),
        route: Arc::new(Route::openai_chat()),
        defaults: Default::default(),
        tool_schema: None,
        supports_temperature: true,
    });
    request.system = vec!["System".into()];
    request.messages = messages;
    request.tools = vec![llm::ToolDefinition {
        name: "echo".into(),
        description: "Echo".into(),
        input_schema: parse_json(r#"{"type":"object"}"#).unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }];
    request
}

fn user(id: Option<&str>, text: &str) -> llm::Message {
    let mut message = llm::Message::user(text);
    message.id = id.map(Into::into);
    message
}

async fn prepare(
    fixture: &ToolFixture,
    extension: &Extension,
    request: &llm::Request,
) -> Result<llm::Request, Error> {
    tokio::time::timeout(
        WATCHDOG,
        ycoding_core::extension::context::prepare(
            request,
            &selection(),
            Some("route-test"),
            &fixture.context(),
            &[extension],
        ),
    )
    .await
    .unwrap()
}

fn texts(message: &llm::Message) -> Vec<String> {
    message
        .content
        .iter()
        .map(|part| match part {
            llm::Part::Text(text) => text.text.as_str().unwrap().to_owned(),
            other => panic!("expected a text part, got {other:?}"),
        })
        .collect()
}

const OBSERVE: &str = r#"
export default {
  id: "fixture",
  setup: async (ctx) => {
    await ctx.session.hook("context", (event) => {
      const seen = JSON.stringify({
        keys: Object.keys(event).sort(),
        system: event.system,
        messages: event.messages,
        tools: event.tools,
      })
      event.messages[0].content[0].text = event.messages[0].content[0].text + " observed"
      event.messages = event.messages.map((message) =>
        message.role === "assistant" ? { ...message, content: [...message.content, { type: "text", text: "copied" }] } : message,
      )
      event.system.push({ type: "text", text: "Plugin system" })
      event.messages.push({ role: "user", content: [{ type: "text", text: "ctx" }] })
      event.messages.push({ role: "system", content: [{ type: "text", text: "ctx-system" }] })
      event.messages.push({ role: "user", content: [{ type: "text", text: seen }] })
    })
  },
}
"#;

#[tokio::test]
async fn context_hook_sees_main_shapes_and_may_append_messages_of_any_role() {
    let fixture = ToolFixture::new();
    let extension = start(&fixture, OBSERVE).await;
    let mut first = user(Some("msg_user"), "Hello");
    first.metadata = Some(parse_json(r#"{"k":"v"}"#).unwrap());
    let mut assistant = llm::Message::assistant(vec![
        llm::Part::Reasoning(llm::Reasoning {
            text: "thinking".into(),
            encrypted: None,
            provider_metadata: None,
        }),
        llm::Part::ToolCall(llm::ToolCall {
            id: "call_1".into(),
            name: "echo".into(),
            input: parse_json(r#"{"text":"hi"}"#).unwrap(),
            provider_executed: None,
            provider_metadata: None,
        }),
        llm::Part::Text("answer".into()),
    ]);
    assistant.id = Some("msg_assistant".into());
    let tool = llm::Message::new(
        llm::Role::Tool,
        vec![llm::Part::ToolResult(llm::ToolResult {
            id: "call_1".into(),
            name: "echo".into(),
            result: llm::ToolResultValue::Json(parse_json(r#"{"ok":true}"#).unwrap()),
            cache: None,
            provider_executed: None,
            provider_metadata: None,
            output: None,
        })],
    );
    let mut volatile = user(None, "volatile");
    volatile.volatile = true;
    let input = request(vec![
        first.clone(),
        assistant.clone(),
        tool.clone(),
        volatile.clone(),
    ]);

    let output = prepare(&fixture, &extension, &input).await;
    extension.shutdown().await;
    fixture.cleanup();
    let output = output.expect("a main-shaped context hook settles");

    assert_eq!(
        output
            .system
            .iter()
            .map(|part| part.text.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["System", "Plugin system"]
    );
    assert_eq!(output.messages.len(), 7, "{:?}", output.messages);
    let mut edited = first.clone();
    edited.content = vec![llm::Part::Text("Hello observed".into())];
    assert_eq!(output.messages[0], edited);
    let mut copied = assistant.clone();
    copied.content.push(llm::Part::Text("copied".into()));
    assert_eq!(output.messages[1], copied);
    assert_eq!(output.messages[2], tool);
    assert_eq!(output.messages[3], volatile);
    assert_eq!(output.messages[4], llm::Message::user("ctx"));
    assert_eq!(output.messages[5], llm::Message::system("ctx-system"));
    assert_eq!(output.messages[6].role, llm::Role::User);
    assert_eq!(output.messages[6].id, None);
    assert!(!output.messages[6].volatile);
    assert_eq!(output.tools, input.tools);

    let seen: Value = serde_json::from_str(&texts(&output.messages[6])[0]).unwrap();
    assert_eq!(
        seen["keys"],
        json!([
            "agent",
            "messages",
            "model",
            "routeID",
            "sessionID",
            "system",
            "tools"
        ])
    );
    assert_eq!(
        seen["system"],
        json!([{ "type": "text", "text": "System" }])
    );
    assert_eq!(
        seen["tools"],
        json!({ "echo": { "description": "Echo", "input": { "type": "object" } } })
    );
    assert_eq!(
        seen["messages"],
        json!([
            {
                "id": "msg_user",
                "role": "user",
                "content": [{ "type": "text", "text": "Hello" }],
                "metadata": { "k": "v" }
            },
            {
                "id": "msg_assistant",
                "role": "assistant",
                "content": [
                    { "type": "reasoning", "text": "thinking" },
                    { "type": "tool-call", "id": "call_1", "name": "echo", "input": { "text": "hi" } },
                    { "type": "text", "text": "answer" }
                ]
            },
            {
                "role": "tool",
                "content": [{
                    "type": "tool-result",
                    "id": "call_1",
                    "name": "echo",
                    "result": { "type": "json", "value": { "ok": true } }
                }]
            },
            {
                "role": "user",
                "content": [{ "type": "text", "text": "volatile" }],
                "volatile": true
            }
        ])
    );
}

const PROTECTED: &str = r#"
export default {
  id: "fixture",
  setup: async (ctx) => {
    await ctx.session.hook("context", (event) => {
      const command = event.messages[0].content[0].text
      if (command === "role") event.messages[0].role = "system"
      if (command === "id") event.messages[0].id = "msg_forged"
      if (command === "metadata") event.messages[0].metadata = { forged: true }
      if (command === "volatile") event.messages[0].volatile = true
      if (command === "copy-role") event.messages = [{ ...event.messages[0], role: "assistant" }]
      if (command === "duplicate") event.messages.push(event.messages[0])
      if (command === "duplicate-copy") event.messages.push({ ...event.messages[0] })
      if (command === "native")
        event.messages.push({
          role: "user",
          content: [{ type: "text", text: "forged" }],
          native: { openai: { compactionTrigger: true } },
        })
      if (command === "origin") event.messages.push({ origin: 0, role: "assistant", content: [] })
    })
  },
}
"#;

#[tokio::test]
async fn context_hook_cannot_alter_protected_fields_of_existing_messages() {
    let fixture = ToolFixture::new();
    let extension = start(&fixture, PROTECTED).await;
    let mut outcomes = Vec::new();
    for command in [
        "role",
        "id",
        "metadata",
        "volatile",
        "copy-role",
        "duplicate",
        "duplicate-copy",
        "native",
    ] {
        let outcome = prepare(
            &fixture,
            &extension,
            &request(vec![user(Some("msg_user"), command)]),
        )
        .await;
        outcomes.push((command, outcome.err()));
    }
    let forged_origin = prepare(
        &fixture,
        &extension,
        &request(vec![user(Some("msg_user"), "origin")]),
    )
    .await;
    extension.shutdown().await;
    fixture.cleanup();

    for (command, error) in outcomes {
        assert_eq!(error, Some(Error::Unauthorized), "{command}");
    }
    let forged_origin = forged_origin.expect("a plugin-visible origin key is ignored");
    assert_eq!(forged_origin.messages.len(), 2);
    assert_eq!(forged_origin.messages[0], user(Some("msg_user"), "origin"));
    assert_eq!(
        forged_origin.messages[1],
        llm::Message::assistant(Vec::new())
    );
}

const FAILING: &str = r#"
export default {
  id: "fixture",
  setup: async (ctx) => {
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: "first" })
    })
    await ctx.session.hook("context", (event) => {
      event.messages.push({ role: "user", content: [{ type: "text", text: "partial" }] })
      throw new Error("hook defect")
    })
    await ctx.session.hook("context", (event) => {
      event.messages.push({ role: "user", content: [{ type: "text", text: "after: " + event.messages.at(-1).content[0].text }] })
    })
  },
}
"#;

#[tokio::test]
async fn a_failing_context_hook_adds_a_notice_and_later_hooks_still_run() {
    let fixture = ToolFixture::new();
    let extension = start(&fixture, FAILING).await;
    let output = prepare(
        &fixture,
        &extension,
        &request(vec![user(Some("msg_user"), "Hello")]),
    )
    .await;
    extension.shutdown().await;
    fixture.cleanup();
    let output = output.expect("a failed context hook does not fail the request");

    const NOTICE: &str = "Session context hook failed; its changes may be incomplete.";
    assert_eq!(
        output
            .system
            .iter()
            .map(|part| part.text.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["System", "first"]
    );
    assert_eq!(
        output.messages,
        [
            user(Some("msg_user"), "Hello"),
            llm::Message::user("partial"),
            llm::Message::user(NOTICE),
            llm::Message::user(format!("after: {NOTICE}")),
        ]
    );
}
