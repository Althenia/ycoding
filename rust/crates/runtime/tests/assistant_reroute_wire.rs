#![allow(dead_code)]

#[path = "../src/convert.rs"]
mod convert;
#[path = "../src/message.rs"]
mod message;
mod dispatch {
    pub use ycoding_runtime::Failure;
}

use ycoding_core::ycoding_schema::{DomainDecode, parse_json, session_message};
use ycoding_protocol::v5;

fn assistant(extra: &str) -> v5::SessionMessageAssistant {
    let info = session_message::Info::decode(
        &parse_json(&format!(
            r#"{{"type":"assistant","id":"msg_reroute","time":{{"created":1,"completed":2}},"agent":"build","model":{{"providerID":"anthropic","id":"fallback"}},"content":[]{extra}}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    let Some(v5::session_message_info::Kind::Value8(assistant)) =
        message::message(&info).unwrap().kind
    else {
        panic!("assistant message")
    };
    assistant
}

#[test]
fn assistant_reroutes_keep_order_source_target_and_failure() {
    let rerouted = assistant(
        r#","reroutes":[{"from":{"providerID":"openai","id":"primary","variant":"high"},"model":{"providerID":"anthropic","id":"fallback"},"error":{"type":"provider.quota","message":"quota exhausted"}},{"from":{"providerID":"anthropic","id":"fallback"},"model":{"providerID":"google","id":"last","profile":"work"},"error":{"type":"provider.unavailable","message":"no route"}}]"#,
    );
    let reroutes = rerouted.reroutes.unwrap().items;
    assert_eq!(reroutes.len(), 2);
    assert_eq!(reroutes[0].from.id, convert::text("primary"));
    assert_eq!(reroutes[0].from.variant, Some(convert::text("high")));
    assert_eq!(reroutes[0].model.provider_id, convert::text("anthropic"));
    assert_eq!(reroutes[0].error.r#type, convert::text("provider.quota"));
    assert_eq!(reroutes[1].model.profile, Some(convert::text("work")));
    assert_eq!(reroutes[1].error.message, convert::text("no route"));
    assert!(assistant("").reroutes.is_none());
}
