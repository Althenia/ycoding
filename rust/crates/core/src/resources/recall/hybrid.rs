use super::{
    candidate::{
        Budget, Candidate, Method, MethodScore, Query, Reason, Retrieval, Semantic as Used, Signals,
    },
    document::{Document, Kind, Scope},
    error::Error,
    index::{Engine, Entry, Filter, Hit, Meta, Publication},
    semantic::{Semantic, Status, embedding_text},
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::Instant,
};

#[derive(Clone, Copy, Debug)]
pub struct Calibration {
    pub bm25_floor: f64,
    pub cosine_floor: f32,
    pub lexical_sufficient: f64,
    pub rrf_k: f64,
    pub pool: usize,
}

impl Default for Calibration {
    fn default() -> Self {
        Self {
            bm25_floor: 3.1,
            cosine_floor: 0.6,
            lexical_sufficient: 3.7,
            rrf_k: 60.0,
            pool: 50,
        }
    }
}

pub fn rrf_score(ranks: impl IntoIterator<Item = usize>, k: f64) -> f64 {
    ranks.into_iter().map(|rank| 1.0 / (k + rank as f64)).sum()
}

pub struct Retriever {
    engine: Engine,
    semantic: Option<Arc<Semantic>>,
    calibration: Calibration,
}

impl Retriever {
    pub fn open(
        index: Option<PathBuf>,
        semantic: Option<Arc<Semantic>>,
        calibration: Calibration,
    ) -> Self {
        Self {
            engine: Engine::open(index),
            semantic,
            calibration,
        }
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    pub fn semantic(&self) -> Option<&Arc<Semantic>> {
        self.semantic.as_ref()
    }

    pub fn sync(
        &self,
        manifest: &[Entry],
        load: impl FnMut(&Entry) -> Option<Document>,
        deadline: Instant,
    ) -> Result<Publication, Error> {
        let semantic = self.semantic.as_deref();
        let (publication, loaded) = self.engine.sync(
            manifest,
            load,
            |entry| semantic.is_some_and(|s| !s.cache().contains(&entry.hash)),
            deadline,
        )?;
        if let Some(semantic) = semantic {
            for document in &loaded {
                semantic.enqueue(
                    &document.source.content_hash,
                    embedding_text(&document.fields),
                );
            }
            semantic
                .cache()
                .retain(&manifest.iter().map(|e| e.hash.clone()).collect());
        }
        Ok(publication)
    }

    fn select(&self, ranked: Vec<(String, Candidate)>, query: &Query) -> Vec<(String, Candidate)> {
        let seen: HashSet<&str> = query.seen.iter().map(String::as_str).collect();
        let mut distinct: Vec<(String, Candidate)> = Vec::new();
        for (key, mut candidate) in ranked {
            if seen.contains(candidate.content_hash.as_str()) {
                continue;
            }
            if query.implicit
                && let Some((_, first)) = distinct
                    .iter_mut()
                    .find(|(_, first)| first.content_hash == candidate.content_hash)
            {
                first.aliases.push(key);
                continue;
            }
            candidate.bytes = self.engine.meta(&key).map_or(0, |meta| meta.bytes);
            distinct.push((key, candidate));
        }
        within(&query.budget, distinct)
    }

    pub fn search(&self, query: &Query) -> Retrieval {
        self.search_with(query, &self.calibration)
    }

    pub fn search_with(&self, query: &Query, calibration: &Calibration) -> Retrieval {
        let scale = (1.0 + (self.engine.len().max(2) as f64 - 0.5) / 1.5).ln();
        let calibration = Calibration {
            bm25_floor: calibration.bm25_floor * scale,
            lexical_sufficient: calibration.lexical_sufficient * scale,
            ..*calibration
        };
        let filter = Filter {
            kinds: query.kinds.clone(),
            scopes: query.scopes.clone(),
            tags: query.tags.clone(),
            types: query.types.clone(),
            implicit: query.implicit,
            now: query.now,
        };
        let limit = query.limit.max(1);
        let lexical = self.engine.search(&query.text, &filter, calibration.pool);
        let bm25: Vec<&Hit> = lexical
            .bm25
            .iter()
            .filter(|hit| hit.score >= calibration.bm25_floor)
            .collect();
        let top = lexical.bm25.first().map_or(0.0, |h| h.score);
        let second = lexical.bm25.get(1).map_or(0.0, |h| h.score);
        let matched = lexical
            .bm25
            .first()
            .map_or(0, |h| self.engine.matched_terms(&h.key, &lexical.terms));

        let sufficient = !lexical.exact.is_empty() || top >= calibration.lexical_sufficient;
        let mut state = Used::NotNeeded;
        let mut semantic_hits: Vec<(String, f32)> = Vec::new();
        let mut top_cosine = None;
        if !sufficient && let Some(semantic) = &self.semantic {
            state = Used::Unavailable;
            if semantic.status() == Status::Ready
                && let Some(vector) = semantic.query_vector(&query.text)
            {
                let metas = self.engine.metas();
                let candidates = metas
                    .iter()
                    .filter(|(_, meta)| eligible(meta, &filter))
                    .map(|(key, meta)| (key.as_str(), meta.hash.as_str()));
                semantic_hits = semantic.nearest(&vector, candidates, -1.0, calibration.pool);
                top_cosine = semantic_hits.first().map(|(_, c)| *c);
                semantic_hits.retain(|(_, c)| *c >= calibration.cosine_floor);
                state = Used::Used;
            }
        }

        let mut by_key: BTreeMap<String, Candidate> = BTreeMap::new();
        let meta: HashMap<String, Meta> = if semantic_hits.is_empty() {
            HashMap::new()
        } else {
            self.engine.metas().into_iter().collect()
        };
        for (rank, hit) in bm25.iter().enumerate() {
            let c = place(
                &mut by_key,
                &hit.key,
                &hit.id,
                hit.kind,
                hit.scope,
                &hit.hash,
            );
            c.scores.push(MethodScore {
                method: Method::Bm25,
                score: hit.score,
                rank: rank + 1,
            });
        }
        for (rank, (key, cosine)) in semantic_hits.iter().enumerate() {
            let Some(m) = meta.get(key) else { continue };
            let c = place(&mut by_key, key, &m.id, m.kind, m.scope, &m.hash);
            c.scores.push(MethodScore {
                method: Method::Semantic,
                score: f64::from(*cosine),
                rank: rank + 1,
            });
            if !c.scores.iter().any(|s| s.method == Method::Bm25) {
                c.reason = Reason::Semantic;
            }
        }
        if state == Used::Used {
            for c in by_key.values_mut() {
                let fused = rrf_score(c.scores.iter().map(|s| s.rank), calibration.rrf_k);
                let rank = 0;
                c.scores.push(MethodScore {
                    method: Method::Rrf,
                    score: fused,
                    rank,
                });
                c.method = Method::Rrf;
                if c.scores
                    .iter()
                    .filter(|s| matches!(s.method, Method::Bm25 | Method::Semantic))
                    .count()
                    == 2
                    && c.reason != Reason::BodyPhrase
                {
                    c.reason = Reason::Fused;
                }
            }
        }
        for (rank, (hit, reason)) in lexical.exact.iter().enumerate() {
            let c = place(
                &mut by_key,
                &hit.key,
                &hit.id,
                hit.kind,
                hit.scope,
                &hit.hash,
            );
            c.scores.insert(
                0,
                MethodScore {
                    method: Method::Exact,
                    score: 1.0,
                    rank: rank + 1,
                },
            );
            c.method = Method::Exact;
            c.reason = *reason;
        }
        let mut candidates: Vec<(String, Candidate)> = by_key.into_iter().collect();
        let primary = |c: &Candidate| {
            c.scores
                .iter()
                .find(|s| s.method == c.method)
                .map_or(0.0, |s| {
                    if c.method == Method::Exact {
                        -(s.rank as f64)
                    } else {
                        s.score
                    }
                })
        };
        candidates.sort_by(|a, b| {
            let exact = |c: &Candidate| u8::from(c.method != Method::Exact);
            exact(&a.1)
                .cmp(&exact(&b.1))
                .then_with(|| primary(&b.1).total_cmp(&primary(&a.1)))
                .then_with(|| a.0.cmp(&b.0))
        });
        let mut candidates = self.select(candidates, query);
        candidates.truncate(limit);
        let mut out: Vec<Candidate> = candidates.into_iter().map(|(_, c)| c).collect();
        if state == Used::Used {
            for (i, c) in out.iter_mut().enumerate() {
                if let Some(s) = c.scores.iter_mut().find(|s| s.method == Method::Rrf) {
                    s.rank = i + 1;
                }
            }
        }
        Retrieval {
            candidates: out,
            signals: Signals {
                query_terms: lexical.terms.len(),
                matched_terms: matched,
                top_bm25: top,
                second_bm25: second,
                top_cosine,
                semantic: state,
            },
        }
    }
}

fn within(budget: &Budget, ranked: Vec<(String, Candidate)>) -> Vec<(String, Candidate)> {
    let mut total = 0;
    let mut kinds: HashMap<Kind, (usize, usize)> = HashMap::new();
    let mut kept = Vec::new();
    for (key, candidate) in ranked {
        let (bytes, count) = kinds.get(&candidate.kind).copied().unwrap_or_default();
        if budget.per_kind_candidates.is_some_and(|max| count >= max)
            || budget
                .per_kind_bytes
                .is_some_and(|max| bytes + candidate.bytes > max)
            || budget
                .total_bytes
                .is_some_and(|max| total + candidate.bytes > max)
        {
            continue;
        }
        total += candidate.bytes;
        kinds.insert(candidate.kind, (bytes + candidate.bytes, count + 1));
        kept.push((key, candidate));
    }
    kept
}

fn eligible(meta: &Meta, filter: &Filter) -> bool {
    (filter.kinds.is_empty() || filter.kinds.contains(&meta.kind))
        && (filter.scopes.is_empty() || filter.scopes.contains(&meta.scope))
        && (filter.types.is_empty() || filter.types.contains(&meta.doc_type))
        && filter.tags.iter().all(|t| meta.tags.contains(t))
        && !(filter.implicit && meta.manual)
        && filter
            .now
            .is_none_or(|now| meta.active && now <= meta.eligible_until)
}

fn place<'a>(
    by_key: &'a mut BTreeMap<String, Candidate>,
    key: &str,
    id: &str,
    kind: Kind,
    scope: Scope,
    hash: &str,
) -> &'a mut Candidate {
    by_key.entry(key.to_owned()).or_insert_with(|| Candidate {
        id: id.to_owned(),
        kind,
        scope,
        content_hash: hash.to_owned(),
        bytes: 0,
        aliases: Vec::new(),
        method: Method::Bm25,
        scores: Vec::new(),
        reason: Reason::Lexical,
    })
}
