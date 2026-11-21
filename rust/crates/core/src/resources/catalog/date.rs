use chrono::{Days, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, Offset, TimeZone};

pub(super) fn parse(input: &str) -> Option<f64> {
    if let Some(index) = input.find(['T', 't'])
        && let Some(date) = iso_date(&input[..index])
    {
        let (clock, offset) = zone(&input[index + 1..], true)?;
        let time = clock_time(clock, true)?;
        return finish(date, time, offset);
    }
    if input == input.trim() {
        let date = input.strip_suffix(['Z', 'z']).unwrap_or(input);
        if let Some(date) = iso_date(date) {
            return finish(date, 0, Some(0));
        }
    }
    legacy(input)
}
fn iso_date(input: &str) -> Option<(i64, u32, u32)> {
    let length = if input.starts_with(['+', '-']) { 7 } else { 4 };
    let year = input.get(..length)?;
    if !year
        .trim_start_matches(['+', '-'])
        .bytes()
        .all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let year = year.parse::<i64>().ok()?;
    let rest = input.get(length..)?;
    if rest.is_empty() {
        return Some((year, 1, 1));
    }
    let values = rest.strip_prefix('-')?.split('-').collect::<Vec<_>>();
    if !(1..=2).contains(&values.len())
        || values
            .iter()
            .any(|v| v.len() != 2 || !v.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some((
        year,
        values[0].parse().ok()?,
        values.get(1).map(|v| v.parse().ok()).unwrap_or(Some(1))?,
    ))
}
fn finish(date: (i64, u32, u32), clock: i64, offset: Option<i32>) -> Option<f64> {
    let (year, month, day) = date;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if let Some(offset) = offset {
        let y = i128::from(year) - i128::from(month <= 2);
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let m = i128::from(month) + if month > 2 { -3 } else { 9 };
        let doy = (153 * m + 2) / 5 + i128::from(day) - 1;
        let millis = (era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468) * 86400000
            + i128::from(clock)
            - i128::from(offset) * 60000;
        return (millis.abs() <= 8640000000000000).then_some(millis as f64);
    }
    let naive = NaiveDate::from_ymd_opt(i32::try_from(year).ok()?, month, 1)?
        .checked_add_days(Days::new(u64::from(day - 1)))?
        .and_hms_opt(0, 0, 0)?
        .checked_add_signed(Duration::milliseconds(clock))?;
    local_millis(naive).map(|value| value as f64)
}
pub(crate) fn local_millis(value: NaiveDateTime) -> Option<i64> {
    match Local.from_local_datetime(&value) {
        LocalResult::Single(date) => Some(date.timestamp_millis()),
        LocalResult::Ambiguous(first, second) => {
            Some(first.timestamp_millis().min(second.timestamp_millis()))
        }
        LocalResult::None => {
            let before = value.checked_sub_signed(Duration::days(1))?;
            let offset = Local
                .from_local_datetime(&before)
                .earliest()?
                .offset()
                .fix()
                .local_minus_utc();
            value
                .and_utc()
                .timestamp_millis()
                .checked_sub(i64::from(offset) * 1000)
        }
    }
}
pub(crate) fn day_bounds(now: i64) -> Option<(i64, i64)> {
    let today = Local.timestamp_millis_opt(now).single()?.date_naive();
    let tomorrow = today.checked_add_days(Days::new(1))?;
    Some((
        local_millis(today.and_hms_opt(0, 0, 0)?)?,
        local_millis(tomorrow.and_hms_opt(0, 0, 0)?)?,
    ))
}
fn zone(input: &str, iso: bool) -> Option<(&str, Option<i32>)> {
    if let Some(clock) = input.strip_suffix(['Z', 'z']) {
        return Some((clock, Some(0)));
    }
    if let Some(index) = input.find(['+', '-']) {
        return Some((&input[..index], Some(offset(&input[index..])?)));
    }
    if iso {
        return Some((input, None));
    }
    None
}
fn offset(value: &str) -> Option<i32> {
    let sign = match value.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let value = value[1..].replace(':', "");
    if value.len() != 4 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hour = value[..2].parse::<i32>().ok()?;
    let minute = value[2..].parse::<i32>().ok()?;
    (hour <= 23 && minute <= 59).then_some(sign * (hour * 60 + minute))
}
fn clock_time(value: &str, iso: bool) -> Option<i64> {
    let parts = value.split(':').collect::<Vec<_>>();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    if iso && parts[..2].iter().any(|part| part.len() != 2) {
        return None;
    }
    if parts[..2]
        .iter()
        .any(|p| !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let hour = parts[0].parse::<u32>().ok()?;
    let minute = parts[1].parse::<u32>().ok()?;
    let seconds = parts.get(2).copied().unwrap_or("00");
    let (seconds, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    if (iso && seconds.len() != 2)
        || !seconds.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let second = seconds.parse::<u32>().ok()?;
    let millis = if fraction.is_empty() {
        0
    } else {
        format!("{:0<3}", fraction.chars().take(3).collect::<String>())
            .parse::<u32>()
            .ok()?
    };
    if hour > 24
        || minute > 59
        || second > 59
        || (hour == 24 && (minute != 0 || second != 0 || millis != 0))
    {
        return None;
    }
    Some(i64::from(
        (hour * 3600 + minute * 60 + second) * 1000 + millis,
    ))
}
fn legacy(input: &str) -> Option<f64> {
    let mut depth = 0_u32;
    let mut clean = String::new();
    for c in input.chars() {
        if c == '(' {
            depth += 1;
            continue;
        }
        if c == ')' {
            depth = depth.checked_sub(1)?;
            clean.push(' ');
            continue;
        }
        if depth == 0 {
            clean.push(if c == ',' { ' ' } else { c });
        }
    }
    if depth != 0 {
        return None;
    }
    let mut tokens = clean.split_whitespace().collect::<Vec<_>>();
    let mut offset_value = None;
    let mut clock = 0_i64;
    if let Some(last) = tokens.last().copied() {
        let lower = last.to_ascii_lowercase();
        let known = match lower.as_str() {
            "gmt" | "utc" | "ut" | "z" => Some(0),
            "est" => Some(-300),
            "edt" => Some(-240),
            "cst" => Some(-360),
            "cdt" => Some(-300),
            "mst" => Some(-420),
            "mdt" => Some(-360),
            "pst" => Some(-480),
            "pdt" => Some(-420),
            _ => None,
        };
        if let Some(offset) = known {
            offset_value = Some(offset);
            tokens.pop();
        } else if lower.starts_with("gmt") && lower.len() > 3 {
            offset_value = Some(offset(&last[3..])?);
            tokens.pop();
        } else if last.starts_with(['+', '-']) && last.len() >= 5 {
            offset_value = Some(offset(last)?);
            tokens.pop();
        }
    }
    let meridian = tokens
        .last()
        .copied()
        .filter(|token| token.eq_ignore_ascii_case("am") || token.eq_ignore_ascii_case("pm"));
    if meridian.is_some() {
        tokens.pop();
    }
    if let Some(index) = tokens.iter().position(|token| token.contains(':')) {
        clock = clock_time(tokens.remove(index), false)?;
        if let Some(meridian) = meridian {
            let hour = clock / 3600000;
            if hour > 12 {
                return None;
            }
            clock = clock % 3600000
                + (if meridian.eq_ignore_ascii_case("pm") {
                    hour % 12 + 12
                } else {
                    hour % 12
                }) * 3600000;
        }
    } else if meridian.is_some() {
        return None;
    }
    tokens.retain(|token| {
        !["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
            .iter()
            .any(|day| {
                token
                    .get(..3)
                    .is_some_and(|part| part.eq_ignore_ascii_case(day))
            })
    });
    let months = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let month_word = tokens.iter().enumerate().find_map(|(index, token)| {
        months
            .iter()
            .position(|month| {
                token
                    .get(..3)
                    .is_some_and(|part| part.eq_ignore_ascii_case(month))
            })
            .map(|month| (index, month as u32 + 1))
    });
    let date = if let Some((index, month)) = month_word {
        tokens.remove(index);
        let numbers = tokens
            .iter()
            .map(|v| v.parse::<i64>().ok())
            .collect::<Option<Vec<_>>>()?;
        if numbers.len() != 2 {
            return None;
        }
        if numbers[0] > 31 {
            (year(numbers[0]), month, u32::try_from(numbers[1]).ok()?)
        } else {
            (year(numbers[1]), month, u32::try_from(numbers[0]).ok()?)
        }
    } else {
        if tokens.len() != 1 {
            return None;
        }
        let numbers = tokens[0]
            .split(['-', '/', '.'])
            .map(|v| v.parse::<i64>().ok())
            .collect::<Option<Vec<_>>>()?;
        match numbers.as_slice() {
            [value] if (1..=12).contains(value) => (2001, *value as u32, 1),
            [0] => (2000, 1, 1),
            [value] if *value >= 32 => (year(*value), 1, 1),
            [first, month] if *first >= 32 => (year(*first), u32::try_from(*month).ok()?, 1),
            [month, day] if (1..=12).contains(month) => {
                (2001, *month as u32, u32::try_from(*day).ok()?)
            }
            [first, month, day] if *first >= 32 => (
                year(*first),
                u32::try_from(*month).ok()?,
                u32::try_from(*day).ok()?,
            ),
            [month, day, last] if (1..=12).contains(month) => {
                (year(*last), *month as u32, u32::try_from(*day).ok()?)
            }
            _ => return None,
        }
    };
    finish(date, clock, offset_value)
}
fn year(value: i64) -> i64 {
    if (0..50).contains(&value) {
        return value + 2000;
    }
    if (50..100).contains(&value) {
        return value + 1900;
    }
    value
}
