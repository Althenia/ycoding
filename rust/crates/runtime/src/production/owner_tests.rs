use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::{Semaphore, oneshot};

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

fn failure(stage: &str) -> Failure {
    Failure::Unavailable(stage.to_owned())
}

async fn group(handle: &Handle) -> Handle {
    handle.production_context().unwrap().await.unwrap().handle()
}

#[test]
fn cancellation_before_registration_starts_no_bootstrap_or_library() {
    let runtime = runtime();
    let starts = Arc::new(AtomicUsize::new(0));
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let bootstrap_starts = starts.clone();
            let bootstrap = async {
                handle
                    .register_production(
                        move |_| {
                            Box::pin(async move {
                                bootstrap_starts.fetch_add(1, Ordering::SeqCst);
                            })
                        },
                        |_| Box::pin(async { Report::default() }),
                    )
                    .unwrap()
                    .await
                    .unwrap();
            };
            drop(bootstrap);
            let library = group(&handle).await;
            let starts = starts.clone();
            let unpolled = async move {
                library
                    .register(
                        move |_| {
                            Box::pin(async move {
                                starts.fetch_add(1, Ordering::SeqCst);
                            })
                        },
                        |_| Box::pin(async { Report::default() }),
                    )
                    .unwrap()
                    .await
            };
            drop(unpolled);
        })
    });
    joined.body.unwrap();
    assert!(joined.cleanup.failures.is_empty());
    assert_eq!(starts.load(Ordering::SeqCst), 0);
}

#[test]
fn cancelled_open_closes_a_late_success_without_publishing() {
    let runtime = runtime();
    let calls = Arc::new(AtomicUsize::new(0));
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let library = group(&handle).await;
            let (entered, ready) = oneshot::channel();
            let gate = Arc::new(Semaphore::new(0));
            let request = library
                .register(
                    {
                        let (gate, calls) = (gate.clone(), calls.clone());
                        move |context| {
                            Box::pin(async move {
                                entered.send(()).unwrap();
                                gate.acquire().await.unwrap().forget();
                                context.retain(
                                    Box::new(|| {}),
                                    Box::pin(async move {
                                        calls.fetch_add(1, Ordering::SeqCst);
                                        Report::runtime(Err(failure("late process cleanup")))
                                    }),
                                )
                            })
                        }
                    },
                    |resource| {
                        Box::pin(async move {
                            let _recorded_cleanup = resource.close().await;
                            Report::default()
                        })
                    },
                )
                .unwrap();
            ready.await.unwrap();
            drop(request);
            gate.add_permits(1);
        })
    });
    joined.body.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        joined
            .cleanup
            .failures
            .contains(&OwnerFailure::Runtime(failure("late process cleanup")))
    );
}

#[test]
fn unobserved_ready_result_is_cleaned_by_the_existing_driver() {
    let runtime = runtime();
    let calls = Arc::new(AtomicUsize::new(0));
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let library = group(&handle).await;
            let (returned, ready) = oneshot::channel();
            let request = library
                .register(
                    move |_| {
                        Box::pin(async move {
                            returned.send(()).unwrap();
                            7
                        })
                    },
                    {
                        let calls = calls.clone();
                        move |value| {
                            Box::pin(async move {
                                assert_eq!(value, 7);
                                calls.fetch_add(1, Ordering::SeqCst);
                                Report::default()
                            })
                        }
                    },
                )
                .unwrap();
            ready.await.unwrap();
            drop(request);
        })
    });
    joined.body.unwrap();
    assert!(joined.cleanup.failures.is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn last_wrapper_drop_drives_close_and_releases_the_lease_after_join() {
    let runtime = runtime();
    let lease = Arc::new(());
    let weak = Arc::downgrade(&lease);
    let gate = Arc::new(Semaphore::new(0));
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let library = group(&handle).await;
            let (entered, ready) = oneshot::channel();
            let request = library
                .register(
                    {
                        let gate = gate.clone();
                        move |context| {
                            Box::pin(async move {
                                context.retain(
                                    Box::new(|| {}),
                                    Box::pin(async move {
                                        entered.send(()).unwrap();
                                        gate.acquire().await.unwrap().forget();
                                        drop(lease);
                                        Report::default()
                                    }),
                                )
                            })
                        }
                    },
                    |resource| {
                        Box::pin(async move {
                            let _recorded_cleanup = resource.close().await;
                            Report::default()
                        })
                    },
                )
                .unwrap();
            let resource = request.await.unwrap();
            drop(resource);
            ready.await.unwrap();
            assert!(weak.upgrade().is_some());
            gate.add_permits(1);
        })
    });
    joined.body.unwrap();
    assert!(joined.cleanup.failures.is_empty());
    assert!(weak.upgrade().is_none());
}

