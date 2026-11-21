use std::collections::BTreeSet;
use ycoding_schema::permission::{Effect, Rule, Ruleset};

pub fn effective_denies(rules: &Ruleset) -> Ruleset {
    rules
        .iter()
        .enumerate()
        .filter(|(index, rule)| {
            rule.effect.0.as_str() == Some("deny")
                && !rules[index + 1..].iter().any(|later| {
                    later.effect.0.as_str() != Some("deny")
                        && (later.action.as_str() == Some("*") || later.action == rule.action)
                        && (later.resource.as_str() == Some("*") || later.resource == rule.resource)
                })
        })
        .map(|(_, rule)| rule.clone())
        .collect()
}

pub fn inherit(parent: Option<&Ruleset>, caller: Option<&Ruleset>) -> Ruleset {
    let mut seen = BTreeSet::new();
    parent
        .into_iter()
        .chain(caller)
        .flatten()
        .filter(|rule| rule.effect.0.as_str() == Some("deny"))
        .filter(|rule| seen.insert((rule.action.clone(), rule.resource.clone())))
        .map(|rule| Rule {
            action: rule.action.clone(),
            resource: rule.resource.clone(),
            effect: Effect("deny".into()),
        })
        .collect()
}
