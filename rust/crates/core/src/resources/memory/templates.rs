use super::{
    format::Concept,
    okf::{Diagnostic, Level, diagnostic},
};

pub struct Template {
    pub kind: &'static str,
    pub type_name: &'static str,
    pub purpose: &'static str,
    pub fields: &'static [(&'static str, &'static str)],
    pub sections: &'static [&'static str],
    pub sourced: bool,
}

pub const TEMPLATES: [Template; 9] = [
    Template {
        kind: "fact",
        type_name: "Verified Fact",
        purpose: "A durable fact about the system, checked against live evidence.",
        fields: &[("x-ycoding-subject", "<what the fact is about>")],
        sections: &["Fact", "Evidence"],
        sourced: true,
    },
    Template {
        kind: "decision",
        type_name: "Decision",
        purpose: "A choice that was made, with the reason it was made.",
        fields: &[(
            "x-ycoding-revisit-when",
            "<condition that reopens the decision>",
        )],
        sections: &["Decision", "Rationale", "Consequences"],
        sourced: true,
    },
    Template {
        kind: "constraint",
        type_name: "Constraint",
        purpose: "A rule the work must satisfy, with what enforces it.",
        fields: &[
            ("x-ycoding-applies-to", "<scope the rule covers>"),
            (
                "x-ycoding-enforced-by",
                "<tool, test, or review that enforces it>",
            ),
        ],
        sections: &["Constraint", "Reason"],
        sourced: true,
    },
    Template {
        kind: "preference",
        type_name: "Preference",
        purpose: "A convention that authoritative project material establishes.",
        fields: &[("x-ycoding-applies-to", "<scope the convention covers>")],
        sections: &["Preference", "Evidence"],
        sourced: true,
    },
    Template {
        kind: "lesson",
        type_name: "Lesson",
        purpose: "A repeated, verified mistake or insight and the rule it establishes.",
        fields: &[("x-ycoding-trigger", "<situation where the lesson applies>")],
        sections: &["Lesson", "Context"],
        sourced: false,
    },
    Template {
        kind: "troubleshooting",
        type_name: "Troubleshooting",
        purpose: "A recognizable failure with its verified cause and fix.",
        fields: &[("x-ycoding-symptom", "<observable failure>")],
        sections: &["Symptom", "Cause", "Fix"],
        sourced: false,
    },
    Template {
        kind: "procedure",
        type_name: "Procedure",
        purpose: "Ordered steps or reference material for a recurring task.",
        fields: &[("x-ycoding-applies-to", "<task or situation>")],
        sections: &["When to use", "Steps"],
        sourced: false,
    },
    Template {
        kind: "known-issue",
        type_name: "Known Issue",
        purpose: "An open defect or limitation, its workaround, and its resolution once known.",
        fields: &[
            ("x-ycoding-affects", "<component or behavior affected>"),
            ("x-ycoding-workaround", "<how to proceed meanwhile>"),
            ("x-ycoding-resolution", "<fix or decision, once it exists>"),
        ],
        sections: &["Issue", "Workaround", "Resolution"],
        sourced: false,
    },
    Template {
        kind: "experience",
        type_name: "Experience",
        purpose: "A cue-triggered lesson from one recorded outcome, with the evidence behind it. Confidence is the writer's own estimate and never raises trust.",
        fields: &[
            (
                "x-ycoding-cue",
                "<one-line situation that should recall this>",
            ),
            (
                "x-ycoding-lesson",
                "<one-line rule the outcome established>",
            ),
            (
                "x-ycoding-applicability",
                "<one-line scope where the lesson holds>",
            ),
            ("x-ycoding-outcome", "<success or failure>"),
            ("x-ycoding-confidence", "\"<number from 0 to 1>\""),
            (
                "x-ycoding-harness-change",
                "<optional reference to the harness change it led to>",
            ),
        ],
        sections: &["Cue", "Lesson", "Evidence"],
        sourced: true,
    },
];

pub fn by_kind(kind: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|template| template.kind == kind)
}
pub fn by_type(type_name: &str) -> Option<&'static Template> {
    TEMPLATES
        .iter()
        .find(|template| template.type_name.eq_ignore_ascii_case(type_name))
}
pub fn kinds() -> impl Iterator<Item = &'static str> {
    TEMPLATES.iter().map(|template| template.kind)
}

pub fn skeleton(template: &Template) -> String {
    let mut lines = vec![
        "---".to_owned(),
        format!("type: {}", template.type_name),
        "title: <short noun phrase>".into(),
        "description: <one sentence that states what this concept tells a reader>".into(),
        "tags: [<tag>]".into(),
    ];
    if template.sourced {
        lines.extend([
            "sources:".into(),
            "  - id: <source-id>".into(),
            "    resource: <repo:///path, https URL, or /path of another concept>".into(),
            "    title: <source title>".into(),
        ]);
    }
    lines.extend(
        template
            .fields
            .iter()
            .map(|(key, hint)| format!("{key}: {hint}")),
    );
    lines.push("---".into());
    lines.push(String::new());
    for section in template.sections {
        lines.push(format!("# {section}"));
        lines.push(String::new());
        lines.push("<one to three sentences>".into());
        if template.sourced && *section == template.sections[0] {
            lines.pop();
            lines.push("<one to three sentences>[^source-id]".into());
        }
        lines.push(String::new());
    }
    if template.sourced {
        lines.push("[^source-id]: <source title>".into());
        lines.push(String::new());
    }
    lines.join("\n")
}

pub fn advise(concept: &Concept) -> Vec<Diagnostic> {
    let mut advice = Vec::new();
    let mut note = |code: &'static str, message: &str| {
        advice.push(diagnostic(Level::Advice, code, message, None));
    };
    let meta = &concept.summary.meta;
    if meta.title.is_none() {
        note("Y301", "add a short title");
    }
    if meta.description.is_none() {
        note(
            "Y302",
            "add a one-sentence description; indexes and recall previews reuse it",
        );
    }
    if concept.body.trim().is_empty() {
        note("Y303", "add a body that states the knowledge");
    }
    let Some(template) = by_type(&meta.type_) else {
        note(
            "Y300",
            "use a canonical type: Verified Fact, Decision, Constraint, Preference, Lesson, Troubleshooting, Procedure, Known Issue, or Experience",
        );
        return advice;
    };
    if template.sourced && meta.sources.is_empty() {
        note(
            "Y304",
            "cite the evidence in sources with a stable id and a footnote",
        );
    }
    let headings = concept
        .body
        .lines()
        .filter_map(|line| line.trim_end().strip_prefix('#'))
        .map(|line| line.trim_start_matches('#').trim().to_lowercase())
        .collect::<Vec<_>>();
    for section in template.sections {
        if !headings
            .iter()
            .any(|heading| heading == &section.to_lowercase())
        {
            advice.push(diagnostic(
                Level::Advice,
                "Y305",
                format!("add a \"{section}\" section"),
                None,
            ));
        }
    }
    advice
}
