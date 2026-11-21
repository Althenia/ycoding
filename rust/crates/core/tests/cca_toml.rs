use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_core::cca::{
    environment_config::{
        EnvironmentConfigOptions, EnvironmentConfigReadParams, EnvironmentConfigReadResult,
        read_environment_config,
    },
    error::ExecutorError,
    value::LosslessString,
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "cca-toml-{}-{stamp}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&directory).unwrap();
        Self(fs::canonicalize(directory).unwrap())
    }
}

impl std::ops::Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn put(file: &Path, contents: &str) {
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, contents).unwrap();
}

fn uri(path: &Path) -> String {
    format!("file://{}", path.display())
}

fn options(base: &Path) -> EnvironmentConfigOptions {
    EnvironmentConfigOptions {
        home_directory: base.join("home"),
        system_config_path: Some(base.join("etc").join("config.toml")),
        system_requirements_path: Some(base.join("etc").join("requirements.toml")),
        managed_config_path: Some(base.join("etc").join("managed_config.toml")),
        hostname: Some(Arc::new(|| "Synthetic-Host.".to_owned())),
        ..Default::default()
    }
}

fn lossless(paths: &[&[&str]]) -> Vec<Vec<LosslessString>> {
    paths
        .iter()
        .map(|path| {
            path.iter()
                .map(|segment| LosslessString::from(*segment))
                .collect()
        })
        .collect()
}

async fn read_paths(
    base: &Path,
    config_paths: Vec<Vec<LosslessString>>,
) -> Result<EnvironmentConfigReadResult, ExecutorError> {
    let params = EnvironmentConfigReadParams {
        cwd: uri(&base.join("home")),
        config_paths,
        requirements_paths: vec![],
    };
    read_environment_config(params, &options(base)).await
}

fn lossy(text: &LosslessString) -> String {
    String::from_utf16_lossy(&text.code_units().collect::<Vec<_>>())
}

async fn render(text: &str, paths: &[&[&str]]) -> Option<String> {
    let base = Scratch::new();
    put(&base.join("home").join(".codex").join("config.toml"), text);
    let result = read_paths(&base, lossless(paths))
        .await
        .expect("synthetic document is accepted");
    result
        .config
        .layers
        .iter()
        .find(|layer| layer.source.starts_with("user ("))
        .map(|layer| layer.toml.clone())
}

async fn parse_error(text: &str) -> String {
    let base = Scratch::new();
    let file = base.join("home").join(".codex").join("config.toml");
    put(&file, text);
    let error = read_paths(&base, lossless(&[&["unselected"]]))
        .await
        .expect_err("synthetic document is rejected");
    assert_eq!(error.code, -32603);
    let message = lossy(&error.message);
    let prefix = format!("failed to load executor-local config: {}:", file.display());
    message
        .strip_prefix(&prefix)
        .unwrap_or_else(|| panic!("unexpected error wrapper: {message}"))
        .to_owned()
}

#[tokio::test]
async fn tables_arrays_of_tables_key_quoting_and_insertion_order() {
    let source = [
        "model = \"synthetic\"",
        "[mcp_servers.synthetic]",
        "command = \"/synthetic/bin/server\"",
        "args = [\"--flag\", \"value\"]",
        "startup_timeout_sec = 120",
        "[mcp_servers.synthetic.env]",
        "ZED = \"1\"",
        "ALPHA = \"2\"",
        "\"needs space\" = \"3\"",
        "[[mcp_servers.synthetic.list]]",
        "n = 1",
        "[[mcp_servers.synthetic.list]]",
        "n = 2",
        "inline = { b = 1, a = \"x\" }",
        "",
    ]
    .join("\n");
    assert_eq!(
        render(&source, &[&["mcp_servers"]]).await.as_deref(),
        Some(concat!(
            "[mcp_servers.synthetic]\ncommand = \"/synthetic/bin/server\"\nargs = [\"--flag\", \"value\"]\nstartup_timeout_sec = 120\n\n",
            "[mcp_servers.synthetic.env]\nZED = \"1\"\nALPHA = \"2\"\n\"needs space\" = \"3\"\n\n",
            "[[mcp_servers.synthetic.list]]\nn = 1\n\n[[mcp_servers.synthetic.list]]\nn = 2\n\n[mcp_servers.synthetic.list.inline]\nb = 1\na = \"x\"\n"
        ))
    );
    assert_eq!(render(&source, &[&["absent"]]).await, None);
}

