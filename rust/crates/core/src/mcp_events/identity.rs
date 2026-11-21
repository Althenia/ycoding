use ring::digest;
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, ObjectEncoder,
    mcp_events::{Arguments, Name, Principal},
};

pub struct Identity {
    pub id: LosslessString,
    pub hash: LosslessString,
}

pub fn subscription(
    principal: &Principal,
    url: &LosslessString,
    name: Name,
    args: &Arguments,
) -> Identity {
    let value = ObjectEncoder::new()
        .field("principal", principal)
        .field("url", url)
        .field("name", &name)
        .field("arguments", args)
        .finish();
    let hash = digest::digest(&digest::SHA256, canonical_json(&value).as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Identity {
        id: format!("sub_{}", &hash[..32]).into(),
        hash: hash.into(),
    }
}

pub fn canonical_json(value: &JsonValue) -> String {
    match value {
        JsonValue::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        JsonValue::Object(values) => {
            let mut values = values.iter().collect::<Vec<_>>();
            values.sort_by(|left, right| left.0.cmp(&right.0));
            format!(
                "{{{}}}",
                values
                    .iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        ycoding_schema::stringify_json(&key.encode()),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => ycoding_schema::stringify_json(value),
    }
}

pub fn replayable(name: Name) -> bool {
    matches!(name, Name::Progress | Name::Completed | Name::Error)
}

pub fn ttl(now: i64, requested: Option<i64>, grant: i64) -> i64 {
    now.saturating_add(
        requested
            .unwrap_or(86_400_000)
            .clamp(60_000, 7 * 86_400_000),
    )
    .min(grant)
}
