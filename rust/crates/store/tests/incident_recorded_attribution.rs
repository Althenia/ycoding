use ycoding_schema::{LosslessString, parse_json};
use ycoding_store::{
    Metadata, Options, Store, TableSpec,
    model_incident::{Incident, IncidentTable},
    native::{self, DatabaseKind},
    session::Document,
};

fn row(label: &str) -> Incident {
    Incident {
        id: format!("inc_{label}").into(),
        time_created: 1,
        kind: "guardrail-rejected".into(),
        provider_id: "synthetic".into(),
        model_id: "test".into(),
        variant: None,
        profile: None,
        agent: "build".into(),
        project_id: "prj_test".into(),
        session_id: "ses_test".into(),
        request_id: Some("grq_test".into()),
        category: "ordinary".into(),
        rule_ids: Document::new(parse_json("[]").unwrap()).unwrap(),
        target: None,
        decided_by: Some(label.into()),
    }
}

#[test]
fn physical_rows_preserve_recorded_attribution_without_relabeling() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(DatabaseKind::Core),
        Metadata::new([42; 16], 1),
    )
    .unwrap();
    for label in ["human", "client", "decision-model"] {
        let original = row(label);
        let bytes = IncidentTable::encode(&original).unwrap();
        assert_eq!(bytes[0], 1);
        assert_eq!(IncidentTable::decode(&bytes).unwrap(), original);
        let record = original.clone();
        store
            .submit(move |tx| IncidentTable::insert(tx, &record))
            .unwrap()
            .wait()
            .unwrap();
        let loaded = store
            .snapshot()
            .unwrap()
            .get::<IncidentTable>(&IncidentTable::primary_key(&original))
            .unwrap()
            .unwrap();
        assert_eq!(loaded.decided_by, Some(LosslessString::from(label)));
        assert_eq!(IncidentTable::encode(&loaded).unwrap(), bytes);
    }
}

#[test]
fn physical_rows_reject_unknown_or_misplaced_attribution() {
    for label in ["", "other", "Human", "CLIENT"] {
        assert!(IncidentTable::encode(&row(label)).is_err());
    }
    for kind in ["guardrail-escalated", "fallback"] {
        let mut record = row("client");
        record.kind = kind.into();
        record.decided_by = None;
        if kind == "fallback" {
            record.request_id = None;
            record.target = Some(
                Document::new(parse_json(r#"{"providerID":"synthetic","id":"other"}"#).unwrap())
                    .unwrap(),
            );
            record.category = "rate_limit".into();
        }
        assert!(IncidentTable::encode(&record).is_ok());
        record.decided_by = Some("client".into());
        assert!(IncidentTable::encode(&record).is_err());
    }
}
