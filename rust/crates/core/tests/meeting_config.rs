use serde_json::{Value, json};
use ycoding_core::meeting::config::{AnalysisModel, MeetingConfig, TranscriptionConfig};
use ycoding_schema::DomainDecode;

fn parse(value: Value) -> Result<MeetingConfig, String> {
    MeetingConfig::parse(&value).map_err(|error| error.to_string())
}

#[test]
fn defaults_retain_thai_locally_and_require_human_knowledge_approval() {
    let config = parse(json!({})).unwrap();
    assert_eq!(
        config.transcription.model,
        "biodatlab/whisper-th-large-v3-combined"
    );
    assert_eq!(config.transcription.language, "th");
    assert_eq!(config.transcription.provider, "huggingface");
    assert_eq!(config.transcription.device, "auto");
    assert_eq!(config.transcription.python_executable, "python3");
    assert_eq!(
        (
            config.transcription.chunk_seconds,
            config.transcription.overlap_seconds
        ),
        (15, 2)
    );
    assert_eq!(config.transcription.request_timeout_ms, 600_000);
    assert_eq!(config.streaming.sample_rate, 16000);
    assert_eq!(config.streaming.max_buffered_seconds, 60.0);
    assert!(config.streaming.enabled && config.streaming.vad);
    assert_eq!(config.analysis.model, AnalysisModel::Inherit);
    assert_eq!(
        (config.analysis.incremental, config.analysis.max_characters),
        (true, 32000)
    );
    assert_eq!(config.knowledge.retrieval_ttl, 300_000);
    assert!(config.knowledge.mcp_enabled && config.knowledge.bindings.is_empty());
    assert_eq!(config.storage.retention_days, None);
    let value = config.to_value();
    assert_eq!(value["knowledge"]["autoApply"], false);
    assert_eq!(value["knowledge"]["requireApproval"], true);
    assert_eq!(value["storage"]["retainAudio"], false);
    assert_eq!(value["storage"]["provider"], "sqlite");
    assert_eq!(value["streaming"]["maxBufferedSeconds"], 60);
    assert_eq!(MeetingConfig::parse(&value).unwrap(), config);
}

#[test]
fn rejects_automatic_canonical_mutation_audio_retention_and_unknown_fields() {
    for rejected in [
        json!({ "knowledge": { "autoApply": true } }),
        json!({ "knowledge": { "requireApproval": false } }),
        json!({ "storage": { "retainAudio": true } }),
        json!({ "storage": { "provider": "postgres" } }),
        json!({ "bridge": { "host": "0.0.0.0" } }),
        json!({ "streaming": { "port": 1 } }),
        json!({ "transcription": { "task": "translate" } }),
        json!({ "analysis": { "model": { "id": "m", "providerID": "p", "extra": true } } }),
        json!([]),
        json!({ "streaming": null }),
    ] {
        assert!(parse(rejected.clone()).is_err(), "accepted {rejected}");
    }
}

#[test]
fn validates_the_bounded_worker_request_timeout_in_every_partition() {
    let timeout = |value: Value| parse(json!({ "transcription": { "requestTimeoutMs": value } }));
    assert_eq!(
        timeout(json!(100))
            .unwrap()
            .transcription
            .request_timeout_ms,
        100
    );
    assert_eq!(
        timeout(json!(1)).unwrap().transcription.request_timeout_ms,
        1
    );
    assert_eq!(
        timeout(json!(1_200_000))
            .unwrap()
            .transcription
            .request_timeout_ms,
        1_200_000
    );
    for rejected in [
        json!(0),
        json!(1_200_001),
        json!(1.5),
        json!("100"),
        json!(null),
    ] {
        assert!(timeout(rejected.clone()).is_err(), "accepted {rejected}");
    }
}

#[test]
fn rejects_overlap_equal_to_or_greater_than_the_chunk_duration() {
    let chunking = |chunk: u32, overlap: u32| {
        parse(json!({ "transcription": { "chunkSeconds": chunk, "overlapSeconds": overlap } }))
    };
    assert!(chunking(4, 3).is_ok());
    assert!(chunking(1, 0).is_ok());
    assert!(chunking(4, 4).is_err());
    assert!(chunking(4, 5).is_err());
    assert!(chunking(30, 10).is_ok());
    assert!(chunking(31, 2).is_err());
    assert!(chunking(0, 0).is_err());
    assert!(chunking(15, 11).is_err());
}

