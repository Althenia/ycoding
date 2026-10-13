use ycoding_core::resources::catalog::models_dev;
use ycoding_schema::parse_json;

fn released(date: &str) -> f64 {
    let source = r#"{"p":{"id":"p","name":"P","env":[],"models":{"m":{"id":"m","name":"M","release_date":"DATE","attachment":false,"reasoning":false,"tool_call":false,"limit":{"context":1,"output":1}}}}}"#.replace("DATE",date);
    models_dev::normalize(&parse_json(&source).unwrap()).unwrap()[0].models[0]
        .time
        .released
        .get()
}

#[test]
fn bun_date_vectors_in_isolated_timezone_processes() {
    let Ok(tz) = std::env::var("YCODING_DATE_ORACLE_CHILD") else {
        for tz in ["UTC", "America/New_York", "Asia/Bangkok"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "bun_date_vectors_in_isolated_timezone_processes",
                    "--nocapture",
                ])
                .env("TZ", tz)
                .env("YCODING_DATE_ORACLE_CHILD", tz)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    };
    let offset = match tz.as_str() {
        "UTC" => 0.0,
        "America/New_York" => 14400000.0,
        "Asia/Bangkok" => -25200000.0,
        _ => panic!("unexpected timezone"),
    };
    for (date, expected) in [
        ("2026-09-28", 1790553600000.0),
        ("2026-09", 1788220800000.0),
        ("2026", 1767225600000.0),
        ("2026-02-30", 1772409600000.0),
        ("2026-02-29", 1772323200000.0),
        ("2026-13-01", 0.0),
        ("2026-04-31", 1777593600000.0),
        ("Mon, 28 Sep 2026 12:34:56 GMT", 1790598896000.0),
        ("2026-09-28T12:34:56.1239Z", 1790598896123.0),
        ("2026-09-28T24:00:00Z", 1790640000000.0),
        ("2026-09-28T12:34:56+0700", 1790573696000.0),
        ("2026-09-28T12:34:56+07:00", 1790573696000.0),
        ("2026-09-28Z", 1790553600000.0),
        ("+275760-09-13", 8640000000000000.0),
        ("+275760-09-14", 0.0),
        ("2026-09-28T12:34:56 GMT", 0.0),
        ("13", 0.0),
    ] {
        assert_eq!(released(date), expected, "{tz}: {date}");
    }
    for (date, utc) in [
        ("2026-09-28T12:34", 1790598840000.0),
        ("2026-09-28 12:34:56", 1790598896000.0),
        ("September 28, 2026 12:34:56", 1790598896000.0),
        ("09/28/2026", 1790553600000.0),
        ("2026/9/28", 1790553600000.0),
        (" 2026-09-28 ", 1790553600000.0),
        ("09-28-26", 1790553600000.0),
        ("28 Sep 26", 1790553600000.0),
        ("28 September 2026 12:34 PM", 1790598840000.0),
    ] {
        assert_eq!(released(date), utc + offset, "{tz}: {date}");
    }
    let (gap, overlap) = match tz.as_str() {
        "UTC" => (1772937000000.0, 1793496600000.0),
        "America/New_York" => (1772955000000.0, 1793511000000.0),
        "Asia/Bangkok" => (1772911800000.0, 1793471400000.0),
        _ => unreachable!(),
    };
    assert_eq!(released("2026-03-08T02:30:00"), gap);
    assert_eq!(released("2026-11-01T01:30:00"), overlap);
    let (one, year) = match tz.as_str() {
        "UTC" => (978307200000.0, -631152000000.0),
        "America/New_York" => (978325200000.0, -631134000000.0),
        "Asia/Bangkok" => (978282000000.0, -631177200000.0),
        _ => unreachable!(),
    };
    assert_eq!(released("1"), one);
    assert_eq!(released("50"), year);
}
