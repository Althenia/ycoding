use ycoding_schema::LosslessString;

pub(super) fn uri(value: &LosslessString) -> bool {
    let scalar = String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>());
    url::Url::parse(&scalar).is_ok()
}
pub(super) fn date(value: &LosslessString) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 10
            && value.as_bytes()[4] == b'-'
            && value.as_bytes()[7] == b'-'
            && value
                .bytes()
                .enumerate()
                .all(|(index, unit)| matches!(index, 4 | 7) || unit.is_ascii_digit())
            && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
    })
}
pub(super) fn date_time(value: &LosslessString) -> bool {
    let input = String::from_utf16_lossy(
        &value
            .code_units()
            .take_while(|unit| *unit != 0)
            .collect::<Vec<_>>(),
    );
    let pattern = r"^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-]\d{2}:?\d{2})?)?$";
    let matched = crate::regexp::RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "")
        .expect("static date pattern")
        .exec(
            &input.encode_utf16().collect::<Vec<_>>(),
            &mut crate::regexp::Budget::unlimited(),
        )
        .expect("unlimited date pattern");
    if let Some(matched) = matched {
        let capture = |index: usize| {
            matched.captures[index]
                .as_ref()
                .map(|value| String::from_utf16_lossy(value))
        };
        let number = |index: usize, default: i64| {
            capture(index)
                .and_then(|value| value.parse().ok())
                .unwrap_or(default)
        };
        if capture(1).as_deref() != Some("-000000") {
            let timezone = capture(8).map(|value| offset(&value)).unwrap_or(Some(0));
            return timezone.is_some_and(|offset| {
                valid(
                    [number(1, 0), number(2, 1), number(3, 1)],
                    (
                        number(4, 0),
                        number(5, 0),
                        number(6, 0),
                        capture(7).map_or(0.0, |value| fraction(&value)),
                        capture(7).is_some_and(|value| value.bytes().any(|unit| unit != b'0')),
                    ),
                    i128::from(offset),
                )
            });
        }
    }
    let mut prefix = true;
    let mut digit = false;
    for unit in input.chars() {
        if matches!(unit, 'T' | 't') && prefix && digit {
            return false;
        }
        digit |= unit.is_ascii_digit();
        if !unit.is_ascii_digit() && !matches!(unit, '+' | '-') {
            prefix = false;
        }
    }
    legacy(&input)
}

fn valid(date: [i64; 3], clock: (i64, i64, i64, f64, bool), offset: i128) -> bool {
    let [year, month, day] = date;
    let (hour, minute, second, millisecond, fraction) = clock;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=24).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=59).contains(&second)
        || (hour == 24 && (minute != 0 || second != 0 || fraction))
    {
        return false;
    }
    let year = i128::from(year) - i128::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let adjusted = month + if month > 2 { -3 } else { 9 };
    let days = era * 146097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100
        + i128::from((153 * adjusted + 2) / 5 + day - 1)
        - 719468;
    let milliseconds = days * 86_400_000
        + i128::from(hour * 3_600_000 + minute * 60_000 + second * 1_000)
        - offset * 60_000;
    (milliseconds as f64 + millisecond).abs() <= 8_640_000_000_000_000.0
}

fn fraction(digits: &str) -> f64 {
    format!("0.{digits}")
        .parse::<f64>()
        .expect("validated fraction digits")
        * 1000.0
}

fn offset(value: &str) -> Option<i64> {
    if value.eq_ignore_ascii_case("z") {
        return Some(0);
    }
    let sign = if value.starts_with('-') { -1 } else { 1 };
    let value = value.get(1..)?.replace(':', "");
    if value.len() != 4 || !value.bytes().all(|unit| unit.is_ascii_digit()) {
        return None;
    }
    let hour = value[..2].parse::<i64>().ok()?;
    let minute = value[2..].parse::<i64>().ok()?;
    (hour <= 23 && minute <= 59).then_some(sign * (hour * 60 + minute))
}