#[test]
fn concurrent_repeated_and_cancelled_close_observe_one_outcome() {
    let runtime = runtime();
    let calls = Arc::new(AtomicUsize::new(0));
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let library = group(&handle).await;
            let (entered, ready) = oneshot::channel();
            let gate = Arc::new(Semaphore::new(0));
            let request = library
                .register(
                    {
                        let (gate, calls) = (gate.clone(), calls.clone());
                        move |context| {
                            Box::pin(async move {
                                context.retain(
                                    Box::new(|| {}),
                                    Box::pin(async move {
                                        calls.fetch_add(1, Ordering::SeqCst);
                                        entered.send(()).unwrap();
                                        gate.acquire().await.unwrap().forget();
                                        Report::runtime(Err(failure("one close")))
                                    }),
                                )
                            })
                        }
                    },
                    |resource| {
                        Box::pin(async move {
                            let _recorded_cleanup = resource.close().await;
                            Report::default()
                        })
                    },
                )
                .unwrap();
            let resource = request.await.unwrap();
            let first = resource.close();
            ready.await.unwrap();
            drop(first);
            gate.add_permits(1);
            let (second, third) = tokio::join!(resource.close(), resource.close());
            assert_eq!(second, third);
            assert_eq!(second.result(), Err(failure("one close")));
        })
    });
    joined.body.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        joined.cleanup.failures,
        vec![OwnerFailure::Runtime(failure("one close"))]
    );
}

#[test]
fn production_release_waits_for_admitted_library_jobs_and_late_resource_cleanup() {
    let runtime = runtime();
    let order = Arc::new(Mutex::new(Vec::new()));
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let request = handle
                .register_production(
                    {
                        let order = order.clone();
                        move |context| {
                            Box::pin(async move {
                                let port = context.handle();
                                let resource = context.retain(
                                    context.production_retirement(),
                                    Box::pin(async move {
                                        order.lock().unwrap().push("production");
                                        Report::default()
                                    }),
                                );
                                (port, resource)
                            })
                        }
                    },
                    |(_, resource)| {
                        Box::pin(async move {
                            let _recorded_cleanup = resource.close().await;
                            Report::default()
                        })
                    },
                )
                .unwrap();
            let (library, production) = request.await.unwrap();
            let open_gate = Arc::new(Semaphore::new(0));
            let close_gate = Arc::new(Semaphore::new(0));
            let (entered, ready) = oneshot::channel();
            let (closing, closed) = oneshot::channel();
            let open = library
                .register(
                    {
                        let (open_gate, close_gate, order) =
                            (open_gate.clone(), close_gate.clone(), order.clone());
                        move |context| {
                            Box::pin(async move {
                                entered.send(()).unwrap();
                                open_gate.acquire().await.unwrap().forget();
                                context.retain(
                                    Box::new(|| {}),
                                    Box::pin(async move {
                                        closing.send(()).unwrap();
                                        close_gate.acquire().await.unwrap().forget();
                                        order.lock().unwrap().push("library");
                                        Report::runtime(Err(failure("library dependency")))
                                    }),
                                )
                            })
                        }
                    },
                    |resource| {
                        Box::pin(async move {
                            let _recorded_cleanup = resource.close().await;
                            Report::default()
                        })
                    },
                )
                .unwrap();
            ready.await.unwrap();
            let mut release = production.close();
            assert!(futures_util::poll!(&mut release).is_pending());
            assert!(!library.admitting());
            assert!(
                library
                    .register(
                        |_| Box::pin(async {}),
                        |_| Box::pin(async { Report::default() })
                    )
                    .is_err()
            );
            drop(open);
            open_gate.add_permits(1);
            closed.await.unwrap();
            assert!(order.lock().unwrap().is_empty());
            close_gate.add_permits(1);
            assert_eq!(release.await.result(), Err(failure("library dependency")));
        })
    });
    joined.body.unwrap();
    assert_eq!(*order.lock().unwrap(), vec!["library", "production"]);
    assert_eq!(joined.cleanup.failures.len(), 1);
}

