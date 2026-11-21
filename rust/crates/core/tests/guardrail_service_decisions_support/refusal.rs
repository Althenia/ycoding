use ycoding_core::resources::decision;
use ycoding_schema::JsonValue;

pub fn refusal(name: &str) -> Result<JsonValue, decision::Error> {
    super::support::response(&format!(
        r#"{{"name":"{name}","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}}"#
    ))
}
