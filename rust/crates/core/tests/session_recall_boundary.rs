pub mod filesystem_fixture;
mod policy_fixture;

use std::{fs, sync::Arc};
use ycoding_ai::{llm, route::Route};
use ycoding_core::{
    resources::memory::{Limits, Options, Repository, Scope, Service},
    session::recall::Context,
};
use ycoding_schema::{DomainDecode, parse_json, permission, provider, session_message};

#[tokio::test]
async fn repository_references_obey_current_authority_and_never_modify_the_stable_prefix() {
    let root = filesystem_fixture::Fixture::new();
    let path = &root.0;
    let git = path.join(".git");
    fs::create_dir(&git).unwrap();
    let service = Arc::new(
        Service::new(Options {
            home: path.clone(),
            data: path.join("data"),
            directory: path.clone(),
            repository: Some(Repository {
                directory: path.clone(),
                common_directory: git,
                worktrees: vec![path.clone()],
            }),
            limits: Limits::default(),
        })
        .unwrap(),
    );
    let bytes = "---\ntype: Decision\n---\nThe cobalt canary is ready.\n";
    for id in ["checks/first", "checks/second"] {
        service
            .write(Scope::Repository, id, bytes, None)
            .await
            .unwrap();
    }
    service
        .write(
            Scope::Knowledge,
            "other",
            "---\ntype: Decision\n---\ncobalt canary shared-only marker\n",
            None,
        )
        .await
        .unwrap();
    let p = policy_fixture::Fixture::default();
    let session = p.session("ses_recall", None, 0, false, None);
    let recall = Context {
        memory: service.clone(),
        permissions: p.permissions(),
    };
    let mut prefix = llm::Request::new(llm::Model {
        id: "fixture".into(),
        provider: provider::Id("fixture".into()),
        route: Arc::new(Route::openai_chat()),
        defaults: Default::default(),
        tool_schema: None,
        supports_temperature: true,
    });
    prefix.messages.push(llm::Message::user("cobalt canary"));
    prefix.tools.push(llm::ToolDefinition {
        name: "memory".into(),
        description: "Read references".into(),
        input_schema: parse_json(r#"{"type":"object"}"#).unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    });
    let user=session_message::Info::decode(&parse_json(r#"{"type":"user","id":"msg_cobalt","time":{"created":1,"consumed":2},"text":"cobalt canary"}"#).unwrap()).unwrap();
    let rules = |effect: &str| {
        *p.rules.lock().unwrap()=permission::Ruleset::decode(&parse_json(&format!(r#"[{{"action":"memory","resource":"*","effect":"allow"}},{{"action":"memory_read","resource":"*","effect":"{effect}"}}]"#)).unwrap()).unwrap();
    };
    rules("allow");
    let mut request = prefix.clone();
    let appended = recall
        .append(
            &session,
            &"test".into(),
            std::slice::from_ref(&user),
            &mut request,
            4096,
            2048,
        )
        .await;
    assert!(appended);
    assert_eq!(request.messages.len(), 2);
    assert_eq!(request.messages[0], prefix.messages[0]);
    assert_eq!(request.tools, prefix.tools);
    let [llm::Part::Text(text)] = request.messages[1].content.as_slice() else {
        panic!("expected a single reference message")
    };
    let text = text.text.to_utf8().unwrap();
    assert_eq!(text.matches("The cobalt canary is ready.").count(), 1);
    assert!(text.contains("checks/first") && text.contains("checks/second"));
    assert!(!text.contains("shared-only marker"));
    assert!(text.contains("body-phrase") && text.contains("lexical"));
    let mut weak = user.clone();
    if let session_message::Info::User(item) = &mut weak {
        item.text = "ready".into();
    }
    let mut abstained = prefix.clone();
    let appended = recall
        .append(
            &session,
            &"test".into(),
            &[weak],
            &mut abstained,
            4096,
            2048,
        )
        .await;
    assert!(!appended);
    assert_eq!(abstained.messages, prefix.messages);
    let mut clipped = prefix.clone();
    let appended = recall
        .append(
            &session,
            &"test".into(),
            std::slice::from_ref(&user),
            &mut clipped,
            4096,
            8,
        )
        .await;
    assert!(!appended);
    assert_eq!(clipped.messages, prefix.messages);
    for effect in ["ask", "deny"] {
        rules(effect);
        let mut request = prefix.clone();
        recall
            .append(
                &session,
                &"test".into(),
                std::slice::from_ref(&user),
                &mut request,
                4096,
                2048,
            )
            .await;
        assert_eq!(request.messages, prefix.messages);
    }
    assert!(p.events.lock().unwrap().is_empty());
    rules("allow");
    service
        .configure(Limits {
            enabled: false,
            ..Limits::default()
        })
        .unwrap();
    let mut request = prefix.clone();
    recall
        .append(&session, &"test".into(), &[user], &mut request, 4096, 2048)
        .await;
    assert_eq!(request.messages, prefix.messages);
}