fn legacy(input: &str) -> bool {
    let iso_prefix = crate::regexp::RegExp::new(
        &r"^[+-]?\d{4,}-\d{2}-\d{2}"
            .encode_utf16()
            .collect::<Vec<_>>(),
        "",
    )
    .expect("static date prefix")
    .test(
        &input.encode_utf16().collect::<Vec<_>>(),
        &mut crate::regexp::Budget::unlimited(),
    )
    .expect("unlimited date prefix");
    let mut plain = String::new();
    let mut nesting = 0usize;
    for character in input.chars() {
        if character == '(' {
            nesting += 1;
            continue;
        }
        if character == ')' && nesting > 0 {
            nesting -= 1;
            continue;
        }
        if nesting == 0 {
            plain.push(character);
        }
    }
    let input = plain.as_bytes();
    let mut numbers = vec![];
    let mut month = None;
    let mut clock = None;
    let mut zone = None;
    let mut meridiem = None;
    let mut index = 0;
    while index < input.len() {
        let unit = input[index];
        if unit.is_ascii_digit() {
            let start = index;
            while input.get(index).is_some_and(u8::is_ascii_digit) {
                index += 1;
            }
            let Some(number) = std::str::from_utf8(&input[start..index])
                .ok()
                .and_then(|value| value.parse::<i64>().ok())
            else {
                return false;
            };
            if input.get(index) == Some(&b':') {
                if clock.is_some() {
                    return false;
                }
                index += 1;
                let Some(minute) = read_number(input, &mut index) else {
                    return false;
                };
                let has_seconds = input.get(index) == Some(&b':');
                let second = if has_seconds {
                    index += 1;
                    let Some(second) = read_number(input, &mut index) else {
                        return false;
                    };
                    second
                } else {
                    0
                };
                let (millisecond, fraction) = if input.get(index) == Some(&b'.') {
                    if !has_seconds {
                        return false;
                    }
                    index += 1;
                    let start = index;
                    while input.get(index).is_some_and(u8::is_ascii_digit) {
                        index += 1;
                    }
                    if index == start {
                        return false;
                    }
                    (
                        self::fraction(
                            std::str::from_utf8(&input[start..index]).expect("fraction digits"),
                        ),
                        input[start..index].iter().any(|unit| *unit != b'0'),
                    )
                } else {
                    (0.0, false)
                };
                clock = Some((number, minute, second, millisecond, fraction));
                continue;
            }
            if clock.is_some() && numbers.len() >= 3 {
                return false;
            }
            numbers.push(number);
            if numbers.len() > 3 {
                return false;
            }
            if input.get(index) == Some(&b'-') {
                if iso_prefix && index + 1 == input.len() {
                    return false;
                }
                index += 1;
            }
            continue;
        }
        if unit.is_ascii_alphabetic() {
            let start = index;
            while input.get(index).is_some_and(u8::is_ascii_alphabetic) {
                index += 1;
            }
            let word = String::from_utf8_lossy(&input[start..index]).to_ascii_lowercase();
            let prefix = &word[..word.len().min(3)];
            if let Some(selected) = [
                "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
            ]
            .iter()
            .position(|month| *month == prefix)
            {
                month = Some(selected as i64 + 1);
                continue;
            }
            if word == "am" || word == "pm" {
                if meridiem.is_some() || clock.is_none() {
                    return false;
                }
                meridiem = Some(word == "pm");
                continue;
            }
            if let Some(offset) = match word.as_str() {
                "ut" | "utc" | "gmt" | "z" => Some(0),
                "est" => Some(-300),
                "edt" => Some(-240),
                "cst" => Some(-360),
                "cdt" => Some(-300),
                "mst" => Some(-420),
                "mdt" => Some(-360),
                "pst" => Some(-480),
                "pdt" => Some(-420),
                _ => None,
            } {
                zone = Some(offset);
                continue;
            }
            if !numbers.is_empty() || clock.is_some() {
                return false;
            }
            continue;
        }
        if matches!(unit, b'+' | b'-')
            && (clock.is_some() || zone.is_some())
            && input.get(index + 1).is_some_and(u8::is_ascii_digit)
        {
            let sign = if unit == b'-' { -1 } else { 1 };
            index += 1;
            let start = index;
            let Some(value) = read_number(input, &mut index) else {
                return false;
            };
            let length = index - start;
            let (hour, minute) = if input.get(index) == Some(&b':') {
                index += 1;
                let Some(minute) = read_number(input, &mut index) else {
                    return false;
                };
                (value, minute)
            } else if length <= 2 {
                (value, 0)
            } else if length <= 4 {
                (value / 100, value % 100)
            } else {
                return false;
            };
            if hour
                > if month.is_some() || zone.is_some() {
                    9959
                } else {
                    23
                }
                || (month.is_none() && minute > 59)
            {
                return false;
            }
            zone = Some(i128::from(sign) * (i128::from(hour) * 60 + i128::from(minute)));
            continue;
        }
        if matches!(unit, b'+' | b'-') {
            if !numbers.is_empty() || clock.is_some() {
                return false;
            }
            index += 1;
            continue;
        }
        if matches!(
            unit,
            b'/' | b',' | b'.' | b' ' | b'\t' | b'\r' | b'\n' | b'\x0b' | b'\x0c'
        ) {
            index += 1;
            continue;
        }
        let Some(character) = plain[index..].chars().next() else {
            return false;
        };
        if crate::process::guardrails::is_whitespace(character as u16) || numbers.is_empty() {
            index += character.len_utf8();
            continue;
        }
        return false;
    }
    if numbers.is_empty() {
        return false;
    }
    let (year, month, day) = if let Some(month) = month {
        if !(1..=31).contains(&numbers[0]) {
            (numbers[0], month, numbers.get(1).copied().unwrap_or(1))
        } else {
            (numbers.get(1).copied().unwrap_or(2001), month, numbers[0])
        }
    } else if !(1..=31).contains(&numbers[0]) {
        (
            numbers[0],
            numbers.get(1).copied().unwrap_or(1),
            numbers.get(2).copied().unwrap_or(1),
        )
    } else {
        (
            numbers.get(2).copied().unwrap_or(2001),
            numbers[0],
            numbers.get(1).copied().unwrap_or(1),
        )
    };
    let year = if (0..=49).contains(&year) {
        year + 2000
    } else if (50..=99).contains(&year) {
        year + 1900
    } else {
        year
    };
    let (hour, minute, second, millisecond, fraction) = clock.unwrap_or((0, 0, 0, 0.0, false));
    let hour = if let Some(pm) = meridiem {
        if hour > 12 {
            return false;
        }
        if pm {
            if hour == 12 { 12 } else { hour + 12 }
        } else if hour == 12 {
            0
        } else {
            hour
        }
    } else {
        hour
    };
    valid(
        [year, month, day],
        (hour, minute, second, millisecond, fraction),
        zone.unwrap_or(0),
    )
}

fn read_number(input: &[u8], index: &mut usize) -> Option<i64> {
    let start = *index;
    while input.get(*index).is_some_and(u8::is_ascii_digit) {
        *index += 1;
    }
    std::str::from_utf8(&input[start..*index])
        .ok()?
        .parse()
        .ok()
}
