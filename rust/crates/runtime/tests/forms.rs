mod support;

use std::time::Duration;
use support::{wire::*, *};
use v5::form_field::Kind;
use ycoding_protocol::v5;

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn option(value: &str) -> v5::FormOption {
    v5::FormOption {
        value: text(value),
        label: text(&value.to_uppercase()),
        description: None,
    }
}

fn fields() -> Vec<v5::FormField> {
    let field = |kind| v5::FormField { kind: Some(kind) };
    vec![
        field(Kind::Value1(v5::FormStringField {
            key: text("name"),
            title: Some(text("Name")),
            description: Some(text("Who")),
            required: Some(true),
            when: None,
            r#type: 1,
            format: Some(1),
            min_length: Some(1),
            max_length: Some(40),
            pattern: None,
            placeholder: Some(text("Ada")),
            default: None,
            options: None,
            custom: None,
        })),
        field(Kind::Value2(v5::FormNumberField {
            key: text("ratio"),
            title: None,
            description: None,
            required: None,
            when: None,
            r#type: 1,
            minimum: Some(0.0),
            maximum: Some(1.0),
            default: Some(0.5),
        })),
        field(Kind::Value3(v5::FormIntegerField {
            key: text("age"),
            title: None,
            description: None,
            required: None,
            when: Some(v5::FormIntegerFieldWhen {
                items: vec![v5::FormWhen {
                    key: text("name"),
                    op: 2,
                    value: v5::FormWhenValue {
                        kind: Some(v5::form_when_value::Kind::Value1(text("nobody"))),
                    },
                }],
            }),
            r#type: 1,
            minimum: Some(0.0),
            maximum: Some(150.0),
            default: None,
        })),
        field(Kind::Value4(v5::FormBooleanField {
            key: text("ok"),
            title: None,
            description: None,
            required: None,
            when: None,
            r#type: 1,
            default: Some(true),
        })),
        field(Kind::Value5(v5::FormMultiselectField {
            key: text("tags"),
            title: None,
            description: None,
            required: None,
            when: None,
            r#type: 1,
            options: v5::FormMultiselectFieldOptions {
                items: vec![option("a"), option("b")],
            },
            min_items: Some(0),
            max_items: Some(2),
            custom: Some(false),
            default: Some(v5::FormMultiselectFieldDefault {
                items: vec![text("a")],
            }),
        })),
        field(Kind::Value6(v5::FormExternalField {
            key: text("docs"),
            r#type: 1,
            url: text("https://example.test/docs"),
            title: Some(text("Docs")),
            description: None,
        })),
    ]
}

fn payload(id: Option<&str>, fields: Vec<v5::FormField>) -> v5::FormCreatePayload {
    v5::FormCreatePayload {
        id: id.map(text),
        title: text("Profile"),
        metadata: Some(v5::FormMetadata {
            entries: vec![v5::FormMetadataEntry {
                key: text("origin"),
                value: v5::Value {
                    kind: Some(v5::value::Kind::String(text("test"))),
                },
            }],
        }),
        fields: v5::FormFields { items: fields },
    }
}

fn create(session: &str, payload: v5::FormCreatePayload) -> v5::SessionFormCreateRequest {
    v5::SessionFormCreateRequest {
        params: v5::SessionFormCreateRequestParams {
            session_id: text(session),
        },
        payload,
    }
}

fn target(session: &str, form: &str) -> v5::SessionFormGetRequestParams {
    v5::SessionFormGetRequestParams {
        session_id: text(session),
        form_id: text(form),
    }
}

fn state_target(session: &str, form: &str) -> v5::SessionFormStateRequestParams {
    v5::SessionFormStateRequestParams {
        session_id: text(session),
        form_id: text(form),
    }
}

fn reply_target(session: &str, form: &str) -> v5::SessionFormReplyRequestParams {
    v5::SessionFormReplyRequestParams {
        session_id: text(session),
        form_id: text(form),
    }
}

fn cancel_target(session: &str, form: &str) -> v5::SessionFormCancelRequestParams {
    v5::SessionFormCancelRequestParams {
        session_id: text(session),
        form_id: text(form),
    }
}

fn answer(entries: Vec<(&str, v5::form_value::Kind)>) -> v5::FormAnswer {
    v5::FormAnswer {
        entries: entries
            .into_iter()
            .map(|(key, kind)| v5::FormAnswerEntry {
                key: text(key),
                value: v5::FormValue { kind: Some(kind) },
            })
            .collect(),
    }
}

