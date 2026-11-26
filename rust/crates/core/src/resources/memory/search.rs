use super::{
    Concept, Error, SearchHit,
    format::{text_value, tokens},
    recall::Cache,
};
use crate::resources::discovery;
use crate::resources::recall::{lexical::Document, ranking};
use icu_properties::{
    CodePointMapData,
    props::{GeneralCategory, GeneralCategoryGroup},
};
use std::collections::BTreeSet;

const SNIPPET_LENGTH: usize = 320;
const SNIPPET_LEAD: usize = 60;
const BM25_CONTEXT_FLOOR: f64 = 3.583519;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Span {
    start: usize,
    end: usize,
}
pub(super) struct Query<'a> {
    pub text: &'a str,
    pub limit: usize,
    pub type_: Option<&'a str>,
    pub tag: Option<&'a str>,
}

pub(super) fn rank(
    cache: &mut Cache,
    cache_path: &std::path::Path,
    concepts: Vec<Concept>,
    query: &Query<'_>,
) -> Result<Vec<SearchHit>, Error> {
    if concepts.is_empty() {
        return Ok(Vec::new());
    }
    let words = tokens(query.text)?;
    let matching = words.iter().cloned().collect::<BTreeSet<_>>();
    let docs: Vec<_> = concepts
        .iter()
        .map(|c| {
            let s = &c.summary;
            let tags: Vec<_> = s.tags.iter().flatten().map(text_value).collect();
            Document {
                id: &s.id,
                title: s.title.as_ref().map(text_value).unwrap_or_default(),
                metadata: format!(
                    "{} {} {}",
                    text_value(&s.type_),
                    tags.join(" "),
                    s.description.as_ref().map(text_value).unwrap_or_default()
                ),
                tags,
                body: &c.body,
            }
        })
        .collect();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let (scores, _) = cache.scores(cache_path, &concepts, &docs, &matching, deadline)?;
    let normalized = icu_normalizer::ComposingNormalizerBorrowed::new_nfc()
        .normalize(&query.text.trim().to_lowercase())
        .into_owned();
    let rows = docs
        .iter()
        .zip(scores)
        .enumerate()
        .filter_map(|(i, (d, score))| {
            let c = &concepts[i];
            if query
                .type_
                .is_some_and(|v| !v.is_empty() && c.summary.type_.as_str() != Some(v))
                || query
                    .tag
                    .is_some_and(|v| !v.is_empty() && !d.tags.iter().any(|t| t == v))
            {
                return None;
            }
            Some((i, d.id, score))
        });
    ranking::rank(rows, query.limit)
        .into_iter()
        .map(|(i, score)| {
            let c = &concepts[i];
            let automatic_reason = docs[i]
                .match_reason(&normalized, &words)?
                .or((score >= BM25_CONTEXT_FLOOR).then_some("lexical"));
            Ok(SearchHit {
                summary: c.summary.clone(),
                score,
                snippet: snippet(&c.body, &matching)?,
                automatic_reason,
            })
        })
        .collect()
}

fn snippet(body: &str, terms: &BTreeSet<String>) -> Result<ycoding_schema::LosslessString, Error> {
    let units = body.encode_utf16().collect::<Vec<_>>();
    let words = tokens(body)?;
    let in_body = words.iter().any(|token| terms.contains(token));
    let mut spans = Vec::new();
    let mut found: Option<Span> = None;
    for span in token_spans(body) {
        if in_body
            && found.is_none()
            && words
                .get(spans.len())
                .is_some_and(|word| terms.contains(word))
        {
            found = Some(span);
        }
        spans.push(span);
        if (found.is_some() || !in_body)
            && span.start >= found.map_or(0, |found| found.start) + SNIPPET_LENGTH
        {
            break;
        }
    }
    let lead = found
        .map_or(0, |found| found.start)
        .saturating_sub(SNIPPET_LEAD);
    let start = code_point_start(
        &units,
        spans
            .iter()
            .find(|span| span.start < lead && lead < span.end)
            .map_or(lead, |span| span.end),
    );
    let limit = units.len().min(start + SNIPPET_LENGTH);
    let cut = spans
        .iter()
        .find(|span| span.start < limit && limit < span.end);
    let end = code_point_end(
        &units,
        match cut {
            Some(cut) if Some(*cut) != found && cut.start > start => cut.start,
            _ => limit,
        },
    );
    let slice = units.get(start..end).unwrap_or_default();
    let whitespace =
        |unit: &u16| char::from_u32(u32::from(*unit)).is_some_and(discovery::whitespace);
    let first = slice
        .iter()
        .position(|unit| !whitespace(unit))
        .unwrap_or(slice.len());
    let last = slice
        .iter()
        .rposition(|unit| !whitespace(unit))
        .map_or(first, |index| index + 1);
    Ok(ycoding_schema::LosslessString::from_utf16(
        slice[first..last].to_vec(),
    ))
}

fn token_spans(text: &str) -> Vec<Span> {
    let categories = CodePointMapData::<GeneralCategory>::new();
    let is_mark = |ch: char| GeneralCategoryGroup::Mark.contains(categories.get(ch));
    let is_word = |ch: char| {
        ch == '_'
            || GeneralCategoryGroup::Letter.contains(categories.get(ch))
            || GeneralCategoryGroup::Number.contains(categories.get(ch))
    };
    let normalizer = icu_normalizer::ComposingNormalizerBorrowed::new_nfc();
    let mut spans = Vec::new();
    let mut start: Option<usize> = None;
    let mut chars = text.chars().peekable();
    let mut offset = 0;
    while let Some(first) = chars.next() {
        let mut cluster = String::from(first);
        let mut length = first.len_utf16();
        while let Some(mark) = chars.next_if(|ch| is_mark(*ch)) {
            cluster.push(mark);
            length += mark.len_utf16();
        }
        let index = offset;
        offset += length;
        let lowered = cluster.to_lowercase();
        let normalized = normalizer.normalize(&lowered);
        if !normalized.chars().next().is_some_and(is_word) {
            if let Some(begin) = start.take() {
                spans.push(Span {
                    start: begin,
                    end: index,
                });
            }
            continue;
        }
        let begin = *start.get_or_insert(index);
        if normalized.chars().any(|ch| !is_word(ch)) {
            spans.push(Span {
                start: begin,
                end: offset,
            });
            start = None;
        }
    }
    if let Some(begin) = start {
        spans.push(Span {
            start: begin,
            end: offset,
        });
    }
    spans
}

fn code_point_start(units: &[u16], index: usize) -> usize {
    if index > 0
        && units
            .get(index)
            .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
        && units
            .get(index - 1)
            .is_some_and(|unit| (0xd800..=0xdbff).contains(unit))
    {
        index + 1
    } else {
        index
    }
}

fn code_point_end(units: &[u16], index: usize) -> usize {
    if index > 0
        && units
            .get(index - 1)
            .is_some_and(|unit| (0xd800..=0xdbff).contains(unit))
        && units
            .get(index)
            .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
    {
        index - 1
    } else {
        index
    }
}
