pub(crate) fn rank<'a>(
    rows: impl Iterator<Item = (usize, &'a str, f64)>,
    limit: usize,
) -> Vec<(usize, f64)> {
    let mut hits = rows
        .filter(|(_, _, score)| score.is_finite() && *score > 0.0)
        .collect::<Vec<_>>();
    hits.sort_unstable_by(|a, b| b.2.total_cmp(&a.2).then_with(|| a.1.cmp(b.1)));
    hits.into_iter()
        .take(limit)
        .map(|(index, _, score)| (index, score))
        .collect()
}
