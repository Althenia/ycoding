mod support;

use prost::{Message, Name};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use support::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};
use ycoding_core::ycoding_schema::{
    DomainDecode, model, parse_json, provider, provider_usage, schema::NonNegativeInt,
};
use ycoding_core::ycoding_store::{
    KeyPart,
    resources::{Request, RequestTable, Secret},
    session::{Document, SessionTable},
    tuple_key,
};
use ycoding_core::{
    resources::{credential, model::quota},
    session::usage_read::{Pricing, PricingRef},
};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, ProviderUsageServices, standard};

fn location(directory: &str) -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Location(text(directory))),
    }
}

async fn seed() {
    let baseline = world()
        .store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&"ses_get".into())]))
        .unwrap()
        .unwrap();
    let rows = (0..3)
        .map(|index| {
            let mut row = baseline.clone();
            row.id = format!("ses_usage_op_{index}").as_str().into();
            row.directory = if index == 2 {
                "/other".into()
            } else {
                "/project".into()
            };
            row.parent_id = (index == 1).then(|| "ses_usage_op_0".into());
            row.time_archived = (index == 2).then_some(1);
            row
        })
        .collect::<Vec<_>>();
    let requests = rows
        .iter()
        .enumerate()
        .map(|(index, session)| Request {
            id: format!("prq_usage_op_{index}").as_str().into(),
            session_id: session.id.clone(),
            input_id: None,
            assistant_message_id: None,
            connection_identity_digest: None,
            source: if index == 1 {
                "title".into()
            } else {
                "step".into()
            },
            agent: "build".into(),
            model: Document::from_domain(&model::Ref {
                id: format!("model_{index}").as_str().into(),
                provider_id: provider::Id("openai".into()),
                variant: None,
                profile: None,
            })
            .unwrap(),
            route_id: "private-route".into(),
            prompt_cache_key: "private-namespace".into(),
            system_digest: "private-system".into(),
            tool_digest: "private-tool".into(),
            request: 1,
            attempts: 1,
            invalidation: "first-request".into(),
            continuation: "full".into(),
            cache_read_reported: Some(1),
            timing: None,
            cost: (index != 2).then_some(index as f64),
            tokens: Document::new(
                parse_json(r#"{"input":10,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}"#)
                    .unwrap(),
            )
            .unwrap(),
            time_created: [1_761_438_600_000, 1_761_442_200_000, 1_761_445_800_000][index],
        })
        .collect::<Vec<_>>();
    world()
        .store
        .submit(move |tx| {
            for row in &rows {
                SessionTable::insert(tx, row)?;
            }
            for row in &requests {
                RequestTable::insert(tx, row)?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
}

fn report_query(group: i32) -> v5::UsageReportRequestQuery {
    v5::UsageReportRequestQuery {
        group,
        time_zone: None,
        from: None,
        to: None,
        offset: None,
        limit: None,
        sort: None,
        order: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backend_reads_are_global_preserve_queries_prices_and_validate_zones_on_the_wire() {
    timeout(Duration::from_secs(60), async {
        seed().await;
        let mut config = services(LocalAuth::disabled(), true);
        config.core.as_mut().unwrap().usage_pricer = Some(Arc::new(|reference: &PricingRef| {
            assert_eq!(reference.directory.as_str(), Some("/other"));
            Some(Pricing {
                provider: vec![
                    model::Cost::decode(
                        &parse_json(r#"{"input":200000,"output":0,"cache":{"read":0,"write":0}}"#)
                            .unwrap(),
                    )
                    .unwrap(),
                ],
                router: vec![],
            })
        }));
        let server = start(config, standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let summary: v5::UsageGetResult = success(
            client
                .call(
                    "usage.get",
                    machine(),
                    v5::UsageGetRequest {}.encode_to_vec(),
                )
                .await,
        );
        assert_eq!(
            (
                summary.data.logical,
                summary.data.physical,
                summary.data.helpers
            ),
            (3, 3, 1)
        );
        assert_eq!(summary.data.cost, Some(3.0));
        assert_eq!(summary.data.tokens.reasoning, 9.0);
        assert_eq!(
            summary.data.models.unwrap().items[0].cost_provenance,
            Some(2)
        );
        let report: v5::UsageReportResult = success(
            client
                .call(
                    "usage.report",
                    machine(),
                    v5::UsageReportRequest {
                        query: v5::UsageReportRequestQuery {
                            time_zone: Some(text("Asia/Kathmandu")),
                            from: Some(1_761_438_600_000),
                            to: Some(1_761_445_800_001),
                            offset: Some(1),
                            limit: Some(1),
                            sort: Some(3),
                            order: Some(2),
                            ..report_query(5)
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert_eq!(report.data.row_count, 3);
        assert_eq!(report.data.next_offset, Some(2));
        assert_eq!(units(&report.data.rows.items[0].key), "ses_usage_op_1");
        assert_eq!(report.data.total.logical, 3);
        assert_eq!(report.data.total.cost, Some(3.0));
        let bytes = report.encode_to_vec();
        for private in [
            "private-route",
            "private-namespace",
            "private-system",
            "private-tool",
            "prq_usage_op",
        ] {
            assert!(!String::from_utf8_lossy(&bytes).contains(private));
        }
        let zoned: v5::UsageReportResult = success(
            client
                .call(
                    "usage.report",
                    machine(),
                    v5::UsageReportRequest {
                        query: v5::UsageReportRequestQuery {
                            time_zone: Some(text("Europe/Berlin")),
                            ..report_query(2)
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert_eq!(
            zoned
                .data
                .rows
                .items
                .iter()
                .map(|r| units(&r.key))
                .collect::<Vec<_>>(),
            [
                "2025-10-26T02:00:00+02:00",
                "2025-10-26T02:00:00+01:00",
                "2025-10-26T03:00:00+01:00"
            ]
        );
        let invalid = rejected(
            client
                .call(
                    "usage.report",
                    machine(),
                    v5::UsageReportRequest {
                        query: v5::UsageReportRequestQuery {
                            time_zone: Some(text("Mars/Olympus_Mons")),
                            ..report_query(1)
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        let error = v5::InvalidRequestError::decode(invalid.payload.as_slice()).unwrap();
        assert_eq!(error.field.as_ref().map(units).as_deref(), Some("timeZone"));
        assert_eq!(units(&error.message), "Invalid IANA time zone");
        for name in ["usage.get", "usage.report"] {
            let roles = operation(name).roles;
            for role in [
                v5::PeerRole::LocalClient,
                v5::PeerRole::RemoteClient,
                v5::PeerRole::Relay,
            ] {
                assert!(roles.contains(&(role as i32)));
            }
        }
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

fn query(refresh: Option<bool>) -> v5::ProviderUsageQuery {
    v5::ProviderUsageQuery {
        location: None,
        refresh,
    }
}

async fn get(
    client: &mut Client,
    directory: &str,
    provider: &str,
    refresh: Option<bool>,
) -> v5::ProviderUsageGetResult {
    success(
        client
            .call(
                "providerUsage.get",
                location(directory),
                v5::ProviderUsageGetRequest {
                    params: v5::ProviderUsageGetRequestParams {
                        provider_id: text(provider),
                    },
                    query: query(refresh),
                }
                .encode_to_vec(),
            )
            .await,
    )
}

fn observe(service: &quota::Service, used: Option<f64>) {
    service
        .observe(
            provider_usage::Observation {
                provider_id: provider::Id("muse".into()),
                label: "Muse (Meta)".into(),
                source: "response_stream".into(),
                stability: "observed".into(),
                observed_at: NonNegativeInt::new(100).unwrap(),
                windows: vec![provider_usage::Window {
                    id: "window".into(),
                    label: "5-hour window".into(),
                    unit: "percent".into(),
                    used,
                    limit: None,
                    remaining: None,
                    unlimited: None,
                    reset_at: Some(NonNegativeInt::new(1791876076000).unwrap()),
                    period_seconds: Some(NonNegativeInt::new(18000).unwrap()),
                }],
            },
            None,
        )
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quotas_are_location_owned_normalized_and_best_effort_with_stale_and_partial_failures() {
    timeout(Duration::from_secs(60), async {
        let credentials = credential::Service::new(world().store.clone());
        let secret = Secret::new(parse_json(r#"{"type":"key","key":"synthetic-private-key"}"#).unwrap()).unwrap();
        for (provider, id) in [("openrouter", "private-credential-router"), ("opencode-go", "private-credential-go")] {
            credentials.create(id.into(), provider.into(), Some("Work".into()), secret.clone(), 1).await.unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let worker = tokio::spawn(async move {
            for (path, status, body) in [
                ("/key", 200, r#"{"data":{"usage_daily":0,"limit":null,"limit_remaining":null,"email":"private@example.invalid","credentialID":"private-credential-router"}}"#),
                ("/credits", 403, "{}"),
                ("/key", 503, r#"{"token":"synthetic-private-key"}"#),
                ("/usage", 503, r#"{"email":"private@example.invalid"}"#),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = vec![0; 8192];
                let size = socket.read(&mut bytes).await.unwrap();
                assert!(String::from_utf8_lossy(&bytes[..size]).starts_with(&format!("GET {path} HTTP/1.1")));
                socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let quota = Arc::new(quota::Service::new(credentials.clone(), quota::Endpoints(BTreeMap::from([("openrouter".into(), endpoint.clone()), ("opencode-go".into(), endpoint)]))).unwrap());
        let other = Arc::new(quota::Service::new(credentials, quota::Endpoints::default()).unwrap());
        observe(&quota, Some(0.0));
        observe(&other, None);
        let mut config = services(LocalAuth::disabled(), true);
        config.core.as_mut().unwrap().provider_usage = Some(Arc::new({
            let quota = quota.clone(); let other = other.clone();
            move |info| Ok(ProviderUsageServices {
                quota: if info.directory.as_lossless().as_str() == Some("/project") { quota.clone() } else { other.clone() },
                providers: ["muse", "openrouter", "opencode-go"].map(|id| provider::Id(id.into())).to_vec(),
            })
        }));
        let server = start(config, standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let first = get(&mut client, "/project", "openrouter", None).await;
        assert_eq!(units(&first.location.directory), "/project");
        assert_eq!((first.data.status, first.data.source, first.data.stability), (1, 1, 1));
        let window = &first.data.windows.items[0];
        assert_eq!((window.used, window.limit, window.remaining), (Some(0.0), None, None));
        let stale = get(&mut client, "/project", "openrouter", Some(true)).await;
        assert_eq!((stale.data.status, stale.data.source, stale.data.stability), (2, 1, 1));
        assert_eq!(stale.data.windows.items[0].used, Some(0.0));
        assert_eq!(stale.data.message.as_ref().map(units).as_deref(), Some("Provider usage refresh failed"));
        let muse = get(&mut client, "/project", "muse", Some(true)).await;
        assert_eq!((muse.data.source, muse.data.stability), (6, 3));
        assert_eq!(muse.data.windows.items[0].used, Some(0.0));
        assert_eq!(units(&muse.data.windows.items[0].label), "5-hour window");
        assert_eq!(muse.data.windows.items[0].reset_at, Some(1791876076000));
        let absent = get(&mut client, "/project/team", "muse", Some(false)).await;
        assert_eq!(units(&absent.location.directory), "/project/team");
        assert_eq!(absent.data.windows.items[0].used, None);
        let list: v5::ProviderUsageListResult = success(client.call("providerUsage.list", location("/project"), v5::ProviderUsageListRequest { query: query(Some(false)) }.encode_to_vec()).await);
        assert_eq!(list.data.items.len(), 3);
        assert_eq!(list.data.items.iter().find(|snapshot| units(&snapshot.provider_id) == "opencode-go").unwrap().status, 5);
        assert_eq!(list.data.items.iter().find(|snapshot| units(&snapshot.provider_id) == "muse").unwrap().status, 1);
        for bytes in [first.encode_to_vec(), stale.encode_to_vec(), list.encode_to_vec()] {
            let payload = String::from_utf8_lossy(&bytes);
            for private in ["synthetic-private-key", "private-credential", "private@example", "usage_daily", "limit_remaining", "authorization"] { assert!(!payload.contains(private)); }
        }
        let mismatch = rejected(client.call("providerUsage.list", location("/project"), v5::ProviderUsageListRequest { query: v5::ProviderUsageQuery { location: Some(v5::ProviderUsageQueryLocation { directory: Some(text("/other")), workspace: None }), refresh: None } }.encode_to_vec()).await);
        assert_eq!(mismatch.type_name, v5::InvalidRequestError::full_name());
        worker.await.unwrap();
        server.shutdown().await.unwrap();
        quota.shutdown().await.unwrap(); other.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quota_resolver_absence_is_typed_unavailable_and_muse_without_observation_is_unreported() {
    timeout(Duration::from_secs(30), async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let error = rejected(
            client
                .call(
                    "providerUsage.list",
                    location("/project"),
                    v5::ProviderUsageListRequest { query: query(None) }.encode_to_vec(),
                )
                .await,
        );
        assert_eq!(error.type_name, v5::ServiceUnavailableError::full_name());
        server.shutdown().await.unwrap();
        let quota = Arc::new(
            quota::Service::new(
                credential::Service::new(world().store.clone()),
                quota::Endpoints::default(),
            )
            .unwrap(),
        );
        let mut config = services(LocalAuth::disabled(), true);
        config.core.as_mut().unwrap().provider_usage = Some(Arc::new({
            let quota = quota.clone();
            move |_| {
                Ok(ProviderUsageServices {
                    quota: quota.clone(),
                    providers: vec![provider::Id("muse".into())],
                })
            }
        }));
        let server = start(config, standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let unreported = get(&mut client, "/project", "muse", Some(true)).await;
        assert_eq!(
            (
                unreported.data.status,
                unreported.data.source,
                unreported.data.stability
            ),
            (3, 6, 3)
        );
        assert!(unreported.data.windows.items.is_empty());
        assert_eq!(
            unreported.data.message.as_ref().map(units).as_deref(),
            Some("Quota is reported after the next Muse response")
        );
        server.shutdown().await.unwrap();
        quota.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn muse_list_keeps_each_profile_and_the_unbound_observation_separate() {
    timeout(Duration::from_secs(30), async {
        let store = ycoding_core::ycoding_store::Store::disposable(
            ycoding_core::ycoding_store::Options::core(),
            ycoding_core::ycoding_store::Catalog::new(
                1,
                ycoding_core::ycoding_store::resources::TABLES,
            ),
            ycoding_core::ycoding_store::Metadata::new([11; 16], 1),
        )
        .unwrap();
        let credentials = credential::Service::new(store.client());
        let secret =
            Secret::new(parse_json(r#"{"type":"key","key":"fixture-muse-key"}"#).unwrap()).unwrap();
        let quota = Arc::new(
            quota::Service::new(credentials.clone(), quota::Endpoints::default()).unwrap(),
        );
        for (index, label) in ["Work", "Personal"].iter().enumerate() {
            let saved = credentials
                .create(
                    format!("private-profile-{index}").as_str().into(),
                    "muse".into(),
                    Some((*label).into()),
                    secret.clone(),
                    1,
                )
                .await
                .unwrap();
            quota
                .observe(
                    provider_usage::Observation {
                        provider_id: provider::Id("muse".into()),
                        label: "Muse (Meta)".into(),
                        source: "response_stream".into(),
                        stability: "observed".into(),
                        observed_at: NonNegativeInt::new(100).unwrap(),
                        windows: vec![provider_usage::Window {
                            id: "weekly".into(),
                            label: "Weekly".into(),
                            unit: "percent".into(),
                            used: Some(index as f64),
                            limit: None,
                            remaining: None,
                            unlimited: None,
                            reset_at: None,
                            period_seconds: Some(NonNegativeInt::new(604800).unwrap()),
                        }],
                    },
                    Some(ycoding_core::resources::model::account_identity(&saved)),
                )
                .unwrap();
        }
        observe(&quota, Some(9.0));
        let mut config = services(LocalAuth::disabled(), true);
        config.core.as_mut().unwrap().provider_usage = Some(Arc::new({
            let quota = quota.clone();
            move |_| {
                Ok(ProviderUsageServices {
                    quota: quota.clone(),
                    providers: vec![provider::Id("muse".into()), provider::Id("muse".into())],
                })
            }
        }));
        let server = start(config, standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let list: v5::ProviderUsageListResult = success(
            client
                .call(
                    "providerUsage.list",
                    location("/project"),
                    v5::ProviderUsageListRequest {
                        query: query(Some(true)),
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert_eq!(list.data.items.len(), 3);
        assert_eq!(
            list.data
                .items
                .iter()
                .map(|snapshot| (
                    snapshot.profile.as_ref().map(units),
                    snapshot.windows.items[0].used
                ))
                .collect::<Vec<_>>(),
            [
                (Some("Personal".into()), Some(1.0)),
                (Some("Work".into()), Some(0.0)),
                (None, Some(9.0))
            ]
        );
        assert!(!String::from_utf8_lossy(&list.encode_to_vec()).contains("private-profile"));
        server.shutdown().await.unwrap();
        quota.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
