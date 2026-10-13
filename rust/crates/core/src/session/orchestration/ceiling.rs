use std::collections::BTreeSet;
use ycoding_schema::permission::{Effect, Rule, Ruleset};

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