#[test]
fn racing_library_admission_and_retirement_settle_before_production_release() {
    let runtime = runtime();
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            for _ in 0..32 {
                let order = Arc::new(Mutex::new(Vec::new()));
                let request = handle
                    .register_production(
                        {
                            let order = order.clone();
                            move |context| {
                                Box::pin(async move {
                                    let library = context.handle();
                                    let resource = context.retain(
                                        context.production_retirement(),
                                        Box::pin(async move {
                                            order.lock().unwrap().push("production");
                                            Report::default()
                                        }),
                                    );
                                    (library, resource)
                                })
                            }
                        },
                        |(_, resource)| {
                            Box::pin(async move {
                                let _recorded_cleanup = resource.close().await;
                                Report::default()
                            })
                        },
                    )
                    .unwrap();
                let (library, production) = request.await.unwrap();
                let gate = Arc::new(Semaphore::new(0));
                let (entered, ready) = oneshot::channel();
                let (start, starting) = oneshot::channel();
                let worker = {
                    let (library, gate, order) = (library.clone(), gate.clone(), order.clone());
                    std::thread::spawn(move || {
                        entered.send(()).unwrap();
                        starting.blocking_recv().unwrap();
                        library.register(
                            move |context| {
                                Box::pin(async move {
                                    gate.acquire().await.unwrap().forget();
                                    assert!(order.lock().unwrap().is_empty());
                                    context.retain(
                                        Box::new(|| {}),
                                        Box::pin(async move {
                                            let mut order = order.lock().unwrap();
                                            assert!(order.is_empty());
                                            order.push("library");
                                            Report::default()
                                        }),
                                    )
                                })
                            },
                            |resource| {
                                Box::pin(async move {
                                    let _recorded_cleanup = resource.close().await;
                                    Report::default()
                                })
                            },
                        )
                    })
                };
                ready.await.unwrap();
                start.send(()).unwrap();
                let release = production.close();
                let pending = worker.join().unwrap();
                assert!(!library.admitting());
                assert!(
                    library
                        .register(
                            |_| Box::pin(async {}),
                            |_| Box::pin(async { Report::default() })
                        )
                        .is_err()
                );
                gate.add_permits(1);
                assert!(release.await.failures.is_empty());
                if let Ok(mut pending) = pending {
                    assert!(matches!(
                        futures_util::poll!(&mut pending),
                        std::task::Poll::Ready(Err(_))
                    ));
                }
                let order = order.lock().unwrap();
                assert!(
                    order.as_slice() == ["production"]
                        || order.as_slice() == ["library", "production"]
                );
            }
        })
    });
    joined.body.unwrap();
    assert!(joined.cleanup.failures.is_empty());
}

#[test]
fn closing_bootstrap_is_not_its_own_library_dependency() {
    let runtime = runtime();
    let cleanup = Arc::new(AtomicUsize::new(0));
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let request = handle
                .register_production(
                    {
                        let cleanup = cleanup.clone();
                        move |context| {
                            Box::pin(async move {
                                let report = context.drain_library().await;
                                assert!(report.failures.is_empty());
                                cleanup.fetch_add(1, Ordering::SeqCst);
                                11
                            })
                        }
                    },
                    |_| Box::pin(async { Report::default() }),
                )
                .unwrap();
            assert_eq!(request.await.unwrap(), 11);
        })
    });
    joined.body.unwrap();
    assert_eq!(cleanup.load(Ordering::SeqCst), 1);
    assert!(joined.cleanup.failures.is_empty());
}

#[test]
fn independent_bootstrap_groups_do_not_close_each_others_admission() {
    let runtime = runtime();
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let one = group(&handle).await;
            let two = group(&handle).await;
            one.group.as_ref().unwrap().close();
            assert!(!one.admitting());
            assert!(two.admitting());
            let request = two
                .register(
                    |_| Box::pin(async { 23 }),
                    |_| Box::pin(async { Report::default() }),
                )
                .unwrap();
            assert_eq!(request.await.unwrap(), 23);
        })
    });
    joined.body.unwrap();
    assert!(joined.cleanup.failures.is_empty());
}

