use super::*;
use crate::platform::computer;
use std::{
    io,
    sync::atomic::{AtomicUsize, Ordering},
};

const TARGET: &str = "10000000-0000-4000-8000-000000000001";
const ELEMENT: &str = "10000000-0000-4000-8000-000000000002";
struct Fixture {
    key: &'static str,
    empty: usize,
    attempts: AtomicUsize,
    inventory: tokio::sync::Notify,
    empty_confirm: bool,
}
impl Driver for Fixture {
    fn platform(&self) -> &'static str {
        if self.key == "macos" {
            "macos"
        } else {
            "chrome"
        }
    }
    fn call(
        &self,
        operation: Operation,
        input: Value,
        _: watch::Receiver<bool>,
    ) -> computer::Future<'_, Result<Value, Error>> {
        Box::pin(async move {
            Ok(match operation {
                Operation::Inventory => {
                    let attempt = self.attempts.fetch_add(1, Ordering::SeqCst) + 1;
                    self.inventory.notify_one();
                    if attempt <= self.empty
                        || (self.empty_confirm && input["purpose"] == "confirm")
                    {
                        json!([])
                    } else {
                        json!([if self.key == "macos" {
                            json!({"kind":"macos-window","id":TARGET,"label":"Synthetic","bundleID":"local.synthetic.Example"})
                        } else {
                            json!({"kind":"chrome-isolated","id":TARGET,"label":"Synthetic","url":"https://example.test/approved","origin":"https://example.test","pathname":"/approved"})
                        }])
                    }
                }
                Operation::Attach => json!({"id":TARGET}),
                Operation::Observe => {
                    json!({"revision":1,"elements":[{"id":ELEMENT,"role":"AXButton","label":"Increment","editable":false}]})
                }
                Operation::Perform => json!({"outcome":"applied"}),
                Operation::Preview | Operation::Detach => Value::Null,
                Operation::Resume => json!(true),
                Operation::Run => json!({"outcome":"refused","reason":"unsupported"}),
            })
        })
    }
}
fn fixture(
    key: &'static str,
    empty: usize,
    empty_confirm: bool,
) -> (Arc<Authority>, Native, Arc<Fixture>, Value) {
    let authority = Authority::new(Options::default());
    let driver = Arc::new(Fixture {
        key,
        empty,
        attempts: AtomicUsize::new(0),
        inventory: tokio::sync::Notify::new(),
        empty_confirm,
    });
    let native = authority.register(key, driver.clone()).unwrap();
    let selection = if key == "macos" {
        json!({"platform":"macos"})
    } else {
        json!({"platform":"chrome","mode":"isolated","url":"https://example.test/approved"})
    };
    let status = authority.request("ses_consent", selection).unwrap();
    assert_eq!(status["state"], "pending");
    let request = native.pending()[0].clone();
    (authority, native, driver, request)
}
async fn approve(native: &Native, request: &Value, targets: &[Value]) -> Result<(), ConsentError> {
    if native.approve(json!({"candidateID":request["candidateID"],"sessionID":request["sessionID"],"targetID":targets[0]["id"],"authorization":"synthetic-consent"})).await{Ok(())}else{Err(Error("authority_declined").into())}
}
#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<u8>>>);
impl io::Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn warnings() -> (Output, impl tracing::Subscriber) {
    let output = Output::default();
    let writer = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .without_time()
        .with_target(false)
        .with_max_level(tracing::Level::WARN)
        .with_writer(move || writer.clone())
        .finish();
    (output, subscriber)
}
impl Output {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
    fn rejected(&self, key: &str, purpose: &str, reason: &str) {
        let text = self.text();
        assert_eq!(
            text.matches("Native interaction consent was rejected")
                .count(),
            1,
            "{text}"
        );
        for field in [
            format!("driver=\"{key}\""),
            format!("purpose=\"{purpose}\""),
            "sessionID=\"ses_consent\"".into(),
            format!("reason=\"{reason}\""),
        ] {
            assert!(text.contains(&field), "missing {field}: {text}");
        }
    }
}

