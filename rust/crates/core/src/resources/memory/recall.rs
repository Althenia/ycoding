use super::{Concept, Error, atomic, create_root, safe_path, sha256};
use crate::resources::recall::lexical::{Document, Lexical};
use std::{fs, io::Read, path::Path, time::Instant};

const SNAPSHOT_LIMIT: usize = 48 << 20;
#[derive(Default)]
pub(super) struct Cache {
    generation: String,
    lexical: Option<Lexical>,
}

fn acquire_builder(cache: &Path) -> Option<fs::File> {
    let directory = cache.parent()?;
    let path = directory.join(".locks/recall-build.lock");
    if !safe_path(directory, &path).ok()? {
        create_root(directory).ok()?;
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return None;
        }
    }
    file.try_lock().ok()?;
    Some(file)
}

impl Cache {
    pub fn scores(
        &mut self,
        cache: &Path,
        concepts: &[Concept],
        docs: &[Document<'_>],
        terms: &std::collections::BTreeSet<String>,
        publish_before: Instant,
    ) -> Result<(Vec<f64>, bool), Error> {
        let mut identity = cache.as_os_str().as_encoded_bytes().to_owned();
        for c in concepts {
            identity.push(0);
            identity.extend_from_slice(c.summary.id.as_bytes());
            identity.push(0);
            identity.extend_from_slice(c.summary.digest.as_bytes());
        }
        let generation = sha256(&identity);
        if self.generation == generation
            && let Some(index) = &self.lexical
        {
            return Ok((index.scores(terms)?, true));
        }
        let target = cache.join("bm25-v1");
        let (index, persisted) = match load(&target)
            .and_then(|bytes| Lexical::unpack(&bytes, &generation, docs.len()))
        {
            Some(index) => (index, true),
            None => {
                let builder = acquire_builder(cache);
                let index = Lexical::build(docs)?;
                let persisted = builder.is_some()
                    && Instant::now() < publish_before
                    && index.pack(&generation, SNAPSHOT_LIMIT).is_ok_and(|bytes| {
                        Instant::now() < publish_before && save(&target, &bytes).is_ok()
                    });
                (index, persisted)
            }
        };
        let scores = index.scores(terms)?;
        if persisted {
            self.generation = generation;
            self.lexical = Some(index);
        }
        Ok((scores, persisted))
    }
}

fn load(path: &Path) -> Option<Vec<u8>> {
    if !safe_path(path.parent()?, path).ok()? {
        return None;
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let info = file.metadata().ok()?;
    if !info.is_file() || info.len() > SNAPSHOT_LIMIT as u64 + 32 || info.len() < 32 {
        return None;
    }
    let mut buf = Vec::with_capacity(info.len() as usize);
    file.take(info.len() + 1).read_to_end(&mut buf).ok()?;
    if buf.len() as u64 != info.len()
        || ring::digest::digest(&ring::digest::SHA256, &buf[32..]).as_ref() != &buf[..32]
    {
        return None;
    }
    buf.drain(..32);
    Some(buf)
}

fn save(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    if bytes.len() > SNAPSHOT_LIMIT {
        return Err(Error::TooLarge);
    }
    let root = path.parent().ok_or(Error::UnsafePath)?;
    create_root(root)?;
    let mut buffer = Vec::with_capacity(32 + bytes.len());
    buffer.extend_from_slice(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref());
    buffer.extend_from_slice(bytes);
    atomic(root, path, &buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn competing_builder_leaves_the_committed_generation_unchanged() {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("cue-busy-build-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let index = root.join("index");
        create_root(&index).unwrap();
        let cache_path = index.join("collection");
        let terms = super::super::format::words("canary").unwrap();
        let mut cache = Cache::default();
        let score = |cache: &mut Cache, body: &str| {
            let concept =
                super::super::format::parse("fixture", &format!("---\ntype: Note\n---\n{body}"))
                    .unwrap();
            let doc = Document {
                id: "fixture",
                title: String::new(),
                metadata: "Note".into(),
                tags: vec![],
                body,
            };
            cache
                .scores(
                    &cache_path,
                    &[concept],
                    &[doc],
                    &terms,
                    Instant::now() + std::time::Duration::from_secs(60),
                )
                .unwrap()
        };
        let (old, true) = score(&mut cache, "obsolete") else {
            panic!("expected a committed index")
        };
        let target = cache_path.join("bm25-v1");
        let prior = fs::read(&target).unwrap();
        let fence = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(index.join(".locks/recall-build.lock"))
            .unwrap();
        fence.lock().unwrap();
        let (current, false) = score(&mut cache, "canary") else {
            panic!("competing reader published an index")
        };
        assert_ne!(old, current);
        assert_eq!(fs::read(&target).unwrap(), prior);
        drop(fence);
        assert_eq!(score(&mut cache, "canary"), (current, true));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn expired_rebuild_scores_current_sources_without_publishing_over_the_last_generation() {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("cue-expired-build-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let cache_path = root.join("cache");
        let terms = super::super::format::words("canary ready").unwrap();
        let mut cache = Cache::default();
        let score = |cache: &mut Cache, body: &str, deadline| {
            let concept =
                super::super::format::parse("fixture", &format!("---\ntype: Note\n---\n{body}"))
                    .unwrap();
            let doc = Document {
                id: "fixture",
                title: String::new(),
                metadata: "Note".into(),
                tags: vec![],
                body,
            };
            cache
                .scores(&cache_path, &[concept], &[doc], &terms, deadline)
                .unwrap()
        };
        let future = || Instant::now() + std::time::Duration::from_secs(60);
        let (before, true) = score(&mut cache, "ready", future()) else {
            panic!("expected indexed score")
        };
        let previous = fs::read(cache_path.join("bm25-v1")).unwrap();
        let (current, false) = score(&mut cache, "canary ready", Instant::now()) else {
            panic!("expected direct score")
        };
        assert_ne!(current, before);
        assert_eq!(fs::read(cache_path.join("bm25-v1")).unwrap(), previous);
        assert_eq!(score(&mut cache, "canary ready", future()), (current, true));
        fs::remove_dir_all(root).unwrap();
    }
}