#[test]
fn operation_and_retirement_panics_preserve_later_cleanup() {
    let runtime = runtime();
    let calls = Arc::new(AtomicUsize::new(0));
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let library = group(&handle).await;
            let request = library
                .register(
                    {
                        let calls = calls.clone();
                        move |context| {
                            Box::pin(async move {
                                let resource = context.retain(
                                    Box::new(|| panic!("synthetic retire")),
                                    Box::pin(async move {
                                        calls.fetch_add(1, Ordering::SeqCst);
                                        Report::runtime(Err(failure("later cleanup")))
                                    }),
                                );
                                drop(resource);
                                panic!("synthetic operation")
                            })
                        }
                    },
                    |_: ()| Box::pin(async { Report::default() }),
                )
                .unwrap();
            assert!(request.await.is_err());
        })
    });
    joined.body.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(joined.cleanup.failures.len(), 3);
    assert!(
        joined
            .cleanup
            .failures
            .contains(&OwnerFailure::Runtime(failure("later cleanup")))
    );
    assert!(
        joined
            .cleanup
            .failures
            .iter()
            .filter_map(|error| match error {
                OwnerFailure::Join(stage) => Some(stage),
                _ => None,
            })
            .all(|stage| !stage.contains("synthetic"))
    );
}

#[test]
fn cleanup_joins_real_composition_from_outside_its_host() {
    let runtime = runtime();
    let host = std::thread::current().id();
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let request = handle
                .register_production(
                    move |context| {
                        Box::pin(async move {
                            let composition =
                                Arc::new(super::super::composition::Composition::start().unwrap());
                            let composition_thread = composition
                                .run(async {
                                    Ok(tokio::spawn(async { std::thread::current().id() })
                                        .await
                                        .unwrap())
                                })
                                .unwrap();
                            context.retain(
                                context.production_retirement(),
                                Box::pin(async move {
                                    assert_ne!(std::thread::current().id(), composition_thread);
                                    assert_ne!(std::thread::current().id(), host);
                                    let work = composition.run(async { Ok(()) });
                                    let close = composition.close();
                                    Report::runtime(super::super::cleanup_results([work, close]))
                                }),
                            )
                        })
                    },
                    |resource| {
                        Box::pin(async move {
                            let _recorded_cleanup = resource.close().await;
                            Report::default()
                        })
                    },
                )
                .unwrap();
            drop(request.await.unwrap());
        })
    });
    joined.body.unwrap();
    assert!(joined.cleanup.failures.is_empty());
}

#[test]
fn scope_unwind_drains_and_weak_ports_do_not_retain_the_owner() {
    let runtime = runtime();
    let calls = Arc::new(AtomicUsize::new(0));
    let saved = Mutex::new(None);
    let joined = ProductionOwner::scope(&runtime, |handle| {
        *saved.lock().unwrap() = Some(handle.clone());
        runtime.block_on(async {
            let library = group(&handle).await;
            let request = library
                .register(
                    {
                        let calls = calls.clone();
                        move |context| {
                            Box::pin(async move {
                                context.retain(
                                    Box::new(|| {}),
                                    Box::pin(async move {
                                        calls.fetch_add(1, Ordering::SeqCst);
                                        Report::default()
                                    }),
                                )
                            })
                        }
                    },
                    |resource| {
                        Box::pin(async move {
                            let _recorded_cleanup = resource.close().await;
                            Report::default()
                        })
                    },
                )
                .unwrap();
            let _resource = request.await.unwrap();
            panic!("synthetic host")
        });
    });
    assert!(joined.body.is_err());
    assert!(joined.cleanup.failures.is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        saved
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .shared
            .upgrade()
            .is_none()
    );
}

#[test]
fn actual_store_owner_survives_body_unwind_until_client_cleanup_joins() {
    use ycoding_core::ycoding_store::{Metadata, Options, Store, native};
    let runtime = runtime();
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([87; 16], 1),
    )
    .unwrap();
    let cleaned = Arc::new(AtomicBool::new(false));
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let library = group(&handle).await;
            let client = store.client();
            let cleaned = cleaned.clone();
            let request = library
                .register(
                    move |context| {
                        Box::pin(async move {
                            context.retain(
                                Box::new(|| {}),
                                Box::pin(async move {
                                    assert!(client.snapshot().is_ok());
                                    cleaned.store(true, Ordering::Release);
                                    Report::default()
                                }),
                            )
                        })
                    },
                    |resource| {
                        Box::pin(async move {
                            let _recorded_cleanup = resource.close().await;
                            Report::default()
                        })
                    },
                )
                .unwrap();
            let _resource = request.await.unwrap();
            panic!("synthetic hosting cancellation")
        })
    });
    assert!(joined.body.is_err());
    assert!(joined.cleanup.failures.is_empty());
    assert!(cleaned.load(Ordering::Acquire));
    store.shutdown().unwrap();
}

