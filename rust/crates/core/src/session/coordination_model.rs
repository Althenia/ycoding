use super::store::Service;
use std::ops::Bound;
use ycoding_schema::{DomainDecode, JsonValue, LosslessString, model, session};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write,
    session::{EventTable, MessageTable},
    tuple_key,
};

const TERMINAL: [&str; 3] = [
    "session.execution.succeeded.1",
    "session.execution.failed.1",
    "session.execution.interrupted.1",
];

pub(crate) fn current(store: &Service, id: &session::Id) -> Result<Option<model::Ref>, Error> {
    let snapshot = store.client.snapshot()?;
    current_from(&mut Reader::Snapshot(&snapshot), id)
}

pub(crate) fn current_in(
    tx: &mut Write<'_>,
    id: &session::Id,
) -> Result<Option<model::Ref>, Error> {
    current_from(&mut Reader::Transaction(tx), id)
}

enum Reader<'a, 'tx> {
    Snapshot(&'a Snapshot),
    Transaction(&'a mut Write<'tx>),
}

impl Reader<'_, '_> {
    fn latest<T: TableSpec>(
        &mut self,
        name: &str,
        prefix: &[u8],
    ) -> Result<Option<T::Record>, Error> {
        let query = IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: Some(prefix),
            order: IndexOrder::Descending,
            after: None,
            limit: 1,
        };
        let rows = match self {
            Self::Snapshot(snapshot) => snapshot.index_range::<T>(name, query)?,
            Self::Transaction(tx) => tx.index_range::<T>(name, query)?,
        };
        Ok(rows.into_iter().next().map(|entry| entry.record))
    }
}

fn current_from(
    reader: &mut Reader<'_, '_>,
    id: &session::Id,
) -> Result<Option<model::Ref>, Error> {
    let Some(latest) = latest_user(reader, id)? else {
        return Ok(None);
    };
    let Some(model) = requested(&latest.data) else {
        return Ok(None);
    };
    for kind in TERMINAL {
        if newest(reader, id, kind)?.is_some_and(|seq| seq > latest.seq) {
            return Ok(None);
        }
    }
    Ok(Some(model))
}

fn latest_user(
    reader: &mut Reader<'_, '_>,
    id: &session::Id,
) -> Result<Option<ycoding_store::session::Message>, Error> {
    let prefix = tuple_key(&[
        KeyPart::String(id.as_lossless()),
        KeyPart::String(&"user".into()),
    ]);
    reader.latest::<MessageTable>("session_message_session_type_seq_idx", &prefix)
}

fn newest(reader: &mut Reader<'_, '_>, id: &session::Id, kind: &str) -> Result<Option<i64>, Error> {
    let kind = LosslessString::from(kind);
    let prefix = tuple_key(&[KeyPart::String(id.as_lossless()), KeyPart::String(&kind)]);
    Ok(reader
        .latest::<EventTable>("event_aggregate_type_seq_idx", &prefix)?
        .map(|event| event.seq))
}