#[tokio::test]
async fn string_representations_follow_the_literal_multiline_and_escape_rules() {
    let source = r##"quoted = 'has "double" quotes'
back = "a\\b"
both = "it's \"x\""
multi = "line1\nline2"
ctrl = "tab\there"
uni = "héllo"
s_ctrl = "a\u0001b"
s_cr = "a\rb"
s_triple = "x'''y"
s_endq = "it'"
s_bs_q = "a\\b'c"
s_empty = ""
s_nl_bs = "a\\b\nc"
s_del = "a\u007fb"
s_esc = "a\eb\x41"
"##;
    let keys = [
        "quoted", "back", "both", "multi", "ctrl", "uni", "s_ctrl", "s_cr", "s_triple", "s_endq",
        "s_bs_q", "s_empty", "s_nl_bs", "s_del", "s_esc",
    ];
    let paths: Vec<[&str; 1]> = keys.iter().map(|key| [*key]).collect();
    let selected: Vec<&[&str]> = paths.iter().map(|path| path.as_slice()).collect();
    let expected = [
        "quoted = 'has \"double\" quotes'".to_owned(),
        "back = 'a\\b'".to_owned(),
        "both = \"\"\"it's \"x\"\"\"\"".to_owned(),
        "multi = \"\"\"\nline1\nline2\"\"\"".to_owned(),
        "ctrl = \"tab\\there\"".to_owned(),
        "uni = \"héllo\"".to_owned(),
        "s_ctrl = \"a\\u0001b\"".to_owned(),
        "s_cr = \"a\\rb\"".to_owned(),
        "s_triple = \"x'''y\"".to_owned(),
        "s_endq = \"it'\"".to_owned(),
        "s_bs_q = '''a\\b'c'''".to_owned(),
        "s_empty = \"\"".to_owned(),
        "s_nl_bs = '''\na\\b\nc'''".to_owned(),
        "s_del = \"a\\u007Fb\"".to_owned(),
        "s_esc = \"a\\u001BbA\"".to_owned(),
        String::new(),
    ]
    .join("\n");
    assert_eq!(render(source, &selected).await, Some(expected));
}

#[tokio::test]
async fn numbers_datetimes_arrays_inline_tables_and_quoted_keys() {
    let source = r##"zeta = 1
alpha = 2.0
"10" = "ten"
"2" = "two"
a_inf = inf
a_ninf = -inf
a_nan = nan
a_negzero = -0.0
a_exp = 1e10
a_float = 3.14159
a_hex = 0xff
a_big = 9223372036854775807
a_neg = -42
a_us = 1_000
f_small = 0.0000001
f_huge = 1e300
when = 1979-05-27T07:32:00Z
d_local = 1979-05-27T07:32:00
d_frac = 1979-05-27T00:32:00.999999-07:00
d_date = 1979-05-27
d_time = 07:32:00
t_short = 07:32
dt_short = 1979-05-27T07:32Z
dt_space = 1979-05-27 07:32:00z
dt_zero_frac = 1979-05-27T07:32:00.000Z
dt_millis = 1979-05-27T07:32:00.120+05:30
k_arr_empty = []
k_arr_nested = [[1, 2], ["a"]]
k_arr_inline = [{ x = 1 }, { y = "z" }]
k_arr_mixed = [1, "a", true]
m_mixed = [1, { x = 1, y = { z = 2 } }]
m_inline_empty = [{}]
"key\"q" = 1
"a.b" = 2
"" = 3
"é" = 4
"##;
    let keys = [
        "zeta",
        "alpha",
        "10",
        "2",
        "a_inf",
        "a_ninf",
        "a_nan",
        "a_negzero",
        "a_exp",
        "a_float",
        "a_hex",
        "a_big",
        "a_neg",
        "a_us",
        "f_small",
        "f_huge",
        "when",
        "d_local",
        "d_frac",
        "d_date",
        "d_time",
        "t_short",
        "dt_short",
        "dt_space",
        "dt_zero_frac",
        "dt_millis",
        "k_arr_empty",
        "k_arr_nested",
        "k_arr_inline",
        "k_arr_mixed",
        "m_mixed",
        "m_inline_empty",
        "key\"q",
        "a.b",
        "",
        "é",
    ];
    let paths: Vec<[&str; 1]> = keys.iter().map(|key| [*key]).collect();
    let selected: Vec<&[&str]> = paths.iter().map(|path| path.as_slice()).collect();
    let expected = [
        "zeta = 1".to_owned(),
        "alpha = 2.0".to_owned(),
        "10 = \"ten\"".to_owned(),
        "2 = \"two\"".to_owned(),
        "a_inf = inf".to_owned(),
        "a_ninf = -inf".to_owned(),
        "a_nan = nan".to_owned(),
        "a_negzero = -0.0".to_owned(),
        "a_exp = 10000000000.0".to_owned(),
        "a_float = 3.14159".to_owned(),
        "a_hex = 255".to_owned(),
        "a_big = 9223372036854775807".to_owned(),
        "a_neg = -42".to_owned(),
        "a_us = 1000".to_owned(),
        "f_small = 0.0000001".to_owned(),
        format!("f_huge = 1{}.0", "0".repeat(300)),
        "when = 1979-05-27T07:32:00Z".to_owned(),
        "d_local = 1979-05-27T07:32:00".to_owned(),
        "d_frac = 1979-05-27T00:32:00.999999-07:00".to_owned(),
        "d_date = 1979-05-27".to_owned(),
        "d_time = 07:32:00".to_owned(),
        "t_short = 07:32:00".to_owned(),
        "dt_short = 1979-05-27T07:32:00Z".to_owned(),
        "dt_space = 1979-05-27T07:32:00Z".to_owned(),
        "dt_zero_frac = 1979-05-27T07:32:00Z".to_owned(),
        "dt_millis = 1979-05-27T07:32:00.12+05:30".to_owned(),
        "k_arr_empty = []".to_owned(),
        "k_arr_nested = [[1, 2], [\"a\"]]".to_owned(),
        "k_arr_mixed = [1, \"a\", true]".to_owned(),
        "m_mixed = [1, { x = 1, y = { z = 2 } }]".to_owned(),
        "'key\"q' = 1".to_owned(),
        "\"a.b\" = 2".to_owned(),
        "\"\" = 3".to_owned(),
        "\"é\" = 4".to_owned(),
        String::new(),
        "[[k_arr_inline]]".to_owned(),
        "x = 1".to_owned(),
        String::new(),
        "[[k_arr_inline]]".to_owned(),
        "y = \"z\"".to_owned(),
        String::new(),
        "[[m_inline_empty]]".to_owned(),
        String::new(),
    ]
    .join("\n");
    assert_eq!(render(source, &selected).await, Some(expected));
}

