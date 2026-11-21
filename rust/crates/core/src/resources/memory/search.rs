use super::{
    Concept, Error, SearchHit,
    format::{compare, text_value, tokens},
};
use crate::resources::discovery;
use icu_properties::{
    CodePointMapData,
    props::{GeneralCategory, GeneralCategoryGroup},
};
use std::collections::{BTreeSet, HashMap};

const K1: f64 = 1.2;
const B: f64 = 0.75;
const WEIGHTS: [f64; 3] = [4.0, 2.0, 1.0];
const SNIPPET_LENGTH: usize = 320;
const SNIPPET_LEAD: usize = 60;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Span {
    start: usize,
    end: usize,
}
struct Field {
    length: usize,
    counts: HashMap<String, usize>,
}

pub(super) struct Query<'a> {
    pub text: &'a str,
    pub limit: usize,
    pub type_: Option<&'a str>,
    pub tag: Option<&'a str>,
}

pub(super) fn rank(concepts: Vec<Concept>, query: &Query<'_>) -> Result<Vec<SearchHit>, Error> {
    let matching = tokens(query.text)?.into_iter().collect::<BTreeSet<_>>();
    let mut terms = matching.iter().cloned().collect::<Vec<_>>();
    terms.sort_by(|a, b| compare(a, b));
    let mut documents = Vec::with_capacity(concepts.len());
    for concept in concepts {
        let summary = &concept.summary;
        let texts = [
            format!(
                "{} {}",
                summary.title.as_ref().map(text_value).unwrap_or_default(),
                summary.id
            ),
            format!(
                "{} {} {}",
                text_value(&summary.type_),
                summary
                    .tags
                    .as_ref()
                    .map(|tags| tags.iter().map(text_value).collect::<Vec<_>>().join(" "))
                    .unwrap_or_default(),
                summary
                    .description
                    .as_ref()
                    .map(text_value)
                    .unwrap_or_default()
            ),
            concept.body.clone(),
        ];
        let fields = [
            frequencies(&texts[0])?,
            frequencies(&texts[1])?,
            frequencies(&texts[2])?,
        ];
        documents.push((concept, fields));
    }
    let count = documents.len() as f64;
    let averages = [0, 1, 2].map(|index| {
        documents
            .iter()
            .map(|(_, fields)| fields[index].length)
            .sum::<usize>() as f64
            / count.max(1.0)
    });
    let idf = terms
        .iter()
        .map(|term| {
            let frequency = documents
                .iter()
                .filter(|(_, fields)| fields.iter().any(|field| field.counts.contains_key(term)))
                .count() as f64;
            (
                term,
                (1.0 + (count - frequency + 0.5) / (frequency + 0.5)).ln(),
            )
        })
        .collect::<Vec<_>>();
    let mut hits = Vec::new();
    for (concept, fields) in documents {
        let summary = &concept.summary;
        if query
            .type_
            .is_some_and(|value| !value.is_empty() && summary.type_.as_str() != Some(value))
            || query.tag.is_some_and(|value| {
                !value.is_empty()
                    && !summary
                        .tags
                        .as_ref()
                        .is_some_and(|tags| tags.iter().any(|tag| tag.as_str() == Some(value)))
            })
        {
            continue;
        }
        let mut score = 0.0;
        for (term, idf) in &idf {
            let mut sum = 0.0;
            for (index, field) in fields.iter().enumerate() {
                sum += WEIGHTS[index]
                    * saturation(
                        field.counts.get(*term).copied().unwrap_or(0) as f64,
                        field.length as f64,
                        averages[index],
                    );
            }
            score += idf * sum;
        }
        if score > 0.0 {
            hits.push((concept, score));
        }
    }
    hits.sort_by(|(left, left_score), (right, right_score)| {
        right_score
            .total_cmp(left_score)
            .then_with(|| compare(&left.summary.id, &right.summary.id))
    });
    hits.truncate(query.limit);
    hits.into_iter()
        .map(|(concept, score)| {
            Ok(SearchHit {
                snippet: snippet(&concept.body, &matching)?,
                summary: concept.summary,
                score,
            })
        })
        .collect()
}

fn frequencies(text: &str) -> Result<Field, Error> {
    let tokens = tokens(text)?;
    let mut counts = HashMap::new();
    for token in &tokens {
        *counts.entry(token.clone()).or_insert(0) += 1;
    }
    Ok(Field {
        length: tokens.len(),
        counts,
    })
}

fn saturation(frequency: f64, length: f64, average: f64) -> f64 {
    if frequency == 0.0 {
        return 0.0;
    }
    (frequency * (K1 + 1.0)) / (frequency + K1 * (1.0 - B + (B * length) / average))
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
