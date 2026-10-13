use crate::regexp::{Budget, RegExp};
use icu_normalizer::ComposingNormalizer;
use std::sync::OnceLock;
use ycoding_schema::{DomainDecode, JsonValue, LosslessString, project_artifact};

const UNSAFE: &[(&str, &str)] = &[
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "i"),
    (
        r"(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth(?:orization)?|password|passwd|credential|secret)\s*[:=]",
        "i",
    ),
    (r"\bclientSecret\s*[:=]", ""),
    (
        r"\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
        "",
    ),
    (r"\bsk_[A-Za-z0-9_-]{8,}\b", ""),
    (
        r"\b(?:ghp_|github_pat_|npm_|hf_|sk-ant-api\d*-)[A-Za-z0-9_-]{16,}\b",
        "i",
    ),
    (r"\b(?:glpat-|xox[baprs]-|pypi-)[A-Za-z0-9_-]{16,}\b", "i"),
    (r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", ""),
    (r"\bAIzaSy[A-Za-z0-9_-]{30,}\b", ""),
    (r"(?:https?|file):", "i"),
    (r#"(?:^|[\s=("'`:])\\[^\s]+"#, "m"),
    (r#"(?:^|[\s=("'`:])[A-Za-z]:[\\/][^\s]+"#, "m"),
    (r#"(?:^|[\s=("'`:])~(?:[\\/]|\b)"#, "m"),
    (r#"(?:^|[\s=:("'`\\/])\.\.(?:[\\/]|$)"#, "m"),
    (r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "i"),
    (
        r"<!--[\s\S]*?-->|</?[a-z][a-z0-9-]*(?:\s+[^<>]*?)?\s*/?>",
        "i",
    ),
    (r"!?\[[^\]]*\]\([^)]*\)", ""),
    (r"<\|(?:system|developer|assistant|user)\|>", "i"),
    (
        r"\b(?:system|developer)\s+(?:message|prompt|instructions?)\b",
        "i",
    ),
    (
        r"\b(?:override|bypass|ignore|disable)\b[^\n]{0,80}\b(?:permission|policy|prompt|instruction|safety)\b",
        "i",
    ),
    (r"\bimport\s*\(", "i"),
    (
        r#"^\s*import\s+(?:["']|[\w$*{},\s]+\s+from\s+|[\w.]+(?:\s+as\s+\w+)?\s*$|[\w$]+\s*=\s*require\s*\()"#,
        "im",
    ),
    (r"^\s*from\s+[\w.]+\s+import\s+", "im"),
    (r#"^\s*export\s+[^\n]+\s+from\s+["']"#, "im"),
    (r"\brequire\s*\(", "i"),
    (r"^\s*#!", "m"),
    (r"^\s*(?:bun|npm|pnpm|yarn)\s+(?:add|install)\b", "im"),
    (r"^\s*(?:pip\s+install|cargo\s+add|go\s+get)\b", "im"),
    (
        r"^\s*(?:scripts|dependencies|devDependencies|peerDependencies|optionalDependencies)\s*:",
        "im",
    ),
    (r"\bcurl\b[^\n|]*\|\s*(?:sh|bash|zsh)\b", "i"),
    (r"\bchmod\s+\+x\b", "i"),
    (
        r"\b(?:package\.json|bun\.lock|package-lock\.json|pnpm-lock|yarn\.lock|postinstall|preinstall|github/workflows|gitlab-ci|dockerfile)\b",
        "i",
    ),
];

pub fn validate_automatic(
    id: &JsonValue,
    definition: &JsonValue,
    existing_ids: &[LosslessString],
) -> Vec<project_artifact::ValidationError> {
    let JsonValue::Object(value) = definition else {
        return vec![error("InvalidArtifact", "definition")];
    };
    let Some(JsonValue::String(kind)) = value.get(&"kind".into()) else {
        return vec![error(
            if value.get(&"kind".into()).is_some() {
                "UnsupportedKind"
            } else {
                "InvalidArtifact"
            },
            if value.get(&"kind".into()).is_some() {
                "kind"
            } else {
                "definition"
            },
        )];
    };
    let fields: &[&str] = match kind.as_str() {
        Some("skill") => &["kind", "name", "description", "content"],
        Some("command") => &["kind", "name", "description", "template", "subtask"],
        Some("agent") => &[
            "kind",
            "name",
            "description",
            "system",
            "mode",
            "permissions",
        ],
        _ => return vec![error("UnsupportedKind", "kind")],
    };
    let mut errors = validate_id(id, existing_ids);
    if value.iter().any(|(key, _)| {
        !fields
            .iter()
            .any(|field| key == &LosslessString::from(*field))
    }) || (kind.as_str() == Some("command")
        && value.get(&"subtask".into()) != Some(&JsonValue::Bool(false)))
        || (kind.as_str() == Some("agent")
            && (value.get(&"mode".into()) != Some(&JsonValue::String("subagent".into()))
                || !matches!(value.get(&"permissions".into()), Some(JsonValue::Array(_)))))
    {
        errors.push(error("InvalidArtifact", "definition"));
        return errors;
    }
    errors.extend(validate_bounded_text(
        value.get(&"name".into()).unwrap_or(&JsonValue::Null),
        "name",
        128,
        512,
    ));
    errors.extend(validate_bounded_text(
        value.get(&"description".into()).unwrap_or(&JsonValue::Null),
        "description",
        512,
        2048,
    ));
    let (field, maximum) = match kind.as_str() {
        Some("skill") => ("content", 24 * 1024),
        Some("command") => ("template", 16 * 1024),
        _ => ("system", 16 * 1024),
    };
    errors.extend(validate_text(
        value.get(&field.into()).unwrap_or(&JsonValue::Null),
        field,
        maximum,
    ));
    errors
}

pub fn validate_id(
    id: &JsonValue,
    existing_ids: &[LosslessString],
) -> Vec<project_artifact::ValidationError> {
    let Ok(id) = project_artifact::Id::decode(id) else {
        return vec![error("InvalidArtifact", "id")];
    };
    if existing_ids.iter().any(|existing| {
        existing.to_utf8().is_ok_and(|existing| {
            ComposingNormalizer::new_nfkc()
                .normalize(&existing)
                .to_lowercase()
                == id
                    .as_lossless()
                    .as_str()
                    .expect("validated ASCII artifact ID")
        })
    }) {
        return vec![error("ArtifactCollision", "id")];
    }
    Vec::new()
}

pub fn validate_text(
    value: &JsonValue,
    field: &str,
    maximum_bytes: usize,
) -> Vec<project_artifact::ValidationError> {
    let JsonValue::String(value) = value else {
        return vec![error("InvalidArtifact", field)];
    };
    if value.is_empty() {
        return vec![error("InvalidArtifact", field)];
    }
    let units = value.code_units().collect::<Vec<_>>();
    if String::from_utf16_lossy(&units).len() > maximum_bytes {
        return vec![error("ContentTooLarge", field)];
    }
    if char::decode_utf16(units.iter().copied()).any(|scalar| {
        scalar.is_err()
            || scalar.is_ok_and(|c| {
                (c < '\u{20}' && c != '\t' && c != '\n') || ('\u{7f}'..='\u{9f}').contains(&c)
            })
    }) || has_absolute_path(&units)
        || unsafe_patterns().iter().any(|pattern| {
            pattern
                .clone()
                .test(&units, &mut Budget::unlimited())
                .expect("static artifact validation pattern")
        })
    {
        return vec![error("UnsafeContent", field)];
    }
    Vec::new()
}

pub fn validate_rendered(value: &LosslessString) -> Vec<project_artifact::ValidationError> {
    if String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>()).len() > 32 * 1024 {
        return vec![error("ContentTooLarge", "renderedContent")];
    }
    Vec::new()
}

fn validate_bounded_text(
    value: &JsonValue,
    field: &str,
    maximum_scalars: usize,
    maximum_bytes: usize,
) -> Vec<project_artifact::ValidationError> {
    let errors = validate_text(value, field, maximum_bytes);
    if !errors.is_empty() {
        return errors;
    }
    if let JsonValue::String(value) = value
        && char::decode_utf16(value.code_units()).count() > maximum_scalars
    {
        return vec![error("ContentTooLarge", field)];
    }
    Vec::new()
}

fn unsafe_patterns() -> &'static [RegExp] {
    static PATTERNS: OnceLock<Vec<RegExp>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        UNSAFE
            .iter()
            .map(|(pattern, flags)| {
                RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), flags)
                    .expect("static artifact validation pattern")
            })
            .collect()
    })
}

