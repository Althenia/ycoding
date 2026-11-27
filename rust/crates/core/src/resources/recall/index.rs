use super::{
    analysis::{self, ANALYZER, REVISION},
    candidate::Reason,
    document::{Activation, Document, Kind, Scope, Status},
    error::Error,
};
use std::{
    collections::{BTreeSet, HashMap},
    ops::Bound,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::Instant,
};
use tantivy::{
    DocAddress, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term,
    collector::{DocSetCollector, TopDocs},
    directory::MmapDirectory,
    query::{AllQuery, BooleanQuery, BoostQuery, Occur, PhraseQuery, Query, RangeQuery, TermQuery},
    schema::{
        FAST, Field, INDEXED, IndexRecordOption, STORED, STRING, Schema, TextFieldIndexing,
        TextOptions, Value,
    },
};

const WRITER_HEAP: usize = 15_000_000;
const TEXT_FIELDS: [(&str, f32); 8] = [
    ("title", 3.0),
    ("tags", 2.0),
    ("keywords", 2.0),
    ("identifiers", 3.0),
    ("description", 2.0),
    ("doc_type", 2.0),
    ("relationships", 0.5),
    ("body", 1.0),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub scope: Scope,
    pub kind: Kind,
    pub id: String,
    pub hash: String,
}

impl Entry {
    pub fn key(&self) -> String {
        key(self.scope, self.kind, &self.id)
    }
}

pub fn key(scope: Scope, kind: Kind, id: &str) -> String {
    format!("{}\u{1}{}\u{1}{id}", scope.as_str(), kind.as_str())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Publication {
    Unchanged,
    Committed,
    Volatile,
}

#[derive(Clone, Debug, Default)]
pub struct Filter {
    pub kinds: Vec<Kind>,
    pub scopes: Vec<Scope>,
    pub tags: Vec<String>,
    pub types: Vec<String>,
    pub implicit: bool,
    pub now: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Hit {
    pub key: String,
    pub id: String,
    pub kind: Kind,
    pub scope: Scope,
    pub hash: String,
    pub score: f64,
}

#[derive(Clone, Debug)]
pub struct Meta {
    pub id: String,
    pub kind: Kind,
    pub scope: Scope,
    pub stamp: String,
    pub hash: String,
    pub doc_type: String,
    pub tags: Vec<String>,
    pub manual: bool,
    pub eligible_until: i64,
    pub active: bool,
    pub bytes: usize,
}

#[derive(Clone)]
struct Fields {
    key: Field,
    stamp: Field,
    hash: Field,
    id: Field,
    kind: Field,
    scope: Field,
    status: Field,
    superseded: Field,
    activation: Field,
    stale: Field,
    bytes: Field,
    x_id: Field,
    x_title: Field,
    x_tag: Field,
    x_tag_raw: Field,
    x_ident: Field,
    x_type: Field,
    text: Vec<(Field, f32)>,
    body: Field,
}

fn schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let text_options = TextOptions::default().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer(ANALYZER)
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    );
    let key = builder.add_text_field("key", STRING | STORED);
    let stamp = builder.add_text_field("stamp", STORED);
    let hash = builder.add_text_field("hash", STORED);
    let id = builder.add_text_field("id", STRING | STORED);
    let kind = builder.add_text_field("kind", STRING | STORED);
    let scope = builder.add_text_field("scope", STRING | STORED);
    let status = builder.add_text_field("status", STRING);
    let superseded = builder.add_text_field("superseded", STRING);
    let activation = builder.add_text_field("activation", STRING | STORED);
    let stale = builder.add_i64_field("stale", INDEXED | FAST | STORED);
    let bytes = builder.add_i64_field("bytes", STORED);
    let x_id = builder.add_text_field("x_id", STRING);
    let x_title = builder.add_text_field("x_title", STRING);
    let x_tag = builder.add_text_field("x_tag", STRING);
    let x_tag_raw = builder.add_text_field("x_tag_raw", STRING | STORED);
    let x_ident = builder.add_text_field("x_ident", STRING);
    let x_type = builder.add_text_field("x_type", STRING | STORED);
    let text: Vec<_> = TEXT_FIELDS
        .iter()
        .map(|(name, boost)| (builder.add_text_field(name, text_options.clone()), *boost))
        .collect();
    let body = text.last().unwrap().0;
    (
        builder.build(),
        Fields {
            key,
            stamp,
            hash,
            id,
            kind,
            scope,
            status,
            superseded,
            activation,
            stale,
            bytes,
            x_id,
            x_title,
            x_tag,
            x_tag_raw,
            x_ident,
            x_type,
            text,
            body,
        },
    )
}

