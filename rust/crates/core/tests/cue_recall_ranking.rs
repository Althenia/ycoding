#[path = "../src/resources/recall/ranking.rs"]
mod ranking;

#[test]
fn bm25_preserves_raw_scores_and_applies_the_limit_after_stable_ties() {
    let rows = [
        (0, "b", 2.0),
        (1, "a", 2.0),
        (2, "weak", 0.01),
        (3, "absent", 0.0),
        (4, "invalid", f64::NAN),
    ];
    assert_eq!(
        ranking::rank(rows.into_iter(), 50),
        [(1, 2.0), (0, 2.0), (2, 0.01)]
    );
    assert_eq!(ranking::rank(rows.into_iter(), 1), [(1, 2.0)]);
}
