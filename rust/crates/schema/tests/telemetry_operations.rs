use std::collections::BTreeSet;
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, telemetry::Operation};

const PLATFORM_PROTO: &str = include_str!("../../../../protocol/ycoding/v5/platform.proto");
const PREFIX: &str = "TELEMETRY_REQUESTSAMPLE_OPERATION_";
const LABEL_OPTION: &str = "(ycoding.v5.domain_label) = \"";

#[test]
fn every_wire_operation_round_trips_through_the_canonical_schema() {
    let labels: BTreeSet<_> = PLATFORM_PROTO
        .lines()
        .filter(|line| line.trim_start().starts_with(PREFIX))
        .map(|line| {
            line.split(LABEL_OPTION)
                .nth(1)
                .unwrap()
                .split('"')
                .next()
                .unwrap()
        })
        .collect();
    assert_eq!(labels, Operation::LABELS.iter().copied().collect());
    for label in labels {
        let value = JsonValue::String(label.into());
        let operation = Operation::decode(&value).unwrap();
        assert_eq!(operation.as_str(), label);
        assert_eq!(operation.encode(), value);
    }
}

#[test]
fn current_operations_reject_retired_requests() {
    for label in [
        "artifact.demo.export",
        "local.app.list",
        "session.dots.send",
    ] {
        assert!(Operation::decode(&JsonValue::String(label.into())).is_err());
    }
}
