use super::BoxFuture;
use super::pcm::{AudioChunk, AudioSource};
use super::transcription::sanitize_error;
use icu_properties::props::{
    ExtendedPictographic, GeneralCategory, GeneralCategoryGroup, GraphemeClusterBreak, Script,
};
use icu_properties::{CodePointMapData, CodePointSetData};
use ring::digest::{Context, SHA256};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::f64::consts::PI;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::watch;

const SPEECH_RMS: f64 = 0.005;
const REPLAY_LIMIT: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CAPACITY_EPSILON: f64 = 1e-9;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AudioError {
    Backpressure,
    Rejected(String),
    Inference(String),
}

impl fmt::Display for AudioError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Backpressure => formatter.write_str(
                "Audio buffer is full; drain pending inference and retry the unaccepted input",
            ),
            Self::Rejected(message) | Self::Inference(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for AudioError {}

fn rejected(message: &str) -> AudioError {
    AudioError::Rejected(message.into())
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioInput {
    pub capture_id: String,
    pub source: AudioSource,
    pub sequence: u64,
    pub start_ms: f64,
    pub sample_rate: u32,
    pub samples: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accepted {
    pub duplicate: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Gap {
    pub source: AudioSource,
    pub start_ms: f64,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    pub buffered_seconds: f64,
    pub processed_seconds: f64,
    pub backlog: usize,
    pub error: Option<String>,
}

pub type ChunkHandler =
    Arc<dyn Fn(AudioChunk) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;
pub type GapHandler = Arc<dyn Fn(Gap) + Send + Sync>;

#[derive(Clone)]
pub struct Options {
    pub chunk_seconds: f64,
    pub overlap_seconds: f64,
    pub sample_rate: u32,
    pub vad: bool,
    pub max_buffered_seconds: Option<f64>,
    pub on_chunk: ChunkHandler,
    pub on_gap: GapHandler,
}

#[derive(Clone)]
struct Source {
    origin_ms: f64,
    input_rate: u32,
    input: Vec<f32>,
    input_offset: usize,
    input_through: usize,
    output_through: usize,
    output: Vec<f32>,
    output_offset: usize,
    emitted_through: usize,
    end_ms: f64,
    sequence: u64,
    finalized: bool,
}

struct Pending {
    chunk: AudioChunk,
    seconds: f64,
}

#[derive(Default)]
struct Replay {
    digests: HashMap<u64, String>,
    order: VecDeque<u64>,
}

type Completion = Option<Result<(), String>>;

#[derive(Default)]
struct State {
    sources: Vec<(AudioSource, Source)>,
    replays: HashMap<AudioSource, Replay>,
    pending: VecDeque<Pending>,
    running: Option<watch::Receiver<Completion>>,
    capture_id: Option<String>,
    closing: bool,
    closed: bool,
    processed_seconds: f64,
    error: Option<String>,
}

struct Inner {
    rate: u32,
    window: usize,
    overlap: usize,
    capacity: f64,
    options: Options,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct AudioProcessor {
    inner: Arc<Inner>,
}

impl AudioProcessor {
    pub fn new(options: Options) -> Result<Self, AudioError> {
        let rate = options.sample_rate;
        if !(8000..=192_000).contains(&rate) {
            return Err(rejected("Invalid output sample rate"));
        }
        if !options.chunk_seconds.is_finite()
            || options.chunk_seconds <= 0.0
            || options.chunk_seconds > 30.0
        {
            return Err(rejected("Invalid chunk duration"));
        }
        if !options.overlap_seconds.is_finite()
            || options.overlap_seconds < 0.0
            || options.overlap_seconds >= options.chunk_seconds
        {
            return Err(rejected("Overlap must be shorter than the audio chunk"));
        }
        let window = (options.chunk_seconds * f64::from(rate)).round() as usize;
        let overlap = (options.overlap_seconds * f64::from(rate)).round() as usize;
        if window < 1 || window <= overlap {
            return Err(rejected("Invalid audio window"));
        }
        let capacity = options
            .max_buffered_seconds
            .unwrap_or_else(|| 60f64.max(4.0 * options.chunk_seconds));
        if !capacity.is_finite() || capacity < options.chunk_seconds {
            return Err(rejected("Buffer capacity must hold one chunk"));
        }
        Ok(Self {
            inner: Arc::new(Inner {
                rate,
                window,
                overlap,
                capacity,
                options,
                state: Mutex::new(State::default()),
            }),
        })
    }

    pub async fn push(&self, input: AudioInput) -> Result<Accepted, AudioError> {
        let accepted = self.accept(input)?;
        self.drain(false).await?;
        Ok(accepted)
    }

    pub fn accept(&self, input: AudioInput) -> Result<Accepted, AudioError> {
        let (accepted, gap) = {
            let mut state = self.inner.lock();
            self.inner.admit(&mut state, &input)?
        };
        if let Some(gap) = gap {
            (self.inner.options.on_gap)(gap);
        }
        Ok(accepted)
    }

    pub async fn flush(&self) -> Result<(), AudioError> {
        if self.inner.lock().closed {
            return Ok(());
        }
        self.drain(false).await?;
        {
            let mut state = self.inner.lock();
            let capture_id = state.capture_id.clone().unwrap_or_default();
            let mut queued = Vec::new();
            for index in 0..state.sources.len() {
                let name = state.sources[index].0;
                let mut source = state.sources[index].1.clone();
                self.inner.convert(&mut source, true)?;
                self.inner
                    .emit(&mut source, name, &capture_id, &mut queued, true);
                state.sources[index].1 = source;
            }
            state.pending.extend(queued);
        }
        self.drain(false).await
    }

    pub async fn drain(&self, retry: bool) -> Result<(), AudioError> {
        let mut receiver = {
            let mut state = self.inner.lock();
            if let Some(running) = &state.running {
                running.clone()
            } else {
                if state.closed {
                    return Ok(());
                }
                if let Some(error) = &state.error
                    && !retry
                {
                    return Err(AudioError::Inference(error.clone()));
                }
                state.error = None;
                let (sender, receiver) = watch::channel(None);
                state.running = Some(receiver.clone());
                let inner = self.inner.clone();
                tokio::spawn(async move {
                    let result = match tokio::spawn(inner.clone().process()).await {
                        Ok(result) => result,
                        Err(_) => Err("Audio inference task failed".into()),
                    };
                    inner.lock().running = None;
                    let _ = sender.send(Some(result));
                });
                receiver
            }
        };
        let outcome = receiver
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|completion| completion.clone());
        match outcome {
            Some(Ok(())) => Ok(()),
            Some(Err(message)) => Err(AudioError::Inference(message)),
            None => Err(AudioError::Inference("Audio inference task stopped".into())),
        }
    }

    pub async fn close(&self) -> Result<(), AudioError> {
        {
            let mut state = self.inner.lock();
            if state.closed {
                return Ok(());
            }
            state.closing = true;
        }
        self.flush().await?;
        let mut state = self.inner.lock();
        state.sources.clear();
        state.replays.clear();
        state.capture_id = None;
        state.closed = true;
        Ok(())
    }

    pub fn stats(&self) -> Stats {
        let state = self.inner.lock();
        Stats {
            buffered_seconds: self
                .inner
                .buffered_seconds(&state.sources, state.pending.iter()),
            processed_seconds: state.processed_seconds,
            backlog: state.pending.len(),
            error: state.error.clone(),
        }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn admit(
        &self,
        state: &mut State,
        input: &AudioInput,
    ) -> Result<(Accepted, Option<Gap>), AudioError> {
        if state.closed || state.closing {
            return Err(rejected("Audio processor is closed to new input"));
        }
        validate(state, input)?;
        let previous = find(&state.sources, input.source).cloned();
        let replayed = state
            .replays
            .get(&input.source)
            .and_then(|replay| replay.digests.get(&input.sequence));
        if previous
            .as_ref()
            .is_some_and(|previous| input.sequence <= previous.sequence)
            && replayed.is_none()
        {
            return Err(rejected("Audio replay expired; sequence must increase"));
        }
        let digest = input_digest(input);
        if let Some(existing) = replayed {
            if *existing != digest {
                return Err(rejected("Changed duplicate audio replay"));
            }
            return Ok((Accepted { duplicate: true }, None));
        }
        if let Some(error) = &state.error {
            return Err(AudioError::Rejected(format!(
                "Pending audio inference failed; call drain to retry: {error}"
            )));
        }
        let incoming = input.samples.len() as f64 / f64::from(input.sample_rate);
        if self.buffered_seconds(&state.sources, state.pending.iter()) + incoming
            > self.capacity + CAPACITY_EPSILON
        {
            return Err(AudioError::Backpressure);
        }
        if let Some(previous) = &previous {
            if input.sequence <= previous.sequence {
                return Err(rejected("Audio sequence must increase"));
            }
            if input.start_ms < previous.end_ms - tolerance(previous) {
                return Err(rejected("Audio clock cannot regress or overlap"));
            }
        }
        let discontinuity = previous.as_ref().is_some_and(|previous| {
            input.sequence != previous.sequence + 1
                || (input.start_ms - previous.end_ms).abs() > tolerance(previous)
                || input.sample_rate != previous.input_rate
        });
        let mut queued = Vec::new();
        if discontinuity && let Some(previous) = &previous {
            let mut tail = previous.clone();
            self.convert(&mut tail, true)?;
            self.emit(
                &mut tail,
                input.source,
                &input.capture_id,
                &mut queued,
                true,
            );
        }
        let mut source = match previous {
            Some(previous) if !discontinuity && !previous.finalized => previous,
            _ => Source {
                origin_ms: input.start_ms,
                input_rate: input.sample_rate,
                input: Vec::new(),
                input_offset: 0,
                input_through: 0,
                output_through: 0,
                output: Vec::new(),
                output_offset: 0,
                emitted_through: 0,
                end_ms: input.start_ms,
                sequence: input.sequence,
                finalized: false,
            },
        };
        source.input.extend_from_slice(&input.samples);
        source.input_through += input.samples.len();
        source.end_ms = source.origin_ms
            + (source.input_through as f64 * 1000.0) / f64::from(source.input_rate);
        source.sequence = input.sequence;
        self.convert(&mut source, false)?;
        self.emit(
            &mut source,
            input.source,
            &input.capture_id,
            &mut queued,
            false,
        );
        let mut projected = state.sources.clone();
        upsert(&mut projected, input.source, source.clone());
        if self.buffered_seconds(&projected, state.pending.iter().chain(queued.iter()))
            > self.capacity + CAPACITY_EPSILON
        {
            return Err(AudioError::Backpressure);
        }
        let mut final_queued = Vec::new();
        let mut finalized = Vec::new();
        for (name, current) in &projected {
            let mut tail = current.clone();
            self.convert(&mut tail, true)?;
            self.emit(&mut tail, *name, &input.capture_id, &mut final_queued, true);
            finalized.push((*name, tail));
        }
        if self.buffered_seconds(
            &finalized,
            state
                .pending
                .iter()
                .chain(queued.iter())
                .chain(final_queued.iter()),
        ) > self.capacity + CAPACITY_EPSILON
        {
            return Err(AudioError::Backpressure);
        }
        upsert(&mut state.sources, input.source, source);
        state.pending.extend(queued);
        state.capture_id = Some(input.capture_id.clone());
        let replay = state.replays.entry(input.source).or_default();
        replay.digests.insert(input.sequence, digest);
        replay.order.push_back(input.sequence);
        if replay.order.len() > REPLAY_LIMIT
            && let Some(oldest) = replay.order.pop_front()
        {
            replay.digests.remove(&oldest);
        }
        let gap = discontinuity.then(|| Gap {
            source: input.source,
            start_ms: input.start_ms,
            reason: "Audio sequence, timestamp or sample-rate discontinuity".into(),
        });
        Ok((Accepted { duplicate: false }, gap))
    }

    fn buffered_seconds<'a>(
        &self,
        sources: &[(AudioSource, Source)],
        pending: impl Iterator<Item = &'a Pending>,
    ) -> f64 {
        sources
            .iter()
            .map(|(_, source)| {
                source.input.len() as f64 / f64::from(source.input_rate)
                    + source.output.len() as f64 / f64::from(self.rate)
            })
            .sum::<f64>()
            + pending
                .map(|item| item.chunk.samples.len() as f64 / f64::from(self.rate))
                .sum::<f64>()
    }

    fn convert(&self, source: &mut Source, last: bool) -> Result<(), AudioError> {
        if source.input_rate == self.rate {
            source.output.extend_from_slice(&source.input);
            source.output_through += source.input.len();
            source.input_offset = source.input_through;
            source.input.clear();
            return Ok(());
        }
        let ratio = f64::from(self.rate) / f64::from(source.input_rate);
        let cutoff = ratio.min(1.0) * 0.9;
        let radius = (24.0 / cutoff).ceil() as i64;
        let through = ((source.input_through as f64 * f64::from(self.rate))
            / f64::from(source.input_rate))
        .round() as usize;
        let mut converted = Vec::new();
        while source.output_through < through {
            let position = (source.output_through as f64 * f64::from(source.input_rate))
                / f64::from(self.rate);
            if !last && position.ceil() as i64 + radius >= source.input_through as i64 {
                break;
            }
            let mut value = 0.0;
            let mut weight = 0.0;
            for index in
                (position - radius as f64).ceil() as i64..=(position + radius as f64).floor() as i64
            {
                let distance = position - index as f64;
                let argument = PI * cutoff * distance;
                let coefficient = cutoff
                    * if argument == 0.0 {
                        1.0
                    } else {
                        argument.sin() / argument
                    }
                    * (0.5 + 0.5 * (PI * distance / radius as f64).cos());
                let clamped = index.min(source.input_through as i64 - 1).max(0);
                let offset = clamped - source.input_offset as i64;
                let sample = usize::try_from(offset)
                    .ok()
                    .and_then(|offset| source.input.get(offset))
                    .ok_or_else(|| rejected("Missing audio resampler history"))?;
                value += f64::from(*sample) * coefficient;
                weight += coefficient;
            }
            converted.push((value / weight).clamp(-1.0, 1.0) as f32);
            source.output_through += 1;
        }
        source.output.extend(converted);
        let discard_through = if last {
            source.input_through
        } else {
            let retained = ((source.output_through as f64 * f64::from(source.input_rate))
                / f64::from(self.rate))
            .floor() as i64
                - radius;
            source
                .input_through
                .min(source.input_offset.max(retained.max(0) as usize))
        };
        source.input.drain(..discard_through - source.input_offset);
        source.input_offset = discard_through;
        Ok(())
    }

    fn emit(
        &self,
        source: &mut Source,
        name: AudioSource,
        capture_id: &str,
        pending: &mut Vec<Pending>,
        last: bool,
    ) {
        while !source.output.is_empty() {
            if source.output.len() < self.window
                && (!last || source.output_offset + source.output.len() <= source.emitted_through)
            {
                break;
            }
            let length = self.window.min(source.output.len());
            let through = source.output_offset + length;
            let chunk = AudioChunk {
                id: chunk_id(capture_id, name, source.origin_ms, source.output_offset),
                source: name,
                start_ms: source.origin_ms
                    + (source.output_offset as f64 * 1000.0) / f64::from(self.rate),
                sample_rate: self.rate,
                samples: source.output[..length].to_vec(),
            };
            pending.push(Pending {
                chunk,
                seconds: (through - source.emitted_through.max(source.output_offset)) as f64
                    / f64::from(self.rate),
            });
            source.emitted_through = through;
            let stride = if length == self.window {
                self.window - self.overlap
            } else {
                length
            };
            source.output.drain(..stride);
            source.output_offset += stride;
        }
        if last {
            source.output.clear();
            source.output_offset = source.output_through;
            source.finalized = true;
        }
    }

    async fn process(self: Arc<Self>) -> Result<(), String> {
        loop {
            let (chunk, seconds) = {
                let state = self.lock();
                match state.pending.front() {
                    Some(item) => (item.chunk.clone(), item.seconds),
                    None => return Ok(()),
                }
            };
            if !self.options.vad || speech(&chunk.samples) {
                let outcome = (self.options.on_chunk)(chunk).await;
                if let Err(message) = outcome {
                    self.lock().error = Some(sanitize_error(&message));
                    return Err(message);
                }
            }
            let mut state = self.lock();
            state.pending.pop_front();
            state.processed_seconds += seconds;
        }
    }
}

fn validate(state: &State, input: &AudioInput) -> Result<(), AudioError> {
    if input.capture_id.is_empty()
        || input.capture_id.encode_utf16().count() > 256
        || state
            .capture_id
            .as_ref()
            .is_some_and(|current| *current != input.capture_id)
    {
        return Err(rejected("Invalid or changed capture id"));
    }
    if input.sequence > MAX_SAFE_INTEGER {
        return Err(rejected("Invalid audio sequence"));
    }
    if !input.start_ms.is_finite() || input.start_ms < 0.0 {
        return Err(rejected("Invalid audio timestamp"));
    }
    if !(8000..=192_000).contains(&input.sample_rate) {
        return Err(rejected("Invalid input sample rate"));
    }
    if input.samples.is_empty() {
        return Err(rejected("Audio input must contain Float32 samples"));
    }
    if input.samples.iter().any(|sample| !sample.is_finite()) {
        return Err(rejected("Audio samples must be finite"));
    }
    Ok(())
}

fn find(sources: &[(AudioSource, Source)], name: AudioSource) -> Option<&Source> {
    sources
        .iter()
        .find(|(candidate, _)| *candidate == name)
        .map(|(_, source)| source)
}

fn upsert(sources: &mut Vec<(AudioSource, Source)>, name: AudioSource, source: Source) {
    match sources.iter_mut().find(|(candidate, _)| *candidate == name) {
        Some(entry) => entry.1 = source,
        None => sources.push((name, source)),
    }
}

fn tolerance(source: &Source) -> f64 {
    0.5 * 1000.0 / f64::from(source.input_rate)
}

fn speech(samples: &[f32]) -> bool {
    let energy: f64 = samples
        .iter()
        .map(|sample| f64::from(*sample) * f64::from(*sample))
        .sum();
    (energy / samples.len() as f64).sqrt() >= SPEECH_RMS
}

fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn input_digest(input: &AudioInput) -> String {
    let mut context = Context::new(&SHA256);
    context.update(
        format!(
            "[{},{},{},{},{}]",
            Value::from(input.capture_id.as_str()),
            Value::from(input.source.as_str()),
            input.sequence,
            js_number(input.start_ms),
            input.sample_rate
        )
        .as_bytes(),
    );
    for sample in &input.samples {
        context.update(&sample.to_le_bytes());
    }
    hex(context.finish().as_ref())
}

fn chunk_id(capture_id: &str, name: AudioSource, origin_ms: f64, offset: usize) -> String {
    let mut context = Context::new(&SHA256);
    context.update(
        format!(
            "[{},{},{},{}]",
            Value::from(capture_id),
            Value::from(name.as_str()),
            js_number(origin_ms),
            offset
        )
        .as_bytes(),
    );
    hex(context.finish().as_ref())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn reconcile_overlap(
    previous_text: &str,
    previous_end_ms: f64,
    next_text: &str,
    next_start_ms: f64,
) -> String {
    if !previous_end_ms.is_finite()
        || !next_start_ms.is_finite()
        || next_start_ms >= previous_end_ms
    {
        return next_text.into();
    }
    let left = graphemes(previous_text.trim_end());
    let right = graphemes(next_text);
    for length in (2..=left.len().min(right.len())).rev() {
        let matching = right[..length].concat();
        if left[left.len() - length..].concat() != matching {
            continue;
        }
        let tail = right[length..].concat();
        let before = left[..left.len() - length].concat();
        if matching.chars().all(latin_or_number)
            && (tail.chars().next().is_some_and(latin_or_number)
                || before.chars().next_back().is_some_and(latin_or_number))
        {
            continue;
        }
        return tail.trim_start().to_owned();
    }
    next_text.into()
}

fn latin_or_number(character: char) -> bool {
    CodePointMapData::<Script>::new().get(character) == Script::Latin
        || GeneralCategoryGroup::Number
            .contains(CodePointMapData::<GeneralCategory>::new().get(character))
}

#[derive(Clone, Copy, PartialEq)]
enum Pictograph {
    None,
    Sequence,
    Joined,
}

fn graphemes(text: &str) -> Vec<&str> {
    let classes = CodePointMapData::<GraphemeClusterBreak>::new();
    let pictographic = CodePointSetData::new::<ExtendedPictographic>();
    let mut clusters = Vec::new();
    let mut start = 0;
    let mut previous = None;
    let mut regional = 0usize;
    let mut pictograph = Pictograph::None;
    for (index, character) in text.char_indices() {
        let class = classes.get(character);
        let extended = pictographic.contains(character);
        if let Some(before) = previous
            && !joins(before, class, extended, regional, pictograph)
        {
            clusters.push(&text[start..index]);
            start = index;
        }
        regional = if class == GraphemeClusterBreak::RegionalIndicator {
            regional + 1
        } else {
            0
        };
        pictograph = if extended
            || (pictograph != Pictograph::None && class == GraphemeClusterBreak::Extend)
        {
            Pictograph::Sequence
        } else if pictograph == Pictograph::Sequence && class == GraphemeClusterBreak::ZWJ {
            Pictograph::Joined
        } else {
            Pictograph::None
        };
        previous = Some(class);
    }
    if start < text.len() {
        clusters.push(&text[start..]);
    }
    clusters
}

fn joins(
    before: GraphemeClusterBreak,
    class: GraphemeClusterBreak,
    extended: bool,
    regional: usize,
    pictograph: Pictograph,
) -> bool {
    let control = |class: GraphemeClusterBreak| {
        class == GraphemeClusterBreak::Control
            || class == GraphemeClusterBreak::CR
            || class == GraphemeClusterBreak::LF
    };
    if before == GraphemeClusterBreak::CR && class == GraphemeClusterBreak::LF {
        return true;
    }
    if control(before) || control(class) {
        return false;
    }
    let hangul_lead = class == GraphemeClusterBreak::L
        || class == GraphemeClusterBreak::V
        || class == GraphemeClusterBreak::LV
        || class == GraphemeClusterBreak::LVT;
    let hangul_vowel = class == GraphemeClusterBreak::V || class == GraphemeClusterBreak::T;
    (before == GraphemeClusterBreak::L && hangul_lead)
        || ((before == GraphemeClusterBreak::LV || before == GraphemeClusterBreak::V)
            && hangul_vowel)
        || ((before == GraphemeClusterBreak::LVT || before == GraphemeClusterBreak::T)
            && class == GraphemeClusterBreak::T)
        || class == GraphemeClusterBreak::Extend
        || class == GraphemeClusterBreak::ZWJ
        || class == GraphemeClusterBreak::SpacingMark
        || before == GraphemeClusterBreak::Prepend
        || (pictograph == Pictograph::Joined && extended)
        || (before == GraphemeClusterBreak::RegionalIndicator
            && class == GraphemeClusterBreak::RegionalIndicator
            && regional % 2 == 1)
}
