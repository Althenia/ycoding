use std::collections::BTreeSet;
use ycoding_schema::{DomainDecode, JsonValue, permission};

pub fn inherit(existing: &[permission::Rule], caller: &[permission::Rule]) -> permission::Ruleset {
    let mut seen = BTreeSet::new();
    existing
        .iter()
        .chain(caller)
        .filter(|rule| {
            rule.effect.0.as_str() == Some("deny")
                && seen.insert((rule.action.clone(), rule.resource.clone()))
        })
        .cloned()
        .collect()
}

pub fn read(value: &JsonValue) -> permission::Ruleset {
    permission::Ruleset::decode(value).map_or_else(|_| vec![], |rules| inherit(&rules, &[]))
}