fn status(state: &v5::FormState) -> &'static str {
    match state.kind.as_ref().unwrap() {
        v5::form_state::Kind::Value1(_) => "pending",
        v5::form_state::Kind::Value2(_) => "answered",
        v5::form_state::Kind::Value3(_) => "cancelled",
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn global_forms_are_created_listed_and_settled_in_the_selected_location_only() {
    bounded(async {
        insert_project("prj_global_one", "/global/forms/one").await;
        insert_project("prj_global_two", "/global/forms/two").await;
        let (server, mut client) = open().await;
        let published = world()
            .core
            .events
            .subscribe(ycoding_core::event_feed::Scope::Global, None, || {})
            .unwrap();
        let scope = |directory: &str| v5::Scope {
            target: Some(v5::scope::Target::GlobalForm(v5::GlobalFormScope {
                directory: text(directory),
                workspace_id: None,
            })),
        };
        let created: v5::SessionFormCreateResult = ask(
            &mut client,
            "session.form.create",
            scope("/global/forms/one"),
            create("global", payload(Some("frm_global_scope"), fields())),
        )
        .await;
        assert_eq!(units(&created.data.session_id), "global");
        for (directory, count) in [("/global/forms/one", 1), ("/global/forms/two", 0)] {
            let list: v5::SessionFormListResult = ask(
                &mut client,
                "session.form.list",
                scope(directory),
                v5::SessionFormListRequest {
                    params: v5::SessionFormListRequestParams {
                        session_id: text("global"),
                    },
                },
            )
            .await;
            assert_eq!(list.data.items.len(), count);
        }
        let invalid: v5::InvalidRequestError = refuse(
            &mut client,
            "session.form.list",
            scope("/global/forms/one"),
            v5::SessionFormListRequest {
                params: v5::SessionFormListRequestParams {
                    session_id: text("ses_form_a"),
                },
            },
        )
        .await;
        assert!(units(&invalid.message).contains("global"));
        let id = units(&created.data.id);
        let fetched: v5::SessionFormGetResult = ask(
            &mut client,
            "session.form.get",
            scope("/global/forms/one"),
            v5::SessionFormGetRequest {
                params: target("global", &id),
            },
        )
        .await;
        assert_eq!(fetched.data, created.data);
        let _: v5::FormNotFoundError = refuse(
            &mut client,
            "session.form.get",
            scope("/global/forms/two"),
            v5::SessionFormGetRequest {
                params: target("global", &id),
            },
        )
        .await;
        let pending: v5::SessionFormStateResult = ask(
            &mut client,
            "session.form.state",
            scope("/global/forms/one"),
            v5::SessionFormStateRequest {
                params: state_target("global", &id),
            },
        )
        .await;
        assert_eq!(status(&pending.data), "pending");
        let _: v5::SessionFormReplyResult = ask(
            &mut client,
            "session.form.reply",
            scope("/global/forms/one"),
            v5::SessionFormReplyRequest {
                params: reply_target("global", &id),
                payload: v5::FormReply {
                    answer: answer(vec![
                        (
                            "name",
                            v5::form_value::Kind::Value1(text("ada@example.test")),
                        ),
                        ("docs", v5::form_value::Kind::Value3(true)),
                    ]),
                },
            },
        )
        .await;
        let answered: v5::SessionFormStateResult = ask(
            &mut client,
            "session.form.state",
            scope("/global/forms/one"),
            v5::SessionFormStateRequest {
                params: state_target("global", &id),
            },
        )
        .await;
        assert_eq!(status(&answered.data), "answered");
        let cancelled: v5::SessionFormCreateResult = ask(
            &mut client,
            "session.form.create",
            scope("/global/forms/one"),
            create("global", payload(Some("frm_global_cancel_scope"), fields())),
        )
        .await;
        let _: v5::SessionFormCancelResult = ask(
            &mut client,
            "session.form.cancel",
            scope("/global/forms/one"),
            v5::SessionFormCancelRequest {
                params: v5::SessionFormCancelRequestParams {
                    session_id: text("global"),
                    form_id: cancelled.data.id.clone(),
                },
            },
        )
        .await;
        let list: v5::SessionFormListResult = ask(
            &mut client,
            "session.form.list",
            scope("/global/forms/one"),
            v5::SessionFormListRequest {
                params: v5::SessionFormListRequestParams {
                    session_id: text("global"),
                },
            },
        )
        .await;
        assert!(list.data.items.is_empty());
        let mut settlements = Vec::new();
        while let Some(item) = published.next().unwrap() {
            if let ycoding_core::event_feed::Payload::Ephemeral(event) = &item.payload
                && event.session.is_none()
                && matches!(event.data.name(), "form.replied" | "form.cancelled")
            {
                settlements.push(event.data.name());
            }
        }
        assert_eq!(settlements, ["form.replied", "form.cancelled"]);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forms_round_trip_through_their_session_and_settle_once() {
    bounded(async {
        insert_session("ses_form_a", "/loc/form", None).await;
        insert_session("ses_form_b", "/loc/form", None).await;
        let (server, mut client) = open().await;
        let own = form_scope("ses_form_a");

        let created: v5::SessionFormCreateResult = ask(
            &mut client,
            "session.form.create",
            own.clone(),
            create("ses_form_a", payload(None, fields())),
        )
        .await;
        let id = units(&created.data.id);
        assert!(id.starts_with("frm_"), "{id}");
        assert_eq!(units(&created.data.session_id), "ses_form_a");
        assert_eq!(created.data.fields.items, fields());
        assert_eq!(created.data.metadata, payload(None, vec![]).metadata);

        let fetched: v5::SessionFormGetResult = ask(
            &mut client,
            "session.form.get",
            own.clone(),
            v5::SessionFormGetRequest {
                params: target("ses_form_a", &id),
            },
        )
        .await;
        assert_eq!(fetched.data, created.data);

        let listed: v5::SessionFormListResult = ask(
            &mut client,
            "session.form.list",
            own.clone(),
            v5::SessionFormListRequest {
                params: v5::SessionFormListRequestParams {
                    session_id: text("ses_form_a"),
                },
            },
        )
        .await;
        assert_eq!(listed.data.items, vec![created.data.clone()]);
        let sibling: v5::SessionFormListResult = ask(
            &mut client,
            "session.form.list",
            form_scope("ses_form_b"),
            v5::SessionFormListRequest {
                params: v5::SessionFormListRequestParams {
                    session_id: text("ses_form_b"),
                },
            },
        )
        .await;
        assert!(sibling.data.items.is_empty());
        let location: v5::FormRequestListResult = ask(
            &mut client,
            "form.request.list",
            location_scope("/loc/form"),
            v5::FormRequestListRequest {
                query: query("/loc/form", None),
            },
        )
        .await;
        assert_eq!(units(&location.location.project.id), "prj_one");
        assert_eq!(location.data.items, vec![created.data.clone()]);

        let foreign_get: v5::FormNotFoundError = refuse(
            &mut client,
            "session.form.get",
            form_scope("ses_form_b"),
            v5::SessionFormGetRequest {
                params: target("ses_form_b", &id),
            },
        )
        .await;
        assert_eq!(units(&foreign_get.id), id);
        let _: v5::FormNotFoundError = refuse(
            &mut client,
            "session.form.cancel",
            form_scope("ses_form_b"),
            v5::SessionFormCancelRequest {
                params: cancel_target("ses_form_b", &id),
            },
        )
        .await;

        let state_request = || v5::SessionFormStateRequest {
            params: state_target("ses_form_a", &id),
        };
        let pending: v5::SessionFormStateResult = ask(
            &mut client,
            "session.form.state",
            own.clone(),
            state_request(),
        )
        .await;
        assert_eq!(status(&pending.data), "pending");

        let reply = |entries| v5::SessionFormReplyRequest {
            params: reply_target("ses_form_a", &id),
            payload: v5::FormReply { answer: entries },
        };
        let invalid: v5::FormInvalidAnswerError = refuse(
            &mut client,
            "session.form.reply",
            own.clone(),
            reply(answer(vec![("name", v5::form_value::Kind::Value2(7.0))])),
        )
        .await;
        assert_eq!(units(&invalid.id), id);
        let given = answer(vec![
            (
                "name",
                v5::form_value::Kind::Value1(text("ada@example.test")),
            ),
            ("age", v5::form_value::Kind::Value2(36.0)),
            ("ok", v5::form_value::Kind::Value3(false)),
            ("docs", v5::form_value::Kind::Value3(true)),
            (
                "tags",
                v5::form_value::Kind::Value4(v5::FormValueValue4 {
                    items: vec![text("a"), text("b")],
                }),
            ),
        ]);
        let _: v5::SessionFormReplyResult = ask(
            &mut client,
            "session.form.reply",
            own.clone(),
            reply(given.clone()),
        )
        .await;
        let answered: v5::SessionFormStateResult = ask(
            &mut client,
            "session.form.state",
            own.clone(),
            state_request(),
        )
        .await;
        let Some(v5::form_state::Kind::Value2(settled)) = answered.data.kind else {
            panic!("the form is answered");
        };
        let mut expected = given.entries.clone();
        let mut actual = settled.answer.entries.clone();
        expected.sort_by_key(|entry| units(&entry.key));
        actual.sort_by_key(|entry| units(&entry.key));
        assert_eq!(actual, expected);
        let settled_again: v5::FormAlreadySettledError =
            refuse(&mut client, "session.form.reply", own.clone(), reply(given)).await;
        assert_eq!(units(&settled_again.id), id);
        let _: v5::FormAlreadySettledError = refuse(
            &mut client,
            "session.form.cancel",
            own.clone(),
            v5::SessionFormCancelRequest {
                params: cancel_target("ses_form_a", &id),
            },
        )
        .await;
        let drained: v5::SessionFormListResult = ask(
            &mut client,
            "session.form.list",
            own.clone(),
            v5::SessionFormListRequest {
                params: v5::SessionFormListRequestParams {
                    session_id: text("ses_form_a"),
                },
            },
        )
        .await;
        assert!(
            drained.data.items.is_empty(),
            "settled forms are no longer pending"
        );
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_forms_conflicts_invalid_definitions_and_scope_failures_are_typed() {
    bounded(async {
        insert_session("ses_form_c", "/loc/form-cancel", None).await;
        let (server, mut client) = open().await;
        let scope = form_scope("ses_form_c");
        let created: v5::SessionFormCreateResult = ask(
            &mut client,
            "session.form.create",
            scope.clone(),
            create("ses_form_c", payload(Some("frm_fixed"), fields())),
        )
        .await;
        assert_eq!(units(&created.data.id), "frm_fixed");
        let duplicate: v5::ConflictError = refuse(
            &mut client,
            "session.form.create",
            scope.clone(),
            create("ses_form_c", payload(Some("frm_fixed"), fields())),
        )
        .await;
        assert!(units(&duplicate.message).contains("exists"));
        let duplicated = fields()
            .into_iter()
            .chain(fields().into_iter().take(1))
            .collect();
        let invalid: v5::InvalidRequestError = refuse(
            &mut client,
            "session.form.create",
            scope.clone(),
            create("ses_form_c", payload(None, duplicated)),
        )
        .await;
        assert_eq!(units(invalid.field.as_ref().unwrap()), "fields");
        assert!(units(&invalid.message).contains("Duplicate form field key"));

        let _: v5::SessionFormCancelResult = ask(
            &mut client,
            "session.form.cancel",
            scope.clone(),
            v5::SessionFormCancelRequest {
                params: cancel_target("ses_form_c", "frm_fixed"),
            },
        )
        .await;
        let state: v5::SessionFormStateResult = ask(
            &mut client,
            "session.form.state",
            scope.clone(),
            v5::SessionFormStateRequest {
                params: state_target("ses_form_c", "frm_fixed"),
            },
        )
        .await;
        assert_eq!(status(&state.data), "cancelled");
        let _: v5::FormAlreadySettledError = refuse(
            &mut client,
            "session.form.cancel",
            scope.clone(),
            v5::SessionFormCancelRequest {
                params: cancel_target("ses_form_c", "frm_fixed"),
            },
        )
        .await;

        let global: v5::InvalidRequestError = refuse(
            &mut client,
            "session.form.list",
            form_scope("global"),
            v5::SessionFormListRequest {
                params: v5::SessionFormListRequestParams {
                    session_id: text("global"),
                },
            },
        )
        .await;
        assert!(units(&global.message).contains("Session"));
        let disagree: v5::InvalidRequestError = refuse(
            &mut client,
            "session.form.list",
            form_scope("ses_form_c"),
            v5::SessionFormListRequest {
                params: v5::SessionFormListRequestParams {
                    session_id: text("ses_form_other"),
                },
            },
        )
        .await;
        assert!(units(&disagree.message).contains("disagree"));
        let unknown: v5::SessionNotFoundError = refuse(
            &mut client,
            "session.form.list",
            form_scope("ses_form_missing"),
            v5::SessionFormListRequest {
                params: v5::SessionFormListRequestParams {
                    session_id: text("ses_form_missing"),
                },
            },
        )
        .await;
        assert_eq!(units(&unknown.session_id), "ses_form_missing");
        server.shutdown().await.unwrap();
    })
    .await;
}