#[test]
fn resource_retirement_finishes_before_cleanup_is_polled() {
    let runtime = runtime();
    let retired = Arc::new(AtomicBool::new(false));
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let library = group(&handle).await;
            let request = library
                .register(
                    move |context| {
                        Box::pin(async move {
                            let checked = retired.clone();
                            context.retain(
                                Box::new(move || {
                                    retired.store(true, Ordering::Release);
                                }),
                                Box::pin(async move {
                                    assert!(checked.load(Ordering::Acquire));
                                    Report::default()
                                }),
                            )
                        })
                    },
                    |resource| {
                        Box::pin(async move {
                            let _recorded_cleanup = resource.close().await;
                            Report::default()
                        })
                    },
                )
                .unwrap();
            let resource = request.await.unwrap();
            assert!(resource.close().await.failures.is_empty());
        })
    });
    joined.body.unwrap();
    assert!(joined.cleanup.failures.is_empty());
}

#[test]
fn startup_error_drain_retires_unobserved_library_results_without_cancelling_its_own_result() {
    let runtime = runtime();
    let abandoned = Arc::new(AtomicUsize::new(0));
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let request = handle
                .register_production(
                    {
                        let abandoned = abandoned.clone();
                        move |context| {
                            Box::pin(async move {
                                let (finished, ready) = oneshot::channel();
                                let unobserved = context
                                    .handle()
                                    .register(
                                        move |_| {
                                            Box::pin(async move {
                                                finished.send(()).unwrap();
                                                5
                                            })
                                        },
                                        move |value| {
                                            Box::pin(async move {
                                                assert_eq!(value, 5);
                                                abandoned.fetch_add(1, Ordering::SeqCst);
                                                Report::default()
                                            })
                                        },
                                    )
                                    .unwrap();
                                ready.await.unwrap();
                                assert!(context.drain_library().await.failures.is_empty());
                                drop(unobserved);
                                Err::<(), Failure>(failure("startup failure"))
                            })
                        }
                    },
                    |result| Box::pin(async move { Report::runtime(result) }),
                )
                .unwrap();
            assert_eq!(request.await.unwrap(), Err(failure("startup failure")));
        })
    });
    joined.body.unwrap();
    assert!(joined.cleanup.failures.is_empty());
    assert_eq!(abandoned.load(Ordering::SeqCst), 1);
}

#[test]
fn retiring_a_pending_native_refusal_is_not_a_cleanup_failure() {
    let runtime = runtime();
    let joined = ProductionOwner::scope(&runtime, |handle| {
        runtime.block_on(async {
            let request = handle
                .register_production(
                    move |context| {
                        Box::pin(async move {
                            let library = context.handle();
                            let resource = context.retain(
                                context.production_retirement(),
                                Box::pin(async { Report::default() }),
                            );
                            (library, resource)
                        })
                    },
                    |(_, resource)| {
                        Box::pin(async move {
                            let _recorded_cleanup = resource.close().await;
                            Report::default()
                        })
                    },
                )
                .unwrap();
            let (library, production) = request.await.unwrap();
            let gate = Arc::new(Semaphore::new(0));
            let (entered, ready) = oneshot::channel();
            let pending = library
                .register(
                    {
                        let gate = gate.clone();
                        move |_| {
                            Box::pin(async move {
                                entered.send(()).unwrap();
                                gate.acquire().await.unwrap().forget();
                                Err::<(), ExecutorError>(ExecutorError::new(
                                    -32603,
                                    "synthetic retired authority",
                                ))
                            })
                        }
                    },
                    |_| Box::pin(async { Report::default() }),
                )
                .unwrap();
            ready.await.unwrap();
            let closing = production.close();
            gate.add_permits(1);
            assert!(closing.await.failures.is_empty());
            assert!(pending.await.is_err());
        })
    });
    joined.body.unwrap();
    assert!(joined.cleanup.failures.is_empty());
}
