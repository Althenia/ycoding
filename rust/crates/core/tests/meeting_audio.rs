use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, Semaphore};
use ycoding_core::meeting::audio::{
    Accepted, AudioError, AudioInput, AudioProcessor, Gap, Options, reconcile_overlap,
};
use ycoding_core::meeting::pcm::{AudioChunk, AudioSource};

type Chunks = Arc<Mutex<Vec<AudioChunk>>>;
type Gaps = Arc<Mutex<Vec<Gap>>>;

#[tokio::test]
async fn one_hour_of_packets_stays_bounded_and_preserves_the_terminal_timestamp() {
    bounded(async {
        let windows = Arc::new(Mutex::new(Vec::new()));
        let recorded = windows.clone();
        let audio = AudioProcessor::new(Options {
            chunk_seconds: 15.0,
            overlap_seconds: 2.0,
            sample_rate: 16_000,
            vad: false,
            max_buffered_seconds: Some(60.0),
            on_chunk: Arc::new(move |chunk| {
                let recorded = recorded.clone();
                Box::pin(async move {
                    recorded.lock().unwrap().push((
                        chunk.start_ms,
                        chunk.start_ms + chunk.samples.len() as f64 / 16.0,
                    ));
                    Ok(())
                })
            }),
            on_gap: Arc::new(|_| panic!("Unexpected gap")),
        })
        .unwrap();
        for sequence in 0..3600 {
            audio
                .push(packet(
                    sequence,
                    sequence as f64 * 1000.0,
                    16_000,
                    vec![0.1; 16_000],
                ))
                .await
                .unwrap();
            assert!(audio.stats().buffered_seconds <= 60.0);
        }
        audio.close().await.unwrap();
        let windows = windows.lock().unwrap();
        assert_eq!(windows.first().unwrap().0, 0.0);
        assert_eq!(windows.last().unwrap().1, 3_600_000.0);
        assert!(windows.windows(2).all(|pair| pair[1].0 <= pair[0].1));
        assert_eq!(audio.stats().backlog, 0);
    })
    .await;
}

async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .expect("audio test exceeded 20 seconds")
}

fn packet(sequence: u64, start_ms: f64, rate: u32, samples: Vec<f32>) -> AudioInput {
    AudioInput {
        capture_id: "capture".into(),
        source: AudioSource::Remote,
        sequence,
        start_ms,
        sample_rate: rate,
        samples,
    }
}

fn first() -> AudioInput {
    packet(0, 1000.0, 8000, vec![0.2; 8000])
}

fn options(chunks: &Chunks) -> Options {
    let chunks = chunks.clone();
    Options {
        chunk_seconds: 1.0,
        overlap_seconds: 0.25,
        sample_rate: 8000,
        vad: false,
        max_buffered_seconds: None,
        on_chunk: Arc::new(move |chunk| {
            let chunks = chunks.clone();
            Box::pin(async move {
                chunks.lock().unwrap().push(chunk);
                Ok(())
            })
        }),
        on_gap: Arc::new(|_| {}),
    }
}

fn failing(attempts: &Arc<AtomicUsize>, fail: &Arc<AtomicBool>, message: &'static str) -> Options {
    let attempts = attempts.clone();
    let fail = fail.clone();
    Options {
        on_chunk: Arc::new(move |_| {
            let attempts = attempts.clone();
            let fail = fail.clone();
            Box::pin(async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                if fail.load(Ordering::SeqCst) {
                    Err(message.into())
                } else {
                    Ok(())
                }
            })
        }),
        ..options(&Chunks::default())
    }
}

fn gated(chunks: &Chunks, entered: &Arc<Notify>, gate: &Arc<Semaphore>) -> Options {
    let recorded = chunks.clone();
    let entered = entered.clone();
    let gate = gate.clone();
    Options {
        on_chunk: Arc::new(move |chunk| {
            let recorded = recorded.clone();
            let entered = entered.clone();
            let gate = gate.clone();
            Box::pin(async move {
                entered.notify_one();
                gate.acquire().await.unwrap().forget();
                recorded.lock().unwrap().push(chunk);
                Ok(())
            })
        }),
        max_buffered_seconds: Some(1.75),
        ..options(chunks)
    }
}

