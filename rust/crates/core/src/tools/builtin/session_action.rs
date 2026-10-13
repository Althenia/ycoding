use crate::tools::{
    context::{Context, policy::LeafPolicy},
    registry::Failure,
};
use ycoding_ai::llm::ToolOutput;
use ycoding_schema::{
    JsonPath, JsonValue, ObjectDecoder,
    llm::{ToolContent, ToolTextContent},
};

pub(super) fn decode(value: &JsonValue) -> Result<ObjectDecoder<'_>, Failure> {
    static PATH: std::sync::LazyLock<JsonPath> = std::sync::LazyLock::new(JsonPath::default);
    ObjectDecoder::new(value, &PATH).map_err(invalid)
}
pub(super) fn invalid(error: ycoding_schema::DecodeError) -> Failure {
    Failure::message(format!("Invalid tool input: {error}"))
}
pub(super) fn output(
    value: JsonValue,
    text: impl Into<ycoding_schema::LosslessString>,
) -> ToolOutput {
    ToolOutput {
        structured: value,
        content: vec![ToolContent::Text(ToolTextContent { text: text.into() })],
    }
}
pub(super) async fn permit(
    policy: &LeafPolicy,
    context: &Context,
    action: &str,
    resource: &str,
    save: bool,
    error: &str,
) -> Result<(), Failure> {
    policy
        .assert(
            context,
            action,
            vec![resource.into()],
            if save { vec![resource.into()] } else { vec![] },
            None,
        )
        .await
        .map_err(|failure| match failure {
            Failure::Cancelled | Failure::Defect(_) => failure,
            _ => Failure::message(error),
        })
}
