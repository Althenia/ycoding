use super::super::evaluator::Vm;
use super::super::program::Position;
use super::super::values::{Fault, Heap, Value};
use chrono::{Local, Offset, TimeZone};

pub(crate) fn iso(time: f64) -> Option<String> {
    if !time.is_finite() {
        return None;
    }
    let parts = parts(time);
    let year = if (0..=9999).contains(&parts[0]) {
        format!("{:04}", parts[0])
    } else {
        format!(
            "{}{:06}",
            if parts[0] < 0 { "-" } else { "+" },
            parts[0].abs()
        )
    };
    Some(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        parts[1] + 1,
        parts[2],
        parts[3],
        parts[4],
        parts[5],
        parts[6]
    ))
}

fn clip(time: f64) -> f64 {
    if !time.is_finite() || time.abs() > 8.64e15 {
        f64::NAN
    } else if time == 0.0 {
        0.0
    } else {
        time.trunc()
    }
}
fn offset(time: f64) -> Option<i64> {
    Local
        .timestamp_millis_opt(time as i64)
        .single()
        .map(|date| date.offset().fix().local_minus_utc() as i64 * 1000)
}
fn local(time: f64) -> f64 {
    if !time.is_finite() {
        return f64::NAN;
    }
    offset(time).map_or(f64::NAN, |offset| time + offset as f64)
}
fn utc(time: f64) -> f64 {
    if !time.is_finite() {
        return f64::NAN;
    }
    let Some(date) = chrono::DateTime::from_timestamp_millis(time as i64) else {
        return f64::NAN;
    };
    let wall = date.naive_utc();
    if let Some(date) = Local.from_local_datetime(&wall).earliest() {
        return date.timestamp_millis() as f64;
    }
    let before = offset(time - 86_400_000.0);
    let after = offset(time + 86_400_000.0);
    match (before, after) {
        (Some(before), Some(after)) if after > before => time - before as f64,
        _ => f64::NAN,
    }
}

fn parts(time: f64) -> [i64; 7] {
    let milliseconds = time as i64;
    let days = milliseconds.div_euclid(86_400_000);
    let clock = milliseconds.rem_euclid(86_400_000);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    [
        year,
        month - 1,
        day,
        clock / 3_600_000,
        clock / 60_000 % 60,
        clock / 1000 % 60,
        clock % 1000,
    ]
}

fn make(values: [f64; 7]) -> f64 {
    if values.iter().any(|value| !value.is_finite()) {
        return f64::NAN;
    }
    let mut year = values[0].trunc() as i128;
    let month = values[1].trunc() as i128;
    year = match year.checked_add(month.div_euclid(12)) {
        Some(year) => year,
        None => return f64::NAN,
    };
    let month = month.rem_euclid(12) + 1;
    year -= i128::from(month <= 2);
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * month + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let Some(days) = era
        .checked_mul(146097)
        .and_then(|days| days.checked_add(doe - 719468))
        .and_then(|days| days.checked_add(values[2].trunc() as i128 - 1))
    else {
        return f64::NAN;
    };
    days as f64 * 86_400_000.0
        + values[3].trunc() * 3_600_000.0
        + values[4].trunc() * 60_000.0
        + values[5].trunc() * 1000.0
        + values[6].trunc()
}

