use super::{protobuf, wire::Counters};
use crate::{Error, llm::Usage};

pub fn normalize(counters: &Counters) -> Usage {
    let input = counters.input.map(f64::from);
    let output = counters.output.map(f64::from);
    let read = counters
        .cache_read
        .map(f64::from)
        .map(|value| input.map_or(value, |input| value.min(input)));
    let write = counters
        .cache_write
        .map(f64::from)
        .map(|value| input.map_or(value, |input| value.min(input - read.unwrap_or(0.0))));
    Usage {
        input_tokens: input,
        output_tokens: output,
        non_cached_input_tokens: input
            .zip(read)
            .zip(write)
            .map(|((input, read), write)| (input - read - write).max(0.0)),
        cache_read_input_tokens: read,
        cache_write_input_tokens: write,
        reasoning_tokens: counters
            .reasoning
            .map(f64::from)
            .map(|value| output.map_or(value, |output| value.min(output))),
        total_tokens: input.zip(output).map(|(input, output)| input + output),
        ..Usage::default()
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Category {
    pub id: String,
    pub label: String,
    pub tokens: Option<u32>,
    pub characters: Option<u32>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Breakdown {
    pub used: Option<u32>,
    pub maximum: Option<u32>,
    pub categories: Vec<Category>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TokenDetails {
    pub used: Option<u32>,
    pub maximum: Option<u32>,
    pub breakdown: Option<Breakdown>,
}
fn category(bytes: &[u8]) -> Result<Category, Error> {
    let mut category = Category::default();
    for field in protobuf::fields(bytes)? {
        match field.number {
            1 => category.id = field.text()?,
            2 => category.label = field.text()?,
            3 => category.tokens = Some(field.uint32()?),
            4 => category.characters = Some(field.uint32()?),
            _ => {}
        }
    }
    Ok(category)
}
fn breakdown(bytes: &[u8]) -> Result<Breakdown, Error> {
    let mut breakdown = Breakdown::default();
    for field in protobuf::fields(bytes)? {
        match field.number {
            1 => breakdown.used = Some(field.uint32()?),
            2 => breakdown.maximum = Some(field.uint32()?),
            3 => {
                let bytes = field.bytes()?;
                if breakdown.categories.len() < 128 {
                    breakdown.categories.push(category(bytes)?);
                }
            }
            _ => {}
        }
    }
    Ok(breakdown)
}
fn details(bytes: &[u8]) -> Result<Option<TokenDetails>, Error> {
    let mut details = TokenDetails::default();
    for field in protobuf::fields(bytes)? {
        match field.number {
            1 => details.used = Some(field.uint32()?),
            2 => details.maximum = Some(field.uint32()?),
            3 => details.breakdown = Some(breakdown(field.bytes()?)?),
            _ => {}
        }
    }
    Ok(
        (details.used.is_some() || details.maximum.is_some() || details.breakdown.is_some())
            .then_some(details),
    )
}
pub fn token_details(checkpoint: &[u8]) -> Option<TokenDetails> {
    let fields = protobuf::fields(checkpoint).ok()?;
    let mut result = None;
    for field in fields.into_iter().filter(|field| field.number == 5) {
        result = details(field.bytes().ok()?).ok()?;
    }
    result
}
