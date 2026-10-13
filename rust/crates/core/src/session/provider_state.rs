use super::{
    key,
    prompt_cache::{canonical_json, sha256},
    store::Service,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Bound,
};
use ycoding_schema::{JsonValue, LosslessString, session, session_message};
use ycoding_store::{
    Error, IndexOrder, IndexQuery,
    resources::{StateBlob, StateBlobTable, StateLink, StateLinkTable, capture_state},
    session::{ContextStateTable, Document},
};

pub struct Capture {
    pub message: session_message::Id,
    pub ordinal: usize,
    pub kind: &'static str,
    pub item: JsonValue,
}

pub fn state_key(message: &LosslessString, ordinal: i64, kind: &str) -> String {
    format!("{}:{ordinal}:{kind}", message.to_utf8().unwrap_or_default())
}

impl Service {
    pub async fn capture_provider_state(
        &self,
        session: &session::Id,
        provider: LosslessString,
        model_id: LosslessString,
        captures: Vec<Capture>,
        now: i64,
    ) -> Result<(), Error> {
        let session = session.as_lossless().clone();
        self.client
            .submit(move |tx| {
                let revision = tx
                    .get::<ContextStateTable>(&key(&session))?
                    .map_or(0, |state| state.revision);
                for capture in &captures {
                    let digest =
                        LosslessString::from(sha256(&canonical_json(&capture.item)).as_str());
                    capture_state(
                        tx,
                        &StateBlob {
                            digest: digest.clone(),
                            provider: provider.clone(),
                            model_id: model_id.clone(),
                            item_type: item_type(&capture.item),
                            content: Document::new(capture.item.clone())?,
                            time_created: now,
                        },
                        &StateLink {
                            session_id: session.clone(),
                            message_id: capture.message.as_lossless().clone(),
                            part_ordinal: capture.ordinal as i64,
                            part_kind: capture.kind.into(),
                            provider: provider.clone(),
                            model_id: model_id.clone(),
                            blob_digest: digest,
                            context_revision: revision,
                            time_created: now,
                        },
                    )?;
                }
                Ok(())
            })?
            .await
    }

    pub fn provider_states(
        &self,
        session: &session::Id,
        provider: &LosslessString,
        model_id: &LosslessString,
        messages: &BTreeSet<LosslessString>,
    ) -> Result<BTreeMap<String, JsonValue>, Error> {
        let snapshot = self.client.snapshot()?;
        let prefix = key(session.as_lossless());
        let mut states = BTreeMap::new();
        let mut after = None;
        loop {
            let page = snapshot.index_range::<StateLinkTable>(
                "session_provider_state_link_revision_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            let Some(last) = page.last() else {
                return Ok(states);
            };
            after = Some(last.cursor.clone());
            for link in page.into_iter().map(|entry| entry.record) {
                if link.provider != *provider
                    || link.model_id != *model_id
                    || !messages.contains(&link.message_id)
                {
                    continue;
                }
                let Some(blob) = snapshot.get::<StateBlobTable>(&key(&link.blob_digest))? else {
                    continue;
                };
                if matches!(blob.content.value(), JsonValue::Object(_)) {
                    states.insert(
                        state_key(
                            &link.message_id,
                            link.part_ordinal,
                            &link.part_kind.to_utf8().unwrap_or_default(),
                        ),
                        blob.content.value().clone(),
                    );
                }
            }
        }
    }
}

fn item_type(item: &JsonValue) -> LosslessString {
    match item {
        JsonValue::Object(fields) => match fields.get(&"type".into()) {
            Some(JsonValue::String(kind)) if !kind.is_empty() => kind.clone(),
            _ => "opaque".into(),
        },
        _ => "opaque".into(),
    }
}
