use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::watch;
use ycoding_core::platform::{
    computer::Future,
    interaction::{Authority, Driver, Error, Native, Operation, Options},
};

const TARGET: &str = "10000000-0000-4000-8000-000000000001";
const LEASE: &str = "10000000-0000-4000-8000-000000000002";
const ELEMENT: &str = "10000000-0000-4000-8000-000000000003";
const CALL: &str = "10000000-0000-4000-8000-000000000004";

#[test]
fn native_consent_application_stays_forbidden_even_when_allowlisted() {
    use ycoding_core::platform::computer::policy::{Decision, evaluate};
    for bundle in ["app.ycoding.interaction", "APP.YCODING.INTERACTION"] {
        assert_eq!(
            evaluate(bundle, &[bundle.into()]).decision,
            Decision::Forbidden
        );
    }
}

struct Fixture {
    revision: AtomicU64,
    calls: Mutex<Vec<(Operation, Value)>>,
    result: Mutex<Value>,
}
impl Driver for Fixture {
    fn platform(&self) -> &'static str {
        "chrome"
    }
    fn call(
        &self,
        op: Operation,
        input: Value,
        _: watch::Receiver<bool>,
    ) -> Future<'_, Result<Value, Error>> {
        self.calls.lock().unwrap().push((op, input));
        Box::pin(async move {
            Ok(match op {
                Operation::Inventory => {
                    json!([{"kind":"chrome-tab","id":TARGET,"label":"Fixture","origin":"https://example.test","pathname":"/"}])
                }
                Operation::Attach => json!({"id":LEASE}),
                Operation::Observe => {
                    json!({"revision":self.revision.fetch_add(1,Ordering::SeqCst)+1,"pathname":"/","elements":[{"id":ELEMENT,"role":"button","label":"Save","editable":false}]})
                }
                Operation::Perform => self.result.lock().unwrap().clone(),
                Operation::Resume => json!(true),
                Operation::Run => json!({"outcome":"completed","value":42,"logs":[]}),
                Operation::Preview | Operation::Detach => Value::Null,
            })
        })
    }
}
fn fixture() -> (Arc<Authority>, Native, Arc<Fixture>) {
    let authority = Authority::new(Options::default());
    let driver = Arc::new(Fixture {
        revision: AtomicU64::new(0),
        calls: Mutex::new(vec![]),
        result: Mutex::new(json!({"outcome":"applied"})),
    });
    let native = authority.register("chrome", driver.clone()).unwrap();
    (authority, native, driver)
}
async fn activate(authority: &Arc<Authority>, native: &Native) -> String {
    let pending = authority
        .request("ses_fixture", json!({"platform":"chrome"}))
        .unwrap();
    assert_eq!(pending["state"], "pending");
    let candidate = native.pending()[0].clone();
    let proof = json!({"candidateID":candidate["candidateID"],"sessionID":"ses_fixture","targetID":TARGET,"authorization":"native-proof"});
    assert!(!native.approve(proof.clone()).await);
    assert_eq!(
        native
            .inventory(candidate["candidateID"].as_str().unwrap())
            .await
            .len(),
        1
    );
    assert!(native.approve(proof).await);
    pending["generation"].as_str().unwrap().to_owned()
}
#[tokio::test]
async fn consent_generation_revision_and_stop_fence_every_dispatch() {
    let (authority, native, driver) = fixture();
    let generation = activate(&authority, &native).await;
    assert!(authority.observe("ses_other", &generation).await.is_err());
    assert!(!authority.stop("ses_fixture", CALL));
    let action = json!({"platform":"chrome","type":"click","elementID":ELEMENT});
    assert_eq!(
        authority
            .perform("ses_fixture", &generation, 1, CALL, action.clone())
            .await,
        json!({"outcome":"refused","reason":"stale"})
    );
    authority.observe("ses_fixture", &generation).await.unwrap();
    assert_eq!(
        authority
            .perform("ses_fixture", &generation, 1, CALL, action.clone())
            .await,
        json!({"outcome":"applied"})
    );
    assert_eq!(
        authority
            .perform("ses_fixture", &generation, 1, CALL, action)
            .await,
        json!({"outcome":"refused","reason":"stale"})
    );
    assert_eq!(
        driver
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(op, _)| *op == Operation::Perform)
            .count(),
        1
    );
    assert!(authority.stop("ses_fixture", &generation));
    authority.drain().await.unwrap();
    assert_eq!(authority.status("ses_fixture")["cleanup"], "complete");
    assert!(!native.pause(LEASE, "dialog"));
    assert!(!native.resume(LEASE));
    authority.shutdown().await.unwrap();
}
#[tokio::test]
async fn focus_pause_requires_native_resume_and_a_new_observation() {
    let (authority, native, driver) = fixture();
    let generation = activate(&authority, &native).await;
    authority.observe("ses_fixture", &generation).await.unwrap();
    *driver.result.lock().unwrap() = json!({"outcome":"paused","reason":"foreground_required"});
    let action = json!({"platform":"chrome","type":"scroll","deltaY":100});
    assert_eq!(
        authority
            .perform("ses_fixture", &generation, 1, CALL, action.clone())
            .await["outcome"],
        "paused"
    );
    let count = driver.calls.lock().unwrap().len();
    assert!(authority.observe("ses_fixture", &generation).await.is_err());
    assert_eq!(
        authority
            .perform("ses_fixture", &generation, 1, CALL, action)
            .await["outcome"],
        "paused"
    );
    assert_eq!(driver.calls.lock().unwrap().len(), count);
    assert!(!authority.resume("ses_other", &generation).await);
    assert!(authority.resume("ses_fixture", &generation).await);
    assert_eq!(
        authority.observe("ses_fixture", &generation).await.unwrap()["revision"],
        2
    );
    authority.revoke("ses_fixture");
    assert_eq!(authority.status("ses_fixture")["reason"], "permission");
    assert!(!native.resume(LEASE));
    authority.shutdown().await.unwrap();
}
#[tokio::test]
async fn confirmation_is_bound_to_the_exact_action_and_revision() {
    let (authority, native, _) = fixture();
    let generation = activate(&authority, &native).await;
    authority.observe("ses_fixture", &generation).await.unwrap();
    let action = json!({"platform":"chrome","type":"click","elementID":ELEMENT,"destructive":true});
    assert_eq!(
        authority
            .perform("ses_fixture", &generation, 1, CALL, action.clone())
            .await["reason"],
        "confirmation_required"
    );
    assert!(
        authority
            .confirmation("ses_fixture", &generation, 1, action.clone())
            .unwrap()
            .is_none()
    );
    let candidate = native.pending()[0].clone();
    native
        .inventory(candidate["candidateID"].as_str().unwrap())
        .await;
    assert!(native.approve(json!({"candidateID":candidate["candidateID"],"sessionID":"ses_fixture","targetID":TARGET,"authorization":"native-proof"})).await);
    let different = json!({"platform":"chrome","type":"fill","elementID":ELEMENT,"text":"changed","destructive":true});
    assert_eq!(
        authority
            .perform("ses_fixture", &generation, 1, CALL, different)
            .await["reason"],
        "confirmation_required"
    );
    assert_eq!(
        authority
            .perform("ses_fixture", &generation, 1, CALL, action)
            .await["outcome"],
        "applied"
    );
    authority.shutdown().await.unwrap();
}
#[tokio::test]
async fn navigation_cannot_leave_the_granted_path_and_runs_consume_revisions() {
    let (authority, native, driver) = fixture();
    let generation = activate(&authority, &native).await;
    authority.observe("ses_fixture", &generation).await.unwrap();
    for url in ["https://other.test/", "https://example.test/private"] {
        assert_eq!(
            authority
                .perform(
                    "ses_fixture",
                    &generation,
                    1,
                    CALL,
                    json!({"platform":"chrome","type":"navigate","url":url})
                )
                .await["reason"],
            "policy"
        );
    }
    assert_eq!(
        authority
            .run(
                "ses_fixture",
                &generation,
                1,
                json!({"mode":"script","source":"return 42"})
            )
            .await
            .unwrap()["value"],
        42
    );
    assert_eq!(
        authority
            .run(
                "ses_fixture",
                &generation,
                1,
                json!({"mode":"script","source":"return 42"})
            )
            .await
            .unwrap()["reason"],
        "stale"
    );
    assert!(
        !driver
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(op, _)| *op == Operation::Perform)
    );
    authority.shutdown().await.unwrap();
}