#[tokio::test]
async fn header_only_tables_empty_tables_multiline_inline_tables_and_projection_into_arrays() {
    let source = "m_dotted = { a.b = 1, c = [] }\ninl = {\n  a = 1,\n  b = 2,\n}\n[empty_table]\n[[aot]]\n[aot.sub]\nk = 1\n[[aot]]\nv = 2\n[[aot.inner]]\nq = 1\n[tab]\n[tab.empty_child]\n[tab.val_child]\nx = 1\n[outer]\nv = 1\n[outer.mid.inner]\nw = 2\n";
    assert_eq!(
        render(source, &[&["m_dotted"], &["inl"], &["empty_table"]])
            .await
            .as_deref(),
        Some("[m_dotted]\nc = []\n\n[m_dotted.a]\nb = 1\n\n[inl]\na = 1\nb = 2\n\n[empty_table]\n")
    );
    assert_eq!(
        render(source, &[&["aot"], &["tab"]]).await.as_deref(),
        Some(
            "[[aot]]\n\n[aot.sub]\nk = 1\n\n[[aot]]\nv = 2\n\n[[aot.inner]]\nq = 1\n\n[tab.empty_child]\n\n[tab.val_child]\nx = 1\n"
        )
    );
    assert_eq!(
        render(source, &[&["aot", "v"], &["tab", "empty_child"]])
            .await
            .as_deref(),
        Some(
            "[[aot]]\n\n[aot.sub]\nk = 1\n\n[[aot]]\nv = 2\n\n[[aot.inner]]\nq = 1\n\n[tab.empty_child]\n"
        )
    );
    assert_eq!(
        render(source, &[&["outer", "mid"], &["outer", "v", "deeper"]])
            .await
            .as_deref(),
        Some("[outer]\nv = 1\n\n[outer.mid.inner]\nw = 2\n")
    );
}

#[tokio::test]
async fn multiline_commented_trailing_comma_inline_tables_render_as_canonical_sections() {
    assert_eq!(
        render("v = {\n a = 1, # c\n b = 2,\n}\n", &[&["v"]])
            .await
            .as_deref(),
        Some("[v]\na = 1\nb = 2\n")
    );
}