fn has_absolute_path(value: &[u16]) -> bool {
    let mut paths = RegExp::new(
        &r#"(?:^|[\s=("'`:])(/(?!/)[^\s)]+)"#.encode_utf16().collect::<Vec<_>>(),
        "gm",
    )
    .expect("static artifact absolute-path pattern");
    let mut pragma = RegExp::new(&r"^`/\*\*[ \t]+@jsxImportSource[ \t]+(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*[ \t]+\*/`".encode_utf16().collect::<Vec<_>>(), "").expect("static artifact pragma pattern");
    while let Some(matched) = paths
        .exec(value, &mut Budget::unlimited())
        .expect("static artifact absolute-path pattern")
    {
        let path_length = matched.captures[1].as_ref().expect("path capture").len();
        let start =
            matched.index + matched.captures[0].as_ref().expect("whole match").len() - path_length;
        if start == 0
            || !pragma
                .test(&value[start - 1..], &mut Budget::unlimited())
                .expect("static artifact pragma pattern")
        {
            return true;
        }
    }
    false
}

fn error(code: &str, field: &str) -> project_artifact::ValidationError {
    project_artifact::ValidationError {
        code: project_artifact::ErrorCode::decode(&JsonValue::String(code.into()))
            .expect("static artifact error code"),
        message: project_artifact::Description::decode(&JsonValue::String(
            "Project Artifact input was rejected".into(),
        ))
        .expect("static artifact rejection message"),
        field: Some(
            project_artifact::NonEmptyText::decode(&JsonValue::String(field.into()))
                .expect("nonempty validation field"),
        ),
    }
}
