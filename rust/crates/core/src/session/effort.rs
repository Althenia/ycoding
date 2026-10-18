//! Reconstruct chronological provider effort changes from retained Step requests.
//! This is request assembly only: durable messages and request refs remain authoritative.
use crate::resources::catalog::{merge_json, object};
use std::collections::BTreeMap;
use ycoding_ai::{
    effort::{self, Provider},
    llm,
};
use ycoding_schema::{JsonValue, LosslessString, model, session};
use ycoding_store::{IndexOrder, KeyPart, Snapshot, tuple_key};

#[derive(Default)]
pub(crate) struct Updates(Vec<usize>);
impl Updates {
    pub(crate) fn input_start(&self, index: usize) -> usize {
        index + self.0.iter().filter(|boundary| **boundary < index).count()
    }
}

struct Historical {
    index: usize,
    effort: Option<String>,
}

pub(crate) fn prepare(
    snapshot: &Snapshot,
    session: &session::Id,
    selection: &model::Ref,
    account: Option<&str>,
    namespace: &str,
    request: &mut llm::Request,
    mut resolve: impl FnMut(&model::Ref) -> Option<llm::Model>,
) -> Result<Updates, ycoding_store::Error> {
    let Some(provider) = effort::mechanism(request) else {
        return Ok(Updates::default());
    };
    if effort::default_effort(request.model.id.as_str().unwrap_or_default()).is_none()
        && effort::selected(request, provider).is_none()
    {
        return Ok(Updates::default());
    }
    let positions = request
        .messages
        .iter()
        .enumerate()
        .filter(|(_, message)| message.role == llm::Role::Assistant)
        .filter_map(|(index, message)| message.id.clone().map(|id| (id, index)))
        .collect::<BTreeMap<_, _>>();
    if positions.is_empty() {
        return Ok(Updates::default());
    }
    let state = snapshot
        .get::<ycoding_store::session::ContextStateTable>(&super::key(session.as_lossless()))?;
    let activation = match state {
        Some(state) => snapshot
            .get::<ycoding_store::session::RevisionTable>(&tuple_key(&[
                KeyPart::String(session.as_lossless()),
                KeyPart::I64(state.revision),
            ]))?
            .and_then(|revision| revision.activation_sequence),
        None => None,
    };
    let mut after = None;
    let mut history = Vec::new();
    let mut variants = BTreeMap::<Option<model::VariantId>, Option<Option<String>>>::new();
    loop {
        let page = ycoding_store::resources::requests(
            snapshot,
            session.as_lossless(),
            IndexOrder::Ascending,
            after.as_ref(),
            256,
        )?;
        if page.is_empty() {
            break;
        }
        after = page.last().map(|entry| entry.cursor.clone());
        for entry in page {
            let row = entry.record;
            let historical_model = row.model.domain()?;
            let Some(index) = row
                .assistant_message_id
                .as_ref()
                .and_then(|id| positions.get(id))
                .copied()
            else {
                continue;
            };
            if row.source.as_str() != Some("step")
                || row.route_id.as_str() != Some(request.model.route.id.as_str())
                || row.prompt_cache_key.as_str() != Some(namespace)
                || row
                    .connection_identity_digest
                    .as_ref()
                    .and_then(LosslessString::as_str)
                    != account
                || historical_model.provider_id != selection.provider_id
                || historical_model.id != selection.id
                || historical_model.profile != selection.profile
            {
                continue;
            }
            if let Some(activation) = activation {
                let message = snapshot.get::<ycoding_store::session::MessageTable>(&super::key(
                    row.assistant_message_id
                        .as_ref()
                        .expect("retained assistant"),
                ))?;
                if message.is_none_or(|message| message.seq <= activation) {
                    continue;
                }
            }
            let setting = variants
                .entry(historical_model.variant.clone())
                .or_insert_with(|| {
                    let historical = llm::Request::new(resolve(&historical_model)?);
                    (effort::mechanism(&historical) == Some(provider))
                        .then(|| effort::selected(&historical, provider))
                });
            if let Some(effort) = setting {
                history.push(Historical {
                    index,
                    effort: effort.clone(),
                });
            }
        }
    }
    Ok(apply(request, provider, &history))
}