#[test]
fn bounds_streaming_vocabulary_analysis_knowledge_and_retention() {
    assert!(
        parse(json!({ "streaming": { "sampleRate": 8000, "maxBufferedSeconds": 30 } })).is_ok()
    );
    assert!(
        parse(json!({ "streaming": { "sampleRate": 48000, "maxBufferedSeconds": 180 } })).is_ok()
    );
    for rejected in [
        json!({ "streaming": { "sampleRate": 7999 } }),
        json!({ "streaming": { "sampleRate": 48001 } }),
        json!({ "streaming": { "maxBufferedSeconds": 29.9 } }),
        json!({ "streaming": { "maxBufferedSeconds": 180.1 } }),
        json!({ "vocabulary": { "hints": vec!["hint"; 65] } }),
        json!({ "vocabulary": { "hints": [""] } }),
        json!({ "vocabulary": { "hints": ["x".repeat(101)] } }),
        json!({ "analysis": { "maxCharacters": 7999 } }),
        json!({ "analysis": { "maxCharacters": 64001 } }),
        json!({ "analysis": { "model": "other" } }),
        json!({ "analysis": { "model": { "id": "", "providerID": "p" } } }),
        json!({ "knowledge": { "retrievalTTL": -1 } }),
        json!({ "knowledge": { "retrievalTTL": 3_600_001 } }),
        json!({ "storage": { "retentionDays": 0 } }),
        json!({ "storage": { "retentionDays": 36501 } }),
        json!({ "storage": { "retentionDays": 1.5 } }),
    ] {
        assert!(parse(rejected.clone()).is_err(), "accepted {rejected}");
    }
    assert!(parse(json!({ "vocabulary": { "hints": vec!["x".repeat(100); 64] } })).is_ok());
    let kept =
        parse(json!({ "storage": { "retentionDays": 36500 }, "knowledge": { "retrievalTTL": 0 } }))
            .unwrap();
    assert_eq!(kept.storage.retention_days, Some(36500));
    assert_eq!(kept.knowledge.retrieval_ttl, 0);
}

#[test]
fn knowledge_bindings_are_bounded_and_strict() {
    let binding = json!({ "server": "wiki", "search": "search", "read": "read", "write": "write" });
    let configured = parse(json!({ "knowledge": { "bindings": [binding.clone()] } })).unwrap();
    assert_eq!(
        configured.to_value()["knowledge"]["bindings"],
        json!([{ "server": "wiki", "search": "search", "read": "read", "write": "write", "enabled": true }])
    );
    assert!(parse(json!({ "knowledge": { "bindings": vec![binding.clone(); 4] } })).is_ok());
    assert!(parse(json!({ "knowledge": { "bindings": vec![binding; 5] } })).is_err());
    for rejected in [
        json!({ "server": "", "search": "s", "read": "r" }),
        json!({ "server": "w", "search": "s" }),
        json!({ "server": "w", "search": "s", "read": "r", "write": "" }),
        json!({ "server": "w", "search": "s", "read": "r", "delete": "d" }),
        json!({ "server": "x".repeat(201), "search": "s", "read": "r" }),
    ] {
        assert!(
            parse(json!({ "knowledge": { "bindings": [rejected.clone()] } })).is_err(),
            "accepted {rejected}"
        );
    }
    assert!(
        parse(
            json!({ "knowledge": { "bindings": [{ "server": "w", "search": "s", "read": "r" }] } })
        )
        .unwrap()
        .knowledge
        .bindings[0]
            .write
            .is_none()
    );
}

#[test]
fn explicit_analysis_model_and_fallback_round_trip() {
    let config = parse(json!({
        "analysis": { "model": { "id": "m", "providerID": "p", "variant": "high" } },
        "fallback": { "enabled": false, "provider": "huggingface", "model": "openai/whisper-large-v3" },
        "transcription": { "device": "mps", "cacheDir": "/models", "pythonExecutable": "/usr/bin/python3" },
    }))
    .unwrap();
    assert_eq!(
        config.analysis.model,
        AnalysisModel::Explicit {
            id: "m".into(),
            provider_id: "p".into(),
            variant: Some("high".into()),
            profile: None
        }
    );
    assert_eq!(
        config.fallback.model.as_deref(),
        Some("openai/whisper-large-v3")
    );
    assert_eq!(config.transcription.cache_dir, "/models");
    assert_eq!(MeetingConfig::parse(&config.to_value()).unwrap(), config);
    assert!(parse(json!({ "transcription": { "device": "tpu" } })).is_err());
}

