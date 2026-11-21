use crate::{
    session::orchestration::{Notice, Service},
    tools::builtin::mcp::{Notification, Notifier},
};
use ring::digest;
use std::sync::Arc;
use ycoding_schema::{ObjectEncoder, session_message};

pub fn mcp_notifier(orchestration: Service) -> Notifier {
    Arc::new(move |notification| {
        let orchestration = orchestration.clone();
        Box::pin(async move {
            if let Err(error) = deliver(&orchestration, notification).await {
                eprintln!("MCP completion notification failed: {error}");
            }
        })
    })
}

fn notice_id(notification: &Notification) -> Result<session_message::Id, String> {
    let identity = format!(
        "{}\0{}",
        notification
            .session_id
            .as_lossless()
            .to_utf8()
            .map_err(|error| error.to_string())?,
        notification.job_id
    );
    let hash = digest::digest(&digest::SHA256, identity.as_bytes());
    let suffix = hash
        .as_ref()
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    session_message::Id::new(format!("msg_mcp_notice_{suffix}")).map_err(|error| error.to_string())
}

async fn deliver(orchestration: &Service, notification: Notification) -> Result<(), String> {
    orchestration
        .notice(Notice {
            id: notice_id(&notification)?,
            session_id: notification.session_id,
            text: notification.text,
            description: notification.description,
            metadata: ObjectEncoder::new()
                .field("source", "mcp")
                .field("state", notification.state)
                .finish(),
            resume: true,
        })
        .await
        .map_err(|error| error.to_string())
}