pub fn injected_bytes(doc: &Document) -> usize {
    doc.fields.title.len() + doc.fields.description.len() + doc.fields.body.len()
}

pub fn stamp(hash: &str) -> String {
    format!("{REVISION}:{hash}")
}

fn kind_of(value: &str) -> Option<Kind> {
    match value {
        "concept" => Some(Kind::Concept),
        "skill" => Some(Kind::Skill),
        "experience" => Some(Kind::Experience),
        _ => None,
    }
}

fn scope_of(value: &str) -> Option<Scope> {
    match value {
        "workspace" => Some(Scope::Workspace),
        "project" => Some(Scope::Project),
        "knowledge" => Some(Scope::Knowledge),
        _ => None,
    }
}

struct Store {
    index: Index,
    reader: IndexReader,
    fields: Fields,
    docs: RwLock<HashMap<String, Meta>>,
}

fn open_directory(path: &Path) -> Result<Index, Error> {
    std::fs::create_dir_all(path)?;
    let (schema, _) = schema();
    let index = Index::open_or_create(MmapDirectory::open(path)?, schema)?;
    Ok(index)
}

impl Store {
    fn new(index: Index) -> Result<Self, Error> {
        index.tokenizers().register(ANALYZER, analysis::analyzer());
        let (_, fields) = schema();
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        let store = Self {
            index,
            reader,
            fields,
            docs: RwLock::default(),
        };
        store.scan()?;
        Ok(store)
    }

    fn volatile() -> Result<Self, Error> {
        let (schema, _) = schema();
        Self::new(Index::create_in_ram(schema))
    }

    fn persistent(path: &Path) -> Result<Self, Error> {
        match open_directory(path).and_then(Self::new) {
            Ok(store) => Ok(store),
            Err(_) => Self::reset(path),
        }
    }

