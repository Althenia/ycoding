use ycoding_core::session::autonomy::{Effective, YoloLevel};
use ycoding_core::tools::policy::{
    Effect, ceiling, decision, evaluate, expand_permissions, wildcard,
};
use ycoding_schema::{LosslessString, permission};

fn rule(action: &str, resource: &str, effect: &str) -> permission::Rule {
    permission::Rule {
        action: action.into(),
        resource: resource.into(),
        effect: permission::Effect(effect.into()),
    }
}

#[test]
fn last_matching_rule_wins_and_unknown_defaults_to_ask() {
    let rules = vec![
        rule("*", "*", "deny"),
        rule("read", "src/*", "allow"),
        rule("read", "src/private/?", "ask"),
    ];
    assert_eq!(
        evaluate(&"read".into(), &"src/file".into(), &rules)
            .effect
            .0,
        LosslessString::from("allow")
    );
    assert_eq!(
        evaluate(&"read".into(), &"src/private/x".into(), &rules)
            .effect
            .0,
        LosslessString::from("ask")
    );
    assert_eq!(
        evaluate(&"read".into(), &"file".into(), &[]).effect.0,
        LosslessString::from("ask")
    );
    assert!(wildcard(&"git status".into(), &"git status *".into()));
    assert!(wildcard(&"a\\b\nc".into(), &"a/*".into()));
    assert!(wildcard(
        &LosslessString::from_utf16(vec![0xd800]),
        &"?".into()
    ));
    assert!(!wildcard(&"😀".into(), &"?".into()));
}

#[test]
fn filesystem_rules_expand_home_but_shell_and_wildcard_actions_do_not() {
    let rules = expand_permissions(
        &[
            rule("external_directory", "~/private/*", "allow"),
            rule("read", "$HOME\\private\\*", "deny"),
            rule("edit", "~", "ask"),
            rule("shell", "~/private/*", "deny"),
            rule("*", "~/private/*", "deny"),
        ],
        &"/home/operator".into(),
    );
    assert_eq!(
        rules[0].resource,
        LosslessString::from("/home/operator/private/*")
    );
    assert_eq!(
        rules[1].resource,
        LosslessString::from("/home/operator\\private\\*")
    );
    assert_eq!(rules[2].resource, LosslessString::from("/home/operator"));
    assert_eq!(rules[3].resource, LosslessString::from("~/private/*"));
    assert_eq!(rules[4].resource, LosslessString::from("~/private/*"));
    assert!(wildcard(
        &"/home/operator/private/*".into(),
        &rules[0].resource
    ));
}

#[test]
fn remembered_allows_cannot_override_configured_denies_or_child_ceilings() {
    let denies = vec![rule("read", "private/*", "deny")];
    let remembered = vec![rule("*", "*", "allow")];
    assert_eq!(
        decision(&"read".into(), &["private/x".into()], &denies, &remembered),
        Effect::Deny
    );
    assert_eq!(
        decision(&"read".into(), &["public/x".into()], &denies, &remembered),
        Effect::Allow
    );
    assert_eq!(decision(&"read".into(), &[], &[], &[]), Effect::Allow);
    let inherited = ceiling::inherit(
        &[rule("read", "*", "allow"), denies[0].clone()],
        &[
            denies[0].clone(),
            rule("shell", "*", "deny"),
            rule("read", "*", "ask"),
        ],
    );
    assert_eq!(inherited.len(), 2);
    assert!(
        inherited
            .iter()
            .all(|item| item.effect.0.as_str() == Some("deny"))
    );
    assert_eq!(
        decision(
            &"shell".into(),
            &["echo safe".into()],
            &inherited,
            &remembered
        ),
        Effect::Deny
    );
}

#[test]
fn autonomy_grants_permissions_and_answers_but_goals_do_not_grant_reviews() {
    for yolo in 0..=3 {
        let current = Effective {
            yolo: YoloLevel::new(yolo).unwrap(),
            goal_active: false,
        };
        assert_eq!(current.can_auto_permission(), yolo >= 1);
        assert_eq!(current.can_auto_answer(), yolo >= 2);
        assert_eq!(current.can_auto_guardrail(), yolo >= 1);
    }
    let goal = Effective {
        yolo: YoloLevel::OFF,
        goal_active: true,
    };
    assert!(goal.can_auto_permission());
    assert!(goal.can_auto_answer());
    assert!(!goal.can_auto_guardrail());
}

#[test]
fn binary_policy_load_replaces_statements_and_preserves_last_match_and_fallback() {
    use ycoding_core::tools::policy::{Policy, PolicyEffect, Statement};
    let mut policy = Policy::default();
    assert!(!policy.has_statements());
    assert_eq!(
        policy.evaluate(&"read".into(), &"src/file".into(), PolicyEffect::Allow),
        PolicyEffect::Allow
    );
    policy.load(vec![
        Statement {
            action: "*".into(),
            resource: "*".into(),
            effect: PolicyEffect::Deny,
        },
        Statement {
            action: "read".into(),
            resource: "src/*".into(),
            effect: PolicyEffect::Allow,
        },
    ]);
    assert!(policy.has_statements());
    assert_eq!(
        policy.evaluate(&"read".into(), &"src/file".into(), PolicyEffect::Deny),
        PolicyEffect::Allow
    );
    policy.load(vec![]);
    assert!(!policy.has_statements());
    assert_eq!(
        policy.evaluate(&"read".into(), &"src/file".into(), PolicyEffect::Deny),
        PolicyEffect::Deny
    );
}