fn apply(request: &mut llm::Request, provider: Provider, history: &[Historical]) -> Updates {
    let fallback = effort::default_effort(request.model.id.as_str().unwrap_or_default());
    let current = effort::selected(request, provider);
    let history = if fallback.is_none() {
        &history[history
            .iter()
            .rposition(|entry| entry.effort.is_none())
            .unwrap_or(0)..]
    } else {
        history
    };
    let Some(baseline) = history.first() else {
        return Updates::default();
    };
    let mut effort = baseline.effort.as_deref().or(fallback);
    let mut start = 0;
    let mut updates = BTreeMap::new();
    let tail = Historical {
        index: request.messages.len(),
        effort: current,
    };
    for entry in history.iter().chain(std::iter::once(&tail)) {
        let desired = entry.effort.as_deref().or(fallback);
        let boundary = request
            .messages
            .iter()
            .enumerate()
            .find(|(index, message)| {
                *index >= start
                    && *index < entry.index
                    && message.role == llm::Role::User
                    && !message.volatile
                    && message
                        .content
                        .iter()
                        .any(|part| !matches!(part, llm::Part::ToolResult(_)))
            })
            .map(|(index, _)| index);
        if let Some(desired) = desired
            && Some(desired) != effort
            && (!effort::anthropic_model(request.model.id.as_str().unwrap_or_default())
                || boundary.is_some())
        {
            updates.insert(boundary.unwrap_or(entry.index), desired.to_owned());
            effort = Some(desired);
        }
        start = entry.index + 1;
    }
    let baseline = baseline.effort.as_ref().map_or(JsonValue::Null, |effort| {
        JsonValue::String(effort.as_str().into())
    });
    let options = if provider == Provider::OpenRouter {
        object(&[
            (
                "openrouter",
                object(&[("reasoning", object(&[("effort", baseline.clone())]))]),
            ),
            ("openai", object(&[("reasoningEffort", baseline)])),
        ])
    } else {
        object(&[(provider.key(), object(&[(provider.effort_key(), baseline)]))])
    };
    request.provider_options = Some(merge_json(
        request
            .provider_options
            .as_ref()
            .unwrap_or(&JsonValue::Null),
        &options,
    ));
    let original = std::mem::take(&mut request.messages);
    for (index, message) in original
        .into_iter()
        .map(Some)
        .chain(std::iter::once(None))
        .enumerate()
    {
        if let Some(effort) = updates.get(&index) {
            let mut update = llm::Message::new(llm::Role::System, vec![]);
            update.native = Some(object(&[(
                provider.key(),
                object(&[(
                    provider.effort_key(),
                    JsonValue::String(effort.as_str().into()),
                )]),
            )]));
            request.messages.push(update);
        }
        request.messages.extend(message);
    }
    Updates(updates.into_keys().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;
    use ycoding_schema::{DomainDecode, parse_json};

    fn request(model: &str, selected: Option<&str>) -> llm::Request {
        let mut request =
            llm::Request::new(ycoding_ai::route::Route::openai_responses().model(model));
        request.messages = vec![
            llm::Message::user("first"),
            llm::Message::assistant(vec![llm::Part::Text("answer".into())]),
            llm::Message::user("second"),
        ];
        request.messages[1].id = Some("msg_answer".into());
        if let Some(selected) = selected {
            request.provider_options = Some(object(&[(
                "openai",
                object(&[("reasoningEffort", JsonValue::String(selected.into()))]),
            )]));
        }
        request
    }

    #[test]
    fn effort_replay_holds_baseline_and_leaves_task_messages_intact() {
        let mut request = request("gpt-6-sol", Some("high"));
        let original = request.messages.clone();
        let updates = apply(
            &mut request,
            Provider::OpenAI,
            &[Historical {
                index: 1,
                effort: Some("low".into()),
            }],
        );
        assert_eq!(
            effort::selected(&request, Provider::OpenAI).as_deref(),
            Some("low")
        );
        assert_eq!(
            effort::update(&request.messages[2], Provider::OpenAI),
            Some("high")
        );
        assert_eq!(
            request
                .messages
                .iter()
                .filter(|message| effort::update(message, Provider::OpenAI).is_none())
                .cloned()
                .collect::<Vec<_>>(),
            original
        );
        assert_eq!(
            updates.input_start(2),
            2,
            "an update at the continuation boundary remains in the new input"
        );
        assert_eq!(updates.input_start(3), 4);
    }

    #[test]
    fn omitted_baseline_and_repeated_changes_replay_chronologically() {
        let mut request = request("gpt-6-sol", Some("medium"));
        request
            .messages
            .push(llm::Message::assistant(vec![llm::Part::Text(
                "second answer".into(),
            )]));
        request.messages.push(llm::Message::user("third"));
        apply(
            &mut request,
            Provider::OpenAI,
            &[
                Historical {
                    index: 1,
                    effort: None,
                },
                Historical {
                    index: 3,
                    effort: Some("high".into()),
                },
            ],
        );
        assert_eq!(effort::selected(&request, Provider::OpenAI), None);
        assert_eq!(
            request
                .messages
                .iter()
                .filter_map(|message| effort::update(message, Provider::OpenAI))
                .collect::<Vec<_>>(),
            ["high", "medium"]
        );
    }

    #[test]
    fn unknown_astra_default_resets_reconstruction_at_last_omission() {
        let mut request = request("gpt-6-astra", Some("high"));
        request
            .messages
            .extend([llm::Message::assistant(vec![]), llm::Message::user("third")]);
        apply(
            &mut request,
            Provider::OpenAI,
            &[
                Historical {
                    index: 1,
                    effort: Some("low".into()),
                },
                Historical {
                    index: 3,
                    effort: None,
                },
            ],
        );
        assert_eq!(effort::selected(&request, Provider::OpenAI), None);
        assert_eq!(
            effort::update(&request.messages[4], Provider::OpenAI),
            Some("high")
        );
        assert!(
            request.messages[..4]
                .iter()
                .all(|message| effort::update(message, Provider::OpenAI).is_none())
        );
    }

    #[test]
    fn anthropic_defers_changes_until_real_user_input() {
        let mut request = request("claude-opus-5-5", None);
        request.model = ycoding_ai::route::Route::anthropic().model("claude-opus-5-5");
        request.provider_options = Some(parse_json(r#"{"anthropic":{"effort":"high"}}"#).unwrap());
        request.messages[2].volatile = true;
        let history = [Historical {
            index: 1,
            effort: Some("low".into()),
        }];
        apply(&mut request, Provider::Anthropic, &history);
        assert_eq!(request.messages.len(), 3);
        assert_eq!(
            effort::selected(&request, Provider::Anthropic).as_deref(),
            Some("low")
        );
        request.messages[2].volatile = false;
        request.provider_options = Some(parse_json(r#"{"anthropic":{"effort":"high"}}"#).unwrap());
        apply(&mut request, Provider::Anthropic, &history);
        assert_eq!(
            effort::update(&request.messages[2], Provider::Anthropic),
            Some("high")
        );
    }

    fn selection() -> model::Ref {
        model::Ref::decode(
            &parse_json(r#"{"providerID":"openai","id":"gpt-6-sol","variant":"high"}"#).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn retained_request_refs_rebuild_baseline_and_reject_other_authority() {
        use ycoding_store::{
            resources::{Request, RequestTable},
            session::{Document, Message, MessageTable},
        };
        let store = test_support::store();
        let selected = selection();
        let mut old_model = selected.clone();
        old_model.variant = Some("low".into());
        let row = Request {
            id: "request_old".into(),
            session_id: "ses_one".into(),
            input_id: None,
            assistant_message_id: Some("msg_answer".into()),
            connection_identity_digest: Some("account".into()),
            source: "step".into(),
            agent: "build".into(),
            model: Document::from_domain(&old_model).unwrap(),
            route_id: "openai-responses".into(),
            prompt_cache_key: "namespace".into(),
            system_digest: "system".into(),
            tool_digest: "tools".into(),
            request: 1,
            attempts: 1,
            invalidation: "none".into(),
            continuation: "none".into(),
            cache_read_reported: None,
            timing: None,
            cost: None,
            tokens: Document::from_domain(
                &ycoding_schema::token_usage::Info::decode(
                    &parse_json(
                        r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#,
                    )
                    .unwrap(),
                )
                .unwrap(),
            )
            .unwrap(),
            time_created: 1,
            usage_anchor: None,
        };
        store
            .submit(move |tx| {
                MessageTable::insert(
                    tx,
                    &Message {
                        id: "msg_answer".into(),
                        session_id: "ses_one".into(),
                        type_: "assistant".into(),
                        seq: 2,
                        time_created: 1,
                        time_updated: 1,
                        data: JsonValue::Null,
                    },
                )?;
                RequestTable::insert(tx, &row)
            })
            .unwrap()
            .wait()
            .unwrap();
        let session = session::Id::new("ses_one").unwrap();
        let snapshot = store.snapshot().unwrap();
        for (account, namespace, available, expected) in [
            (Some("account"), "namespace", true, 4),
            (Some("other"), "namespace", true, 3),
            (None, "namespace", true, 3),
            (Some("account"), "changed", true, 3),
            (Some("account"), "namespace", false, 3),
        ] {
            let mut request = request("gpt-6-sol", Some("high"));
            prepare(
                &snapshot,
                &session,
                &selected,
                account,
                namespace,
                &mut request,
                |historical| {
                    if !available {
                        return None;
                    }
                    assert_eq!(historical.variant.as_ref().unwrap().as_str(), Some("low"));
                    let mut model = ycoding_ai::route::Route::openai_responses().model("gpt-6-sol");
                    model.defaults.provider_options =
                        Some(parse_json(r#"{"openai":{"reasoningEffort":"low"}}"#).unwrap());
                    Some(model)
                },
            )
            .unwrap();
            assert_eq!(request.messages.len(), expected);
        }
        drop(snapshot);
        store
            .submit(|tx| {
                use ycoding_store::session::{
                    ContextState, ContextStateTable, Revision, RevisionTable,
                };
                RevisionTable::insert(
                    tx,
                    &Revision {
                        session_id: "ses_one".into(),
                        revision: 0,
                        parent_revision: None,
                        manifest_digest: None,
                        covered_through_message_id: None,
                        covered_through_seq: None,
                        activation_event_id: Some("event_compaction".into()),
                        activation_sequence: Some(2),
                        time_created: 1,
                    },
                )?;
                ContextStateTable::insert(
                    tx,
                    &ContextState {
                        session_id: "ses_one".into(),
                        status: "active".into(),
                        revision: 0,
                        manifest_digest: None,
                        covered_through_message_id: None,
                        covered_through_seq: None,
                        activated_event_id: None,
                        time_activated: None,
                        error_code: None,
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();
        let mut request = request("gpt-6-sol", Some("high"));
        prepare(
            &store.snapshot().unwrap(),
            &session,
            &selected,
            Some("account"),
            "namespace",
            &mut request,
            |_| panic!("requests from before the activated compaction cannot establish a baseline"),
        )
        .unwrap();
        assert_eq!(request.messages.len(), 3);
        assert_eq!(
            effort::selected(&request, Provider::OpenAI).as_deref(),
            Some("high")
        );
    }
}
