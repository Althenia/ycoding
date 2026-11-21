use super::*;
use ycoding_core::resources::account_connectors::skills_read::{DetailProof, Proof};

#[test]
fn account_skills_proof_keeps_populated_optional_metadata_and_omits_empty_detail() {
    let proof = account_skills_proof(Proof {
        status: 200,
        keys: vec!["hazelnuts".into()],
        count: 0,
        has_next: false,
        pagination_keys: vec![],
        detail: None,
    })
    .unwrap();
    assert_eq!(proof.status, 200);
    assert_eq!(proof.count, Some(0));
    assert_eq!(proof.has_next, Some(false));
    assert!(proof.pagination_keys.unwrap().items.is_empty());
    assert!(proof.detail.is_none());
    assert_eq!(
        convert::domain(&proof.keys.items[0]).unwrap(),
        ycoding_core::ycoding_schema::LosslessString::from("hazelnuts")
    );
}

#[test]
fn account_skills_proof_converts_detail_without_adding_private_fields() {
    let proof = account_skills_proof(Proof {
        status: 206,
        keys: vec!["hazelnuts".into(), "next_cursor".into()],
        count: 2,
        has_next: true,
        pagination_keys: vec!["next_cursor".into()],
        detail: Some(DetailProof {
            status: 200,
            keys: vec!["id".into(), "permissions".into()],
        }),
    })
    .unwrap();
    assert_eq!(proof.status, 206);
    assert_eq!(proof.count, Some(2));
    assert_eq!(proof.has_next, Some(true));
    let detail = proof.detail.unwrap();
    assert_eq!(detail.status, 200);
    assert_eq!(detail.keys.items.len(), 2);
    assert_eq!(
        convert::domain(&detail.keys.items[0]).unwrap(),
        ycoding_core::ycoding_schema::LosslessString::from("id")
    );
}
