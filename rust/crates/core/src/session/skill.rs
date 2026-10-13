use std::{future::Future, pin::Pin};
use ycoding_schema::{JsonObject, JsonValue, LosslessString, skill};

pub type SkillsFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<skill::Info>, String>> + Send + 'a>>;
pub type InstructionsFuture<'a> =
    Pin<Box<dyn Future<Output = Result<LosslessString, String>> + Send + 'a>>;

pub trait Resolver: Send + Sync {
    fn list(&self) -> SkillsFuture<'_>;
    fn instructions<'a>(&'a self, info: &'a skill::Info) -> InstructionsFuture<'a>;
}

pub async fn activate(
    store: &super::store::Service,
    session_id: &ycoding_schema::session::Id,
    fields: JsonValue,
    now: i64,
) -> Result<(), ycoding_store::Error> {
    let JsonValue::Object(mut data) = fields else {
        return Err(ycoding_store::Error::Rejected(
            "Skill event fields must be an object",
        ));
    };
    data.insert(
        "sessionID".into(),
        ycoding_schema::DomainEncode::encode(session_id),
    );
    let event = ycoding_store::session::NewEvent {
        id: super::projector::random_event_id()?.as_lossless().clone(),
        aggregate_id: session_id.as_lossless().clone(),
        created: now,
        type_: "session.skill.activated.1".into(),
        data: JsonValue::Object(data),
    };
    if let Some(source) = store.artifact_source() {
        source.publish_activation(event).await?;
        return Ok(());
    }
    store.publish(event).await?;
    Ok(())
}

pub fn selected(metadata: Option<&JsonObject>) -> Vec<skill::Id> {
    let Some(JsonValue::Array(skills)) =
        metadata.and_then(|metadata| metadata.get(&"skills".into()))
    else {
        return Vec::new();
    };
    skills
        .iter()
        .filter_map(|value| {
            let JsonValue::Object(fields) = value else {
                return None;
            };
            let Some(JsonValue::String(id)) = fields.get(&"id".into()) else {
                return None;
            };
            (!id.as_str().is_some_and(|id| id.trim().is_empty())).then(|| id.clone())
        })
        .collect()
}

pub fn mentions(text: &LosslessString, available: &[skill::Id]) -> Vec<skill::Id> {
    let text = text.code_units().collect::<Vec<_>>();
    available
        .iter()
        .filter(|id| mentioned(&text, id))
        .cloned()
        .collect()
}

fn mentioned(text: &[u16], id: &skill::Id) -> bool {
    let mut token = vec![36];
    token.extend(id.code_units());
    if token.len() == 1 || token.len() > text.len() {
        return false;
    }
    text.windows(token.len())
        .enumerate()
        .any(|(start, window)| {
            if window != token {
                return false;
            }
            let begins = start == 0 || is_whitespace(text[start - 1]);
            let end = start + token.len();
            let ends = end == text.len() || is_delimiter(text[end]);
            begins && ends
        })
}

fn is_whitespace(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(crate::resources::discovery::whitespace)
}

fn is_delimiter(unit: u16) -> bool {
    is_whitespace(unit)
        || matches!(
            unit,
            33 | 34 | 39 | 40 | 41 | 44 | 46 | 58 | 59 | 63 | 96 | 93
        )
}

#[cfg(test)]
mod tests {
    use super::{mentions, selected};
    use ycoding_schema::{JsonObject, JsonValue, skill};

    fn ids(values: &[&str]) -> Vec<skill::Id> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn mention_matching_obeys_known_exact_token_boundaries_and_catalog_order() {
        let available = ids(&["audit", "audit-long", "audit.v2"]);
        for text in [
            "$audit",
            "Use $audit, then report",
            "\n$audit!",
            "$audit)",
            "$audit'",
            "$audit\"",
            "$audit`",
        ] {
            assert_eq!(
                mentions(&text.into(), &available),
                ids(&["audit"]),
                "{text}"
            );
        }
        for text in [
            "costs $10",
            "$VAR",
            "$unknown",
            "path/$audit",
            "`$audit`",
            "'$audit'",
            "\\$audit",
            "$$audit",
            "$audit_extra",
            "$audit-longer",
            "$audit}",
        ] {
            assert!(mentions(&text.into(), &available).is_empty(), "{text}");
        }
        assert_eq!(
            mentions(&"$audit-long, $audit.v2 $audit $audit".into(), &available),
            available
        );
    }

    #[test]
    fn selected_reads_only_nonblank_string_ids_from_skill_metadata() {
        let mut metadata = JsonObject::new();
        metadata.insert(
            "skills".into(),
            JsonValue::Array(vec![
                JsonValue::Object(object("audit")),
                JsonValue::Object(object("  ")),
                JsonValue::Object(object("")),
                JsonValue::String("audit".into()),
                JsonValue::Object(object_number()),
            ]),
        );
        assert_eq!(selected(Some(&metadata)), ids(&["audit"]));
        assert!(selected(None).is_empty());
        assert!(selected(Some(&JsonObject::new())).is_empty());
    }

    fn object(id: &str) -> JsonObject {
        let mut object = JsonObject::new();
        object.insert("id".into(), JsonValue::String(id.into()));
        object
    }

    fn object_number() -> JsonObject {
        let mut object = JsonObject::new();
        object.insert("id".into(), JsonValue::Number(1.0));
        object
    }
}