#[tokio::test]
async fn empty_inventory_retries_four_times_and_rejects_once() {
    for key in ["macos", "chrome-isolated"] {
        let (output, subscriber) = warnings();
        let _subscriber = tracing::subscriber::set_default(subscriber);
        let (authority, native, driver, request) = fixture(key, usize::MAX, false);
        let cancel = native.cancellation(text(&request, "candidateID")).unwrap();
        native
            .consent(&request, cancel, |_, _| async {
                panic!("empty inventory cannot request consent")
            })
            .await;
        assert_eq!(driver.attempts.load(Ordering::SeqCst), 5);
        assert_eq!(authority.status("ses_consent")["reason"], "rejected");
        output.rejected(key, "attach", "inventory_empty");
        assert!(!native.reject(text(&request, "candidateID")));
        output.rejected(key, "attach", "inventory_empty");
        authority.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn inventory_that_becomes_ready_is_offered_once() {
    for key in ["macos", "chrome-isolated"] {
        let (output, subscriber) = warnings();
        let _subscriber = tracing::subscriber::set_default(subscriber);
        let (authority, native, driver, request) = fixture(key, 1, false);
        let cancel = native.cancellation(text(&request, "candidateID")).unwrap();
        native
            .consent(&request, cancel, |targets, _| {
                let native = &native;
                let request = &request;
                async move { approve(native, request, &targets).await }
            })
            .await;
        assert_eq!(driver.attempts.load(Ordering::SeqCst), 2);
        assert_eq!(authority.status("ses_consent")["state"], "active");
        assert!(output.text().is_empty());
        authority.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn consent_reasons_are_preserved_and_logged_once() {
    for (key, reason) in [
        ("macos", "not_chosen"),
        ("macos", "unverified"),
        ("macos", "error"),
        ("chrome-isolated", "target_mismatch"),
        ("chrome-isolated", "not_confirmed"),
        ("chrome-isolated", "authority_declined"),
    ] {
        let (output, subscriber) = warnings();
        let _subscriber = tracing::subscriber::set_default(subscriber);
        let (authority, native, driver, request) = fixture(key, 0, false);
        let cancel = native.cancellation(text(&request, "candidateID")).unwrap();
        native
            .consent(&request, cancel, |_, _| async { Err(Error(reason).into()) })
            .await;
        assert_eq!(driver.attempts.load(Ordering::SeqCst), 1);
        assert_eq!(authority.status("ses_consent")["reason"], "rejected");
        output.rejected(key, "attach", reason);
        authority.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn empty_confirmation_is_withdrawn_and_a_new_offer_is_allowed() {
    let (output, subscriber) = warnings();
    let _subscriber = tracing::subscriber::set_default(subscriber);
    let (authority, native, _, request) = fixture("macos", 0, true);
    let generation = authority.status("ses_consent")["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    let cancel = native.cancellation(text(&request, "candidateID")).unwrap();
    native
        .consent(&request, cancel, |targets, _| {
            let native = &native;
            let request = &request;
            async move { approve(native, request, &targets).await }
        })
        .await;
    authority.observe("ses_consent", &generation).await.unwrap();
    let action = json!({"platform":"macos","type":"press","elementID":ELEMENT,"destructive":true});
    assert!(
        authority
            .confirmation("ses_consent", &generation, 1, action.clone())
            .unwrap()
            .is_none()
    );
    let request = native.pending()[0].clone();
    let cancel = native.cancellation(text(&request, "candidateID")).unwrap();
    native
        .consent(&request, cancel, |_, _| async {
            panic!("empty confirmation cannot request consent")
        })
        .await;
    output.rejected("macos", "confirm", "inventory_empty");
    assert!(native.pending().is_empty());
    assert_eq!(
        authority
            .perform("ses_consent", &generation, 1, TARGET, action.clone())
            .await["reason"],
        "confirmation_required"
    );
    assert!(
        authority
            .confirmation("ses_consent", &generation, 1, action)
            .unwrap()
            .is_none()
    );
    assert_eq!(native.pending().len(), 1);
    authority.shutdown().await.unwrap();
}

#[tokio::test]
async fn stopping_an_empty_inventory_cancels_retry_without_a_warning() {
    let (output, subscriber) = warnings();
    let _subscriber = tracing::subscriber::set_default(subscriber);
    let (authority, native, driver, request) = fixture("macos", usize::MAX, false);
    let generation = authority.status("ses_consent")["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    let cancel = native.cancellation(text(&request, "candidateID")).unwrap();
    tokio::join!(
        native.consent(&request, cancel, |_, _| async {
            panic!("stopped offer cannot request consent")
        }),
        async {
            driver.inventory.notified().await;
            assert!(authority.stop("ses_consent", &generation));
        }
    );
    assert_eq!(driver.attempts.load(Ordering::SeqCst), 1);
    assert!(output.text().is_empty());
    authority.shutdown().await.unwrap();
}