#[tokio::test]
async fn implicit_parent_declared_later_keeps_its_original_position() {
    assert_eq!(
        render("[a.x]\nv = 1\n[b]\nv = 2\n[a]\nv = 3\n", &[&["a"], &["b"]])
            .await
            .as_deref(),
        Some("[a]\nv = 3\n\n[a.x]\nv = 1\n\n[b]\nv = 2\n")
    );
}

#[tokio::test]
async fn array_of_tables_descent_and_dotted_key_state() {
    assert_eq!(
        render("[[a]]\nx = 1\n[a.b]\ny = 2\n[[a]]\nx = 3\n", &[&["a"]])
            .await
            .as_deref(),
        Some("[[a]]\nx = 1\n\n[a.b]\ny = 2\n\n[[a]]\nx = 3\n")
    );
    assert_eq!(
        render("\"a.b\" = 1\na.b = 2\n", &[&["a.b"], &["a"]])
            .await
            .as_deref(),
        Some("\"a.b\" = 1\n\n[a]\nb = 2\n")
    );
}

#[tokio::test]
async fn integer_domain_radix_forms_and_overflow_cursor_positions() {
    assert_eq!(
        render("x = 9223372036854775807\n", &[&["x"]])
            .await
            .as_deref(),
        Some("x = 9223372036854775807\n")
    );
    assert_eq!(
        render("x = -9223372036854775808\n", &[&["x"]])
            .await
            .as_deref(),
        Some("x = -9223372036854775808\n")
    );
    assert_eq!(
        render("x = 0x7FFFFFFFFFFFFFFF\n", &[&["x"]])
            .await
            .as_deref(),
        Some("x = 9223372036854775807\n")
    );
    assert_eq!(
        render(
            "x = 0o17\ny = 0b101\nz = 0xdead_beef\n",
            &[&["x"], &["y"], &["z"]]
        )
        .await
        .as_deref(),
        Some("x = 15\ny = 5\nz = 3735928559\n")
    );
    assert_eq!(
        parse_error("x = 9223372036854775808\n").await,
        "1:24: integer number overflowed"
    );
    assert_eq!(
        parse_error("x = 0x8000000000000000\n").await,
        "1:5: integer number overflowed"
    );
    assert_eq!(parse_error("x = 01\n").await, "1:6: invalid number");
    assert_eq!(parse_error("x = 0x_1\n").await, "1:5: invalid integer");
    assert_eq!(parse_error("x = 0b102\n").await, "1:5: invalid integer");
    assert_eq!(parse_error("x = +0x1\n").await, "1:7: invalid number");
}

#[tokio::test]
async fn floats_keep_signed_nan_signed_zero_infinities_and_reject_overflow() {
    assert_eq!(
        render(
            "a = +inf\nb = -inf\nc = +nan\nd = -nan\ne = 0.0\nf = -0.0\ng = nan\n",
            &[&["a"], &["b"], &["c"], &["d"], &["e"], &["f"], &["g"]]
        )
        .await
        .as_deref(),
        Some("a = inf\nb = -inf\nc = nan\nd = -nan\ne = 0.0\nf = -0.0\ng = nan\n")
    );
    assert_eq!(parse_error("x = 1e999\n").await, "1:10: invalid float");
    assert_eq!(parse_error("x = -1e999\n").await, "1:11: invalid float");
    assert_eq!(
        render("x = 1e-999\ny = -0.0e5\n", &[&["x"], &["y"]])
            .await
            .as_deref(),
        Some("x = 0.0\ny = -0.0\n")
    );
}

#[tokio::test]
async fn finite_floats_use_the_javascript_number_string_digits_expanded_without_exponents() {
    let source = "a = 1e21\nb = 1e-7\nc = 5e-324\nd = 1.7976931348623157e308\ne = 9007199254740993.0\nf = 0.30000000000000004\ng = 123456789012345680000.0\nh = 1e-6\ni = 2.2250738585072014e-308\nj = -1e21\nk = 1967805326562213.2\n";
    let expected = [
        format!("a = 1{}.0", "0".repeat(21)),
        "b = 0.0000001".to_owned(),
        format!("c = 0.{}5", "0".repeat(323)),
        format!("d = 17976931348623157{}.0", "0".repeat(292)),
        "e = 9007199254740992.0".to_owned(),
        "f = 0.30000000000000004".to_owned(),
        "g = 123456789012345680000.0".to_owned(),
        "h = 0.000001".to_owned(),
        format!("i = 0.{}22250738585072014", "0".repeat(307)),
        format!("j = -1{}.0", "0".repeat(21)),
        "k = 1967805326562213.2".to_owned(),
        String::new(),
    ]
    .join("\n");
    let keys: Vec<[&str; 1]> = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]
        .iter()
        .map(|key| [*key])
        .collect();
    let selected: Vec<&[&str]> = keys.iter().map(|path| path.as_slice()).collect();
    assert_eq!(render(source, &selected).await, Some(expected));
}

