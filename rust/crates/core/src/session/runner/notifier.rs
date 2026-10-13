use super::Clock;
use crate::{
    session::{pending::Request, projector, run_coordinator::Outcome, store::Service},
    tools::builtin::mcp::{Notification, Notifier},
};
use std::sync::Arc;
use ycoding_schema::{DomainDecode, ObjectEncoder, session, session_message, session_pending};

pub type Wake = Arc<dyn Fn(&session::Id) -> Outcome + Send + Sync>;

pub fn mcp_notifier(store: Service, clock: Arc<dyn Clock>, wake: Wake) -> Notifier {
    Arc::new(move |notification| {
        let (store, clock, wake) = (store.clone(), clock.clone(), wake.clone());
        Box::pin(async move {
            if let Err(error) = deliver(&store, &*clock, &wake, notification).await {
                eprintln!("MCP completion notification failed: {error}");
            }
        })
    })
}

async fn deliver(
    store: &Service,
    clock: &dyn Clock,
    wake: &Wake,
    notification: Notification,
) -> Result<(), String> {
    let input = session_pending::Message::decode(
        &ObjectEncoder::new()
            .field("type", "synthetic")
            .field(
                "data",
                &ObjectEncoder::new()
                    .field("text", notification.text.as_str())
                    .field("description", notification.description.as_str())
                    .field(
                        "metadata",
                        &ObjectEncoder::new()
                            .field("source", "mcp")
                            .field("state", notification.state)
                            .finish(),
                    )
                    .finish(),
            )
            .field("delivery", "steer")
            .finish(),
    )
    .map_err(|error| error.to_string())?;
    let admitted = store
        .admit_input(Request {
            id: session_message::Id::from_event(
                &projector::random_event_id().map_err(|error| error.to_string())?,
            ),
            session_id: notification.session_id.clone(),
            input,
            event_id: projector::random_event_id().map_err(|error| error.to_string())?,
            created: clock.now(),
        })
        .await
        .map_err(|error| error.to_string())?;
    if admitted.wake {
        wake(&notification.session_id).map_err(|error| error.to_string())?;
    }
    Ok(())
}
