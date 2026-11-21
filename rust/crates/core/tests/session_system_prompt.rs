use ycoding_core::{
    resources::{agent, catalog::Catalog},
    session::generate,
};
use ycoding_schema::{DomainDecode, model, parse_json};

const BASE: &str = include_str!("../../../../packages/core/src/session/runner/prompt/base.txt");
const ANTHROPIC: &str =
    include_str!("../../../../packages/core/src/plugin/system-prompt/anthropic.txt");
const CODEX: &str = include_str!("../../../../packages/core/src/plugin/system-prompt/codex.txt");
const GEMINI: &str = include_str!("../../../../packages/core/src/plugin/system-prompt/gemini.txt");
const GPT: &str = include_str!("../../../../packages/core/src/plugin/system-prompt/gpt.txt");
const KIMI: &str = include_str!("../../../../packages/core/src/plugin/system-prompt/kimi.txt");
const META: &str = include_str!("../../../../packages/core/src/plugin/system-prompt/meta.txt");
const TRINITY: &str =
    include_str!("../../../../packages/core/src/plugin/system-prompt/trinity.txt");

#[test]
fn embedded_model_family_prompts_are_byte_identical_to_the_typescript_sources() {
    for (embedded, source) in [
        (
            include_str!("../src/session/system_prompt/anthropic.txt"),
            ANTHROPIC,
        ),
        (
            include_str!("../src/session/system_prompt/codex.txt"),
            CODEX,
        ),
        (
            include_str!("../src/session/system_prompt/gemini.txt"),
            GEMINI,
        ),
        (include_str!("../src/session/system_prompt/gpt.txt"), GPT),
        (include_str!("../src/session/system_prompt/kimi.txt"), KIMI),
        (include_str!("../src/session/system_prompt/meta.txt"), META),
        (
            include_str!("../src/session/system_prompt/trinity.txt"),
            TRINITY,
        ),
    ] {
        assert_eq!(embedded.as_bytes(), source.as_bytes());
    }
}

#[test]
fn an_agent_without_a_system_prompt_gets_the_catalog_model_family_prompt_or_the_base_prompt() {
    let catalog = catalog();
    for (provider, id, expected) in [
        ("openai", "gpt-5", GPT),
        ("openai", "gpt-4.1", GPT),
        ("openai", "o3", GPT),
        ("openai", "o1-mini", GPT),
        ("openai", "gpt-5-codex", CODEX),
        ("google", "gemini-2.5-pro", GEMINI),
        ("google", "gemini", BASE),
        ("anthropic", "claude-sonnet-4", ANTHROPIC),
        ("anthropic", "Claude-Opus-4", ANTHROPIC),
        ("moonshot", "kimi-k2", KIMI),
        ("arcee", "trinity-large", TRINITY),
        ("meta", "muse-spark", META),
        ("local", "llama-3.3", BASE),
        ("openai", "gpt-claude-bridge", ANTHROPIC),
        ("google", "gemini-kimi-bridge", KIMI),
        ("openai", "openai-alias", GPT),
        ("openai", "gpt-5-alias", BASE),
        ("openai", "codex-family-alias", CODEX),
        ("claude", "plain-model", BASE),
        ("anthropic", "claude-unlisted", ANTHROPIC),
    ] {
        assert_eq!(
            texts(generate::system(
                &agent::empty("build".into()),
                &catalog,
                &selection(provider, id),
                &[],
                "Initial instructions".into(),
            )),
            [expected, "Initial instructions"],
            "{provider}/{id}"
        );
    }
}

#[test]
fn an_agent_system_prompt_precedes_initial_instructions_and_is_never_replaced() {
    let catalog = catalog();
    let mut configured = agent::empty("build".into());
    configured.system = Some("Agent prompt".into());
    for (provider, id) in [
        ("anthropic", "claude-sonnet-4"),
        ("openai", "gpt-5-codex"),
        ("meta", "muse-spark"),
        ("local", "llama-3.3"),
    ] {
        assert_eq!(
            texts(generate::system(
                &configured,
                &catalog,
                &selection(provider, id),
                &[],
                "Initial instructions".into(),
            )),
            ["Agent prompt", "Initial instructions"],
            "{provider}/{id}"
        );
    }
    assert_eq!(
        texts(generate::system(
            &configured,
            &catalog,
            &selection("openai", "gpt-5"),
            &[],
            "".into(),
        )),
        ["Agent prompt"]
    );
}

#[test]
fn an_empty_agent_system_prompt_counts_as_absent() {
    let catalog = catalog();
    let mut empty = agent::empty("build".into());
    empty.system = Some("".into());
    assert_eq!(
        texts(generate::system(
            &empty,
            &catalog,
            &selection("anthropic", "claude-sonnet-4"),
            &[],
            "Initial instructions".into(),
        )),
        [ANTHROPIC, "Initial instructions"]
    );
    assert_eq!(
        texts(generate::system(
            &empty,
            &catalog,
            &selection("local", "llama-3.3"),
            &[],
            "".into(),
        )),
        [BASE]
    );
}

fn catalog() -> Catalog {
    let mut catalog = Catalog::default();
    catalog
        .configure(&[parse_json(
            r#"{"providers":{
                "openai":{"models":{
                    "gpt-5":{},"gpt-4.1":{},"o3":{},"o1-mini":{},"gpt-5-codex":{},"gpt-claude-bridge":{},
                    "openai-alias":{"modelID":"gpt-5"},
                    "gpt-5-alias":{"modelID":"custom-model"},
                    "codex-family-alias":{"modelID":"custom-deployment","family":"gpt-codex"}
                }},
                "google":{"models":{"gemini-2.5-pro":{},"gemini":{},"gemini-kimi-bridge":{}}},
                "anthropic":{"models":{"claude-sonnet-4":{},"Claude-Opus-4":{}}},
                "moonshot":{"models":{"kimi-k2":{}}},
                "arcee":{"models":{"trinity-large":{"modelID":"arcee-ai/trinity-large"}}},
                "meta":{"models":{"muse-spark":{"modelID":"meta/muse-spark-1.1"}}},
                "claude":{"models":{"plain-model":{}}},
                "local":{"models":{"llama-3.3":{}}}
            }}"#,
        )
        .unwrap()])
        .unwrap();
    catalog
}

fn selection(provider: &str, id: &str) -> model::Ref {
    model::Ref::decode(
        &parse_json(&format!(r#"{{"providerID":"{provider}","id":"{id}"}}"#)).unwrap(),
    )
    .unwrap()
}

fn texts(system: Vec<ycoding_ai::llm::TextPart>) -> Vec<String> {
    system
        .into_iter()
        .map(|part| part.text.to_utf8().unwrap())
        .collect()
}