    fn reset(path: &Path) -> Result<Self, Error> {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                std::fs::remove_file(entry.path())?;
            }
        }
        Self::new(open_directory(path)?)
    }

    fn scan(&self) -> Result<(), Error> {
        let searcher = self.reader.searcher();
        let mut docs = HashMap::new();
        for address in searcher.search(&AllQuery, &DocSetCollector)? {
            let doc: TantivyDocument = searcher.doc(address)?;
            if let Some((key, meta)) = self.meta(&doc) {
                docs.insert(key, meta);
            }
        }
        *self
            .docs
            .write()
            .map_err(|_| Error::Index("poisoned".into()))? = docs;
        Ok(())
    }

    fn text(&self, doc: &TantivyDocument, field: Field) -> String {
        doc.get_first(field)
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_owned()
    }

    fn meta(&self, doc: &TantivyDocument) -> Option<(String, Meta)> {
        let f = &self.fields;
        let tags = doc
            .get_all(f.x_tag_raw)
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect();
        Some((
            self.text(doc, f.key),
            Meta {
                id: self.text(doc, f.id),
                kind: kind_of(&self.text(doc, f.kind))?,
                scope: scope_of(&self.text(doc, f.scope))?,
                stamp: self.text(doc, f.stamp),
                hash: self.text(doc, f.hash),
                doc_type: self.text(doc, f.x_type),
                tags,
                manual: self.text(doc, f.activation) == "manual",
                eligible_until: doc
                    .get_first(f.stale)
                    .and_then(|value| value.as_i64())
                    .unwrap_or(i64::MAX),
                active: true,
                bytes: doc
                    .get_first(f.bytes)
                    .and_then(|value| value.as_i64())
                    .map_or(0, |value| value.max(0) as usize),
            },
        ))
    }

    fn apply(
        &self,
        removed: &[String],
        upserts: &[Document],
        deadline: Option<Instant>,
    ) -> Result<(), Error> {
        let mut writer: IndexWriter =
            self.index
                .writer_with_num_threads(1, WRITER_HEAP)
                .map_err(|error| match error {
                    tantivy::TantivyError::LockFailure(..) => Error::Busy,
                    other => other.into(),
                })?;
        writer.set_merge_policy(Box::new(tantivy::merge_policy::LogMergePolicy::default()));
        let f = &self.fields;
        for key in removed {
            writer.delete_term(Term::from_field_text(f.key, key));
        }
        for doc in upserts {
            if deadline.is_some_and(|limit| Instant::now() >= limit) {
                let _ = writer.rollback();
                return Err(Error::Deadline);
            }
            let key = key(doc.scope, doc.kind, &doc.id);
            writer.delete_term(Term::from_field_text(f.key, &key));
            writer.add_document(self.build(&key, doc))?;
        }
        if deadline.is_some_and(|limit| Instant::now() >= limit) {
            let _ = writer.rollback();
            return Err(Error::Deadline);
        }
        writer.commit()?;
        drop(writer);
        self.reader.reload()?;
        let mut docs = self
            .docs
            .write()
            .map_err(|_| Error::Index("poisoned".into()))?;
        for key in removed {
            docs.remove(key);
        }
        for doc in upserts {
            docs.insert(
                key(doc.scope, doc.kind, &doc.id),
                Meta {
                    id: doc.id.clone(),
                    kind: doc.kind,
                    scope: doc.scope,
                    stamp: stamp(&doc.source.content_hash),
                    hash: doc.source.content_hash.clone(),
                    doc_type: doc.fields.doc_type.clone(),
                    tags: doc
                        .fields
                        .tags
                        .iter()
                        .chain(&doc.fields.keywords)
                        .cloned()
                        .collect(),
                    manual: doc.lifecycle.activation == Some(Activation::Manual),
                    eligible_until: doc.lifecycle.stale_after.unwrap_or(i64::MAX),
                    active: doc.lifecycle.status == Status::Active
                        && doc.lifecycle.superseded_by.is_none(),
                    bytes: injected_bytes(doc),
                },
            );
        }
        Ok(())
    }

    fn build(&self, key: &str, doc: &Document) -> TantivyDocument {
        let f = &self.fields;
        let mut out = TantivyDocument::default();
        out.add_text(f.key, key);
        out.add_text(f.stamp, stamp(&doc.source.content_hash));
        out.add_text(f.hash, &doc.source.content_hash);
        out.add_text(f.id, &doc.id);
        out.add_text(f.kind, doc.kind.as_str());
        out.add_text(f.scope, doc.scope.as_str());
        out.add_text(
            f.status,
            match doc.lifecycle.status {
                Status::Active => "active",
                _ => "inactive",
            },
        );
        if doc.lifecycle.superseded_by.is_some() {
            out.add_text(f.superseded, "1");
        }
        out.add_text(
            f.activation,
            match doc.lifecycle.activation {
                Some(Activation::Auto) => "auto",
                Some(Activation::Manual) => "manual",
                None => "none",
            },
        );
        out.add_i64(f.stale, doc.lifecycle.stale_after.unwrap_or(i64::MAX));
        out.add_i64(f.bytes, injected_bytes(doc) as i64);
        out.add_text(f.x_id, analysis::normalize(&doc.id));
        out.add_text(f.x_title, analysis::normalize(&doc.fields.title));
        for tag in tag_terms(doc) {
            out.add_text(f.x_tag, tag);
        }
        for tag in doc.fields.tags.iter().chain(&doc.fields.keywords) {
            out.add_text(f.x_tag_raw, tag);
        }
        out.add_text(f.x_type, &doc.fields.doc_type);
        for ident in &doc.fields.identifiers {
            out.add_text(f.x_ident, analysis::normalize(ident));
        }
        let fields = &doc.fields;
        let title = format!("{} {}", fields.title, doc.id);
        let relationships = fields.relationships.join(" ");
        let tags = fields.tags.join(" ");
        let keywords = fields.keywords.join(" ");
        let identifiers = fields.identifiers.join(" ");
        let values = [
            title.as_str(),
            tags.as_str(),
            keywords.as_str(),
            identifiers.as_str(),
            fields.description.as_str(),
            fields.doc_type.as_str(),
            relationships.as_str(),
            fields.body.as_str(),
        ];
        for ((field, _), value) in f.text.iter().zip(values) {
            if !value.is_empty() {
                out.add_text(*field, analysis::prepare(value));
            }
        }
        out
    }

    fn filter_clauses(&self, filter: &Filter) -> Vec<(Occur, Box<dyn Query>)> {
        let f = &self.fields;
        let term = |field: Field, value: &str| -> Box<dyn Query> {
            Box::new(BoostQuery::new(
                Box::new(TermQuery::new(
                    Term::from_field_text(field, value),
                    IndexRecordOption::Basic,
                )),
                0.0,
            ))
        };
        let any_of = |field: Field, values: Vec<&str>| -> (Occur, Box<dyn Query>) {
            (
                Occur::Must,
                Box::new(BooleanQuery::new(
                    values
                        .into_iter()
                        .map(|v| (Occur::Should, term(field, v)))
                        .collect(),
                )),
            )
        };
        let mut clauses = Vec::new();
        if !filter.kinds.is_empty() {
            clauses.push(any_of(
                f.kind,
                filter.kinds.iter().map(|k| k.as_str()).collect(),
            ));
        }
        if !filter.scopes.is_empty() {
            clauses.push(any_of(
                f.scope,
                filter.scopes.iter().map(|s| s.as_str()).collect(),
            ));
        }
        for tag in &filter.tags {
            clauses.push((Occur::Must, term(f.x_tag_raw, tag)));
        }
        if !filter.types.is_empty() {
            clauses.push(any_of(
                f.x_type,
                filter.types.iter().map(String::as_str).collect(),
            ));
        }
        if filter.implicit {
            clauses.push((Occur::MustNot, term(f.activation, "manual")));
        }
        if let Some(now) = filter.now {
            clauses.push((Occur::Must, term(f.status, "active")));
            clauses.push((Occur::MustNot, term(f.superseded, "1")));
            clauses.push((
                Occur::Must,
                Box::new(BoostQuery::new(
                    Box::new(RangeQuery::new(
                        Bound::Included(Term::from_field_i64(f.stale, now)),
                        Bound::Unbounded,
                    )),
                    0.0,
                )),
            ));
        }
        clauses
    }

    fn with_filters(&self, main: Box<dyn Query>, filter: &Filter) -> Box<dyn Query> {
        let mut clauses = self.filter_clauses(filter);
        if clauses.is_empty() {
            return main;
        }
        clauses.push((Occur::Must, main));
        Box::new(BooleanQuery::new(clauses))
    }

    fn hit(&self, address: DocAddress, score: f32) -> Option<Hit> {
        let doc: TantivyDocument = self.reader.searcher().doc(address).ok()?;
        let (key, meta) = self.meta(&doc)?;
        Some(Hit {
            key,
            id: meta.id,
            kind: meta.kind,
            scope: meta.scope,
            hash: meta.hash,
            score: f64::from(score),
        })
    }

    fn bm25(&self, query_terms: &[String], filter: &Filter, limit: usize) -> Vec<Hit> {
        if query_terms.is_empty() {
            return Vec::new();
        }
        let mut should: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        for (field, boost) in &self.fields.text {
            for term in query_terms {
                let query = TermQuery::new(
                    Term::from_field_text(*field, term),
                    IndexRecordOption::WithFreqs,
                );
                should.push((
                    Occur::Should,
                    Box::new(BoostQuery::new(Box::new(query), *boost)),
                ));
            }
        }
        let main = self.with_filters(Box::new(BooleanQuery::new(should)), filter);
        let searcher = self.reader.searcher();
        let Ok(found) = searcher.search(&main, &TopDocs::with_limit(limit).order_by_score()) else {
            return Vec::new();
        };
        let mut hits: Vec<Hit> = found
            .into_iter()
            .filter_map(|(score, address)| self.hit(address, score))
            .collect();
        hits.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.key.cmp(&b.key)));
        hits
    }

    fn phrase_hits(
        &self,
        query_terms: &[(usize, String)],
        filter: &Filter,
        limit: usize,
    ) -> Vec<Hit> {
        if query_terms.len() < 2 {
            return Vec::new();
        }
        let phrase = PhraseQuery::new_with_offset(
            query_terms
                .iter()
                .map(|(position, t)| (*position, Term::from_field_text(self.fields.body, t)))
                .collect(),
        );
        let main = self.with_filters(Box::new(phrase), filter);
        let searcher = self.reader.searcher();
        searcher
            .search(&main, &TopDocs::with_limit(limit).order_by_score())
            .map(|found| {
                found
                    .into_iter()
                    .filter_map(|(score, address)| self.hit(address, score))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn exact(&self, normalized: &str, filter: &Filter) -> Vec<(Hit, Reason)> {
        if normalized.is_empty() {
            return Vec::new();
        }
        let f = &self.fields;
        let searcher = self.reader.searcher();
        let mut out: Vec<(Hit, Reason)> = Vec::new();
        for (field, reason) in [
            (f.x_id, Reason::ExactId),
            (f.x_title, Reason::ExactTitle),
            (f.x_ident, Reason::ExactIdentifier),
            (f.x_tag, Reason::ExactTag),
        ] {
            let query = self.with_filters(
                Box::new(TermQuery::new(
                    Term::from_field_text(field, normalized),
                    IndexRecordOption::Basic,
                )),
                filter,
            );
            let Ok(found) = searcher.search(&query, &TopDocs::with_limit(50).order_by_score())
            else {
                continue;
            };
            for (score, address) in found {
                if let Some(hit) = self.hit(address, score)
                    && !out.iter().any(|(seen, _)| seen.key == hit.key)
                {
                    out.push((hit, reason));
                }
            }
        }
        out.sort_by(|a, b| {
            reason_rank(a.1)
                .cmp(&reason_rank(b.1))
                .then_with(|| a.0.key.cmp(&b.0.key))
        });
        out
    }
}

fn tag_terms(doc: &Document) -> Vec<String> {
    let mut set = BTreeSet::new();
    for tag in doc.fields.tags.iter().chain(&doc.fields.keywords) {
        set.insert(analysis::normalize(tag));
    }
    set.into_iter().collect()
}

#[derive(Default)]
struct State {
    persistent: Option<Arc<Store>>,
    volatile: Option<Arc<Store>>,
    active_persistent: bool,
}

pub struct Engine {
    directory: Option<PathBuf>,
    state: Mutex<State>,
    sync: Mutex<()>,
    analyzer: Mutex<tantivy::tokenizer::TextAnalyzer>,
}

pub struct Lexical {
    pub exact: Vec<(Hit, Reason)>,
    pub bm25: Vec<Hit>,
    pub terms: Vec<String>,
}

impl Engine {
    pub fn open(directory: Option<PathBuf>) -> Self {
        let persistent = directory
            .as_deref()
            .and_then(|path| Store::persistent(path).ok())
            .map(Arc::new);
        Self {
            directory,
            state: Mutex::new(State {
                active_persistent: persistent.is_some(),
                persistent,
                volatile: None,
            }),
            sync: Mutex::new(()),
            analyzer: Mutex::new(analysis::analyzer()),
        }
    }

    fn active(&self) -> Option<Arc<Store>> {
        let state = self.state.lock().ok()?;
        if state.active_persistent {
            state.persistent.clone()
        } else {
            state.volatile.clone()
        }
    }

    pub fn len(&self) -> usize {
        self.active()
            .and_then(|s| s.docs.read().ok().map(|d| d.len()))
            .unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn meta(&self, key: &str) -> Option<Meta> {
        self.active()
            .and_then(|s| s.docs.read().ok().and_then(|d| d.get(key).cloned()))
    }

    pub fn metas(&self) -> Vec<(String, Meta)> {
        self.active()
            .and_then(|s| {
                s.docs
                    .read()
                    .ok()
                    .map(|d| d.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            })
            .unwrap_or_default()
    }

    pub fn sync(
        &self,
        manifest: &[Entry],
        mut load: impl FnMut(&Entry) -> Option<Document>,
        extra: impl Fn(&Entry) -> bool,
        deadline: Instant,
    ) -> Result<(Publication, Vec<Document>), Error> {
        let _serial = self
            .sync
            .lock()
            .map_err(|_| Error::Index("poisoned".into()))?;
        let wanted: HashMap<String, &Entry> = manifest.iter().map(|e| (e.key(), e)).collect();
        let persistent = self
            .state
            .lock()
            .map_err(|_| Error::Index("poisoned".into()))?
            .persistent
            .clone();
        let outcome;
        let mut loaded: HashMap<String, Document> = HashMap::new();
        let mut diff = |store: &Store, loaded: &mut HashMap<String, Document>| {
            let docs = store
                .docs
                .read()
                .map_err(|_| Error::Index("poisoned".into()))?;
            let removed: Vec<String> = docs
                .keys()
                .filter(|key| !wanted.contains_key(*key))
                .cloned()
                .collect();
            let mut upserts = Vec::new();
            for (key, entry) in &wanted {
                let current = docs.get(key).is_some_and(|m| m.stamp == stamp(&entry.hash));
                if current && !extra(entry) {
                    continue;
                }
                let document = match loaded.get(key) {
                    Some(document) => document.clone(),
                    None => match load(entry) {
                        Some(document) => {
                            loaded.insert(key.clone(), document.clone());
                            document
                        }
                        None => continue,
                    },
                };
                if !current {
                    upserts.push(document);
                }
            }
            Ok::<_, Error>((removed, upserts))
        };
        if let Some(store) = &persistent {
            let (removed, upserts) = diff(store, &mut loaded)?;
            if removed.is_empty() && upserts.is_empty() {
                self.state
                    .lock()
                    .map_err(|_| Error::Index("poisoned".into()))?
                    .active_persistent = true;
                return Ok((Publication::Unchanged, loaded.into_values().collect()));
            }
            match store.apply(&removed, &upserts, Some(deadline)) {
                Ok(()) => {
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|_| Error::Index("poisoned".into()))?;
                    state.active_persistent = true;
                    state.volatile = None;
                    return Ok((Publication::Committed, loaded.into_values().collect()));
                }
                Err(Error::Busy | Error::Deadline) => outcome = Publication::Volatile,
                Err(_) => match self.recover(&mut diff, &mut loaded) {
                    Ok(()) => {
                        return Ok((Publication::Committed, loaded.into_values().collect()));
                    }
                    Err(_) => outcome = Publication::Volatile,
                },
            }
        } else {
            outcome = Publication::Volatile;
        }
        let existing = self
            .state
            .lock()
            .map_err(|_| Error::Index("poisoned".into()))?
            .volatile
            .clone();
        let store = match existing {
            Some(store) => store,
            None => Arc::new(Store::volatile()?),
        };
        let (removed, upserts) = diff(&store, &mut loaded)?;
        if !removed.is_empty() || !upserts.is_empty() {
            store.apply(&removed, &upserts, None)?;
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Index("poisoned".into()))?;
        state.volatile = Some(store);
        state.active_persistent = false;
        Ok((outcome, loaded.into_values().collect()))
    }

    fn recover<Diff>(
        &self,
        diff: &mut Diff,
        loaded: &mut HashMap<String, Document>,
    ) -> Result<(), Error>
    where
        Diff: FnMut(
            &Store,
            &mut HashMap<String, Document>,
        ) -> Result<(Vec<String>, Vec<Document>), Error>,
    {
        let path = self.directory.as_deref().ok_or(Error::Busy)?;
        let fresh = Arc::new(Store::reset(path)?);
        let (removed, upserts) = diff(&fresh, loaded)?;
        fresh.apply(&removed, &upserts, None)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Index("poisoned".into()))?;
        state.persistent = Some(fresh);
        state.active_persistent = true;
        state.volatile = None;
        Ok(())
    }

    pub fn directory(&self) -> Option<&Path> {
        self.directory.as_deref()
    }

    pub fn search(&self, text: &str, filter: &Filter, limit: usize) -> Lexical {
        let empty = || Lexical {
            exact: Vec::new(),
            bm25: Vec::new(),
            terms: Vec::new(),
        };
        let Some(store) = self.active() else {
            return empty();
        };
        let Ok(mut analyzer) = self.analyzer.lock() else {
            return empty();
        };
        let positioned = analysis::positioned(&mut analyzer, text);
        drop(analyzer);
        let mut terms: Vec<String> = Vec::new();
        for (_, term) in &positioned {
            if !terms.contains(term) {
                terms.push(term.clone());
            }
        }
        Lexical {
            exact: {
                let mut exact = store.exact(&analysis::normalize(text), filter);
                for hit in store.phrase_hits(&positioned, filter, limit) {
                    if !exact.iter().any(|(seen, _)| seen.key == hit.key) {
                        exact.push((hit, Reason::BodyPhrase));
                    }
                }
                exact
            },
            bm25: store.bm25(&terms, filter, limit),
            terms,
        }
    }
}

impl Store {
    fn matched_terms(&self, key: &str, terms: &[String]) -> usize {
        let searcher = self.reader.searcher();
        terms
            .iter()
            .filter(|term| {
                let any = BooleanQuery::new(
                    self.fields
                        .text
                        .iter()
                        .map(|(field, _)| {
                            (
                                Occur::Should,
                                Box::new(TermQuery::new(
                                    Term::from_field_text(*field, term),
                                    IndexRecordOption::Basic,
                                )) as Box<dyn Query>,
                            )
                        })
                        .collect(),
                );
                let pinned = BooleanQuery::new(vec![
                    (
                        Occur::Must,
                        Box::new(TermQuery::new(
                            Term::from_field_text(self.fields.key, key),
                            IndexRecordOption::Basic,
                        )) as Box<dyn Query>,
                    ),
                    (Occur::Must, Box::new(any)),
                ]);
                searcher
                    .search(&pinned, &tantivy::collector::Count)
                    .is_ok_and(|n| n > 0)
            })
            .count()
    }
}

impl Engine {
    pub fn matched_terms(&self, key: &str, terms: &[String]) -> usize {
        self.active().map_or(0, |s| s.matched_terms(key, terms))
    }
}

fn reason_rank(reason: Reason) -> u8 {
    match reason {
        Reason::ExactId => 0,
        Reason::ExactTitle => 1,
        Reason::ExactIdentifier => 2,
        Reason::ExactTag => 3,
        _ => 4,
    }
}