fn parse(text: &str) -> f64 {
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(text) {
        return clip(date.timestamp_millis() as f64);
    }
    if let Ok(date) = chrono::DateTime::parse_from_rfc2822(text) {
        return clip(date.timestamp_millis() as f64);
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
        && let Some(date) = date.and_hms_opt(0, 0, 0)
    {
        return clip(date.and_utc().timestamp_millis() as f64);
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S%.f",
    ] {
        if let Ok(date) = chrono::NaiveDateTime::parse_from_str(text, format) {
            return clip(utc(date.and_utc().timestamp_millis() as f64));
        }
    }
    f64::NAN
}

pub(crate) async fn construct(
    vm: &Vm,
    args: Vec<Value>,
    construct: bool,
    location: &Position,
) -> Result<Value, Fault> {
    if !construct {
        return Ok(Value::String(
            iso(chrono::Utc::now().timestamp_millis() as f64)
                .ok_or_else(|| Fault::error("RangeError", "Invalid time value.", location))?
                .into(),
        ));
    }
    let time = if args.is_empty() {
        chrono::Utc::now().timestamp_millis() as f64
    } else if args.len() == 1 {
        if let Value::Date(id) = args[0] {
            let state = vm.state();
            let Heap::Date(time) = state.heap[id] else {
                return Err(Fault::data("Invalid Date."));
            };
            time
        } else {
            let value = vm.date_primitive(args[0].clone(), location).await?;
            if let Value::String(text) = value {
                text.as_str().map_or(f64::NAN, parse)
            } else {
                clip(vm.state().number(&value)?)
            }
        }
    } else {
        let mut values = [0.0; 7];
        values[2] = 1.0;
        for (index, value) in args.iter().enumerate() {
            let number = vm.state().number(value)?;
            if index < 7 {
                values[index] = number;
            }
        }
        if (0.0..=99.0).contains(&values[0].trunc()) {
            values[0] = values[0].trunc() + 1900.0;
        }
        clip(utc(make(values)))
    };
    Ok(Value::Date(vm.state().allocate(Heap::Date(time))))
}

pub(crate) fn static_method(
    vm: &Vm,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let time = match name {
        "now" => chrono::Utc::now().timestamp_millis() as f64,
        "parse" => {
            let text = vm.state().text(args.first().unwrap_or(&Value::Undefined))?;
            text.as_str().map_or(f64::NAN, parse)
        }
        "UTC" => {
            let mut values = [0.0; 7];
            values[0] = f64::NAN;
            values[2] = 1.0;
            for (index, value) in args.iter().enumerate() {
                let value = vm.state().number(value)?;
                if index < 7 {
                    values[index] = value;
                }
            }
            if (0.0..=99.0).contains(&values[0].trunc()) {
                values[0] = values[0].trunc() + 1900.0;
            }
            clip(make(values))
        }
        _ => {
            return Err(Fault::error(
                "TypeError",
                format!("Date.{name} is not available in CodeMode."),
                location,
            ));
        }
    };
    Ok(Value::Number(time))
}

pub(crate) async fn method(
    vm: &Vm,
    id: usize,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let initial = {
        let state = vm.state();
        let Heap::Date(time) = state.heap[id] else {
            return Err(Fault::data("Invalid Date."));
        };
        time
    };
    if name.starts_with("set") {
        let utc_mode = name.starts_with("setUTC");
        let field = name
            .strip_prefix("setUTC")
            .or_else(|| name.strip_prefix("set"))
            .unwrap_or_default();
        let (index, count) = match field {
            "Time" => (0, 1),
            "FullYear" => (0, 3),
            "Month" => (1, 2),
            "Date" => (2, 1),
            "Hours" => (3, 4),
            "Minutes" => (4, 3),
            "Seconds" => (5, 2),
            "Milliseconds" => (6, 1),
            _ => {
                return Err(Fault::error(
                    "TypeError",
                    format!("Date method '{name}' is not available in CodeMode."),
                    location,
                ));
            }
        };
        let mut numbers = Vec::new();
        for value in args.into_iter().take(count) {
            numbers.push(vm.numeric_argument(value, location).await?);
        }
        if numbers.is_empty() {
            numbers.push(f64::NAN)
        }
        let value = if field == "Time" {
            clip(numbers[0])
        } else if !initial.is_finite() && field != "FullYear" {
            f64::NAN
        } else {
            let time = if !initial.is_finite() {
                0.0
            } else if utc_mode {
                initial
            } else {
                local(initial)
            };
            if !time.is_finite() {
                f64::NAN
            } else {
                let mut values = parts(time).map(|value| value as f64);
                for (offset, value) in numbers.into_iter().enumerate() {
                    values[index + offset] = value;
                }
                let time = make(values);
                clip(if utc_mode { time } else { utc(time) })
            }
        };
        vm.state().heap[id] = Heap::Date(value);
        return Ok(Value::Number(value));
    }
    match name {
        "getTime" | "valueOf" => Ok(Value::Number(initial)),
        "toISOString" => Ok(Value::String(
            iso(initial)
                .ok_or_else(|| Fault::error("RangeError", "Invalid time value.", location))?
                .into(),
        )),
        "toJSON" => Ok(iso(initial).map_or(Value::Null, |text| Value::String(text.into()))),
        "toString" => Ok(Value::String(
            iso(initial).unwrap_or_else(|| "Invalid Date".into()).into(),
        )),
        "toUTCString" | "toGMTString" => {
            if !initial.is_finite() {
                return Ok(Value::String("Invalid Date".into()));
            }
            let values = parts(initial);
            let day = (initial as i64).div_euclid(86_400_000);
            let weekday =
                ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][(day + 4).rem_euclid(7) as usize];
            let month = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ][values[1] as usize];
            Ok(Value::String(
                format!(
                    "{weekday}, {:02} {month} {:04} {:02}:{:02}:{:02} GMT",
                    values[2], values[0], values[3], values[4], values[5]
                )
                .into(),
            ))
        }
        "getTimezoneOffset" => Ok(Value::Number(if initial.is_finite() {
            offset(initial).map_or(f64::NAN, |offset| -(offset as f64) / 60_000.0)
        } else {
            f64::NAN
        })),
        _ => {
            let utc_mode = name.starts_with("getUTC");
            let field = name
                .strip_prefix("getUTC")
                .or_else(|| name.strip_prefix("get"))
                .unwrap_or_default();
            let time = if utc_mode { initial } else { local(initial) };
            if !time.is_finite() {
                return Ok(Value::Number(f64::NAN));
            }
            let values = parts(time);
            let value = match field {
                "FullYear" => values[0],
                "Month" => values[1],
                "Date" => values[2],
                "Day" => ((time as i64).div_euclid(86_400_000) + 4).rem_euclid(7),
                "Hours" => values[3],
                "Minutes" => values[4],
                "Seconds" => values[5],
                "Milliseconds" => values[6],
                _ => {
                    return Err(Fault::error(
                        "TypeError",
                        format!("Date method '{name}' is not available in CodeMode."),
                        location,
                    ));
                }
            };
            Ok(Value::Number(value as f64))
        }
    }
}
