use super::provision::DIMENSIONS;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::PathBuf,
    sync::{Arc, RwLock},
};

const MAGIC: &[u8; 8] = b"CUEVEC01";
const MAX_ENTRIES: usize = 50_000;

pub fn normalized(mut vector: Vec<f32>) -> Option<Vec<f32>> {
    if vector.len() != DIMENSIONS || vector.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm == 0.0 {
        return None;
    }
    vector.iter_mut().for_each(|v| *v /= norm);
    Some(vector)
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub struct VectorCache {
    path: Option<PathBuf>,
    revision: String,
    entries: RwLock<HashMap<String, Arc<Vec<f32>>>>,
}

impl VectorCache {
    pub fn open(path: Option<PathBuf>, revision: &str) -> Self {
        let entries = path
            .as_deref()
            .and_then(|p| fs::read(p).ok())
            .and_then(|bytes| decode(&bytes, revision))
            .unwrap_or_default();
        Self {
            path,
            revision: revision.to_owned(),
            entries: RwLock::new(entries),
        }
    }

    fn key(&self, hash: &str) -> String {
        format!("{}:{hash}", self.revision)
    }

    pub fn get(&self, hash: &str) -> Option<Arc<Vec<f32>>> {
        self.entries.read().ok()?.get(&self.key(hash)).cloned()
    }

    pub fn contains(&self, hash: &str) -> bool {
        self.entries
            .read()
            .is_ok_and(|e| e.contains_key(&self.key(hash)))
    }

    pub fn insert(&self, hash: &str, vector: Vec<f32>) {
        if let (Some(vector), Ok(mut entries)) = (normalized(vector), self.entries.write())
            && entries.len() < MAX_ENTRIES
        {
            entries.insert(self.key(hash), Arc::new(vector));
        }
    }

    pub fn retain(&self, live: &HashSet<String>) {
        if let Ok(mut entries) = self.entries.write() {
            let keep: HashSet<String> = live.iter().map(|h| self.key(h)).collect();
            entries.retain(|k, _| keep.contains(k));
        }
    }

    pub fn len(&self) -> usize {
        self.entries.read().map_or(0, |e| e.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn persist(&self) -> std::io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let entries = self
            .entries
            .read()
            .map_err(|_| std::io::Error::other("poisoned"))?;
        let mut buffer = Vec::with_capacity(16 + entries.len() * (DIMENSIONS * 4 + 80));
        buffer.extend_from_slice(MAGIC);
        buffer.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        let mut keys: Vec<_> = entries.keys().collect();
        keys.sort();
        for key in keys {
            buffer.extend_from_slice(&(key.len() as u16).to_le_bytes());
            buffer.extend_from_slice(key.as_bytes());
            for value in entries[key].iter() {
                buffer.extend_from_slice(&value.to_le_bytes());
            }
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("tmp");
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&buffer)?;
        file.sync_all()?;
        fs::rename(temporary, path)
    }
}

fn decode(bytes: &[u8], revision: &str) -> Option<HashMap<String, Arc<Vec<f32>>>> {
    let rest = bytes.strip_prefix(MAGIC)?;
    let count = u32::from_le_bytes(rest.get(..4)?.try_into().ok()?) as usize;
    if count > MAX_ENTRIES {
        return None;
    }
    let mut cursor = &rest[4..];
    let mut out = HashMap::with_capacity(count);
    for _ in 0..count {
        let len = u16::from_le_bytes(cursor.get(..2)?.try_into().ok()?) as usize;
        let key = std::str::from_utf8(cursor.get(2..2 + len)?)
            .ok()?
            .to_owned();
        cursor = &cursor[2 + len..];
        let raw = cursor.get(..DIMENSIONS * 4)?;
        cursor = &cursor[DIMENSIONS * 4..];
        if key.starts_with(&format!("{revision}:")) {
            let vector = raw
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| f32::from_le_bytes(*c))
                .collect();
            out.insert(key, Arc::new(normalized(vector)?));
        }
    }
    cursor.is_empty().then_some(out)
}
