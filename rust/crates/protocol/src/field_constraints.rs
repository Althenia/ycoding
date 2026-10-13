#[derive(Debug, Default)]
pub struct Constraints {
    pub integer_min: Option<i128>,
    pub integer_max: Option<i128>,
    pub utf16_min: Option<u64>,
    pub utf16_max: Option<u64>,
    pub codepoints_min: Option<u64>,
    pub codepoints_max: Option<u64>,
    pub utf8_bytes_min: Option<u64>,
    pub utf8_bytes_max: Option<u64>,
    pub count_min: Option<u64>,
    pub count_max: Option<u64>,
}

pub fn validate_constraints(
    rule: &Constraints,
    integer: Option<i128>,
    units: Option<&[u16]>,
    count: Option<usize>,
) -> Result<(), &'static str> {
    let bounded = |value: u64, min: Option<u64>, max: Option<u64>| {
        min.is_some_and(|min| value < min) || max.is_some_and(|max| value > max)
    };
    if integer.is_some_and(|value| {
        rule.integer_min.is_some_and(|min| value < min)
            || rule.integer_max.is_some_and(|max| value > max)
    }) {
        return Err("integer constraint");
    }
    if count.is_some_and(|count| bounded(count as u64, rule.count_min, rule.count_max)) {
        return Err("count constraint");
    }
    if let Some(units) = units {
        let points: Vec<_> = char::decode_utf16(units.iter().copied())
            .map(|value| value.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect();
        if bounded(units.len() as u64, rule.utf16_min, rule.utf16_max)
            || bounded(
                points.len() as u64,
                rule.codepoints_min,
                rule.codepoints_max,
            )
            || bounded(
                points.iter().map(|char| char.len_utf8() as u64).sum(),
                rule.utf8_bytes_min,
                rule.utf8_bytes_max,
            )
        {
            return Err("text constraint");
        }
    }
    Ok(())
}