fn shape(chunks: &Chunks) -> Vec<(f64, usize)> {
    chunks
        .lock()
        .unwrap()
        .iter()
        .map(|chunk| (chunk.start_ms, chunk.samples.len()))
        .collect()
}

fn sine(rate: u32, frequency: f64, count: usize) -> Vec<f32> {
    (0..count)
        .map(|index| {
            (2.0 * std::f64::consts::PI * frequency * index as f64 / f64::from(rate)).sin() as f32
        })
        .collect()
}

#[tokio::test]
async fn resampled_samples_stay_normalized_within_the_worker_input_contract() {
    bounded(async {
        let chunks = Chunks::default();
        let audio = AudioProcessor::new(Options {
            sample_rate: 16000,
            overlap_seconds: 0.0,
            ..options(&chunks)
        })
        .unwrap();
        let square = (0..48000)
            .map(|index| {
                if (2.0 * std::f64::consts::PI * 500.0 * f64::from(index) / 48000.0).sin() >= 0.0 {
                    1.0
                } else {
                    -1.0
                }
            })
            .collect();
        audio.push(packet(0, 1000.0, 48000, square)).await.unwrap();
        audio.close().await.unwrap();
        let chunks = chunks.lock().unwrap();
        assert_eq!(chunks.len(), 1);
        assert!(
            chunks[0]
                .samples
                .iter()
                .all(|sample| sample.is_finite() && sample.abs() <= 1.0)
        );
    })
    .await;
}

#[tokio::test]
async fn closing_failed_audio_does_not_infer_again_and_retains_it_for_explicit_drain() {
    bounded(async {
        let attempts = Arc::new(AtomicUsize::new(0));
        let fail = Arc::new(AtomicBool::new(true));
        let audio =
            AudioProcessor::new(failing(&attempts, &fail, "Original inference failure")).unwrap();
        let error = audio.push(first()).await.unwrap_err();
        assert_eq!(error.to_string(), "Original inference failure");
        let error = audio.close().await.unwrap_err();
        assert_eq!(error.to_string(), "Original inference failure");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        let stats = audio.stats();
        assert_eq!(stats.backlog, 1);
        assert_eq!(stats.error.as_deref(), Some("Original inference failure"));
        fail.store(false, Ordering::SeqCst);
        audio.drain(true).await.unwrap();
        audio.close().await.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    })
    .await;
}

#[tokio::test]
async fn emits_stable_overlapping_windows_and_flushes_only_new_tail_audio() {
    bounded(async {
        let chunks = Chunks::default();
        let audio = AudioProcessor::new(options(&chunks)).unwrap();
        audio
            .push(packet(0, 1000.0, 8000, vec![0.2; 16000]))
            .await
            .unwrap();
        audio.flush().await.unwrap();
        assert_eq!(
            shape(&chunks),
            vec![(1000.0, 8000), (1750.0, 8000), (2500.0, 4000)]
        );
        {
            let chunks = chunks.lock().unwrap();
            assert_eq!(chunks[0].samples[6000..], chunks[1].samples[..2000]);
            let ids = chunks
                .iter()
                .map(|chunk| chunk.id.clone())
                .collect::<std::collections::HashSet<_>>();
            assert_eq!(ids.len(), 3);
            assert!(chunks.iter().all(|chunk| chunk.id.len() == 64));
        }
        assert!((audio.stats().processed_seconds - 2.0).abs() < 1e-9);
        audio.flush().await.unwrap();
        assert_eq!(chunks.lock().unwrap().len(), 3);
        audio.close().await.unwrap();
        assert_eq!(audio.stats().buffered_seconds, 0.0);
        let error = audio
            .push(packet(1, 2000.0, 8000, vec![0.2; 8000]))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("closed"), "{error}");
    })
    .await;
}

