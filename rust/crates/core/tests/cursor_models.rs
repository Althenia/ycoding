use ycoding_ai::cursor::models::{Info, Variant};
use ycoding_core::resources::cursor::models::from_cursor;
use ycoding_schema::{DomainEncode, JsonValue, model};

fn variant(
    key: &str,
    display: &str,
    parameters: &[(&str, &str)],
    non_max: bool,
    max: bool,
) -> Variant {
    Variant {
        key: key.into(),
        display_name: display.into(),
        parameters: parameters
            .iter()
            .map(|(id, value)| ((*id).into(), (*value).into()))
            .collect(),
        default_non_max: non_max,
        default_max: max,
    }
}

fn info(id: &str, display: &str, variants: Vec<Variant>) -> Info {
    Info {
        id: id.into(),
        display_name: display.into(),
        supports_thinking: false,
        supports_agent: true,
        supports_images: None,
        max_context: None,
        max_context_max_mode: None,
        supports_max_mode: false,
        variants,
    }
}

fn ids(models: &[model::Info]) -> Vec<String> {
    models
        .iter()
        .map(|model| model.id.as_str().unwrap().to_owned())
        .collect()
}

fn get<'a>(models: &'a [model::Info], id: &str) -> &'a model::Info {
    models
        .iter()
        .find(|model| model.id.as_str() == Some(id))
        .unwrap_or_else(|| panic!("missing {id}"))
}

fn tuple(parameters: &[(&str, &str)]) -> JsonValue {
    let mut settings = ycoding_schema::JsonObject::new();
    settings.insert(
        "cursorVariantParameters".into(),
        JsonValue::Array(
            parameters
                .iter()
                .map(|(id, value)| {
                    let mut item = ycoding_schema::JsonObject::new();
                    item.insert("id".into(), (*id).encode());
                    item.insert("value".into(), (*value).encode());
                    JsonValue::Object(item)
                })
                .collect(),
        ),
    );
    JsonValue::Object(settings)
}

fn settings(model: &model::Info) -> Option<JsonValue> {
    model.settings.as_ref().map(|settings| settings.encode())
}

fn variant_view(model: &model::Info) -> Vec<(String, Option<JsonValue>)> {
    model
        .variants
        .iter()
        .map(|variant| {
            (
                variant.id.as_str().unwrap().to_owned(),
                variant.settings.as_ref().map(|settings| settings.encode()),
            )
        })
        .collect()
}

fn rates(model: &model::Info) -> Vec<(f64, f64, f64, f64)> {
    model
        .cost
        .iter()
        .map(|cost| {
            (
                cost.input.get(),
                cost.output.get(),
                cost.cache.read.get(),
                cost.cache.write.get(),
            )
        })
        .collect()
}

fn opus() -> Info {
    let mut model = info(
        "claude-opus-4-8",
        "Opus 4.8",
        vec![
            variant(
                "high",
                "Opus 4.8 <span>High</span>",
                &[("effort", "high"), ("context", "300k")],
                true,
                false,
            ),
            variant(
                "high-fast",
                "Opus 4.8 High Fast",
                &[("effort", "high"), ("fast", "true"), ("context", "300k")],
                false,
                false,
            ),
            variant(
                "1m-high",
                "Opus 4.8 1M High",
                &[("effort", "high"), ("context", "1m")],
                false,
                true,
            ),
        ],
    );
    model.supports_thinking = true;
    model.supports_images = Some(true);
    model.max_context = Some(300_000.0);
    model.max_context_max_mode = Some(1_000_000.0);
    model
}

