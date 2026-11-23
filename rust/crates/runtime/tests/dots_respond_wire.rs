mod support;

use support::{
    Client, basic, services, start, text, units,
    wire::{location_scope, refuse},
};
use tokio::time::timeout;
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

const OPERATION: &str = "dots.thread.respond";
const PASSWORD: &str = "synthetic-dots-password";

fn approval() -> v5::DotsThreadRespondRequest {
    v5::DotsThreadRespondRequest {
        params: v5::DotsThreadRespondRequestParams {
            thread_id: text("synthetic-thread"),
            request_id: text("synthetic-request"),
        },
        payload: v5::DotsRequestResponse {
            decision: Some(
                v5::DotsRequestResponseDecision::DotsRequestresponseDecisionDecline as i32,
            ),
            answers: None,
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_auth_gates_dots_respond_without_a_session() {
    timeout(std::time::Duration::from_secs(60), async {
        let server = start(
            services(LocalAuth::with_password(PASSWORD), true),
            standard().unwrap(),
        )
        .await;
        let address = server.address();
        assert_eq!(Client::open(address, &[]).await.err(), Some(401));
        assert_eq!(
            Client::open(address, &[("Authorization", basic("wrong"))])
                .await
                .err(),
            Some(401)
        );

        let mut client = Client::open(address, &[("Authorization", basic(PASSWORD))])
            .await
            .unwrap();
        let error: v5::InvalidRequestError = refuse(
            &mut client,
            OPERATION,
            location_scope("/project"),
            approval(),
        )
        .await;
        assert_eq!(units(error.kind.as_ref().unwrap()), "unavailable");
        assert_eq!(
            units(&error.message),
            "Native Dots services are unavailable"
        );
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dots_respond_rejects_both_or_neither_answer_forms_before_service_lookup() {
    timeout(std::time::Duration::from_secs(60), async {
        let server = start(
            services(LocalAuth::with_password(PASSWORD), true),
            standard().unwrap(),
        )
        .await;
        let mut client = Client::open(server.address(), &[("Authorization", basic(PASSWORD))])
            .await
            .unwrap();
        let mut both = approval();
        both.payload.answers = Some(v5::DotsRequestResponseAnswers {
            entries: vec![v5::DotsRequestResponseAnswersEntry {
                key: text("synthetic-question"),
                value: v5::DotsRequestResponseAnswersEntryValue {
                    items: vec![text("synthetic-answer")],
                },
            }],
        });
        let mut neither = approval();
        neither.payload.decision = None;
        for malformed in [both, neither] {
            let error: v5::InvalidRequestError = refuse(
                &mut client,
                OPERATION,
                location_scope("/project"),
                malformed,
            )
            .await;
            assert_eq!(error.kind, None, "{error:?}");
            assert_eq!(
                units(&error.message),
                "Provide exactly one of decision or answers."
            );
            assert_eq!(error.rejection, None);
        }
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
