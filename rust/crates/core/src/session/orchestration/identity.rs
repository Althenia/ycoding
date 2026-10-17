use crate::session::prompt_cache::sha256;
use ycoding_schema::{event, session, session_message, session_orchestration::NotificationType};

pub struct Launch {
    pub child_id: session::Id,
    pub input_id: session_message::Id,
    pub launch_event_id: event::Id,
    pub started_event_id: event::Id,
    digest: String,
}

impl Launch {
    pub fn new(
        parent_id: &session::Id,
        parent_assistant_message_id: &session_message::Id,
        tool_call_id: &str,
    ) -> Self {
        let digest = sha256(&format!(
            "{}\0{}\0{tool_call_id}",
            text(parent_id.as_lossless()),
            text(parent_assistant_message_id.as_lossless()),
        ));
        let short = &digest[..24];
        Self {
            child_id: session::Id::new(format!("ses_task_{short}")).expect("hex identifier"),
            input_id: session_message::Id::new(format!("msg_task_{short}"))
                .expect("hex identifier"),
            launch_event_id: event::Id::new(format!("evt_task_{short}")).expect("hex identifier"),
            started_event_id: event::Id::new(format!("evt_task_started_{short}"))
                .expect("hex identifier"),
            digest,
        }
    }

    pub fn answer(&self, question_id: &str) -> session_message::Id {
        let hash = sha256(&format!("{}\0{question_id}", self.digest));
        session_message::Id::new(format!("msg_task_answer_{}", &hash[..24]))
            .expect("hex identifier")
    }

    pub fn notification(&self, revision: i64, kind: &NotificationType) -> session_message::Id {
        let hash = sha256(&format!(
            "{}\0{revision}\0{}",
            self.digest,
            notification_name(kind)
        ));
        session_message::Id::new(format!("msg_task_notice_{}", &hash[..24]))
            .expect("hex identifier")
    }
}

pub fn send(parent_id: &str, message_id: &str, call_id: &str) -> session_message::Id {
    let hash = sha256(&format!("{parent_id}\0{message_id}\0{call_id}"));
    session_message::Id::new(format!("msg_task_send_{}", &hash[..24])).expect("hex identifier")
}

pub(super) fn notification_name(kind: &NotificationType) -> &'static str {
    match kind {
        NotificationType::Question => "question",
        NotificationType::Completed => "completed",
        NotificationType::Failed => "failed",
        NotificationType::Cancelled => "cancelled",
        NotificationType::Lost => "lost",
        NotificationType::Resumed => "resumed",
    }
}

fn text(value: &ycoding_schema::LosslessString) -> &str {
    value.as_str().unwrap_or_default()
}
