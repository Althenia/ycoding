use crate::session::{
    key,
    projector::{insert_message, record_error},
};
use ycoding_schema::{
    DomainEncode, JsonObject, JsonPath, JsonValue, ObjectDecoder, schema::DateTimeUtcFromMillis,
    session_event, session_message, skill,
};
use ycoding_store::{
    Error, Write,
    session::{Event, Message, MessageTable},
};

pub fn apply(
    tx: &mut Write<'_>,
    event: &Event,
    decoded: &session_event::Event,
) -> Result<(), Error> {
    let data = decoded.data.encode();
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&data, &path).map_err(record_error)?;
    match decoded.event_type.as_str() {
        Some("session.skill.activated") => {
            let time = DateTimeUtcFromMillis::new(event.created as f64).map_err(record_error)?;
            insert_message(
                tx,
                event,
                &session_message::Info::Skill(session_message::Skill {
                    id: session_message::Id::from_event(&decoded.id),
                    metadata: decoded.metadata.clone(),
                    time: session_message::BaseTime { created: time },
                    skill: object.field("id").map_err(record_error)?,
                    name: object.field("name").map_err(record_error)?,
                    text: object.field("text").map_err(record_error)?,
                    conflicts: Some(
                        object
                            .optional("conflicts")
                            .map_err(record_error)?
                            .unwrap_or(skill::Conflicts {
                                skills: Vec::new(),
                                instructions: Vec::new(),
                            }),
                    ),
                    skill_deactivations: None,
                    artifact: object.optional("artifact").map_err(record_error)?,
                }),
            )
        }
        Some("session.skill.deactivated") => {
            let activation: session_message::Id =
                object.field("activationMessageID").map_err(record_error)?;
            let Some(row) = tx
                .get::<MessageTable>(&key(activation.as_lossless()))?
                .filter(|row| row.session_id == event.aggregate_id)
            else {
                return Ok(());
            };
            let deactivation = session_message::SkillDeactivation {
                skill: object.field("id").map_err(record_error)?,
                reason: object.field("reason").map_err(record_error)?,
            };
            match row.info()? {
                session_message::Info::Skill(mut skill) => {
                    skill
                        .skill_deactivations
                        .get_or_insert_with(Vec::new)
                        .push(deactivation);
                    rewrite(tx, &row, &session_message::Info::Skill(skill))
                }
                session_message::Info::Assistant(mut assistant) => {
                    assistant
                        .skill_deactivations
                        .get_or_insert_with(Vec::new)
                        .push(deactivation);
                    rewrite(tx, &row, &session_message::Info::Assistant(assistant))
                }
                _ => Ok(()),
            }
        }
        _ => Err(Error::Rejected("Skill projection does not own this event")),
    }
}

fn rewrite(
    tx: &mut Write<'_>,
    row: &Message,
    message: &session_message::Info,
) -> Result<(), Error> {
    let JsonValue::Object(value) = message.encode() else {
        return Err(Error::Rejected("message must encode an object"));
    };
    let mut data = JsonObject::new();
    for (key, value) in value
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), Some("id" | "type")))
    {
        data.insert(key.clone(), value.clone());
    }
    MessageTable::put(
        tx,
        &Message {
            data: JsonValue::Object(data),
            ..row.clone()
        },
    )
}