#[tokio::test]
async fn datetime_precision_offsets_and_calendar_bounds() {
    for (source, expected) in [
        ("x = 07:32\n", "x = 07:32:00\n"),
        ("x = 1979-05-27T07:32Z\n", "x = 1979-05-27T07:32:00Z\n"),
        (
            "x = 1979-05-27T07:32:00.000Z\n",
            "x = 1979-05-27T07:32:00Z\n",
        ),
        (
            "x = 1979-05-27T07:32:00.120Z\n",
            "x = 1979-05-27T07:32:00.12Z\n",
        ),
        (
            "x = 1979-05-27T07:32:00.1234567899Z\n",
            "x = 1979-05-27T07:32:00.123456789Z\n",
        ),
        (
            "x = 1979-05-27T07:32:00-00:00\n",
            "x = 1979-05-27T07:32:00-00:00\n",
        ),
        (
            "x = 1979-05-27T07:32:00+00:00\n",
            "x = 1979-05-27T07:32:00+00:00\n",
        ),
        ("x = 1979-05-27t07:32:00z\n", "x = 1979-05-27T07:32:00Z\n"),
        ("x = 2000-02-29\n", "x = 2000-02-29\n"),
        ("x = 07:32:60\n", "x = 07:32:60\n"),
    ] {
        assert_eq!(
            render(source, &[&["x"]]).await.as_deref(),
            Some(expected),
            "{source}"
        );
    }
    assert_eq!(parse_error("x = 1979-02-31\n").await, "1:5: invalid date");
    assert_eq!(parse_error("x = 1900-02-29\n").await, "1:5: invalid date");
    assert_eq!(parse_error("x = 1979-13-01\n").await, "1:5: invalid date");
    assert_eq!(parse_error("x = 07:32:61\n").await, "1:5: invalid time");
    assert_eq!(parse_error("x = 24:00:00\n").await, "1:5: invalid time");
    assert_eq!(
        parse_error("x = 1979-05-27T07:32:00+24:00\n").await,
        "1:5: invalid offset"
    );
    assert_eq!(
        parse_error("x = 1979-05-27T\n").await,
        "1:5: invalid datetime"
    );
}

#[tokio::test]
async fn first_error_in_source_order_wins_with_line_and_column() {
    assert_eq!(parse_error("bad = = 1\n").await, "1:7: invalid value");
    assert_eq!(
        parse_error("a = 1 x\n").await,
        "1:7: extra `x`, expected nothing"
    );
    assert_eq!(
        parse_error("a = 1\na = 2\n").await,
        "2:1: duplicate key `a`"
    );
    assert_eq!(
        parse_error("a.b = 1\na.b = 2\n").await,
        "2:1: duplicate key `b`"
    );
    assert_eq!(
        parse_error("a = 1\n\"a\" = 2\n").await,
        "2:1: duplicate key `a`"
    );
    assert_eq!(parse_error("[t]\n[t]\n").await, "3:1: duplicate key `t`");
    assert_eq!(
        parse_error("a = 1\na = 2\nbad = = 3\n").await,
        "2:1: duplicate key `a`"
    );
    assert_eq!(
        parse_error("t = { a = 1 }\n[t]\n").await,
        "3:1: duplicate key `t`"
    );
    assert_eq!(
        parse_error("a.b = 1\n[a]\n").await,
        "3:1: duplicate key `a`"
    );
    assert_eq!(
        parse_error("ok = 1\nbad = = 1\n").await,
        "2:7: invalid value"
    );
}

#[tokio::test]
async fn coordinates_count_utf16_units_and_reset_only_on_line_feed() {
    assert_eq!(
        parse_error("\"\u{1F600}\" = 1 x\n").await,
        "1:10: extra `x`, expected nothing"
    );
    assert_eq!(
        parse_error("a = 1\r\nb = = 2\r\n").await,
        "2:5: invalid value"
    );
    assert_eq!(parse_error("a = \n").await, "1:5: invalid value");
    assert_eq!(parse_error("a =").await, "1:4: expected a value");
}

