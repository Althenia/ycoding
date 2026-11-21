use super::BoxFuture;
use super::audio::{
    AudioError, AudioInput, AudioProcessor, Options as AudioOptions, reconcile_overlap,
};
use super::bridge::CaptureMessage;
use super::config::{AnalysisModel, ConfigError, MeetingConfig, TranscriptionConfig};
use super::intelligence::{Generate, Intelligence, Mcp, Settings};
use super::owner::Update;
use super::pcm::{AudioChunk, AudioSource};
use super::store::{Change, MeetingDatabase, StoreError, now, to_store, uuid};
use super::transcription::{
    TranscribeContext, Transcript, TranscriptionError, TranscriptionProvider, create_provider,
    install_model, list_models, sanitize_error,
};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;
use ycoding_schema::JsonValue;
use ycoding_store::meeting as records;

pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);
const INVALID_COMMAND: &str = "Invalid meeting command or configuration";
const UNAVAILABLE: &str = "Meeting intelligence is not available in this runtime";
const ACTIONS: [&str; 21] = [
    "start",
    "stop",
    "status",
    "summary",
    "plan",
    "transcript",
    "knowledge-review",
    "models",
    "config",
    "select",
    "configure",
    "model-select",
    "model-install",
    "approve",
    "reject",
    "confirm",
    "reject-finding",
    "correct",
    "delete",
    "retry",
    "reconcile",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeError(pub String);

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for RuntimeError {}

macro_rules! runtime_error_from {
    ($($error:ty),*) => {$(
        impl From<$error> for RuntimeError {
            fn from(error: $error) -> Self {
                Self(error.to_string())
            }
        }
    )*};
}
runtime_error_from!(StoreError, AudioError, ConfigError, TranscriptionError);

fn fail<T>(message: &str) -> Result<T, RuntimeError> {
    Err(RuntimeError(message.into()))
}

pub type SessionFactory = Arc<
    dyn Fn(Option<String>, AnalysisModel) -> BoxFuture<'static, Result<String, String>>
        + Send
        + Sync,
>;
pub type ProviderFactory = Arc<
    dyn Fn(&TranscriptionConfig) -> Result<Arc<dyn TranscriptionProvider>, TranscriptionError>
        + Send
        + Sync,
>;

pub struct RuntimeOptions {
    pub directory: PathBuf,
    pub database: MeetingDatabase,
    pub config: MeetingConfig,
    pub create_session: SessionFactory,
    pub provider_factory: Option<ProviderFactory>,
    pub heartbeat_timeout: Duration,
    pub generate: Option<Generate>,
    pub mcp: Option<Arc<dyn Mcp>>,
}

#[derive(Clone)]
struct Health {
    model: String,
    provider: String,
    device: String,
    status: &'static str,
    warning: Option<String>,
    error: Option<String>,
}

impl Health {
    fn to_value(&self) -> Value {
        let mut value = json!({
            "model": self.model,
            "provider": self.provider,
            "device": self.device,
            "status": self.status,
        });
        if let Some(warning) = &self.warning {
            value["warning"] = json!(warning);
        }
        if let Some(error) = &self.error {
            value["error"] = json!(error);
        }
        value
    }
}

struct State {
    config: MeetingConfig,
    selected: Option<String>,
    active: Option<String>,
    audio: Option<AudioProcessor>,
    audio_meeting_id: Option<String>,
    failed_capture: Option<(String, String)>,
    provider: Option<Arc<dyn TranscriptionProvider>>,
    health: Health,
    changing: bool,
    last_heartbeat: Instant,
    microphone: bool,
    provisional: Option<Value>,
    previous: HashMap<String, Value>,
    shutdown: bool,
    work: Vec<JoinHandle<()>>,
}

pub struct MeetingRuntime {
    directory: PathBuf,
    database: MeetingDatabase,
    create_session: SessionFactory,
    provider_factory: ProviderFactory,
    intelligence: Arc<Intelligence>,
    heartbeat_timeout: Duration,
    state: Mutex<State>,
    control_turn: tokio::sync::Mutex<()>,
    closed: tokio::sync::Mutex<Option<Result<(), RuntimeError>>>,
}

struct Control {
    action: &'static str,
    meeting_id: Option<String>,
    session_id: Option<String>,
    title: Option<String>,
    proposal_id: Option<String>,
    finding_id: Option<String>,
    segment_id: Option<String>,
    model: Option<String>,
    text: Option<String>,
    config: Option<Value>,
    authorized: bool,
    confirmed: bool,
}

impl MeetingRuntime {
    pub async fn new(options: RuntimeOptions) -> Result<Arc<Self>, RuntimeError> {
        options.database.recover().await?;
        if let Some(days) = options.config.storage.retention_days {
            options.database.retain(f64::from(days)).await?;
        }
        let selected = options
            .database
            .list_meetings("", 1)?
            .first()
            .and_then(|meeting| meeting["id"].as_str().map(str::to_owned));
        let intelligence = Intelligence::new(
            options.database.clone(),
            options.generate,
            options.mcp,
            intelligence_settings(&options.config),
        );
        let health = Health {
            model: options.config.transcription.model.clone(),
            provider: options.config.transcription.provider.clone(),
            device: options.config.transcription.device.clone(),
            status: "unloaded",
            warning: None,
            error: None,
        };
        Ok(Arc::new(Self {
            directory: options.directory,
            database: options.database,
            create_session: options.create_session,
            intelligence,
            provider_factory: options
                .provider_factory
                .unwrap_or_else(|| Arc::new(create_provider)),
            heartbeat_timeout: options.heartbeat_timeout,
            state: Mutex::new(State {
                config: options.config,
                selected,
                active: None,
                audio: None,
                audio_meeting_id: None,
                failed_capture: None,
                provider: None,
                health,
                changing: false,
                last_heartbeat: Instant::now(),
                microphone: false,
                provisional: None,
                previous: HashMap::new(),
                shutdown: false,
                work: Vec::new(),
            }),
            control_turn: tokio::sync::Mutex::new(()),
            closed: tokio::sync::Mutex::new(None),
        }))
    }

    pub fn database(&self) -> &MeetingDatabase {
        &self.database
    }

    pub fn config(&self) -> MeetingConfig {
        self.state().config.clone()
    }

    pub fn status(&self, meeting_id: Option<&str>) -> Result<Value, RuntimeError> {
        let (selected, health, audio, active, microphone, config) = {
            let state = self.state();
            (
                state.selected.clone(),
                state.health.to_value(),
                state.audio.as_ref().map(AudioProcessor::stats),
                state.active.is_some(),
                state.microphone,
                state.config.to_value(),
            )
        };
        let meeting = match meeting_id.map(str::to_owned).or(selected) {
            Some(id) => self.database.get_meeting(&id)?,
            None => None,
        };
        let id = meeting
            .as_ref()
            .and_then(|meeting| meeting["id"].as_str())
            .map(str::to_owned);
        let mut audio_view = json!({
            "bufferedSeconds": audio.as_ref().map_or(0.0, |stats| stats.buffered_seconds),
            "processedSeconds": audio.as_ref().map_or(0.0, |stats| stats.processed_seconds),
            "backlog": audio.as_ref().map_or(0, |stats| stats.backlog),
            "sources": {
                "remote": if active { "capturing" } else { "inactive" },
                "microphone": if active && microphone { "capturing" } else { "disabled" },
            },
        });
        if let Some(error) = audio.and_then(|stats| stats.error) {
            audio_view["error"] = json!(error);
        }
        let mut view = Map::new();
        if let Some(meeting) = meeting {
            view.insert("meeting".into(), meeting);
        }
        view.insert(
            "meetings".into(),
            json!(self.database.list_meetings("", 100)?),
        );
        let mut segments = Vec::new();
        let mut findings = Vec::new();
        let mut proposals = Vec::new();
        if let Some(id) = &id {
            let after = (self.database.next_sequence(id)? - 101).max(0);
            segments = self.database.segments(id, after, 101)?;
            findings = self.database.findings(id)?;
            proposals = self.database.proposals(id)?;
            if let Some(summary) = self.database.checkpoints(id)?.pop() {
                view.insert("summary".into(), summary);
            }
            if let Some(plan) = self.database.plan(id)? {
                view.insert("plan".into(), plan);
            }
        }
        view.insert("segments".into(), json!(segments));
        view.insert("findings".into(), json!(findings));
        view.insert("proposals".into(), json!(proposals));
        view.insert("health".into(), health);
        view.insert("audio".into(), audio_view);
        view.insert(
            "analysis".into(),
            id.as_deref().map_or_else(
                || json!({ "status": "idle" }),
                |id| self.intelligence.state(id),
            ),
        );
        view.insert("config".into(), config);
        Ok(Value::Object(view))
    }

    pub async fn control(&self, value: Value) -> Result<Value, RuntimeError> {
        let input = parse_control(&value)?;
        if self.state().shutdown && !["status", "retry"].contains(&input.action) {
            return fail("Meeting runtime is closing");
        }
        if ["status", "transcript", "knowledge-review", "config"].contains(&input.action) {
            return self.status(input.meeting_id.as_deref());
        }
        let _turn = self.control_turn.lock().await;
        self.mutate(input).await
    }

    async fn mutate(&self, input: Control) -> Result<Value, RuntimeError> {
        let id = input
            .meeting_id
            .clone()
            .or_else(|| self.state().selected.clone());
        match input.action {
            "start" => return self.start(&input).await,
            "select" => {
                let Some(id) = id.filter(|id| self.exists(id)) else {
                    return fail("Meeting not found");
                };
                self.state().selected = Some(id);
                return self.status(None);
            }
            "models" => {
                let config = self.config().transcription;
                let mut view = self.status(id.as_deref())?;
                view["models"] = json!(list_models(&config).await?);
                return Ok(view);
            }
            "model-install" => {
                let (Some(model), true) = (&input.model, input.authorized) else {
                    return fail("Explicit model download authorization is required");
                };
                install_model(model, true, &self.config().transcription).await?;
                return self.status(id.as_deref());
            }
            "configure" | "model-select" => {
                let next = if input.action == "configure" {
                    MeetingConfig::parse(input.config.as_ref().unwrap_or(&Value::Null))?
                } else {
                    let mut value = self.config().to_value();
                    match &input.model {
                        Some(model) => value["transcription"]["model"] = json!(model),
                        None => {
                            value["transcription"]
                                .as_object_mut()
                                .map(|transcription| transcription.remove("model"));
                        }
                    }
                    MeetingConfig::parse(&value)?
                };
                self.configure(next).await?;
                return self.status(id.as_deref());
            }
            _ => (),
        }
        let Some(id) = id.filter(|id| self.exists(id)) else {
            return fail("Select or start a meeting first");
        };
        match input.action {
            "stop" => self.stop(&id).await?,
            "summary" | "reconcile" | "plan" if !self.intelligence.generates() => {
                return fail(UNAVAILABLE);
            }
            "summary" => {
                let recovered = self.state().active.as_deref() != Some(&id);
                if recovered {
                    self.finalize_recovered(&id).await?;
                }
                self.analyze_later(&id, recovered, false);
            }
            "reconcile" => {
                if self.state().active.as_deref() == Some(&id) {
                    return fail("Stop capture before historical reconciliation");
                }
                self.finalize_recovered(&id).await?;
                self.analyze_later(&id, true, true);
            }
            "plan" => {
                let (intelligence, meeting) = (self.intelligence.clone(), id.clone());
                self.schedule_checked(&id, async move { intelligence.plan(&meeting).await });
            }
            "approve" | "reject" => {
                let Some(proposal) = input.proposal_id.as_deref() else {
                    return fail("Proposal ID is required");
                };
                self.intelligence
                    .review(&id, proposal, input.action == "approve")
                    .await
                    .map_err(RuntimeError)?;
            }
            "retry" => self.retry(&id).await?,
            "confirm" | "reject-finding" => self.review_finding(&id, &input).await?,
            "correct" => self.correct(&id, &input).await?,
            "delete" => {
                let idle = {
                    let mut state = self.state();
                    state.work.retain(|work| !work.is_finished());
                    state.active.as_deref() != Some(&id) && state.work.is_empty()
                };
                if !input.confirmed || !idle {
                    return fail("Deletion needs confirmation and an idle meeting runtime");
                }
                self.database.delete_meeting(&id).await?;
                let mut state = self.state();
                if state.selected.as_deref() == Some(&id) {
                    state.selected = None;
                }
                drop(state);
                return self.status(None);
            }
            _ => (),
        }
        self.status(Some(&id))
    }

    async fn start(&self, input: &Control) -> Result<Value, RuntimeError> {
        let (active, backlog) = {
            let state = self.state();
            (
                state.active.is_some(),
                state
                    .audio
                    .as_ref()
                    .is_some_and(|audio| audio.stats().backlog > 0),
            )
        };
        if active {
            return fail("Stop the current recording before arming another");
        }
        if backlog {
            return fail("Explicitly retry retained failed audio before arming another meeting");
        }
        self.load().await?;
        let model = self.config().analysis.model;
        let session = (self.create_session)(input.session_id.clone(), model)
            .await
            .map_err(RuntimeError)?;
        let meeting = self
            .database
            .create_meeting(
                &uuid()?,
                input.title.as_deref().unwrap_or("Meeting"),
                &session,
            )
            .await?;
        let mut state = self.state();
        state.previous.clear();
        state.selected = meeting["id"].as_str().map(str::to_owned);
        drop(state);
        self.status(None)
    }

    fn exists(&self, id: &str) -> bool {
        self.database
            .get_meeting(id)
            .is_ok_and(|meeting| meeting.is_some())
    }

    async fn review_finding(&self, id: &str, input: &Control) -> Result<(), RuntimeError> {
        let _gate = self.intelligence.commit().await;
        let Some(mut finding) = self
            .database
            .findings(id)?
            .into_iter()
            .find(|item| input.finding_id.as_deref() == item["id"].as_str())
        else {
            return fail("Finding not found");
        };
        let confirm = input.action == "confirm";
        finding["status"] = json!(if confirm { "confirmed" } else { "rejected" });
        let approval = json!({
            "id": uuid()?,
            "meetingID": id,
            "targetID": finding["id"],
            "decision": if confirm { "approve" } else { "reject" },
            "detail": finding["summary"],
            "createdAt": now(),
        });
        let (finding, approval) = (to_store(&finding)?, to_store(&approval)?);
        self.database
            .write(move |tx| {
                records::put_finding(tx, &finding)?;
                records::put_approval(tx, &approval)
            })
            .await?;
        Ok(())
    }

    async fn correct(&self, id: &str, input: &Control) -> Result<(), RuntimeError> {
        if self.state().active.as_deref() == Some(id) || self.intelligence.writing() {
            return fail("Stop capture and finish knowledge writes before correcting evidence");
        }
        if let Some(running) = self.intelligence.running(id) {
            running.wait().await.map_err(RuntimeError)?;
        }
        let _gate = self.intelligence.commit().await;
        let text = input.text.clone().unwrap_or_default();
        let segment_id = input.segment_id.clone().unwrap_or_default();
        let segment = self
            .database
            .segments(id, -1, 10_000)?
            .into_iter()
            .find(|item| item["id"].as_str() == Some(&segment_id));
        let Some(segment) =
            segment.filter(|item| item["state"] == "final" && !text.trim().is_empty())
        else {
            return fail("A finalized segment and nonempty correction are required");
        };
        let cites = |value: &Value| {
            value["sourceSegmentIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|item| *item == segment["id"]))
        };
        let findings = self
            .database
            .findings(id)?
            .into_iter()
            .filter(|finding| cites(finding) && finding["status"] == "confirmed")
            .map(|mut finding| {
                finding["status"] = json!("unconfirmed");
                finding
            })
            .collect::<Vec<_>>();
        let proposals = self
            .database
            .proposals(id)?
            .into_iter()
            .filter(|proposal| {
                cites(proposal)
                    && ["pending", "approved", "manual", "failed"]
                        .iter()
                        .any(|status| proposal["status"] == *status)
            })
            .map(|mut proposal| {
                proposal["status"] = json!("stale");
                proposal["error"] =
                    json!("Supporting transcript was corrected; reconcile and review again");
                proposal
            })
            .collect::<Vec<_>>();
        let plan = self.database.plan(id)?.filter(cites).map(|mut plan| {
            plan["status"] = json!("rejected");
            plan
        });
        let approval = json!({
            "id": uuid()?,
            "meetingID": id,
            "targetID": segment["id"],
            "decision": "correct",
            "detail": text,
            "createdAt": now(),
        });
        let records_to_write = findings
            .iter()
            .chain(&proposals)
            .chain(&plan)
            .chain([&approval])
            .map(to_store)
            .collect::<Result<Vec<_>, _>>()?;
        let (segment_key, corrected) = (segment_id.clone(), text.clone());
        let counts = (findings.len(), proposals.len(), plan.is_some());
        self.database
            .write(move |tx| {
                records::correct_segment(
                    tx,
                    &segment_key.as_str().into(),
                    &corrected.as_str().into(),
                )?;
                let (findings, rest) = records_to_write.split_at(counts.0);
                let (proposals, rest) = rest.split_at(counts.1);
                findings
                    .iter()
                    .try_for_each(|value| records::put_finding(tx, value))?;
                proposals
                    .iter()
                    .try_for_each(|value| records::put_proposal(tx, value))?;
                let (plan, approval) = rest.split_at(usize::from(counts.2));
                plan.iter()
                    .try_for_each(|value| records::put_plan(tx, value))?;
                approval
                    .iter()
                    .try_for_each(|value| records::put_approval(tx, value))
            })
            .await?;
        let mut hints = self.config().vocabulary.hints;
        for term in technical_terms(&text) {
            if !hints.contains(&term) {
                hints.push(term);
            }
        }
        hints.truncate(64);
        let mut value = self.config().to_value();
        value["vocabulary"]["hints"] = json!(hints);
        self.state().config = MeetingConfig::parse(&value)?;
        self.save_config()?;
        self.analyze_later(id, true, true);
        Ok(())
    }

    async fn load(&self) -> Result<(), RuntimeError> {
        if self.state().provider.is_some() {
            return Ok(());
        }
        let config = {
            let mut state = self.state();
            state.health.status = "loading";
            state.health.error = None;
            state.config.transcription.clone()
        };
        let model = config.model.clone();
        let attempt = async {
            let provider = (self.provider_factory)(&config)?;
            let started = async {
                provider.initialize(&config).await?;
                let health = provider.health_check().await?;
                if !health.healthy {
                    return Err(TranscriptionError {
                        kind: super::transcription::ErrorKind::Failure,
                        message: "Transcription provider is unhealthy".into(),
                    });
                }
                Ok(health)
            }
            .await;
            match started {
                Ok(health) => Ok((provider, health)),
                Err(error) => {
                    provider.dispose().await;
                    Err(error)
                }
            }
        }
        .await;
        match attempt {
            Ok((provider, health)) => {
                let metrics = health.metrics.unwrap_or_default();
                let mut state = self.state();
                state.health = Health {
                    model,
                    provider: provider.id().to_owned(),
                    device: metrics.device.unwrap_or(config.device),
                    status: "ready",
                    warning: metrics.warning,
                    error: None,
                };
                state.provider = Some(provider);
                Ok(())
            }
            Err(error) => {
                let mut state = self.state();
                state.health.status = "error";
                state.health.error = Some(sanitize_error(&error.message));
                Err(error.into())
            }
        }
    }

    pub async fn capture(self: &Arc<Self>, input: CaptureMessage) -> Result<Value, RuntimeError> {
        let capture_id = input.capture_id().to_owned();
        let failed = {
            let state = self.state();
            if state.shutdown {
                return Ok(json!({ "stop": true }));
            }
            state
                .failed_capture
                .clone()
                .filter(|(failed, _)| *failed == capture_id)
        };
        if let Some((_, meeting_id)) = failed {
            if matches!(input, CaptureMessage::Stop { .. }) {
                self.stop(&meeting_id).await?;
            }
            return Ok(json!({ "stop": true, "reason": "inference_failed" }));
        }
        if matches!(input, CaptureMessage::Heartbeat { .. }) {
            let active = self.state().active.clone();
            let live = match active {
                Some(active) => self.database.get_meeting(&active)?.is_some_and(|meeting| {
                    meeting["status"] == "recording" && meeting["captureID"] == capture_id.as_str()
                }),
                None => false,
            };
            if !live {
                return Ok(json!({ "stop": true }));
            }
            self.state().last_heartbeat = Instant::now();
            return Ok(json!({ "accepted": true }));
        }
        if self.state().changing {
            return Ok(json!({ "busy": true }));
        }
        match input {
            CaptureMessage::Start { microphone, .. } => {
                self.begin_capture(&capture_id, microphone).await
            }
            CaptureMessage::Stop { .. } => {
                let Some(id) = self.owner_of(&capture_id)? else {
                    return Ok(json!({ "stop": true }));
                };
                self.stop(&id).await?;
                Ok(json!({ "stop": true }))
            }
            CaptureMessage::Audio {
                source,
                sequence,
                start_ms,
                sample_rate,
                samples,
                ..
            } => {
                let Some(id) = self.owner_of(&capture_id)? else {
                    return Ok(json!({ "stop": true }));
                };
                self.accept_audio(
                    &id,
                    AudioInput {
                        capture_id,
                        source,
                        sequence,
                        start_ms,
                        sample_rate,
                        samples,
                    },
                )
                .await
            }
            CaptureMessage::Heartbeat { .. } => Ok(json!({ "stop": true })),
        }
    }

    fn owner_of(&self, capture_id: &str) -> Result<Option<String>, RuntimeError> {
        let Some(id) = self.state().active.clone() else {
            return Ok(None);
        };
        let owned = self
            .database
            .get_meeting(&id)?
            .is_some_and(|meeting| meeting["captureID"] == capture_id);
        Ok(owned.then_some(id))
    }

    async fn begin_capture(
        self: &Arc<Self>,
        capture_id: &str,
        microphone: bool,
    ) -> Result<Value, RuntimeError> {
        let (config, active, selected, ready) = {
            let state = self.state();
            (
                state.config.clone(),
                state.active.clone(),
                state.selected.clone(),
                state.provider.is_some(),
            )
        };
        if !config.streaming.enabled {
            return fail("Enable incremental chunking before live capture");
        }
        if let Some(active) = active {
            let same = self
                .database
                .get_meeting(&active)?
                .is_some_and(|meeting| meeting["captureID"] == capture_id);
            if same {
                return Ok(json!({ "accepted": true, "duplicate": true }));
            }
            return fail("Another capture is already active");
        }
        let meeting = match selected {
            Some(id) => self.database.get_meeting(&id)?,
            None => None,
        };
        let Some(meeting) = meeting.filter(|meeting| meeting["status"] == "ready" && ready) else {
            return fail("Arm a ready meeting in YCoding before capture");
        };
        let id = meeting["id"].as_str().unwrap_or_default().to_owned();
        let audio = AudioProcessor::new(self.audio_options(&id, &config))?;
        self.database
            .update_meeting(
                &id,
                Some("recording"),
                Change::Set(capture_id.into()),
                Change::Keep,
            )
            .await?;
        let mut state = self.state();
        state.active = Some(id.clone());
        state.audio_meeting_id = Some(id);
        state.failed_capture = None;
        state.microphone = microphone;
        state.last_heartbeat = Instant::now();
        state.audio = Some(audio);
        Ok(json!({ "accepted": true }))
    }

    fn audio_options(self: &Arc<Self>, meeting_id: &str, config: &MeetingConfig) -> AudioOptions {
        let (chunks, gaps) = (Arc::downgrade(self), Arc::downgrade(self));
        let (chunk_meeting, gap_meeting) = (meeting_id.to_owned(), meeting_id.to_owned());
        AudioOptions {
            chunk_seconds: f64::from(config.transcription.chunk_seconds),
            overlap_seconds: f64::from(config.transcription.overlap_seconds),
            sample_rate: config.streaming.sample_rate,
            vad: config.streaming.vad,
            max_buffered_seconds: Some(config.streaming.max_buffered_seconds),
            on_chunk: Arc::new(move |chunk| {
                let runtime = Weak::clone(&chunks);
                let meeting = chunk_meeting.clone();
                Box::pin(async move {
                    match runtime.upgrade() {
                        Some(runtime) => runtime.transcribe(&meeting, chunk).await,
                        None => Err("Meeting runtime is closed".into()),
                    }
                })
            }),
            on_gap: Arc::new(move |_| {
                let Some(runtime) = gaps.upgrade() else {
                    return;
                };
                let meeting = gap_meeting.clone();
                let owner = runtime.clone();
                runtime.schedule(async move {
                    let _ = owner
                        .database
                        .update_meeting(
                            &meeting,
                            None,
                            Change::Keep,
                            Change::Set(
                                "Audio discontinuity detected; timestamps preserve the gap".into(),
                            ),
                        )
                        .await;
                });
            }),
        }
    }

    async fn accept_audio(
        self: &Arc<Self>,
        id: &str,
        input: AudioInput,
    ) -> Result<Value, RuntimeError> {
        let (audio, microphone) = {
            let state = self.state();
            (state.audio.clone(), state.microphone)
        };
        let Some(audio) = audio else {
            return Ok(json!({ "stop": true }));
        };
        if input.source == AudioSource::Microphone && !microphone {
            return fail("Microphone capture was not enabled");
        }
        match audio.accept(input) {
            Ok(accepted) => {
                if !accepted.duplicate {
                    let (runtime, id, audio) = (self.clone(), id.to_owned(), audio.clone());
                    self.schedule(async move {
                        if audio.drain(false).await.is_err() {
                            let stoppable = {
                                let state = runtime.state();
                                state.active.as_deref() == Some(&id) && !state.changing
                            };
                            if stoppable {
                                let _ = runtime.stop(&id).await;
                            }
                        }
                    });
                }
                Ok(json!({ "accepted": true, "duplicate": accepted.duplicate }))
            }
            Err(AudioError::Backpressure) => Ok(json!({ "busy": true })),
            Err(_) if audio.stats().error.is_some() => {
                Ok(json!({ "stop": true, "reason": "inference_failed" }))
            }
            Err(error) => {
                self.database
                    .update_meeting(
                        id,
                        None,
                        Change::Keep,
                        Change::Set(sanitize_error(&error.to_string())),
                    )
                    .await?;
                Err(error.into())
            }
        }
    }

    async fn transcribe(&self, meeting_id: &str, chunk: AudioChunk) -> Result<(), String> {
        self.transcribe_chunk(meeting_id, chunk)
            .await
            .map_err(|error| error.0)
    }

    async fn transcribe_chunk(
        &self,
        meeting_id: &str,
        chunk: AudioChunk,
    ) -> Result<(), RuntimeError> {
        let job = self
            .database
            .jobs(meeting_id)?
            .into_iter()
            .find(|item| item["id"] == chunk.id.as_str());
        if job.as_ref().is_some_and(|job| job["status"] == "done") {
            return Ok(());
        }
        let attempts = job.and_then(|job| job["attempts"].as_u64()).unwrap_or(0) + 1;
        self.finalize_provisional().await?;
        self.database
            .put_job(&job_record(
                &chunk.id, meeting_id, "running", attempts, None,
            ))
            .await?;
        let results = match self.infer(&chunk).await {
            Ok(results) => results,
            Err(error) => {
                let detail = sanitize_error(&error.message);
                self.database
                    .put_job(&job_record(
                        &chunk.id,
                        meeting_id,
                        "failed",
                        attempts,
                        Some(&detail),
                    ))
                    .await?;
                self.database
                    .update_meeting(meeting_id, None, Change::Keep, Change::Set(detail.clone()))
                    .await?;
                let capture = self
                    .database
                    .get_meeting(meeting_id)?
                    .and_then(|meeting| meeting["captureID"].as_str().map(str::to_owned));
                let mut state = self.state();
                state.health.status = "error";
                state.health.error = Some(detail);
                if let Some(capture) = capture {
                    state.failed_capture = Some((capture, meeting_id.to_owned()));
                }
                return Err(error.into());
            }
        };
        let (mut provisional, mut previous, model) = {
            let state = self.state();
            (
                state.provisional.clone(),
                state.previous.clone(),
                state.health.model.clone(),
            )
        };
        let (meeting, id) = (meeting_id.to_owned(), chunk.id.clone());
        let source = chunk.source;
        let job = to_store(&job_record(&chunk.id, meeting_id, "done", attempts, None))?;
        let (provisional, previous, promoted) = self
            .database
            .write(move |tx| {
                let mut promoted = false;
                for (index, result) in results.iter().enumerate() {
                    let key = format!("{meeting}:{}", source.as_str());
                    let text = match previous.get(&key) {
                        Some(earlier) => reconcile_overlap(
                            earlier["text"].as_str().unwrap_or_default(),
                            earlier["endMs"].as_f64().unwrap_or(f64::NAN),
                            &result.text,
                            result.start_ms,
                        ),
                        None => result.text.clone(),
                    };
                    if text.trim().is_empty() {
                        continue;
                    }
                    if let Some(mut earlier) = provisional.take() {
                        earlier["state"] = json!("final");
                        records::put_segment(tx, &record(&earlier)?)?;
                        promoted = true;
                    }
                    let sequence = records::next_sequence_tx(tx, &meeting.as_str().into())?;
                    let segment = json!({
                        "id": format!("{id}:{index}"),
                        "meetingID": meeting,
                        "sequence": sequence,
                        "source": source.as_str(),
                        "speakerID": format!("{}-unknown", source.as_str()),
                        "startMs": result.start_ms,
                        "endMs": result.end_ms,
                        "rawText": result.text,
                        "text": text,
                        "state": "temporary",
                        "model": model,
                        "createdAt": now(),
                    });
                    records::put_segment(tx, &record(&segment)?)?;
                    previous.insert(key, segment.clone());
                    provisional = Some(segment);
                }
                records::put_job(tx, &job)?;
                Ok((provisional, previous, promoted))
            })
            .await?;
        let incremental = {
            let mut state = self.state();
            state.provisional = provisional;
            state.previous = previous;
            promoted && state.config.analysis.incremental && !state.shutdown
        };
        if incremental {
            self.analyze_later(meeting_id, false, false);
        }
        Ok(())
    }

    async fn infer(&self, chunk: &AudioChunk) -> Result<Vec<Transcript>, TranscriptionError> {
        let (provider, config, model) = {
            let state = self.state();
            (
                state.provider.clone(),
                state.config.clone(),
                state.health.model.clone(),
            )
        };
        let hints = if config.vocabulary.preserve_technical_terms {
            config.vocabulary.hints.clone()
        } else {
            Vec::new()
        };
        let context = || TranscribeContext {
            hints: hints.clone(),
            signal: None,
        };
        let error = match &provider {
            Some(provider) => match provider.transcribe(chunk, context()).await {
                Ok(results) => return Ok(results),
                Err(error) => error,
            },
            None => TranscriptionError {
                kind: super::transcription::ErrorKind::Failure,
                message: "Transcription provider is not loaded".into(),
            },
        };
        let fallback = &config.fallback;
        let (Some(fallback_provider), Some(fallback_model), true) = (
            &fallback.provider,
            &fallback.model,
            fallback.enabled && provider.is_some(),
        ) else {
            return Err(error);
        };
        if *fallback_model == model {
            return Err(error);
        }
        if let Some(provider) = &provider {
            provider.dispose().await;
        }
        self.state().provider = None;
        let mut selected = config.transcription.clone();
        selected.provider = fallback_provider.clone();
        selected.model = fallback_model.clone();
        let replacement = (self.provider_factory)(&selected)?;
        let attempt: Result<_, TranscriptionError> = async {
            replacement.initialize(&selected).await?;
            let results = replacement.transcribe(chunk, context()).await?;
            Ok((results, replacement.health_check().await?))
        }
        .await;
        match attempt {
            Ok((results, health)) => {
                let metrics = health.metrics.unwrap_or_default();
                let mut state = self.state();
                state.health = Health {
                    model: fallback_model.clone(),
                    provider: fallback_provider.clone(),
                    device: metrics.device.unwrap_or(selected.device),
                    status: "fallback",
                    warning: Some(format!(
                        "The selected model failed; using explicitly configured fallback {fallback_model}"
                    )),
                    error: None,
                };
                state.provider = Some(replacement);
                Ok(results)
            }
            Err(failure) => {
                replacement.dispose().await;
                let mut state = self.state();
                state.health.status = "error";
                state.health.error = Some(sanitize_error(&failure.message));
                Err(failure)
            }
        }
    }

    async fn finalize_provisional(&self) -> Result<(), RuntimeError> {
        let Some(mut segment) = self.state().provisional.clone() else {
            return Ok(());
        };
        segment["state"] = json!("final");
        self.database.put_segment(&segment).await?;
        self.state().provisional = None;
        let incremental = {
            let state = self.state();
            state.config.analysis.incremental && !state.shutdown
        };
        if incremental && let Some(meeting) = segment["meetingID"].as_str() {
            self.analyze_later(meeting, false, false);
        }
        Ok(())
    }

    async fn finalize_recovered(&self, id: &str) -> Result<(), RuntimeError> {
        for mut segment in self.database.segments(id, -1, 10_000)? {
            if segment["state"] == "temporary" {
                segment["state"] = json!("final");
                self.database.put_segment(&segment).await?;
            }
        }
        Ok(())
    }

    async fn retry(&self, id: &str) -> Result<(), RuntimeError> {
        let (audio, retained, provider, shutdown) = {
            let state = self.state();
            (
                state.audio.clone(),
                state.audio_meeting_id.as_deref() == Some(id),
                state.provider.clone(),
                state.shutdown,
            )
        };
        let (Some(audio), true) = (audio, retained) else {
            return fail("No retained audio is available for this meeting");
        };
        if !shutdown {
            let healthy = match &provider {
                Some(provider) => provider
                    .health_check()
                    .await
                    .is_ok_and(|health| health.healthy),
                None => false,
            };
            if !healthy {
                if let Some(provider) = provider {
                    provider.dispose().await;
                }
                self.state().provider = None;
                self.load().await?;
            }
        }
        audio.drain(true).await?;
        if self.state().active.as_deref() != Some(id) {
            audio.close().await?;
            self.finalize_provisional().await?;
        }
        self.database
            .update_meeting(id, None, Change::Keep, Change::Clear)
            .await?;
        let mut state = self.state();
        if state.health.status == "error" {
            state.health.status = "ready";
            state.health.error = None;
        }
        Ok(())
    }

    pub async fn stop(&self, id: &str) -> Result<(), RuntimeError> {
        if self.state().active.as_deref() != Some(id) {
            self.finalize_recovered(id).await?;
            self.database
                .update_meeting(id, Some("stopped"), Change::Keep, Change::Keep)
                .await?;
            return Ok(());
        }
        self.state().changing = true;
        let outcome = self.stop_active(id).await;
        self.state().changing = false;
        outcome
    }

    async fn stop_active(&self, id: &str) -> Result<(), RuntimeError> {
        self.database
            .update_meeting(id, Some("stopping"), Change::Keep, Change::Keep)
            .await?;
        let audio = self.state().audio.clone();
        if let Some(audio) = &audio
            && let Err(error) = audio.close().await
            && audio.stats().error.is_none()
        {
            return Err(error.into());
        }
        self.finalize_provisional().await?;
        self.state().active = None;
        let detail = audio.and_then(|audio| audio.stats().error);
        self.database
            .update_meeting(
                id,
                Some("stopped"),
                Change::Keep,
                match detail {
                    Some(detail) => Change::Set(format!(
                        "{detail}; retained failed audio requires explicit retry in this process"
                    )),
                    None => Change::Clear,
                },
            )
            .await?;
        self.analyze_later(id, true, false);
        Ok(())
    }

    pub async fn expire_capture(&self, now: Instant) -> Result<(), RuntimeError> {
        let id = {
            let state = self.state();
            match &state.active {
                Some(id)
                    if now.saturating_duration_since(state.last_heartbeat)
                        >= self.heartbeat_timeout
                        && !state.changing
                        && !state.shutdown =>
                {
                    id.clone()
                }
                _ => return Ok(()),
            }
        };
        self.stop(&id).await?;
        self.database
            .update_meeting(
                &id,
                Some("interrupted"),
                Change::Keep,
                Change::Set(
                    "Capture source disconnected. Re-arm and start from the live page with fresh consent to record again."
                        .into(),
                ),
            )
            .await?;
        Ok(())
    }

    async fn configure(&self, next: MeetingConfig) -> Result<(), RuntimeError> {
        {
            let state = self.state();
            if state.active.is_some()
                && (next.streaming != state.config.streaming
                    || next.transcription.chunk_seconds != state.config.transcription.chunk_seconds
                    || next.transcription.overlap_seconds
                        != state.config.transcription.overlap_seconds)
            {
                return fail("Stop capture before changing streaming configuration");
            }
        }
        self.state().changing = true;
        let outcome = self.apply_configuration(next).await;
        self.state().changing = false;
        outcome
    }

    async fn apply_configuration(&self, next: MeetingConfig) -> Result<(), RuntimeError> {
        self.settled().await;
        let audio = self.state().audio.clone();
        let recovering = audio
            .as_ref()
            .is_some_and(|audio| audio.stats().error.is_some());
        if !recovering {
            if let Some(audio) = &audio {
                audio.flush().await?;
            }
            self.finalize_provisional().await?;
            self.settled().await;
        }
        let provider = self.state().provider.take();
        if let Some(provider) = provider {
            provider.dispose().await;
        }
        let previous = std::mem::replace(&mut self.state().config, next.clone());
        if let Err(error) = self.load().await {
            self.state().config = previous;
            self.load().await?;
            return Err(error);
        }
        self.intelligence.configure(intelligence_settings(&next));
        self.save_config()?;
        if recovering && let Some(audio) = &audio {
            let (active, meeting) = {
                let state = self.state();
                (state.active.clone(), state.audio_meeting_id.clone())
            };
            audio.drain(true).await?;
            if active != meeting {
                audio.close().await?;
            } else {
                audio.flush().await?;
            }
            self.finalize_provisional().await?;
            if let Some(meeting) = meeting {
                self.database
                    .update_meeting(&meeting, None, Change::Keep, Change::Clear)
                    .await?;
            }
        }
        if let Some(days) = next.storage.retention_days {
            self.database.retain(f64::from(days)).await?;
        }
        Ok(())
    }

    fn save_config(&self) -> Result<(), RuntimeError> {
        use std::io::Write;
        let file = self.directory.join("settings.json");
        let temporary = self.directory.join("settings.json.tmp");
        let text = serde_json::to_string_pretty(&self.config().to_value())
            .map_err(|error| RuntimeError(error.to_string()))?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let io = |error: std::io::Error| RuntimeError(error.to_string());
        options
            .open(&temporary)
            .and_then(|mut handle| handle.write_all(text.as_bytes()))
            .map_err(io)?;
        std::fs::rename(&temporary, file).map_err(io)
    }

    pub async fn settled(&self) {
        loop {
            let work = std::mem::take(&mut self.state().work);
            if work.is_empty() {
                return;
            }
            for work in work {
                let _ = work.await;
            }
        }
    }

    pub async fn close(&self) -> Result<(), RuntimeError> {
        let mut closed = self.closed.lock().await;
        if let Some(outcome) = &*closed {
            return outcome.clone();
        }
        self.state().shutdown = true;
        let outcome = self.close_owned_work().await;
        *closed = Some(outcome.clone());
        outcome
    }

    async fn close_owned_work(&self) -> Result<(), RuntimeError> {
        self.state().changing = true;
        let mut failure = None;
        let (active, audio) = {
            let state = self.state();
            (state.active.clone(), state.audio.clone())
        };
        if let Some(active) = active {
            if let Err(error) = self
                .database
                .update_meeting(
                    &active,
                    Some("interrupted"),
                    Change::Keep,
                    Change::Set(
                        "Recording service stopped. Untranscribed volatile audio is not recoverable after restart."
                            .into(),
                    ),
                )
                .await
            {
                failure.get_or_insert(error.into());
            }
            if let Some(audio) = &audio
                && let Err(error) = audio.close().await
            {
                failure.get_or_insert(error.into());
            }
            if let Err(error) = self.finalize_provisional().await {
                failure.get_or_insert(error);
            }
        }
        self.settled().await;
        drop(self.control_turn.lock().await);
        let provider = self.state().provider.take();
        if let Some(provider) = provider {
            provider.dispose().await;
        }
        if let Err(error) = self.database.close().await {
            failure.get_or_insert(error.into());
        }
        failure.map_or(Ok(()), Err)
    }

    fn analyze_later(&self, meeting_id: &str, last: bool, reconcile: bool) {
        if !self.intelligence.generates() {
            return;
        }
        let analysis = self.intelligence.analyze(meeting_id, last, reconcile);
        self.schedule_checked(meeting_id, async move { analysis.wait().await });
    }

    fn schedule_checked(
        &self,
        meeting_id: &str,
        work: impl Future<Output = Result<(), String>> + Send + 'static,
    ) {
        let (intelligence, meeting) = (self.intelligence.clone(), meeting_id.to_owned());
        self.schedule(async move {
            if work.await.is_err() {
                intelligence.fail(
                    &meeting,
                    "Meeting processing failed; retained evidence is available. Retry explicitly.",
                );
            }
        });
    }

    pub async fn create_session(
        &self,
        parent: Option<String>,
        model: AnalysisModel,
    ) -> Result<String, RuntimeError> {
        (self.create_session)(parent, model)
            .await
            .map_err(RuntimeError)
    }

    pub async fn update_owner_settings(&self, update: &Update) -> Result<(), RuntimeError> {
        let _turn = self.control_turn.lock().await;
        if self.state().shutdown {
            return fail("Meeting runtime is closing");
        }
        let mut next = self.config();
        if let Some(model) = &update.ask_model {
            next.analysis.ask_model = model.clone();
        }
        if let Some(knowledge) = &update.knowledge {
            next.knowledge.mcp_enabled = knowledge.mcp_enabled;
            next.knowledge.bindings = knowledge.bindings.clone();
        }
        let previous = std::mem::replace(&mut self.state().config, next.clone());
        if let Err(error) = self.save_config() {
            self.state().config = previous;
            return Err(error);
        }
        self.intelligence.configure(intelligence_settings(&next));
        Ok(())
    }

    fn schedule(&self, work: impl Future<Output = ()> + Send + 'static) {
        let handle = tokio::spawn(work);
        let mut state = self.state();
        state.work.retain(|work| !work.is_finished());
        state.work.push(handle);
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn intelligence_settings(config: &MeetingConfig) -> Settings {
    Settings {
        bindings: if config.knowledge.mcp_enabled {
            config
                .knowledge
                .bindings
                .iter()
                .filter(|binding| binding.enabled)
                .cloned()
                .collect()
        } else {
            Vec::new()
        },
        max_characters: config.analysis.max_characters as usize,
        retrieval_ttl: Duration::from_millis(u64::from(config.knowledge.retrieval_ttl)),
    }
}

fn record(value: &Value) -> Result<JsonValue, ycoding_store::Error> {
    to_store(value).map_err(|_| ycoding_store::Error::Rejected("meeting record is not valid JSON"))
}

fn job_record(
    id: &str,
    meeting_id: &str,
    status: &str,
    attempts: u64,
    error: Option<&str>,
) -> Value {
    let mut job = json!({
        "id": id,
        "meetingID": meeting_id,
        "kind": "transcription",
        "status": status,
        "attempts": attempts,
        "updatedAt": now(),
    });
    if let Some(error) = error {
        job["error"] = json!(error);
    }
    job
}

fn parse_control(value: &Value) -> Result<Control, RuntimeError> {
    let invalid = || RuntimeError(INVALID_COMMAND.into());
    let map = value.as_object().ok_or_else(invalid)?;
    let text = |name: &str, limit: usize| -> Result<Option<String>, RuntimeError> {
        match map.get(name) {
            None => Ok(None),
            Some(Value::String(text)) if text.encode_utf16().count() <= limit => {
                Ok(Some(text.clone()))
            }
            Some(_) => Err(invalid()),
        }
    };
    let literal = |name: &str| -> Result<bool, RuntimeError> {
        match map.get(name) {
            None => Ok(false),
            Some(Value::Bool(true)) => Ok(true),
            Some(_) => Err(invalid()),
        }
    };
    const KEYS: [&str; 12] = [
        "action",
        "meetingID",
        "sessionID",
        "title",
        "proposalID",
        "findingID",
        "segmentID",
        "model",
        "text",
        "config",
        "authorized",
        "confirmed",
    ];
    if map.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return Err(invalid());
    }
    let action = ACTIONS
        .iter()
        .find(|candidate| map.get("action").and_then(Value::as_str) == Some(**candidate))
        .ok_or_else(invalid)?;
    let proposal_id = text("proposalID", 200)?;
    Ok(Control {
        action,
        proposal_id,
        meeting_id: text("meetingID", 200)?,
        session_id: text("sessionID", 200)?,
        title: text("title", 200)?,
        finding_id: text("findingID", 200)?,
        segment_id: text("segmentID", 200)?,
        model: text("model", 200)?,
        text: text("text", 8000)?,
        config: map.get("config").cloned(),
        authorized: literal("authorized")?,
        confirmed: literal("confirmed")?,
    })
}

fn technical_terms(text: &str) -> Vec<String> {
    let characters = text.chars().collect::<Vec<_>>();
    let word = |character: char| character.is_ascii_alphanumeric() || "._-".contains(character);
    let mut terms = Vec::new();
    let mut index = 0;
    while index < characters.len() {
        if !characters[index].is_ascii_alphabetic() {
            index += 1;
            continue;
        }
        let end = characters[index + 1..]
            .iter()
            .take(60)
            .take_while(|character| word(**character))
            .count();
        if end == 0 {
            index += 1;
            continue;
        }
        terms.push(characters[index..=index + end].iter().collect());
        index += end + 1;
    }
    terms
}
