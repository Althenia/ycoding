use super::{
    document::Fields,
    error::Error,
    provision::{self, Pin},
    vectors::{VectorCache, cosine, normalized},
};
use fastembed::{
    AutoDevicePolicy, InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
        mpsc,
    },
};

pub const QUERY_INSTRUCTION: &str = "Represent this sentence for searching relevant passages: ";
const BATCH: usize = 8;
const MAX_TEXT_CHARS: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Idle,
    Starting,
    Ready,
    Failed,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub models: PathBuf,
    pub vectors: Option<PathBuf>,
    pub pin: Pin,
    pub base_url: Option<String>,
    pub threads: usize,
}

impl Config {
    pub fn new(models: PathBuf, vectors: Option<PathBuf>) -> Self {
        Self {
            models,
            vectors,
            pin: provision::BGE_SMALL,
            base_url: None,
            threads: 2,
        }
    }
}

pub trait Embedder: Send {
    fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>, Error>;
}

struct Onnx(TextEmbedding);

impl Embedder for Onnx {
    fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>, Error> {
        self.0
            .embed(texts, Some(BATCH))
            .map_err(|e| Error::Model(e.to_string()))
    }
}

enum Job {
    Warm,
    Embed(String, String),
}

struct Shared {
    config: Config,
    cache: VectorCache,
    status: AtomicU8,
    model: Mutex<Option<Box<dyn Embedder>>>,
    queued: Mutex<HashSet<String>>,
}

pub struct Semantic {
    shared: Arc<Shared>,
    sender: Mutex<Option<mpsc::Sender<Job>>>,
}

pub fn embedding_text(fields: &Fields) -> String {
    let mut text = String::new();
    for part in [&fields.title, &fields.description] {
        if !part.is_empty() {
            text.push_str(part);
            text.push_str(". ");
        }
    }
    let tags = fields.tags.join(", ");
    if !tags.is_empty() {
        text.push_str(&tags);
        text.push_str(". ");
    }
    text.push_str(&fields.body);
    text.chars().take(MAX_TEXT_CHARS).collect()
}

impl Semantic {
    pub fn new(config: Config) -> Arc<Self> {
        let cache = VectorCache::open(
            config.vectors.clone(),
            &format!("{}@{}", provision::MODEL_ID, config.pin.revision),
        );
        Arc::new(Self {
            shared: Arc::new(Shared {
                config,
                cache,
                status: AtomicU8::new(0),
                model: Mutex::new(None),
                queued: Mutex::default(),
            }),
            sender: Mutex::new(None),
        })
    }

    pub fn status(&self) -> Status {
        match self.shared.status.load(Ordering::Acquire) {
            0 => Status::Idle,
            1 => Status::Starting,
            2 => Status::Ready,
            _ => Status::Failed,
        }
    }

    pub fn cache(&self) -> &VectorCache {
        &self.shared.cache
    }

    fn send(&self, job: Job) {
        let Ok(mut sender) = self.sender.lock() else {
            return;
        };
        if self.status() == Status::Failed {
            return;
        }
        let tx = sender.get_or_insert_with(|| {
            let (tx, rx) = mpsc::channel();
            let shared = self.shared.clone();
            self.shared.status.store(1, Ordering::Release);
            let _ = std::thread::Builder::new()
                .name("cue-embedding".into())
                .spawn(move || worker(shared, rx));
            tx
        });
        let _ = tx.send(job);
    }

    pub fn warm(&self) {
        self.send(Job::Warm);
    }

    pub fn enqueue(&self, hash: &str, text: String) {
        if self.shared.cache.contains(hash) {
            return;
        }
        let Ok(mut queued) = self.shared.queued.lock() else {
            return;
        };
        if queued.insert(hash.to_owned()) {
            drop(queued);
            self.send(Job::Embed(hash.to_owned(), text));
        }
    }

    pub fn pending(&self) -> usize {
        self.shared.queued.lock().map_or(0, |q| q.len())
    }

    pub fn query_vector(&self, text: &str) -> Option<Vec<f32>> {
        if self.status() != Status::Ready {
            return None;
        }
        let mut guard = self.shared.model.lock().ok()?;
        let model = guard.as_mut()?;
        let prompt = format!("{QUERY_INSTRUCTION}{text}");
        let vector = model.embed(&[prompt]).ok()?.into_iter().next()?;
        normalized(vector)
    }

    pub fn nearest<'a>(
        &self,
        query: &[f32],
        candidates: impl Iterator<Item = (&'a str, &'a str)>,
        floor: f32,
        limit: usize,
    ) -> Vec<(String, f32)> {
        let mut scored: Vec<(String, f32)> = candidates
            .filter_map(|(key, hash)| {
                let vector = self.shared.cache.get(hash)?;
                let similarity = cosine(query, &vector);
                (similarity >= floor).then(|| (key.to_owned(), similarity))
            })
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        scored.truncate(limit);
        scored
    }
}

fn load(config: &Config) -> Result<Box<dyn Embedder>, Error> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| Error::Model(e.to_string()))?;
    let dir = runtime.block_on(provision::provision(
        &config.models,
        &config.pin,
        config.base_url.as_deref(),
    ))?;
    let read = |name: &str| std::fs::read(dir.join(name)).map_err(|e| Error::Model(e.to_string()));
    let model = UserDefinedEmbeddingModel::new(
        read("model.onnx")?,
        TokenizerFiles {
            tokenizer_file: read("tokenizer.json")?,
            config_file: read("config.json")?,
            special_tokens_map_file: read("special_tokens_map.json")?,
            tokenizer_config_file: read("tokenizer_config.json")?,
        },
    )
    .with_pooling(Pooling::Cls);
    let embedder = TextEmbedding::try_new_from_user_defined(
        model,
        InitOptionsUserDefined::new()
            .with_max_length(512)
            .with_intra_threads(config.threads.max(1))
            .with_auto_device(AutoDevicePolicy::PreferCPU),
    )
    .map_err(|e| Error::Model(e.to_string()))?;
    Ok(Box::new(Onnx(embedder)))
}

fn worker(shared: Arc<Shared>, rx: mpsc::Receiver<Job>) {
    match load(&shared.config) {
        Ok(model) => {
            if let Ok(mut slot) = shared.model.lock() {
                *slot = Some(model);
            }
            shared.status.store(2, Ordering::Release);
        }
        Err(_) => {
            shared.status.store(3, Ordering::Release);
            return;
        }
    }
    while let Ok(first) = rx.recv() {
        let mut batch = vec![first];
        while batch.len() < BATCH
            && let Ok(job) = rx.try_recv()
        {
            batch.push(job);
        }
        let jobs: Vec<(String, String)> = batch
            .into_iter()
            .filter_map(|job| match job {
                Job::Embed(hash, text) => Some((hash, text)),
                Job::Warm => None,
            })
            .collect();
        if !jobs.is_empty() {
            let texts: Vec<String> = jobs.iter().map(|(_, t)| t.clone()).collect();
            let result = shared
                .model
                .lock()
                .ok()
                .and_then(|mut guard| guard.as_mut()?.embed(&texts).ok());
            if let Some(vectors) = result {
                for ((hash, _), vector) in jobs.iter().zip(vectors) {
                    shared.cache.insert(hash, vector);
                }
            }
            if let Ok(mut queued) = shared.queued.lock() {
                for (hash, _) in &jobs {
                    queued.remove(hash);
                }
            }
        }
        if shared.queued.lock().is_ok_and(|q| q.is_empty()) {
            let _ = shared.cache.persist();
        }
    }
}