#[tokio::test]
async fn byte_order_mark_is_not_skipped() {
    assert_eq!(parse_error("\u{FEFF}x = 1\n").await, "1:1: invalid key");
}

#[tokio::test]
async fn string_grammar_errors() {
    assert_eq!(
        parse_error("x = \"\\q\"\n").await,
        "1:7: invalid escape sequence"
    );
    assert_eq!(
        parse_error("x = \"\\uD800\"\n").await,
        "1:8: invalid unicode escape"
    );
    assert_eq!(
        parse_error("x = \"\\U00110000\"\n").await,
        "1:8: invalid unicode escape"
    );
    assert_eq!(
        parse_error("x = \"open\n").await,
        "1:10: invalid basic string, expected `\"`"
    );
    assert_eq!(
        parse_error("x = 'open\n").await,
        "1:10: invalid literal string, expected `'`"
    );
    assert_eq!(
        parse_error("x = \"\"\"open").await,
        "1:12: invalid multiline basic string, expected `\"\"\"`"
    );
    assert_eq!(
        parse_error("\"\"\"x\"\"\" = 1\n").await,
        "1:1: multiline strings are not allowed for keys"
    );
    assert_eq!(
        parse_error("'''x''' = 1\n").await,
        "1:1: multiline strings are not allowed for keys"
    );
    assert_eq!(
        parse_error("a = 1 # \u{1}\n").await,
        "1:9: invalid comment character"
    );
    assert_eq!(
        parse_error("x = \"a\u{7f}\"\n").await,
        "1:8: invalid string character"
    );
}

#[tokio::test]
async fn multiline_strings_normalize_line_endings_and_continuations() {
    assert_eq!(
        render("a = \"\"\"\nline1\r\nline2\"\"\"\nb = \"\"\"one \\\n   two\"\"\"\nc = '''\nraw\\n'''\n", &[&["a"], &["b"], &["c"]]).await.as_deref(),
        Some("a = \"\"\"\nline1\nline2\"\"\"\nb = \"one two\"\nc = 'raw\\n'\n")
    );
}

#[tokio::test]
async fn unpaired_surrogate_selectors_match_no_key_but_keep_the_parent_table() {
    let base = Scratch::new();
    put(
        &base.join("home").join(".codex").join("config.toml"),
        "[a]\nb = 1\n\"\u{FFFD}\" = 2\n",
    );
    let lone = LosslessString::from_utf16(vec![0xD800]);
    let user_toml = |result: &EnvironmentConfigReadResult| {
        result
            .config
            .layers
            .iter()
            .find(|layer| layer.source.starts_with("user ("))
            .map(|layer| layer.toml.clone())
    };
    let result = read_paths(&base, vec![vec![LosslessString::from("a"), lone.clone()]])
        .await
        .unwrap();
    assert_eq!(user_toml(&result).as_deref(), Some("[a]\n"));
    let result = read_paths(&base, vec![vec![lone]]).await.unwrap();
    assert_eq!(user_toml(&result), None);
    let result = read_paths(
        &base,
        vec![vec![
            LosslessString::from("a"),
            LosslessString::from("\u{FFFD}"),
        ]],
    )
    .await
    .unwrap();
    assert_eq!(
        user_toml(&result).as_deref(),
        Some("[a]\n\"\u{FFFD}\" = 2\n")
    );
}

#[tokio::test]
async fn half_astral_code_unit_in_an_error_detail_reaches_the_error_message_losslessly() {
    let base = Scratch::new();
    let file = base.join("home").join(".codex").join("config.toml");
    put(&file, "a = 1 \u{1F600}\n");
    let error = read_paths(&base, lossless(&[&["a"]])).await.unwrap_err();
    let units: Vec<u16> = error.message.code_units().collect();
    let mut expected: Vec<u16> = format!(
        "failed to load executor-local config: {}:1:7: extra `",
        file.display()
    )
    .encode_utf16()
    .collect();
    expected.push(0xD83D);
    expected.extend("`, expected nothing".encode_utf16());
    assert_eq!(units, expected);
    assert!(error.message.as_str().is_none());
}

#[tokio::test]
async fn deeply_nested_documents_are_accepted_without_a_cutoff() {
    let depth = 100_000;
    let source = format!("x = {}{}\n", "[".repeat(depth), "]".repeat(depth));
    let rendered = render(&source, &[&["x"]])
        .await
        .expect("deep document is projected");
    assert_eq!(rendered.len(), "x = ".len() + 2 * depth + 1);
}
