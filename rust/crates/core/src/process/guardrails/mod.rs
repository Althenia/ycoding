pub mod decision;
mod paths;
mod repository;
mod service;
mod shell;
pub use paths::{dirname, resolve, within};
pub use service::{
    Admission, CustomLayers, DeferredReview, Error, Guardrails, Input, Limits, Reservation,
    ReviewPolicy, Settings, Snapshot,
};

use crate::{
    regexp::{Budget, RegExp},
    tools::policy::{Effect, wildcard},
};
use paths::{temporary, text, units, whole};
use ycoding_schema::{LosslessString, guardrail};

pub(crate) fn is_whitespace(unit: u16) -> bool {
    paths::whitespace(unit)
}

#[derive(Clone, Debug)]
pub struct Paths {
    pub workdir: LosslessString,
    pub project: LosslessString,
    pub home: LosslessString,
    pub tmpdir: Option<LosslessString>,
    pub trusted_paths: Vec<LosslessString>,
}

#[derive(Clone, Debug, Default)]
pub struct CustomLayer {
    pub rules: guardrail::Ruleset,
    pub invalid_files: Vec<LosslessString>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Evaluation {
    pub effect: Effect,
    pub rule_ids: Vec<LosslessString>,
    pub reason: Option<LosslessString>,
    pub standard: bool,
    pub hard_review: bool,
}

impl Evaluation {
    fn allow() -> Self {
        Self {
            effect: Effect::Allow,
            rule_ids: vec![],
            reason: None,
            standard: false,
            hard_review: false,
        }
    }
    fn standard(id: &str, reason: &str, effect: Effect, hard_review: bool) -> Self {
        Self {
            effect,
            rule_ids: vec![id.into()],
            reason: Some(reason.into()),
            standard: true,
            hard_review,
        }
    }
    fn custom(rule: &guardrail::Rule) -> Self {
        Self {
            effect: match rule.decision {
                guardrail::RuleDecision::Allow => Effect::Allow,
                guardrail::RuleDecision::Deny => Effect::Deny,
                _ => Effect::Ask,
            },
            rule_ids: vec![rule.id.clone()],
            reason: Some(rule.reason.clone()),
            standard: false,
            hard_review: rule.decision == guardrail::RuleDecision::HardReview,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Evidence {
    pub matched_segment: LosslessString,
    pub resolved_targets: Vec<LosslessString>,
    pub confirmed: bool,
    pub uncertain_execution: bool,
    pub uncertain_filesystem: bool,
}

impl Evidence {
    fn verifiable(&self, hard_review: bool) -> bool {
        !self.uncertain_filesystem
            && (!hard_review || (!self.confirmed && !self.uncertain_execution))
    }
}

pub fn classify(
    action: &str,
    resources: &[LosslessString],
    paths: &Paths,
    custom: &[CustomLayer],
) -> Evaluation {
    matched(action, resources, paths, custom, &[]).0
}

pub(crate) fn matched(
    action: &str,
    resources: &[LosslessString],
    paths: &Paths,
    custom: &[CustomLayer],
    dismissed: &[LosslessString],
) -> (Evaluation, Option<Evidence>) {
    let standard = resources
        .iter()
        .filter_map(|resource| standard(action, resource, paths, dismissed))
        .collect::<Vec<_>>();
    if let Some((denied, evidence)) = standard.iter().find(|item| item.0.effect == Effect::Deny) {
        return (denied.clone(), Some(evidence.clone()));
    }
    let matching = custom
        .iter()
        .map(|layer| {
            let mut rules = layer
                .rules
                .iter()
                .enumerate()
                .filter(|(_, rule)| {
                    resources.iter().any(|resource| {
                        rule.actions
                            .iter()
                            .any(|pattern| wildcard(&action.into(), pattern))
                            && rule
                                .resources
                                .iter()
                                .any(|pattern| wildcard(resource, pattern))
                    })
                })
                .collect::<Vec<_>>();
            rules.sort_by(|left, right| {
                right
                    .1
                    .priority
                    .cmp(&left.1.priority)
                    .then(left.0.cmp(&right.0))
            });
            rules.into_iter().map(|(_, rule)| rule).collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let hard = matching
        .iter()
        .flatten()
        .find(|rule| rule.decision == guardrail::RuleDecision::HardReview);
    let result = custom.iter().zip(&matching).find_map(|(layer, rules)| {
        if let Some(rule) = rules.first()
            && rule.decision == guardrail::RuleDecision::Deny
        {
            return Some(Evaluation::custom(rule));
        }
        if !layer.invalid_files.is_empty()
            && !["read", "glob", "grep", "webfetch", "websearch"].contains(&action)
        {
            let mut reason = text("Invalid guardrail configuration: ");
            for (index, file) in layer.invalid_files.iter().enumerate() {
                if index != 0 {
                    reason.extend(text(", "));
                }
                reason.extend(file.code_units());
            }
            return Some(Evaluation {
                effect: Effect::Ask,
                rule_ids: vec!["configuration.invalid".into()],
                reason: Some(LosslessString::from_utf16(reason)),
                standard: false,
                hard_review: false,
            });
        }
        rules.first().map(|rule| Evaluation::custom(rule))
    });
    if let Some(result) = &result
        && result.effect == Effect::Deny
    {
        return (result.clone(), None);
    }
    if let Some(first) = standard.iter().find(|item| item.0.hard_review) {
        let (hard, evidence) = if first.0.rule_ids.first().and_then(LosslessString::as_str)
            == Some("standard.review.database-destructive")
        {
            standard
                .iter()
                .find(|item| item.0.rule_ids == first.0.rule_ids && item.1.confirmed)
                .or_else(|| {
                    standard.iter().find(|item| {
                        item.0.rule_ids == first.0.rule_ids && item.1.uncertain_execution
                    })
                })
                .unwrap_or(first)
        } else {
            first
        };
        return (hard.clone(), Some(evidence.clone()));
    }
    if let Some(hard) = hard {
        return (Evaluation::custom(hard), None);
    }
    if let Some(result) = result {
        return (result, None);
    }
    let Some(first) = standard.iter().find(|item| item.0.effect == Effect::Ask) else {
        return (Evaluation::allow(), None);
    };
    if first.0.rule_ids.first().and_then(LosslessString::as_str)
        == Some("standard.review.outside-repo")
        && let Some((evaluation, evidence)) = standard
            .iter()
            .find(|item| item.0.rule_ids == first.0.rule_ids && item.1.uncertain_filesystem)
    {
        let mut evidence = evidence.clone();
        evidence.resolved_targets.clear();
        for target in standard
            .iter()
            .filter(|item| item.0.rule_ids == first.0.rule_ids)
            .flat_map(|item| &item.1.resolved_targets)
        {
            if !evidence.resolved_targets.contains(target) {
                evidence.resolved_targets.push(target.clone());
            }
        }
        return (evaluation.clone(), Some(evidence));
    }
    (first.0.clone(), Some(first.1.clone()))
}

fn standard(
    action: &str,
    resource: &LosslessString,
    paths: &Paths,
    dismissed: &[LosslessString],
) -> Option<(Evaluation, Evidence)> {
    let active = |id: &str| !dismissed.iter().any(|rule| rule.as_str() == Some(id));
    let outside = || {
        let targets = outside_targets(action, resource, paths);
        if targets.is_empty() || !active("standard.review.outside-repo") {
            return None;
        }
        let matched_segment = if action == "shell" {
            shell::workdirs(resource, paths)
                .into_iter()
                .map(|operation| (joined(&operation.segment.raw), operation.workdir))
                .find(|(segment, workdir)| {
                    !outside_targets(
                        action,
                        segment,
                        &Paths {
                            workdir: workdir.clone(),
                            ..paths.clone()
                        },
                    )
                    .is_empty()
                })
                .map_or_else(|| resource.clone(), |(segment, _)| segment)
        } else {
            resource.clone()
        };
        Some((
            Evaluation::standard(
                "standard.review.outside-repo",
                "Work outside the repository requires ordinary guardrail review.",
                Effect::Ask,
                false,
            ),
            Evidence {
                matched_segment,
                resolved_targets: targets.into_iter().map(|target| target.path).collect(),
                confirmed: false,
                uncertain_execution: false,
                uncertain_filesystem: false,
            },
        ))
    };
    if action != "shell" {
        return outside();
    }
    let parsed = shell::segments(resource);
    let inert = shell::inert_segments(resource);
    let mut executable_units: Vec<u16> = vec![];
    for (index, segment) in parsed.iter().enumerate() {
        if index > 0 {
            executable_units.extend(segment.separator.encode_utf16());
        }
        if !inert.get(index).copied().unwrap_or(false) {
            executable_units.extend(units(&joined(&segment.raw)));
            for body in &segment.heredoc_bodies {
                executable_units.push(32);
                executable_units.extend(units(body));
            }
        }
    }
    let executable = collapse(&LosslessString::from_utf16(executable_units));
    for (id, pattern, reason) in [
        (
            "standard.catastrophic.format-disk",
            r"(?:^|\s)(?:mkfs(?:\.[a-z0-9]+)?|diskutil\s+eraseDisk|format\s+[a-z]:)(?:\s|$)",
            "Filesystem or disk formatting",
        ),
        (
            "standard.catastrophic.block-device-write",
            r"(?:^|\s)dd\s+[^\n]*\bof=/dev/(?:disk|sd|nvme|vd)[^\s]*",
            "Raw block-device write",
        ),
        (
            "standard.catastrophic.fork-bomb",
            r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:",
            "Unbounded process spawning",
        ),
    ] {
        if regex(&executable, pattern, "i") {
            return Some((
                Evaluation::standard(id, reason, Effect::Deny, false),
                Evidence {
                    matched_segment: resource.clone(),
                    resolved_targets: vec![],
                    confirmed: false,
                    uncertain_execution: false,
                    uncertain_filesystem: false,
                },
            ));
        }
    }
    let mut deletions = vec![];
    for operation in shell::removals(resource, paths)
        .into_iter()
        .filter(|operation| operation.recursive)
    {
        let targets = operation
            .targets
            .iter()
            .filter(|(_, target)| !temporary(target, &operation.workdir, paths))
            .map(|(_, target)| resolve(&whole(target), &operation.workdir, paths))
            .collect::<Vec<_>>();
        let matches = [
            (
                "standard.catastrophic.rm-root",
                "Recursive deletion of a filesystem root",
                Effect::Deny,
                false,
                targets.iter().any(|target| target.as_str() == Some("/")),
            ),
            (
                "standard.catastrophic.rm-user-home",
                "Recursive deletion of a user home directory",
                Effect::Deny,
                false,
                targets.iter().any(|target| {
                    target == &resolve(&paths.home, &paths.workdir, paths)
                        || regex(target, r"^/(?:Users|home)/[^/]+$", "")
                }),
            ),
            (
                "standard.catastrophic.rm-system",
                "Recursive deletion of system directories",
                Effect::Deny,
                false,
                targets.iter().any(|target| {
                    [
                        "/System",
                        "/Library",
                        "/usr",
                        "/etc",
                        "/bin",
                        "/sbin",
                        "/opt",
                        "/Applications",
                        "/var",
                    ]
                    .iter()
                    .any(|root| within(target, &(*root).into()))
                }),
            ),
            (
                "standard.review.project-deletion",
                "Recursive deletion of the current project or one of its ancestors",
                Effect::Ask,
                true,
                targets
                    .iter()
                    .any(|target| within(&resolve(&paths.project, &paths.workdir, paths), target)),
            ),
            (
                "standard.review.home-child",
                "Recursive deletion of a direct child of the home directory",
                Effect::Ask,
                true,
                targets
                    .iter()
                    .any(|target| dirname(target) == resolve(&paths.home, &paths.workdir, paths)),
            ),
        ];
        if let Some((id, reason, effect, hard, _)) = matches
            .into_iter()
            .find(|(id, _, effect, _, matches)| *matches && (*effect == Effect::Deny || active(id)))
        {
            deletions.push((
                Evaluation::standard(id, reason, effect, hard),
                Evidence {
                    matched_segment: parsed
                        .iter()
                        .find(|segment| segment.index == operation.segment)
                        .map_or_else(|| resource.clone(), |segment| joined(&segment.raw)),
                    resolved_targets: targets,
                    confirmed: false,
                    uncertain_execution: false,
                    uncertain_filesystem: false,
                },
            ));
        }
    }
    if let Some(result) = deletions
        .iter()
        .find(|item| item.0.effect == Effect::Deny)
        .or_else(|| deletions.iter().find(|item| item.0.hard_review))
    {
        return Some(result.clone());
    }
    let segments = parsed
        .iter()
        .map(|segment| joined(&segment.raw))
        .collect::<Vec<_>>();
    for (id, pattern, flags, reason) in [
        (
            "standard.review.git-destructive",
            r"(?:^|\s)git\s+(?:reset\s+--hard|clean\s+-[^\s]*f|checkout\s+--\s+\.|restore\s+[^\n]*--worktree|branch\s+-[^\s]*D)",
            "",
            "Destructive Git operation",
        ),
        (
            "standard.review.force-push",
            r"(?:^|\s)git\s+push\s+[^\n]*(?:--force(?:-with-lease)?|-f)(?:\s|$)",
            "i",
            "Force push",
        ),
    ] {
        if !active(id) {
            continue;
        }
        if let Some(segment) = segments.iter().enumerate().find_map(|(index, segment)| {
            (!inert.get(index).copied().unwrap_or(false) && regex(segment, pattern, flags))
                .then_some(segment)
        }) {
            return Some((
                Evaluation::standard(id, reason, Effect::Ask, true),
                Evidence {
                    matched_segment: segment.clone(),
                    resolved_targets: vec![],
                    confirmed: false,
                    uncertain_execution: false,
                    uncertain_filesystem: false,
                },
            ));
        }
    }
    if active("standard.review.database-destructive")
        && let Some(database) = shell::database_mention(resource)
    {
        return Some((
            Evaluation::standard(
                "standard.review.database-destructive",
                if database.uncertain_execution {
                    "Possible destructive database operation; execution is unproven"
                } else {
                    "Destructive database operation"
                },
                Effect::Ask,
                true,
            ),
            Evidence {
                matched_segment: database.segment,
                resolved_targets: vec![],
                confirmed: database.confirmed,
                uncertain_execution: database.uncertain_execution,
                uncertain_filesystem: false,
            },
        ));
    }
    if active("standard.review.outside-repo")
        && let Some(import) = parsed
            .iter()
            .find(|segment| shell::unknown_sqlite_import(segment))
    {
        return Some((
            Evaluation::standard(
                "standard.review.outside-repo",
                "SQLite import file target is unproven",
                Effect::Ask,
                false,
            ),
            Evidence {
                matched_segment: joined(&import.raw),
                resolved_targets: outside()
                    .map(|(_, evidence)| evidence.resolved_targets)
                    .unwrap_or_default(),
                confirmed: false,
                uncertain_execution: false,
                uncertain_filesystem: true,
            },
        ));
    }
    outside()
}

fn joined(tokens: &[LosslessString]) -> LosslessString {
    let mut command = vec![];
    for (index, token) in tokens.iter().enumerate() {
        if index != 0 {
            command.push(32);
        }
        command.extend(token.code_units());
    }
    LosslessString::from_utf16(command)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutsideTarget {
    pub path: LosslessString,
    pub directory: bool,
}

fn shell_segment_targets(
    resource: &LosslessString,
    paths: &Paths,
    include_read_only: bool,
) -> Vec<OutsideTarget> {
    shell::workdirs(resource, paths)
        .into_iter()
        .flat_map(|operation| {
            if !include_read_only {
                let mut raw = vec![];
                for (index, token) in operation.segment.raw.iter().enumerate() {
                    if index != 0 {
                        raw.push(32);
                    }
                    raw.extend(token.code_units());
                }
                if shell::read_only(&LosslessString::from_utf16(raw)) {
                    return vec![];
                }
            }
            let invocation = shell::executable(&operation.segment.tokens);
            let cd = invocation
                .as_ref()
                .filter(|(name, _)| name.as_str() == Some("cd"));
            let operand = cd
                .and_then(|(_, args)| {
                    if let Some(index) = args.iter().position(|token| token.as_str() == Some("--"))
                    {
                        return args.get(index + 1);
                    }
                    args.iter().find(|token| !units(token).starts_with(&[45]))
                })
                .map(|target| resolve(target, &operation.workdir, paths));
            let mut targets = vec![OutsideTarget {
                path: operation.workdir.clone(),
                directory: true,
            }];
            if cd.is_some_and(|(_, args)| args.is_empty()) {
                targets.push(OutsideTarget {
                    path: paths.home.clone(),
                    directory: true,
                });
            }
            for value in shell::operands(
                &operation.segment.tokens,
                &operation.segment.heredoc_bodies,
                include_read_only,
            ) {
                let resolved = resolve(&value, &operation.workdir, paths);
                targets.push(OutsideTarget {
                    directory: operand.as_ref() == Some(&resolved),
                    path: resolved,
                });
            }
            targets
        })
        .collect()
}

pub fn read_only_shell(command: &LosslessString) -> bool {
    shell::read_only(command)
}

pub fn shell_file_targets(command: &LosslessString, paths: &Paths) -> Vec<LosslessString> {
    let workdir_resolved = resolve(&paths.workdir, &paths.workdir, paths);
    let mut targets: Vec<LosslessString> = Vec::new();
    for target in shell_segment_targets(command, paths, true) {
        if target.path != workdir_resolved
            && !within(&target.path, &"/dev".into())
            && !temporary(&target.path, &paths.workdir, paths)
            && !targets.contains(&target.path)
        {
            targets.push(target.path);
        }
    }
    targets
}

pub fn outside_targets(
    action: &str,
    resource: &LosslessString,
    paths: &Paths,
) -> Vec<OutsideTarget> {
    let targets = if action == "file_mutation" {
        vec![OutsideTarget {
            path: resolve(resource, &paths.workdir, paths),
            directory: false,
        }]
    } else if action == "shell" && !shell::read_only(resource) {
        shell_segment_targets(resource, paths, false)
    } else {
        vec![]
    };
    let mut merged: Vec<OutsideTarget> = vec![];
    for target in targets {
        if let Some(existing) = merged
            .iter_mut()
            .find(|existing| existing.path == target.path)
        {
            existing.directory |= target.directory;
            continue;
        }
        merged.push(target);
    }
    merged
        .into_iter()
        .filter(|target| {
            !within(&target.path, &paths.project)
                && !within(&target.path, &"/dev".into())
                && !temporary(&target.path, &paths.workdir, paths)
                && !paths.trusted_paths.contains(&target.path)
        })
        .collect()
}

pub fn semantic_resources(
    action: &str,
    resources: &[LosslessString],
    paths: &Paths,
) -> Vec<LosslessString> {
    resources
        .iter()
        .filter_map(|resource| {
            if action != "shell" {
                return (!(action == "file_mutation" || units(resource).starts_with(&[47]))
                    || !temporary(resource, &paths.workdir, paths))
                .then(|| resource.clone());
            }
            if shell::read_only(resource) {
                return None;
            }
            let operations = shell::removals(resource, paths);
            let removals = operations
                .iter()
                .flat_map(|operation| {
                    operation
                        .targets
                        .iter()
                        .filter(|(_, target)| {
                            operations
                                .iter()
                                .filter(|other| other.segment == operation.segment)
                                .all(|other| temporary(target, &other.workdir, paths))
                        })
                        .map(|(index, _)| (operation.segment, *index))
                })
                .collect::<Vec<_>>();
            if removals.is_empty() {
                return Some(resource.clone());
            }
            let mut sanitized = vec![];
            for segment in shell::segments(resource) {
                if operations
                    .iter()
                    .find(|operation| operation.segment == segment.index)
                    .is_some_and(|operation| {
                        operation
                            .targets
                            .iter()
                            .all(|(index, _)| removals.contains(&(segment.index, *index)))
                    })
                {
                    continue;
                }
                let tokens = segment
                    .raw
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| !removals.contains(&(segment.index, *index)))
                    .map(|(_, token)| token)
                    .collect::<Vec<_>>();
                if tokens.is_empty() {
                    continue;
                }
                if !sanitized.is_empty() {
                    sanitized.extend(text(&segment.separator));
                }
                for (index, token) in tokens.iter().enumerate() {
                    if index != 0 {
                        sanitized.push(32);
                    }
                    sanitized.extend(token.code_units());
                }
            }
            (!sanitized.is_empty()).then(|| LosslessString::from_utf16(sanitized))
        })
        .collect()
}

fn collapse(value: &LosslessString) -> LosslessString {
    let mut output = vec![];
    for unit in value.code_units() {
        if paths::whitespace(unit) {
            if !output.is_empty() && output.last() != Some(&32) {
                output.push(32);
            }
            continue;
        }
        output.push(unit);
    }
    if output.last() == Some(&32) {
        output.pop();
    }
    LosslessString::from_utf16(output)
}

fn regex(value: &LosslessString, pattern: &str, flags: &str) -> bool {
    RegExp::new(&text(pattern), flags)
        .expect("static guardrail pattern")
        .test(&units(value), &mut Budget::unlimited())
        .expect("unlimited static guardrail pattern")
}

fn regex_match_length(value: &LosslessString, pattern: &str) -> Option<usize> {
    RegExp::new(&text(pattern), "")
        .expect("static guardrail pattern")
        .exec(&units(value), &mut Budget::unlimited())
        .expect("unlimited static guardrail pattern")
        .and_then(|matched| matched.captures[0].as_ref().map(Vec::len))
}

pub(crate) use service::{redact_value, redacted_escalation};

#[cfg(test)]
mod sql906_tests {
    use super::*;

    fn paths() -> Paths {
        Paths {
            workdir: "/workspace/project".into(),
            project: "/workspace/project".into(),
            home: "/home/operator".into(),
            tmpdir: None,
            trusted_paths: vec![],
        }
    }

    #[test]
    fn sql906_matcher_prefers_confirmed_then_uncertain_database_evidence() {
        let client = r#"psql -c "DROP TABLE users""#;
        let opaque = r#"python -c "db.run('DROP TABLE users')""#;
        for (resources, expected, reason) in [
            (
                vec![r#"echo "DROP TABLE note" > notes.sql"#, client],
                client,
                "Destructive database operation",
            ),
            (
                vec![opaque, client],
                client,
                "Destructive database operation",
            ),
            (
                vec![r#"echo "DROP TABLE note" > notes.sql"#, opaque],
                opaque,
                "Possible destructive database operation; execution is unproven",
            ),
        ] {
            let resources = resources
                .into_iter()
                .map(LosslessString::from)
                .collect::<Vec<_>>();
            let (result, evidence) = matched("shell", &resources, &paths(), &[], &[]);
            assert!(result.hard_review, "{resources:?}");
            assert_eq!(result.reason, Some(reason.into()), "{resources:?}");
            assert_eq!(
                evidence
                    .expect("selected database evidence")
                    .matched_segment,
                LosslessString::from(expected),
                "{resources:?}"
            );
        }
    }

    #[test]
    fn sql906_matcher_selects_later_execution_after_inert_or_heredoc_data() {
        for command in [
            "echo \"DROP TABLE note\" > notes.sql; psql -c \"DROP TABLE users\"",
            "cat <<'TEXT'\nDROP TABLE note\nTEXT\npsql -c \"DROP TABLE users\"",
        ] {
            let (result, evidence) = matched("shell", &[command.into()], &paths(), &[], &[]);
            assert!(result.hard_review, "{command}");
            assert_eq!(
                evidence.expect("executed database segment").matched_segment,
                LosslessString::from(r#"psql -c "DROP TABLE users""#),
                "{command}"
            );
        }
    }

    #[test]
    fn sql906_matcher_prefers_uncertain_import_and_unions_known_targets() {
        for resources in [
            vec![
                "touch /outside/first",
                r#"sqlite3 db.sqlite ".import --unknown value file items""#,
                "touch /outside/second",
            ],
            vec![
                "touch /outside/first; sqlite3 db.sqlite \".import --unknown value file items\"; touch /outside/second",
            ],
        ] {
            let resources = resources
                .into_iter()
                .map(LosslessString::from)
                .collect::<Vec<_>>();
            let (result, evidence) = matched("shell", &resources, &paths(), &[], &[]);
            assert_eq!(result.effect, Effect::Ask, "{resources:?}");
            assert!(!result.hard_review, "{resources:?}");
            assert_eq!(
                result.reason,
                Some("SQLite import file target is unproven".into()),
                "{resources:?}"
            );
            assert_eq!(
                evidence.expect("outside evidence").resolved_targets,
                vec![
                    LosslessString::from("/outside/first"),
                    LosslessString::from("/outside/second"),
                ],
                "{resources:?}"
            );
        }
    }
}