#[tokio::test]
async fn replays_idempotently_and_rejects_changed_duplicates_and_regressing_clocks() {
    bounded(async {
        let chunks = Chunks::default();
        let audio = AudioProcessor::new(options(&chunks)).unwrap();
        audio.push(first()).await.unwrap();
        assert_eq!(
            audio.push(first()).await.unwrap(),
            Accepted { duplicate: true }
        );
        let changed = packet(0, 1000.0, 8000, vec![0.3; 8000]);
        let error = audio.push(changed).await.unwrap_err();
        assert!(error.to_string().contains("duplicate"), "{error}");
        let error = audio
            .push(packet(1, 900.0, 8000, vec![0.2; 8000]))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("clock"), "{error}");
        let mut microphone = packet(0, 3000.0, 8000, vec![0.2; 8000]);
        microphone.source = AudioSource::Microphone;
        audio.push(microphone).await.unwrap();
        let starts = chunks
            .lock()
            .unwrap()
            .iter()
            .map(|chunk| chunk.start_ms)
            .collect::<Vec<_>>();
        assert_eq!(starts, vec![1000.0, 3000.0]);
        audio.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn energy_vad_suppresses_silence_and_never_infers_on_silent_flush() {
    bounded(async {
        let chunks = Chunks::default();
        let audio = AudioProcessor::new(Options {
            vad: true,
            ..options(&chunks)
        })
        .unwrap();
        audio
            .push(packet(0, 1000.0, 8000, vec![0.0; 10000]))
            .await
            .unwrap();
        audio.flush().await.unwrap();
        assert!(chunks.lock().unwrap().is_empty());
        assert!((audio.stats().processed_seconds - 1.25).abs() < 1e-9);
        audio.close().await.unwrap();

        let speech = Chunks::default();
        let audible = AudioProcessor::new(Options {
            vad: true,
            ..options(&speech)
        })
        .unwrap();
        audible.push(first()).await.unwrap();
        audible.close().await.unwrap();
        assert_eq!(speech.lock().unwrap().len(), 1);
    })
    .await;
}

#[tokio::test]
async fn bounds_replay_history_per_source_and_rejects_expired_sequences() {
    bounded(async {
        let chunks = Chunks::default();
        let audio = AudioProcessor::new(Options {
            chunk_seconds: 0.01,
            overlap_seconds: 0.0,
            ..options(&chunks)
        })
        .unwrap();
        let initial = packet(0, 1000.0, 8000, vec![0.2; 80]);
        let mut microphone = initial.clone();
        microphone.source = AudioSource::Microphone;
        audio.push(microphone.clone()).await.unwrap();
        for sequence in 0..258 {
            let mut next = initial.clone();
            next.sequence = sequence;
            next.start_ms = 1000.0 + sequence as f64 * 10.0;
            audio.push(next).await.unwrap();
        }
        let error = audio.push(initial.clone()).await.unwrap_err();
        assert!(error.to_string().contains("expired"), "{error}");
        assert_eq!(
            audio.push(microphone).await.unwrap(),
            Accepted { duplicate: true }
        );
        let mut recent = initial;
        recent.sequence = 257;
        recent.start_ms = 3570.0;
        assert_eq!(
            audio.push(recent).await.unwrap(),
            Accepted { duplicate: true }
        );
        assert_eq!(chunks.lock().unwrap().len(), 259);
        audio.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn admits_volatile_input_during_blocked_inference_and_rejects_pressure_before_admission() {
    bounded(async {
        let chunks = Chunks::default();
        let entered = Arc::new(Notify::new());
        let gate = Arc::new(Semaphore::new(0));
        let audio = AudioProcessor::new(gated(&chunks, &entered, &gate)).unwrap();
        assert_eq!(
            audio.accept(first()).unwrap(),
            Accepted { duplicate: false }
        );
        assert!(chunks.lock().unwrap().is_empty());
        let draining = tokio::spawn({
            let audio = audio.clone();
            async move { audio.drain(true).await }
        });
        entered.notified().await;
        assert_eq!(audio.accept(first()).unwrap(), Accepted { duplicate: true });
        let error = audio
            .accept(packet(1, 2000.0, 8000, vec![0.2; 8000]))
            .unwrap_err();
        assert_eq!(error, AudioError::Backpressure);
        gate.add_permits(16);
        draining.await.unwrap().unwrap();
        assert_eq!(
            audio
                .accept(packet(1, 2000.0, 8000, vec![0.2; 8000]))
                .unwrap(),
            Accepted { duplicate: false }
        );
        audio.drain(true).await.unwrap();
        audio.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn failed_drain_keeps_backlog_admits_duplicates_and_retries_the_same_chunk() {
    bounded(async {
        let attempts = Arc::new(AtomicUsize::new(0));
        let fail = Arc::new(AtomicBool::new(true));
        let audio =
            AudioProcessor::new(failing(&attempts, &fail, "drain inference failed")).unwrap();
        assert_eq!(
            audio.accept(first()).unwrap(),
            Accepted { duplicate: false }
        );
        let error = audio.drain(true).await.unwrap_err();
        assert_eq!(error.to_string(), "drain inference failed");
        let stats = audio.stats();
        assert_eq!(stats.backlog, 1);
        assert_eq!(stats.error.as_deref(), Some("drain inference failed"));
        assert!(stats.buffered_seconds > 0.0);
        assert_eq!(audio.accept(first()).unwrap(), Accepted { duplicate: true });
        let error = audio
            .accept(packet(1, 2000.0, 8000, vec![0.2; 8000]))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("Pending audio inference failed; call drain to retry"),
            "{error}"
        );
        let error = audio.drain(false).await.unwrap_err();
        assert_eq!(error.to_string(), "drain inference failed");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        fail.store(false, Ordering::SeqCst);
        audio.drain(true).await.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(audio.stats().error, None);
        audio.close().await.unwrap();
        assert_eq!(audio.stats().buffered_seconds, 0.0);
    })
    .await;
}

#[tokio::test]
async fn push_rejects_pressure_with_a_typed_error_and_recovers_after_inference_completes() {
    bounded(async {
        let chunks = Chunks::default();
        let entered = Arc::new(Notify::new());
        let gate = Arc::new(Semaphore::new(0));
        let audio = AudioProcessor::new(gated(&chunks, &entered, &gate)).unwrap();
        let blocked = tokio::spawn({
            let audio = audio.clone();
            async move { audio.push(first()).await }
        });
        entered.notified().await;
        let error = audio
            .push(packet(1, 2000.0, 8000, vec![0.2; 8000]))
            .await
            .unwrap_err();
        assert_eq!(error, AudioError::Backpressure);
        gate.add_permits(16);
        blocked.await.unwrap().unwrap();
        assert_eq!(
            audio
                .push(packet(1, 2000.0, 8000, vec![0.2; 8000]))
                .await
                .unwrap(),
            Accepted { duplicate: false }
        );
        audio.close().await.unwrap();
        assert!(chunks.lock().unwrap().len() > 1);
    })
    .await;
}

#[tokio::test]
async fn concurrent_drains_join_one_inference_and_share_its_failure() {
    bounded(async {
        let attempts = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(Notify::new());
        let gate = Arc::new(Semaphore::new(0));
        let audio = AudioProcessor::new(Options {
            on_chunk: {
                let attempts = attempts.clone();
                let entered = entered.clone();
                let gate = gate.clone();
                Arc::new(move |_| {
                    let attempts = attempts.clone();
                    let entered = entered.clone();
                    let gate = gate.clone();
                    Box::pin(async move {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        entered.notify_one();
                        gate.acquire().await.unwrap().forget();
                        Err("Controlled inference failure".into())
                    })
                })
            },
            ..options(&Chunks::default())
        })
        .unwrap();
        audio.accept(first()).unwrap();
        let leader = tokio::spawn({
            let audio = audio.clone();
            async move { audio.drain(true).await }
        });
        entered.notified().await;
        let follower = tokio::spawn({
            let audio = audio.clone();
            async move { audio.drain(true).await }
        });
        tokio::task::yield_now().await;
        gate.add_permits(1);
        let leader = leader.await.unwrap().unwrap_err();
        let follower = follower.await.unwrap().unwrap_err();
        assert_eq!(leader.to_string(), "Controlled inference failure");
        assert_eq!(follower.to_string(), "Controlled inference failure");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    })
    .await;
}

#[tokio::test]
async fn reports_gaps_without_blending_disconnected_source_clocks() {
    bounded(async {
        let chunks = Chunks::default();
        let gaps = Gaps::default();
        let audio = AudioProcessor::new(Options {
            on_gap: {
                let gaps = gaps.clone();
                Arc::new(move |gap| gaps.lock().unwrap().push(gap))
            },
            ..options(&chunks)
        })
        .unwrap();
        audio
            .push(packet(0, 1000.0, 8000, vec![0.2; 4000]))
            .await
            .unwrap();
        audio
            .push(packet(2, 3000.0, 8000, vec![0.3; 8000]))
            .await
            .unwrap();
        {
            let gaps = gaps.lock().unwrap();
            assert_eq!(gaps.len(), 1);
            assert_eq!(gaps[0].source, AudioSource::Remote);
            assert_eq!(gaps[0].start_ms, 3000.0);
        }
        assert_eq!(shape(&chunks), vec![(1000.0, 4000), (3000.0, 8000)]);
        audio.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn resamples_dc_with_correct_duration_and_filters_above_nyquist_energy() {
    bounded(async {
        let chunks = Chunks::default();
        let audio = AudioProcessor::new(Options {
            overlap_seconds: 0.0,
            ..options(&chunks)
        })
        .unwrap();
        audio
            .push(packet(0, 1000.0, 48000, vec![0.25; 48000]))
            .await
            .unwrap();
        audio.flush().await.unwrap();
        {
            let chunks = chunks.lock().unwrap();
            assert_eq!(chunks.len(), 1);
            assert_eq!(chunks[0].sample_rate, 8000);
            assert_eq!(chunks[0].start_ms, 1000.0);
            assert_eq!(chunks[0].samples.len(), 8000);
            assert!(
                chunks[0]
                    .samples
                    .iter()
                    .all(|value| (value - 0.25).abs() < 0.0001)
            );
        }
        audio.close().await.unwrap();

        let filtered = Chunks::default();
        let antialias = AudioProcessor::new(Options {
            overlap_seconds: 0.0,
            ..options(&filtered)
        })
        .unwrap();
        antialias
            .push(packet(0, 1000.0, 48000, sine(48000, 6000.0, 48000)))
            .await
            .unwrap();
        antialias.flush().await.unwrap();
        let middle = filtered
            .lock()
            .unwrap()
            .iter()
            .flat_map(|chunk| chunk.samples[100..chunk.samples.len() - 100].to_vec())
            .collect::<Vec<_>>();
        let rms = (middle
            .iter()
            .map(|value| f64::from(*value) * f64::from(*value))
            .sum::<f64>()
            / middle.len() as f64)
            .sqrt();
        assert!(rms < 0.01, "aliased energy {rms}");
        antialias.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn resampling_is_independent_of_packet_fragmentation_and_invalid_input_is_not_admitted() {
    bounded(async {
        let whole = Chunks::default();
        let split = Chunks::default();
        let samples = sine(44100, 440.0, 44100);
        let a = AudioProcessor::new(Options {
            overlap_seconds: 0.0,
            ..options(&whole)
        })
        .unwrap();
        let b = AudioProcessor::new(Options {
            overlap_seconds: 0.0,
            ..options(&split)
        })
        .unwrap();
        a.push(packet(0, 1000.0, 44100, samples.clone()))
            .await
            .unwrap();
        b.push(packet(0, 1000.0, 44100, samples[..10000].to_vec()))
            .await
            .unwrap();
        b.push(packet(
            1,
            1000.0 + 10000.0 / 44.1,
            44100,
            samples[10000..].to_vec(),
        ))
        .await
        .unwrap();
        a.flush().await.unwrap();
        b.flush().await.unwrap();
        assert_eq!(
            split.lock().unwrap()[0].samples,
            whole.lock().unwrap()[0].samples
        );
        let error = a
            .push(packet(1, 2000.0, 8000, vec![f32::NAN]))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("finite"), "{error}");
        a.close().await.unwrap();
        b.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn continues_a_resampled_source_after_flush_without_missing_history_or_duplicating_time() {
    bounded(async {
        let chunks = Chunks::default();
        let audio = AudioProcessor::new(Options {
            overlap_seconds: 0.0,
            ..options(&chunks)
        })
        .unwrap();
        audio
            .push(packet(0, 1000.0, 48000, vec![0.25; 24000]))
            .await
            .unwrap();
        audio.flush().await.unwrap();
        audio
            .push(packet(1, 1500.0, 48000, vec![0.25; 24000]))
            .await
            .unwrap();
        audio.flush().await.unwrap();
        assert_eq!(shape(&chunks), vec![(1000.0, 4000), (1500.0, 4000)]);
        assert!(
            chunks
                .lock()
                .unwrap()
                .iter()
                .all(|chunk| chunk.samples.iter().all(|s| (s - 0.25).abs() < 0.0001))
        );
        audio.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn reserves_bounded_inference_capacity_for_delayed_resampler_tails() {
    bounded(async {
        let chunks = Chunks::default();
        let audio = AudioProcessor::new(Options {
            max_buffered_seconds: Some(1.1),
            ..options(&chunks)
        })
        .unwrap();
        let error = audio
            .accept(packet(0, 1000.0, 48000, vec![0.25; 48048]))
            .unwrap_err();
        assert_eq!(error, AudioError::Backpressure);
        let stats = audio.stats();
        assert_eq!((stats.buffered_seconds, stats.backlog), (0.0, 0));
        assert_eq!(
            audio
                .accept(packet(0, 1000.0, 48000, vec![0.25; 24000]))
                .unwrap(),
            Accepted { duplicate: false }
        );
        audio.flush().await.unwrap();
        assert_eq!(chunks.lock().unwrap()[0].samples.len(), 4000);
        audio.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn rejects_invalid_configuration_and_input_before_admission() {
    let chunks = Chunks::default();
    for broken in [
        Options {
            sample_rate: 4000,
            ..options(&chunks)
        },
        Options {
            chunk_seconds: 31.0,
            ..options(&chunks)
        },
        Options {
            overlap_seconds: 1.0,
            ..options(&chunks)
        },
        Options {
            max_buffered_seconds: Some(0.5),
            ..options(&chunks)
        },
    ] {
        assert!(AudioProcessor::new(broken).is_err());
    }
    let audio = AudioProcessor::new(options(&chunks)).unwrap();
    audio.accept(first()).unwrap();
    let admitted = audio.stats();
    let mut changed = packet(1, 2000.0, 8000, vec![0.2; 8000]);
    changed.capture_id = "other".into();
    assert!(
        audio
            .accept(changed)
            .unwrap_err()
            .to_string()
            .contains("capture id")
    );
    assert!(
        audio
            .accept(packet(1, 2000.0, 7999, vec![0.2; 8000]))
            .is_err()
    );
    assert!(audio.accept(packet(1, 2000.0, 8000, Vec::new())).is_err());
    assert_eq!(audio.stats(), admitted);
}

#[test]
fn reconcile_overlap_removes_only_time_overlapping_text_and_preserves_repeats() {
    assert_eq!(
        reconcile_overlap("hello world", 2000.0, "world again", 1500.0),
        "again"
    );
    assert_eq!(
        reconcile_overlap("hello world", 2000.0, "world again", 2000.0),
        "world again"
    );
    assert_eq!(
        reconcile_overlap("ประชุมสวัสดีครับ", 2000.0, "สวัสดีครับทุกคน", 1500.0),
        "ทุกคน"
    );
    assert_eq!(reconcile_overlap("ครับ", 2000.0, "ครับ", 2200.0), "ครับ");
    assert_eq!(reconcile_overlap("a", 2000.0, "again", 1500.0), "again");
    assert_eq!(
        reconcile_overlap("foobar", 2000.0, "bar again", 1500.0),
        "bar again"
    );
}
