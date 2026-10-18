use std::{
    collections::BTreeMap,
    net::IpAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use ycoding_core::mcp_events::{
    Cancellation, HttpRequest, HttpResponse, ResultFuture, Transport,
    protected_http::{Connect, Network, ProtectedHttp, is_public_address},
};

struct StandIn {
    addresses: Mutex<Vec<IpAddr>>,
    lookups: Mutex<Vec<String>>,
    connections: Mutex<Vec<Connect>>,
    status: u16,
    body: String,
    blocked: AtomicBool,
    entered: tokio::sync::Notify,
}

impl StandIn {
    fn new(addresses: &[&str]) -> Self {
        Self {
            addresses: Mutex::new(
                addresses
                    .iter()
                    .map(|value| value.parse().unwrap())
                    .collect(),
            ),
            lookups: Mutex::new(vec![]),
            connections: Mutex::new(vec![]),
            status: 204,
            body: String::new(),
            blocked: AtomicBool::new(false),
            entered: tokio::sync::Notify::new(),
        }
    }
}

impl Network for StandIn {
    fn resolve(&self, host: String, cancellation: Cancellation) -> ResultFuture<'_, Vec<IpAddr>> {
        Box::pin(async move {
            self.lookups.lock().unwrap().push(host);
            self.entered.notify_one();
            if self.blocked.load(Ordering::Acquire) {
                cancellation.cancelled().await;
            }
            Ok(self.addresses.lock().unwrap().clone())
        })
    }
    fn connect(&self, input: Connect, _: Cancellation) -> ResultFuture<'_, HttpResponse> {
        Box::pin(async move {
            self.connections.lock().unwrap().push(input);
            Ok(HttpResponse {
                status: self.status,
                body: self.body.clone(),
            })
        })
    }
}

fn request(url: &str) -> HttpRequest {
    HttpRequest {
        url: url.to_owned(),
        body: r#"{"synthetic":true}"#.to_owned(),
        headers: BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
        timeout_ms: 10_000,
    }
}

#[test]
fn public_address_rules_cover_private_reserved_ipv4_ipv6_and_mapped_bypasses() {
    for address in [
        "0.0.0.0",
        "10.1.2.3",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.168.1.1",
        "192.0.2.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "2001:db8::1",
        "2001::1",
        "2001:10::1",
        "2001:20::1",
    ] {
        assert!(!is_public_address(address.parse().unwrap()), "{address}");
    }
    for address in [
        "8.8.8.8",
        "1.1.1.1",
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
    ] {
        assert!(is_public_address(address.parse().unwrap()), "{address}");
    }
}

#[tokio::test]
async fn every_attempt_resolves_again_and_connects_to_the_validated_address_with_original_tls_name()
{
    let network = Arc::new(StandIn::new(&["8.8.8.8"]));
    let http = ProtectedHttp::with_network(network.clone());
    http.send(
        request("https://callback.invalid:8443/events?q=one"),
        Cancellation::default(),
    )
    .await
    .unwrap();
    *network.addresses.lock().unwrap() = vec!["1.1.1.1".parse().unwrap()];
    http.send(
        request("https://callback.invalid:8443/events?q=one"),
        Cancellation::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        network.lookups.lock().unwrap().as_slice(),
        ["callback.invalid", "callback.invalid"]
    );
    let connects = network.connections.lock().unwrap();
    assert_eq!(connects.len(), 2);
    assert_eq!(connects[0].hostname, "callback.invalid");
    assert_eq!(connects[0].servername, "callback.invalid");
    assert_eq!(connects[0].address, "8.8.8.8".parse::<IpAddr>().unwrap());
    assert_eq!(connects[1].address, "1.1.1.1".parse::<IpAddr>().unwrap());
    assert_eq!(connects[0].port, 8443);
    assert_eq!(connects[0].path, "/events?q=one");
    assert_eq!(connects[0].body, r#"{"synthetic":true}"#);
}

#[tokio::test]
async fn unsafe_urls_empty_dns_and_mixed_public_private_answers_never_connect() {
    for url in [
        "http://callback.invalid",
        "ftp://callback.invalid",
        "https://user:secret@callback.invalid",
        "https://127.0.0.1/events",
        "https://[::1]/events",
    ] {
        let network = Arc::new(StandIn::new(&["8.8.8.8"]));
        let http = ProtectedHttp::with_network(network.clone());
        assert!(
            http.send(request(url), Cancellation::default())
                .await
                .is_err(),
            "{url}"
        );
        assert!(network.connections.lock().unwrap().is_empty());
    }
    for addresses in [
        vec![],
        vec!["127.0.0.1"],
        vec!["8.8.8.8", "10.0.0.1"],
        vec!["2606:4700:4700::1111", "fe80::1"],
    ] {
        let network = Arc::new(StandIn::new(&addresses));
        let http = ProtectedHttp::with_network(network.clone());
        assert!(
            http.send(
                request("https://callback.invalid/events"),
                Cancellation::default()
            )
            .await
            .is_err()
        );
        assert!(network.connections.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn dns_rebinding_to_a_private_address_is_rejected_on_the_next_attempt() {
    let network = Arc::new(StandIn::new(&["8.8.8.8"]));
    let http = ProtectedHttp::with_network(network.clone());
    http.send(request("https://callback.invalid"), Cancellation::default())
        .await
        .unwrap();
    *network.addresses.lock().unwrap() = vec!["127.0.0.1".parse().unwrap()];
    assert!(
        http.send(request("https://callback.invalid"), Cancellation::default())
            .await
            .is_err()
    );
    assert_eq!(network.connections.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn redirects_are_returned_without_following_and_both_bodies_obey_the_byte_limit() {
    let network = Arc::new(StandIn {
        status: 302,
        body: "redirect".to_owned(),
        ..StandIn::new(&["8.8.8.8"])
    });
    let http = ProtectedHttp::with_network(network.clone());
    assert_eq!(
        http.send(request("https://callback.invalid"), Cancellation::default())
            .await
            .unwrap()
            .status,
        302
    );
    assert_eq!(network.connections.lock().unwrap().len(), 1);
    let mut large = request("https://callback.invalid");
    large.body = "x".repeat(262_145);
    assert!(http.send(large, Cancellation::default()).await.is_err());
    assert_eq!(network.connections.lock().unwrap().len(), 1);
    let network = Arc::new(StandIn {
        body: "é".repeat(131_073),
        ..StandIn::new(&["8.8.8.8"])
    });
    assert!(
        ProtectedHttp::with_network(network)
            .send(request("https://callback.invalid"), Cancellation::default())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn cancellation_interrupts_dns_and_the_attempt_deadline_includes_resolution() {
    let network = Arc::new(StandIn::new(&["8.8.8.8"]));
    network.blocked.store(true, Ordering::Release);
    let http = ProtectedHttp::with_network(network.clone());
    let cancelled = Cancellation::default();
    let task = tokio::spawn({
        let cancelled = cancelled.clone();
        async move {
            http.send(request("https://callback.invalid"), cancelled)
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(3), network.entered.notified())
        .await
        .unwrap();
    cancelled.cancel();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(network.connections.lock().unwrap().is_empty());
    let mut short = request("https://callback.invalid");
    short.timeout_ms = 1;
    assert!(
        tokio::time::timeout(
            Duration::from_secs(3),
            ProtectedHttp::with_network(network.clone()).send(short, Cancellation::default())
        )
        .await
        .unwrap()
        .is_err()
    );
    assert!(network.connections.lock().unwrap().is_empty());
}