pub(super) fn requested(data: &JsonValue) -> Option<model::Ref> {
    let JsonValue::Object(data) = data else {
        return None;
    };
    let JsonValue::Object(metadata) = data.get(&"metadata".into())? else {
        return None;
    };
    let JsonValue::String(origin) = metadata.get(&"inputOrigin".into())? else {
        return None;
    };
    if origin.as_str() != Some("coordination") {
        return None;
    }
    let JsonValue::Object(coordination) = metadata.get(&"coordination".into())? else {
        return None;
    };
    model::Ref::decode(coordination.get(&"model".into())?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;
    use ycoding_schema::{DomainEncode, parse_json};
    use ycoding_store::session::{Append, Message, NewEvent, append};

    const COORDINATION: &str = r#"{"inputOrigin":"coordination","coordination":{"groupID":"cgrp_one","masterSessionID":"ses_one","senderSessionID":"ses_one","messageID":"msg_one","model":{"providerID":"openai","id":"chat-b","variant":"fast","profile":"work"}}}"#;

    fn id(value: &str) -> session::Id {
        session::Id::new(value).unwrap()
    }

    fn user(store: &ycoding_store::Store, name: &str, session: &str, seq: i64, metadata: &str) {
        let data = format!(r#"{{"text":"work","metadata":{metadata},"time":{{"created":1}}}}"#);
        insert(store, name, session, "user", seq, &data);
    }

    fn insert(
        store: &ycoding_store::Store,
        name: &str,
        session: &str,
        kind: &str,
        seq: i64,
        data: &str,
    ) {
        let message = Message {
            id: name.into(),
            session_id: session.into(),
            type_: kind.into(),
            seq,
            time_created: 1,
            time_updated: 1,
            data: parse_json(data).unwrap(),
        };
        store
            .submit(move |tx| MessageTable::insert(tx, &message))
            .unwrap()
            .wait()
            .unwrap();
    }

    fn event(store: &ycoding_store::Store, name: &str, session: &str, kind: &str) -> i64 {
        let request = NewEvent {
            id: name.into(),
            aggregate_id: session.into(),
            created: 1,
            type_: kind.into(),
            data: parse_json(&format!(r#"{{"sessionID":"{session}"}}"#)).unwrap(),
        };
        let Append::Appended(event) = store
            .submit(move |tx| append(tx, &request, None))
            .unwrap()
            .wait()
            .unwrap()
        else {
            panic!("expected an appended event")
        };
        event.seq
    }

    fn current(store: &ycoding_store::Store, session: &str) -> Option<model::Ref> {
        super::current(&Service::new(store.client()), &id(session)).unwrap()
    }

    fn requested_model() -> model::Ref {
        model::Ref::decode(
            &parse_json(
                r#"{"providerID":"openai","id":"chat-b","variant":"fast","profile":"work"}"#,
            )
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn the_latest_coordination_user_message_carries_the_exact_model_reference() {
        let store = test_support::store();
        assert_eq!(current(&store, "ses_one"), None);
        user(&store, "msg_one", "ses_one", 1, COORDINATION);
        let selected = current(&store, "ses_one").unwrap();
        assert_eq!(selected, requested_model());
        assert_eq!(selected.encode(), requested_model().encode());
        assert_eq!(current(&store, "ses_two"), None);
    }

    #[test]
    fn plain_forged_wrong_origin_and_malformed_metadata_never_select_a_model() {
        let model = r#""model":{"providerID":"openai","id":"chat-b"}"#;
        for metadata in [
            "null".to_owned(),
            "{}".to_owned(),
            format!(r#"{{"coordination":{{{model}}}}}"#),
            format!(r#"{{"inputOrigin":"direct","coordination":{{{model}}}}}"#),
            format!(r#"{{"inputOrigin":7,"coordination":{{{model}}}}}"#),
            r#"{"inputOrigin":"coordination"}"#.to_owned(),
            r#"{"inputOrigin":"coordination","coordination":"forged"}"#.to_owned(),
            r#"{"inputOrigin":"coordination","coordination":{"groupID":"cgrp_one"}}"#.to_owned(),
            r#"{"inputOrigin":"coordination","coordination":{"model":"chat-b"}}"#.to_owned(),
            r#"{"inputOrigin":"coordination","coordination":{"model":{"id":"chat-b"}}}"#.to_owned(),
        ] {
            let store = test_support::store();
            user(&store, "msg_one", "ses_one", 1, &metadata);
            assert_eq!(current(&store, "ses_one"), None, "{metadata}");
        }
    }

    #[test]
    fn only_user_messages_select_and_a_later_user_message_supersedes() {
        let store = test_support::store();
        insert(
            &store,
            "msg_synthetic",
            "ses_one",
            "synthetic",
            1,
            &format!(r#"{{"text":"work","metadata":{COORDINATION},"time":{{"created":1}}}}"#),
        );
        assert_eq!(current(&store, "ses_one"), None);
        user(&store, "msg_one", "ses_one", 2, COORDINATION);
        assert!(current(&store, "ses_one").is_some());
        user(
            &store,
            "msg_two",
            "ses_one",
            3,
            r#"{"syntheticLabel":"kept"}"#,
        );
        assert_eq!(current(&store, "ses_one"), None);
        user(&store, "msg_three", "ses_one", 4, COORDINATION);
        assert!(current(&store, "ses_one").is_some());
    }

    #[test]
    fn a_terminal_event_after_the_source_message_expires_the_override() {
        for (index, kind) in TERMINAL.into_iter().enumerate() {
            let store = test_support::store();
            event(
                &store,
                &format!("evt_pad_after_{index}"),
                "ses_one",
                "session.step.ended.1",
            );
            let terminal = event(&store, &format!("evt_after_{index}"), "ses_one", kind);
            user(&store, "msg_one", "ses_one", terminal - 1, COORDINATION);
            assert_eq!(current(&store, "ses_one"), None, "{kind}");

            let store = test_support::store();
            let terminal = event(&store, &format!("evt_before_{index}"), "ses_one", kind);
            user(&store, "msg_one", "ses_one", terminal + 1, COORDINATION);
            assert_eq!(
                current(&store, "ses_one"),
                Some(requested_model()),
                "{kind}"
            );
        }
    }

    #[test]
    fn non_terminal_and_other_session_events_leave_the_override_active() {
        let store = test_support::store();
        let started = event(
            &store,
            "evt_started",
            "ses_one",
            "session.execution.started.1",
        );
        user(&store, "msg_one", "ses_one", started + 1, COORDINATION);
        event(&store, "evt_step", "ses_one", "session.step.ended.1");
        event(
            &store,
            "evt_other",
            "ses_two",
            "session.execution.succeeded.1",
        );
        assert_eq!(current(&store, "ses_one"), Some(requested_model()));
    }
}
