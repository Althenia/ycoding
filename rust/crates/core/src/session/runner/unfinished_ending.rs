use ycoding_schema::{LosslessString, session_error, session_message};

pub const UNSETTLED_STEP_MESSAGE: &str = "Provider did not settle the step";

pub const ANSWERLESS_AFTER_RECOVERY_MESSAGE: &str = "The provider returned no answer after text-only recovery. Retry the request or choose another model.";

pub fn is_unfinished_ending(error: Option<&session_error::Error>) -> bool {
    error.is_some_and(|error| {
        error.r#type.as_str() == Some("provider.invalid-output")
            && matches!(
                error.message.as_str(),
                Some(UNSETTLED_STEP_MESSAGE) | Some(ANSWERLESS_AFTER_RECOVERY_MESSAGE)
            )
    })
}

pub fn excerpt_text(assistant: &session_message::Assistant) -> LosslessString {
    if let Some(error) = &assistant.error {
        return error.message.clone();
    }
    crate::instructions::join(
        &assistant
            .content
            .iter()
            .filter_map(|part| match part {
                session_message::AssistantContent::Text(part) => Some(part.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>(),
        "",
    )
}

#[cfg(test)]
mod tests {
    use super::{excerpt_text, is_unfinished_ending};
    use ycoding_schema::{DomainDecode, parse_json, session_error, session_message};

    fn error(kind: &str, message: &str) -> session_error::Error {
        session_error::Error {
            r#type: kind.into(),
            message: message.into(),
        }
    }

    #[test]
    fn classification_matches_only_the_two_exact_invalid_output_messages() {
        assert!(is_unfinished_ending(Some(&error(
            "provider.invalid-output",
            "Provider did not settle the step"
        ))));
        assert!(is_unfinished_ending(Some(&error(
            "provider.invalid-output",
            "The provider returned no answer after text-only recovery. Retry the request or choose another model."
        ))));
        assert!(!is_unfinished_ending(Some(&error(
            "provider.invalid-output",
            "Provider returned malformed output"
        ))));
        assert!(!is_unfinished_ending(Some(&error(
            "provider.transport",
            "Provider did not settle the step"
        ))));
        assert!(!is_unfinished_ending(None));
    }

    #[test]
    fn excerpt_reports_the_error_message_instead_of_partial_text() {
        let assistant = |error: Option<&str>| {
            let error = match error {
                Some(message) => format!(
                    r#","finish":"error","error":{{"type":"provider.invalid-output","message":"{message}"}}"#
                ),
                None => String::new(),
            };
            let session_message::Info::Assistant(assistant) = session_message::Info::decode(
                &parse_json(&format!(
                    r#"{{"type":"assistant","id":"msg_one","agent":"build","model":{{"providerID":"openai","id":"test"}},"time":{{"created":1,"completed":2}},"content":[{{"type":"text","text":"Partial "}},{{"type":"reasoning","text":"hidden"}},{{"type":"text","text":"text"}}]{error}}}"#
                ))
                .unwrap(),
            )
            .unwrap() else {
                panic!()
            };
            (*assistant).clone()
        };
        assert_eq!(
            excerpt_text(&assistant(Some("Provider did not settle the step"))).as_str(),
            Some("Provider did not settle the step")
        );
        assert_eq!(
            excerpt_text(&assistant(None)).as_str(),
            Some("Partial text")
        );
    }
}