#[test]
fn ask_model_defaults_to_inherit_and_accepts_only_inherit_or_a_bounded_reference() {
    let config = parse(json!({})).unwrap();
    assert_eq!(config.analysis.ask_model, AnalysisModel::Inherit);
    assert_eq!(config.to_value()["analysis"]["askModel"], "inherit");
    let explicit = parse(json!({ "analysis": {
        "model": { "providerID": "p", "id": "analysis" },
        "askModel": { "providerID": "p", "id": "m", "variant": "high", "profile": "acct" },
    } }))
    .unwrap();
    assert_eq!(
        explicit.analysis.ask_model,
        AnalysisModel::Explicit {
            id: "m".into(),
            provider_id: "p".into(),
            variant: Some("high".into()),
            profile: Some("acct".into()),
        }
    );
    assert_eq!(
        explicit.analysis.model,
        AnalysisModel::Explicit {
            id: "analysis".into(),
            provider_id: "p".into(),
            variant: None,
            profile: None,
        }
    );
    assert_eq!(
        explicit.to_value()["analysis"]["askModel"],
        json!({ "providerID": "p", "id": "m", "variant": "high", "profile": "acct" })
    );
    assert_eq!(
        MeetingConfig::parse(&explicit.to_value()).unwrap(),
        explicit
    );
    for rejected in [
        json!({ "analysis": { "askModel": { "providerID": "p" } } }),
        json!({ "analysis": { "askModel": { "id": "m" } } }),
        json!({ "analysis": { "askModel": "p/m" } }),
        json!({ "analysis": { "askModel": null } }),
        json!({ "analysis": { "askModel": { "providerID": "p", "id": "m", "account": "x" } } }),
        json!({ "analysis": { "askModel": { "providerID": "p", "id": "m", "variant": 1 } } }),
    ] {
        assert!(parse(rejected.clone()).is_err(), "accepted {rejected}");
    }
}

#[test]
fn knowledge_bindings_default_enabled_and_preserve_a_disabled_binding() {
    let bound = parse(json!({ "knowledge": { "bindings": [
        { "server": "docs", "search": "search", "read": "read" },
        { "server": "wiki", "search": "find", "read": "get", "write": "put", "enabled": false },
    ] } }))
    .unwrap();
    assert!(bound.knowledge.bindings[0].enabled);
    assert!(!bound.knowledge.bindings[1].enabled);
    assert_eq!(bound.knowledge.bindings[1].write.as_deref(), Some("put"));
    assert_eq!(
        bound.to_value()["knowledge"]["bindings"],
        json!([
            { "server": "docs", "search": "search", "read": "read", "enabled": true },
            { "server": "wiki", "search": "find", "read": "get", "write": "put", "enabled": false },
        ])
    );
    assert_eq!(MeetingConfig::parse(&bound.to_value()).unwrap(), bound);
    for enabled in [json!("false"), json!(0), json!(null)] {
        assert!(
            parse(json!({ "knowledge": { "bindings": [
                { "server": "docs", "search": "search", "read": "read", "enabled": enabled.clone() },
            ] } }))
            .is_err(),
            "accepted enabled {enabled}"
        );
    }
}

#[test]
fn released_owner_settings_file_decodes_without_relaxing_other_fields() {
    let released = json!({
        "analysis": {
            "model": "inherit",
            "askModel": { "providerID": "p", "id": "m1", "variant": "deep" },
            "incremental": false,
            "maxCharacters": 32000,
        },
        "knowledge": {
            "mcpEnabled": false,
            "autoApply": false,
            "requireApproval": true,
            "retrievalTTL": 300000,
            "bindings": [{ "server": "docs", "search": "search", "read": "read", "write": "replace", "enabled": true }],
        },
    });
    let config = parse(released.clone()).unwrap();
    assert!(!config.knowledge.mcp_enabled);
    let mut auto = released.clone();
    auto["knowledge"]["autoApply"] = json!(true);
    let mut approval = released.clone();
    approval["knowledge"]["requireApproval"] = json!(false);
    let mut unknown = released;
    unknown["analysis"]["askModels"] = json!("inherit");
    for rejected in [auto, approval, unknown] {
        assert!(parse(rejected.clone()).is_err(), "accepted {rejected}");
    }
}

#[test]
fn explicit_selections_become_model_references_with_variant_and_profile() {
    assert_eq!(AnalysisModel::Inherit.reference().unwrap(), None);
    let reference = AnalysisModel::Explicit {
        id: "vendor/model-x".into(),
        provider_id: "openrouter".into(),
        variant: Some("deep".into()),
        profile: Some("acct".into()),
    }
    .reference()
    .unwrap()
    .unwrap();
    assert_eq!(
        reference,
        ycoding_schema::model::Ref::decode(
            &ycoding_schema::parse_json(
                r#"{"id":"vendor/model-x","providerID":"openrouter","variant":"deep","profile":"acct"}"#
            )
            .unwrap()
        )
        .unwrap()
    );
    let bare = AnalysisModel::Explicit {
        id: "m".into(),
        provider_id: "p".into(),
        variant: None,
        profile: None,
    }
    .reference()
    .unwrap()
    .unwrap();
    assert_eq!((bare.variant, bare.profile), (None, None));
}

#[test]
fn model_selection_replaces_only_the_model() {
    let config =
        TranscriptionConfig::parse(&json!({ "chunkSeconds": 5, "overlapSeconds": 1 })).unwrap();
    let replaced = config.with_model("openai/whisper-large-v3");
    assert_eq!(replaced.model, "openai/whisper-large-v3");
    assert_eq!((replaced.chunk_seconds, replaced.overlap_seconds), (5, 1));
    assert_eq!(replaced.cache_dir, config.cache_dir);
}