#[test]
fn grok_context_sizes_are_models_with_four_effort_choices_each() {
    let efforts = ["low", "medium", "high", "xhigh"];
    let mut grok = info(
        "grok-4.7",
        "Grok 4.7",
        efforts
            .iter()
            .flat_map(|effort| {
                [
                    variant(
                        effort,
                        &format!(
                            "Grok 4.7 {}",
                            if *effort == "xhigh" {
                                "Extra High"
                            } else {
                                effort
                            }
                        ),
                        &[("effort", effort), ("context", "256k")],
                        *effort == "high",
                        false,
                    ),
                    variant(
                        &format!("{effort}-500k"),
                        &format!("Grok 4.7 {effort} 500k"),
                        &[("effort", effort), ("context", "500k")],
                        false,
                        *effort == "high",
                    ),
                ]
            })
            .collect(),
    );
    grok.max_context = Some(256_000.0);
    grok.max_context_max_mode = Some(500_000.0);
    let models = from_cursor(&[grok]);

    assert_eq!(ids(&models), ["grok-4.7", "grok-4.7-500k"]);
    let base = get(&models, "grok-4.7");
    assert_eq!(base.name.as_str(), Some("Grok 4.7"));
    assert_eq!(base.limit.context.get(), 256_000);
    assert_eq!(base.model_id.as_str(), Some("grok-4.7"));
    let long = get(&models, "grok-4.7-500k");
    assert_eq!(long.name.as_str(), Some("Grok 4.7 500k"));
    assert_eq!(long.limit.context.get(), 500_000);
    assert_eq!(long.model_id.as_str(), Some("grok-4.7"));
    assert_eq!(
        settings(long),
        Some(tuple(&[("effort", "high"), ("context", "500k")]))
    );
    assert!(!long.cost.is_empty());
    for (id, context) in [("grok-4.7", "256k"), ("grok-4.7-500k", "500k")] {
        assert_eq!(
            variant_view(get(&models, id)),
            efforts
                .iter()
                .map(|effort| (
                    (*effort).to_owned(),
                    Some(tuple(&[("effort", effort), ("context", context)]))
                ))
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn advertised_500k_identity_survives_generated_context_collision() {
    let mut grok = info(
        "grok-4.7",
        "grok-4.7",
        vec![
            variant(
                "high",
                "Grok 4.7 High",
                &[("effort", "high"), ("context", "256k")],
                true,
                false,
            ),
            variant(
                "high-500k",
                "Grok 4.7 High 500k",
                &[("effort", "high"), ("context", "500k")],
                false,
                true,
            ),
        ],
    );
    grok.max_context = Some(256_000.0);
    let models = from_cursor(&[info("grok-4.7-500k", "grok-4.7-500k", vec![]), grok]);
    assert_eq!(
        ids(&models),
        ["grok-4.7-500k", "grok-4.7", "grok-4.7-500k-2"]
    );
    assert_eq!(models[2].model_id.as_str(), Some("grok-4.7"));
}

#[test]
fn long_context_variants_split_into_1m_entry_with_exact_tuples() {
    let models = from_cursor(&[opus()]);
    assert_eq!(
        ids(&models),
        [
            "claude-opus-4-8",
            "claude-opus-4-8-fast",
            "claude-opus-4-8-1m"
        ]
    );

    let base = get(&models, "claude-opus-4-8");
    assert_eq!(base.model_id.as_str(), Some("claude-opus-4-8"));
    assert_eq!(base.provider_id.0.as_str(), Some("cursor"));
    assert_eq!(base.name.as_str(), Some("Opus 4.8"));
    assert_eq!(
        base.package.as_ref().and_then(|p| p.as_str()),
        Some("aisdk:cursor-opencode-provider")
    );
    assert!(base.capabilities.tools);
    assert_eq!(base.capabilities.input, ["text".into(), "image".into()]);
    assert_eq!(base.capabilities.output, ["text".into()]);
    assert_eq!(
        (base.limit.context.get(), base.limit.output.get()),
        (300_000, 32_000)
    );
    assert!(base.enabled);
    assert_eq!(base.status.as_str(), Some("active"));
    assert_eq!(settings(base), None);
    assert_eq!(
        variant_view(base),
        [(
            "high".to_owned(),
            Some(tuple(&[("effort", "high"), ("context", "300k")]))
        )]
    );
    assert!(!base.cost.is_empty());

    let fast = get(&models, "claude-opus-4-8-fast");
    assert_eq!(fast.model_id.as_str(), Some("claude-opus-4-8"));
    assert_eq!(fast.name.as_str(), Some("Opus 4.8 Fast"));
    assert!(fast.cost.is_empty());
    assert_eq!(
        variant_view(fast),
        [(
            "high".to_owned(),
            Some(tuple(&[
                ("effort", "high"),
                ("fast", "true"),
                ("context", "300k")
            ]))
        )]
    );

    let long = get(&models, "claude-opus-4-8-1m");
    assert_eq!(long.model_id.as_str(), Some("claude-opus-4-8"));
    assert_eq!(long.name.as_str(), Some("Opus 4.8 1M"));
    assert_eq!(
        (long.limit.context.get(), long.limit.output.get()),
        (1_000_000, 128_000)
    );
    assert_eq!(
        settings(long),
        Some(tuple(&[("effort", "high"), ("context", "1m")]))
    );
    assert_eq!(
        variant_view(long),
        [(
            "high".to_owned(),
            Some(tuple(&[("effort", "high"), ("context", "1m")]))
        )]
    );
}

#[test]
fn separately_priced_fast_variants_split_with_their_own_cost() {
    let models = from_cursor(&[info(
        "composer-2.5",
        "Composer 2.5",
        vec![
            variant(
                "standard",
                "Composer 2.5",
                &[("fast", "false")],
                true,
                false,
            ),
            variant(
                "fast",
                "Composer 2.5 Fast",
                &[("fast", "true")],
                false,
                false,
            ),
        ],
    )]);
    assert_eq!(ids(&models), ["composer-2.5", "composer-2.5-fast"]);
    let base = get(&models, "composer-2.5");
    assert!(base.variants.is_empty());
    assert_eq!(settings(base), Some(tuple(&[("fast", "false")])));
    assert_eq!(rates(base), [(0.5, 2.5, 0.2, 0.0)]);
    let fast = get(&models, "composer-2.5-fast");
    assert_eq!(fast.model_id.as_str(), Some("composer-2.5"));
    assert_eq!(fast.name.as_str(), Some("Composer 2.5 Fast"));
    assert_eq!(settings(fast), Some(tuple(&[("fast", "true")])));
    assert!(fast.variants.is_empty());
    assert_eq!(rates(fast), [(3.0, 15.0, 0.5, 0.0)]);
}

#[test]
fn models_without_variants_stay_variant_free_with_conservative_limits() {
    let models = from_cursor(&[
        info("default", "Auto", vec![]),
        info("unpriced-model", "unpriced-model", vec![]),
    ]);
    let auto = get(&models, "default");
    assert_eq!(auto.name.as_str(), Some("Auto"));
    assert!(auto.variants.is_empty());
    assert_eq!(auto.capabilities.input, ["text".into()]);
    assert_eq!(
        (auto.limit.context.get(), auto.limit.output.get()),
        (256_000, 32_000)
    );
    let unpriced = get(&models, "unpriced-model");
    assert_eq!(unpriced.name.as_str(), Some("unpriced-model"));
    assert!(unpriced.variants.is_empty());
    assert!(unpriced.cost.is_empty());
    assert_eq!(
        (unpriced.limit.context.get(), unpriced.limit.output.get()),
        (200_000, 32_000)
    );
}

#[test]
fn thinking_models_colliding_with_a_plain_twin_are_tagged() {
    let mut thinking = info("sonnet-5-thinking", "Sonnet 5", vec![]);
    thinking.supports_thinking = true;
    let models = from_cursor(&[info("sonnet-5", "Sonnet 5", vec![]), thinking]);
    assert_eq!(get(&models, "sonnet-5").name.as_str(), Some("Sonnet 5"));
    assert_eq!(
        get(&models, "sonnet-5-thinking").name.as_str(),
        Some("Sonnet 5 Thinking")
    );
}
