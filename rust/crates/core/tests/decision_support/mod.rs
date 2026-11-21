#![allow(dead_code)]

use ycoding_core::session::autonomy::{DecisionChange, DecisionMode, Service, State};
use ycoding_schema::session;

pub async fn permissions(service: &Service, id: &session::Id, mode: DecisionMode) -> State {
    service
        .set_decisions(id, DecisionChange::new(Some(mode), None, None).unwrap())
        .await
        .unwrap()
}

pub async fn guardrails(service: &Service, id: &session::Id, mode: DecisionMode) -> State {
    service
        .set_decisions(id, DecisionChange::new(None, Some(mode), None).unwrap())
        .await
        .unwrap()
}

pub async fn answers(service: &Service, id: &session::Id, mode: DecisionMode) -> State {
    service
        .set_decisions(id, DecisionChange::new(None, None, Some(mode)).unwrap())
        .await
        .unwrap()
}

pub fn auto(enabled: bool) -> DecisionMode {
    if enabled {
        DecisionMode::Auto
    } else {
        DecisionMode::Manual
    }
}

pub fn yolo(enabled: bool) -> DecisionMode {
    if enabled {
        DecisionMode::Yolo
    } else {
        DecisionMode::Manual
    }
}
