use super::{message_updater, projector};
use std::ops::Bound;
use ycoding_schema::{
    DomainEncode, JsonPath, ObjectDecoder, schema::DateTimeUtcFromMillis, session_event,
    session_message, shell,
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{Event, MessageTable},
    tuple_key,
};

pub(crate) fn apply(
    tx: &mut Write<'_>,
    event: &Event,
    decoded: &session_event::Event,
) -> Result<(), Error> {
    let data = decoded.data.encode();
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&data, &path).map_err(projector::record_error)?;
    let shell: shell::Info = object.field("shell").map_err(projector::record_error)?;
    let time = DateTimeUtcFromMillis::new(event.created as f64).map_err(projector::record_error)?;
    if decoded.event_type.as_str() == Some("session.shell.started") {
        return projector::insert_message(
            tx,
            event,
            &session_message::Info::Shell(session_message::Shell {
                id: session_message::Id::from_event(&decoded.id),
                metadata: decoded.metadata.clone(),
                time: session_message::CompletedTime {
                    created: time,
                    completed: None,
                },
                shell_id: shell.id,
                command: shell.command,
                status: shell.status,
                exit: None,
                output: None,
            }),
        );
    }
    let prefix = tuple_key(&[
        KeyPart::String(&event.aggregate_id),
        KeyPart::String(&"shell".into()),
    ]);
    let mut after = None;
    loop {
        let rows = tx.index_range::<MessageTable>(
            "session_message_session_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Descending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        let Some(last) = rows.last() else {
            return Ok(());
        };
        after = Some(last.cursor.clone());
        for row in rows {
            let session_message::Info::Shell(mut current) = row.record.info()? else {
                continue;
            };
            if current.shell_id != shell.id {
                continue;
            }
            current.status = shell.status;
            current.exit = shell.exit.map(|exit| exit.get());
            current.output = Some(object.field("output").map_err(projector::record_error)?);
            current.time.completed = Some(time);
            return message_updater::update_message(
                tx,
                &row.record,
                &session_message::Info::Shell(current),
            );
        }
    }
}
