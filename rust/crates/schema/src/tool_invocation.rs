use crate::{JsonValue, LosslessString, schema::NonNegativeInt};

crate::schema::literal_enum_type!(Status, { Completed => "completed", Error => "error" });
crate::schema::record_type!(Settled {
    id: LosslessString => "id",
    index: NonNegativeInt => "index",
    name: LosslessString => "name",
    tool: LosslessString => "tool",
    status: Status => "status",
} {
    input: JsonValue => "input",
    structured: JsonValue => "structured",
});
