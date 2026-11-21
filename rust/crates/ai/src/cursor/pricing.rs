use crate::{Error, json};
use std::{collections::BTreeMap, sync::OnceLock};
use ycoding_schema::{JsonValue, LosslessString};

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct Cost {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub context_over_200k: Option<Box<Cost>>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Tier {
    pub context_size: Option<u32>,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}
pub fn get(model: &LosslessString) -> Result<Option<Cost>, Error> {
    static COSTS: OnceLock<Result<BTreeMap<String, Cost>, Error>> = OnceLock::new();
    let costs = COSTS.get_or_init(|| {
        let costs = serde_json::from_str::<BTreeMap<String, Cost>>(include_str!("costs.json"))
            .map_err(|_| Error::output("Cursor committed pricing data is malformed"))?;
        for cost in costs.values() {
            check(cost)?;
        }
        Ok(costs)
    });
    let costs = costs.as_ref().map_err(Clone::clone)?;
    let Some(model) = model.as_str() else {
        return Ok(None);
    };
    let fast = model.ends_with("-fast");
    let stem = if fast {
        &model[..model.len() - 5]
    } else {
        model
    };
    let base = stem
        .rsplit_once("-1m")
        .filter(|(_, tail)| {
            tail.is_empty()
                || tail.strip_prefix('-').is_some_and(|tail| {
                    !tail.is_empty() && tail.bytes().all(|byte| byte.is_ascii_digit())
                })
        })
        .map(|(base, _)| {
            if fast {
                format!("{base}-fast")
            } else {
                base.to_owned()
            }
        })
        .unwrap_or_else(|| model.to_owned());
    Ok(costs.get(&base).cloned())
}
pub fn has_fast(model: &LosslessString) -> Result<bool, Error> {
    let model =
        LosslessString::from_utf16(model.code_units().chain("-fast".encode_utf16()).collect());
    Ok(get(&model)?.is_some())
}
pub fn validate(value: &JsonValue) -> Result<Cost, Error> {
    Ok(Cost {
        input: rate(
            json::get(value, "input")
                .ok_or_else(|| Error::output("Cursor model cost requires input"))?,
        )?,
        output: rate(
            json::get(value, "output")
                .ok_or_else(|| Error::output("Cursor model cost requires output"))?,
        )?,
        cache_read: json::get(value, "cache_read").map(rate).transpose()?,
        cache_write: json::get(value, "cache_write").map(rate).transpose()?,
        context_over_200k: json::get(value, "context_over_200k")
            .map(validate)
            .transpose()?
            .map(Box::new),
    })
}
fn rate(value: &JsonValue) -> Result<f64, Error> {
    json::number(value)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| Error::output("Cursor model cost rates must be nonnegative finite numbers"))
}
pub fn tiers(cost: Option<&Cost>) -> Vec<Tier> {
    let Some(cost) = cost else {
        return Vec::new();
    };
    std::iter::once((None, cost))
        .chain(
            cost.context_over_200k
                .as_deref()
                .map(|cost| (Some(200_000), cost)),
        )
        .map(|(context_size, cost)| Tier {
            context_size,
            input: cost.input,
            output: cost.output,
            cache_read: cost.cache_read.unwrap_or(0.0),
            cache_write: cost.cache_write.unwrap_or(0.0),
        })
        .collect()
}
fn check(cost: &Cost) -> Result<(), Error> {
    if [
        Some(cost.input),
        Some(cost.output),
        cost.cache_read,
        cost.cache_write,
    ]
    .into_iter()
    .flatten()
    .any(|value| !value.is_finite() || value < 0.0)
    {
        return Err(Error::output(
            "Cursor model cost rates must be nonnegative finite numbers",
        ));
    }
    if let Some(cost) = &cost.context_over_200k {
        check(cost)?;
    }
    Ok(())
}
