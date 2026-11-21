use super::paths::{basename, dirname, resolve, text, units, whitespace};
use super::{Paths, regex};
use crate::regexp::{Budget, RegExp};
use ycoding_schema::LosslessString;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Connector {
    Always,
    And,
    Or,
}
#[derive(Clone, Debug)]
pub(super) struct Segment {
    pub tokens: Vec<LosslessString>,
    pub raw: Vec<LosslessString>,
    pub connector: Connector,
    pub separator: String,
    pub index: usize,
    pub heredoc_bodies: Vec<LosslessString>,
    start: usize,
    end: usize,
    heredoc_ranges: Vec<(usize, usize)>,
}
#[derive(Clone, Debug)]
pub(super) struct Operation {
    pub segment: Segment,
    pub workdir: LosslessString,
}
#[derive(Clone, Debug)]
pub(super) struct Removal {
    pub recursive: bool,
    pub targets: Vec<(usize, LosslessString)>,
    pub workdir: LosslessString,
    pub segment: usize,
}

pub(super) fn segments(command: &LosslessString) -> Vec<Segment> {
    scan(command).0
}

fn scan(command: &LosslessString) -> (Vec<Segment>, Vec<(usize, usize)>) {
    let command = units(command);
    let mut state = Tokenizer {
        result: vec![],
        tokens: vec![],
        raw: vec![],
        token: vec![],
        start: 0,
        quoted: false,
        heredocs: vec![],
        piped: false,
        connector: Connector::Always,
        separator: String::new(),
        segment_start: 0,
    };
    let mut comments = vec![];
    let mut quote = None;
    let mut escaped = false;
    let mut index = 0;
    while index < command.len() {
        let unit = command[index];
        if escaped {
            state.token.push(unit);
            escaped = false;
        } else if unit == 92 && quote != Some(39) {
            if state.token.is_empty() && !state.quoted {
                state.start = index;
            }
            escaped = true;
            state.quoted = true;
        } else if let Some(current) = quote {
            if unit == current {
                quote = None;
            } else {
                state.token.push(unit);
            }
        } else if matches!(unit, 39 | 34) {
            if state.token.is_empty() && !state.quoted {
                state.start = index;
            }
            quote = Some(unit);
            state.quoted = true;
        } else if unit == 35 && state.token.is_empty() && !state.quoted {
            let end = command[index..]
                .iter()
                .position(|unit| *unit == 10)
                .map_or(command.len(), |length| index + length);
            comments.push((index, end));
            index = end - 1;
        } else if matches!(unit, 59 | 10) {
            state.push_segment(
                &command,
                Connector::Always,
                if unit == 59 { "; " } else { "\n " },
                index,
            );
            if unit == 10 {
                index = state.skip_heredocs(&command, index);
            }
        } else if matches!(unit, 60 | 62) {
            if !state.token.is_empty()
                && !regex(
                    &LosslessString::from_utf16(state.token.clone()),
                    r"^(?:\d+|&|(?:\d*|&)[<>][<>&|]*)$",
                    "",
                )
            {
                state.push_token(&command, index);
            }
            if state.token.is_empty() && !state.quoted {
                state.start = index;
            }
            state.token.push(unit);
        } else if unit == 38
            && regex(
                &LosslessString::from_utf16(state.token.clone()),
                r"^(?:\d*|&)[<>]+$",
                "",
            )
        {
            state.token.push(unit);
        } else if unit == 38 && command.get(index + 1) == Some(&62) {
            state.push_token(&command, index);
            state.start = index;
            state.token = vec![38];
        } else if matches!(unit, 124 | 38) {
            let repeated = command.get(index + 1) == Some(&unit);
            if unit == 124 && !repeated {
                state.piped = true;
            }
            let (connector, separator) = match (unit, repeated) {
                (124, true) => (Connector::Or, " || "),
                (124, false) => (Connector::Always, " | "),
                (_, true) => (Connector::And, " && "),
                _ => (Connector::Always, " & "),
            };
            state.push_segment(&command, connector, separator, index);
            if repeated {
                index += 1;
            }
        } else if whitespace(unit) {
            state.push_token(&command, index);
        } else {
            if state.token.is_empty() && !state.quoted {
                state.start = index;
            }
            state.token.push(unit);
        }
        index += 1;
    }
    state.push_segment(&command, Connector::Always, "", command.len());
    (state.result, comments)
}

struct Heredoc {
    delimiter: Vec<u16>,
    strip: bool,
    quoted: bool,
    command: LosslessString,
    segment: usize,
}

struct Tokenizer {
    result: Vec<Segment>,
    tokens: Vec<LosslessString>,
    raw: Vec<LosslessString>,
    token: Vec<u16>,
    start: usize,
    quoted: bool,
    heredocs: Vec<Heredoc>,
    piped: bool,
    connector: Connector,
    separator: String,
    segment_start: usize,
}

impl Tokenizer {
    fn push_token(&mut self, command: &[u16], end: usize) {
        if self.token.is_empty() && !self.quoted {
            return;
        }
        if self.tokens.is_empty() {
            self.segment_start = self.start;
        }
        let token = std::mem::take(&mut self.token);
        let heredoc = if heredoc_operator(&token).is_some() {
            None
        } else if let Some(strip) = self
            .tokens
            .last()
            .and_then(|previous| heredoc_operator(&units(previous)))
        {
            Some((strip, token.clone()))
        } else {
            attached_heredoc(&token)
        };
        self.tokens.push(LosslessString::from_utf16(token));
        self.raw.push(LosslessString::from_utf16(
            command[self.start..end].to_vec(),
        ));
        if let Some((strip, delimiter)) = heredoc {
            self.heredocs.push(Heredoc {
                delimiter,
                strip,
                quoted: self.quoted,
                command: basename(&self.tokens[0]),
                segment: self.result.len(),
            });
        }
        self.quoted = false;
    }

    fn push_segment(&mut self, command: &[u16], next: Connector, separator: &str, end: usize) {
        self.push_token(command, end);
        if !self.tokens.is_empty() {
            self.result.push(Segment {
                tokens: std::mem::take(&mut self.tokens),
                raw: std::mem::take(&mut self.raw),
                connector: self.connector,
                separator: std::mem::take(&mut self.separator),
                index: self.result.len(),
                heredoc_bodies: vec![],
                start: self.segment_start,
                end,
                heredoc_ranges: vec![],
            });
        }
        self.connector = next;
        self.separator = separator.into();
    }

    fn skip_heredocs(&mut self, command: &[u16], newline: usize) -> usize {
        let pending = std::mem::take(&mut self.heredocs);
        let piped = std::mem::replace(&mut self.piped, false);
        if pending.is_empty() {
            return newline;
        }
        let mut bodies = Vec::new();
        let end = pending.iter().try_fold(newline + 1, |cursor, heredoc| {
            if !matches!(
                heredoc.command.as_str(),
                Some(
                    "cat"
                        | "tee"
                        | "git"
                        | "gh"
                        | "node"
                        | "bun"
                        | "deno"
                        | "python"
                        | "python3"
                        | "ruby"
                        | "perl"
                )
            ) {
                return None;
            }
            let lines = command
                .get(cursor..)?
                .split(|unit| *unit == 10)
                .collect::<Vec<_>>();
            let closing = lines.iter().position(|line| {
                let line = if heredoc.strip {
                    &line[line.iter().take_while(|unit| **unit == 9).count()..]
                } else {
                    line
                };
                line == heredoc.delimiter.as_slice()
            })?;
            if !heredoc.quoted
                && lines[..closing]
                    .iter()
                    .any(|line| line.contains(&96) || line.windows(2).any(|pair| pair == [36, 40]))
            {
                return None;
            }
            let mut body_units = Vec::new();
            for (idx, line) in lines[..closing].iter().enumerate() {
                if idx > 0 {
                    body_units.push(10);
                }
                body_units.extend_from_slice(line);
            }
            let body_end = cursor + body_units.len();
            bodies.push((
                heredoc.segment,
                LosslessString::from_utf16(body_units),
                cursor,
                body_end,
            ));
            Some(
                cursor
                    + lines[..=closing]
                        .iter()
                        .map(|line| line.len())
                        .sum::<usize>()
                    + closing
                    + 1,
            )
        });
        match end {
            Some(end) if !piped => {
                for (segment, body, start, end) in bodies {
                    if let Some(seg) = self.result.get_mut(segment) {
                        seg.heredoc_bodies.push(body);
                        seg.heredoc_ranges.push((start, end));
                    }
                }
                end - 2
            }
            _ => newline,
        }
    }
}

fn heredoc_operator(token: &[u16]) -> Option<bool> {
    let rest = &token[token
        .iter()
        .take_while(|unit| (48..=57).contains(*unit))
        .count()..];
    match rest {
        [60, 60] => Some(false),
        [60, 60, 45] => Some(true),
        _ => None,
    }
}

fn attached_heredoc(token: &[u16]) -> Option<(bool, Vec<u16>)> {
    let rest = &token[token
        .iter()
        .take_while(|unit| (48..=57).contains(*unit))
        .count()..];
    let rest = rest.strip_prefix(&[60, 60])?;
    if let [45, first, ..] = rest
        && *first != 60
    {
        return Some((true, rest[1..].to_vec()));
    }
    (rest.first().is_some_and(|unit| *unit != 60)).then(|| (false, rest.to_vec()))
}

pub(super) fn operands(
    tokens: &[LosslessString],
    heredoc_bodies: &[LosslessString],
    include_read_targets: bool,
) -> Vec<LosslessString> {
    let mut redirects = vec![];
    let mut words = vec![];
    let mut index = 0;
    while index < tokens.len() {
        let Some((operator, target)) = redirection(&tokens[index]) else {
            words.push(tokens[index].clone());
            index += 1;
            continue;
        };
        let target = if target.is_empty() {
            index += 1;
            tokens.get(index).cloned()
        } else {
            Some(LosslessString::from_utf16(target))
        };
        index += 1;
        let Some(target) = target else {
            continue;
        };
        if operator.starts_with("<<")
            || (matches!(operator, ">&" | "<&") && regex(&target, r"^(?:\d+|-)$", ""))
        {
            continue;
        }
        redirects.push(target);
    }
    let command = words.iter().position(|token| {
        !matches!(
            basename(token).as_str(),
            Some("sudo" | "command" | "env" | "nohup")
        ) && !shell_keyword(token)
            && !units(token).starts_with(&[45])
            && !regex(token, "^[A-Za-z_][A-Za-z0-9_]*=", "")
    });
    let name = command.map_or_else(|| LosslessString::from(""), |index| basename(&words[index]));
    let args = command_arguments(
        &name,
        &words[command.map_or(0, |index| index + 1)..],
        heredoc_bodies,
        include_read_targets,
    )
    .into_iter()
    .filter_map(|token| {
        let value = units(&token);
        let start = value
            .iter()
            .position(|unit| *unit == 61)
            .filter(|index| *index > 0)
            .map_or(0, |index| index + 1);
        let stripped = &value[start..];
        let value = if stripped.starts_with(&[64, 47])
            || stripped.starts_with(&[64, 126, 47])
            || stripped.starts_with(&[64, 46])
        {
            LosslessString::from_utf16(stripped[1..].to_vec())
        } else {
            LosslessString::from_utf16(stripped.to_vec())
        };
        (!value.is_empty()
            && !units(&value).starts_with(&[45])
            && !regex(&value, r"^[a-z][a-z0-9+.-]*:\/\/", "i")
            && !regex(&value, r"^\/\/[^/]+\/", ""))
        .then_some(value)
    })
    .collect::<Vec<_>>();
    redirects.into_iter().chain(args).collect()
}

fn redirection(token: &LosslessString) -> Option<(&'static str, Vec<u16>)> {
    let value = units(token);
    let digits = value
        .iter()
        .take_while(|unit| (48..=57).contains(*unit))
        .count();
    let operator = |start: usize| {
        ["<<<", "<<-", "<<", "<>", ">>", ">|", ">&", "<&", ">", "<"]
            .into_iter()
            .find(|operator| value[start..].starts_with(&text(operator)))
            .map(|operator| (operator, value[start + operator.len()..].to_vec()))
    };
    operator(digits).or_else(|| (value.first() == Some(&38)).then(|| operator(1)).flatten())
}

const HTTP_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const YCODING_API_TEXT_OPTIONS: &[&str] =
    &["-d", "--data", "-H", "--header", "--param", "--server"];
const SCRIPT_TRANSPORT_OPTIONS: &[&str] = &["--url", "--endpoint"];

fn drop_named_value_options(args: &[LosslessString], options: &[&str]) -> Vec<LosslessString> {
    let mut kept = vec![];
    for (index, token) in args.iter().enumerate() {
        if let Some(s) = token.as_str()
            && options.iter().any(|opt| {
                if let Some(long) = opt.strip_prefix("--") {
                    s.starts_with(&format!("--{long}="))
                } else {
                    false
                }
            })
        {
            continue;
        }
        if index > 0
            && let Some(prev) = args[index - 1].as_str()
            && options.contains(&prev)
        {
            continue;
        }
        kept.push(token.clone());
    }
    kept
}

fn ycoding_api_args(args: &[LosslessString]) -> Option<Vec<LosslessString>> {
    let previous = |index: usize| index.checked_sub(1).and_then(|i| args[i].as_str());
    let api = args.iter().enumerate().position(|(index, arg)| {
        !units(arg).starts_with(&[45])
            && !previous(index).is_some_and(|prev| YCODING_API_TEXT_OPTIONS.contains(&prev))
    })?;
    if args[api].as_str() != Some("api") {
        return None;
    }
    let mut kept = args[..api].to_vec();
    let mut positionals = 0;
    let mut droppable = 1;
    for (index, token) in args.iter().enumerate().skip(api + 1) {
        let positional = !units(token).starts_with(&[45])
            && !previous(index).is_some_and(|prev| YCODING_API_TEXT_OPTIONS.contains(&prev));
        if positional {
            positionals += 1;
            if positionals == 1 && token.as_str().is_some_and(|m| HTTP_METHODS.contains(&m)) {
                droppable = 2;
            }
            if positionals <= droppable {
                continue;
            }
        }
        kept.push(token.clone());
    }
    Some(drop_named_value_options(&kept, YCODING_API_TEXT_OPTIONS))
}

const CURL_FILE_OPTIONS: &[&str] = &[
    "-o",
    "--output",
    "--output-dir",
    "-T",
    "--upload-file",
    "-K",
    "--config",
    "--cert",
    "-E",
    "--key",
    "--cacert",
    "--capath",
    "-c",
    "--cookie-jar",
    "-D",
    "--dump-header",
    "--trace",
    "--trace-ascii",
    "--libcurl",
    "-z",
    "--time-cond",
    "--etag-save",
    "--etag-compare",
    "--unix-socket",
    "--netrc-file",
];
const WGET_FILE_OPTIONS: &[&str] = &[
    "-O",
    "--output-document",
    "-P",
    "--directory-prefix",
    "-i",
    "--input-file",
    "--post-file",
    "--ca-certificate",
    "--certificate",
    "--private-key",
    "--ca-directory",
    "--crl-file",
    "-o",
    "--output-file",
    "-a",
    "--append-output",
    "--load-cookies",
    "--save-cookies",
    "--warc-file",
];
const HTTPIE_FILE_OPTIONS: &[&str] = &["-o", "--output", "--session", "--cert", "--cert-key"];
const CURL_DATA_OPTIONS: &[&str] = &[
    "-d",
    "--data",
    "--data-ascii",
    "--data-binary",
    "--data-urlencode",
    "-F",
    "--form",
];
const CURL_VALUE_OPTIONS: &[&str] = &[
    "--request",
    "--user-agent",
    "--referer",
    "--user",
    "--proxy",
    "--proxy-user",
    "--max-time",
    "--connect-timeout",
    "--expect100-timeout",
    "--retry",
    "--retry-delay",
    "--retry-max-time",
    "--limit-rate",
    "--resolve",
    "--connect-to",
    "--interface",
    "--local-port",
    "--dns-servers",
    "--dns-interface",
    "--dns-ipv4-addr",
    "--dns-ipv6-addr",
    "--pass",
    "--oauth2-bearer",
    "--aws-sigv4",
    "--delegation",
    "--service-name",
    "--krb",
    "--mail-from",
    "--mail-rcpt",
    "--mail-auth",
    "--ftp-alternative",
    "--proto",
    "--proto-redir",
    "--proto-default",
    "--max-redirs",
    "--keepalive-time",
    "--speed-limit",
    "--speed-time",
    "--buffer-size",
    "--write-out",
    "--range",
    "--variable",
    "--data-raw",
    "--form-string",
];
const CURL_SHORT_VALUE_CHARS: &[u16] = &[
    b'A' as u16,
    b'e' as u16,
    b'u' as u16,
    b'U' as u16,
    b'x' as u16,
    b'X' as u16,
    b'm' as u16,
    b'r' as u16,
    b'w' as u16,
    b'Y' as u16,
    b'y' as u16,
    b't' as u16,
    b'z' as u16,
];

fn curl_data_file(option: &str, value: &LosslessString) -> Option<LosslessString> {
    let s = value.as_str()?;
    if option == "-F" || option == "--form" {
        let field = s.split(';').next().unwrap_or(s);
        if let Some(pos) = field.find('=') {
            let after = &field[pos + 1..];
            if (after.starts_with('@') || after.starts_with('<')) && after != "@-" {
                return Some(LosslessString::from(&after[1..]));
            }
        }
        if field.starts_with('@') && field != "@-" {
            return Some(LosslessString::from(&field[1..]));
        }
        return None;
    }
    if option == "--data-urlencode" {
        if let Some(path) = s.strip_prefix('@') {
            return if path == "-" {
                None
            } else {
                Some(LosslessString::from(path))
            };
        }
        if let Some(pos) = s.find('@')
            && !s[..pos].contains('=')
        {
            return Some(LosslessString::from(&s[pos + 1..]));
        }
        return None;
    }
    if s.starts_with('@') && s != "@-" {
        Some(LosslessString::from(&s[1..]))
    } else {
        None
    }
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn decode_uri_component(s: &str) -> String {
    let mut bytes = Vec::new();
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            if let (Some(h1), Some(h2)) = (chars.next(), chars.next()) {
                if let (Some(v1), Some(v2)) = (hex_val(h1), hex_val(h2)) {
                    bytes.push((v1 << 4) | v2);
                    continue;
                }
                bytes.push(b'%');
                bytes.push(h1);
                bytes.push(h2);
            } else {
                bytes.push(b'%');
            }
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|_| s.to_string())
}

fn file_url_target(value: &LosslessString) -> Option<LosslessString> {
    let s = value.as_str()?;
    let rest = s.strip_prefix("file://")?;
    let path_part = if let Some(stripped) = rest.strip_prefix("localhost") {
        stripped
    } else {
        rest
    };
    if !path_part.starts_with('/') {
        return None;
    }
    let end = path_part
        .find(|c: char| c.is_whitespace() || matches!(c, '?' | '#' | '\'' | '"'))
        .unwrap_or(path_part.len());
    let target = &path_part[..end];
    Some(LosslessString::from(decode_uri_component(target)))
}

fn curl_option_value(kept: &mut Vec<LosslessString>, option: &str, value: Option<&LosslessString>) {
    let Some(value) = value else { return };
    if CURL_FILE_OPTIONS.contains(&option) {
        kept.push(value.clone());
    } else if option == "-b" || option == "--cookie" {
        if let Some(s) = value.as_str()
            && !s.contains('=')
        {
            kept.push(value.clone());
        }
    } else if option == "-H" || option == "--header" {
        if let Some(s) = value.as_str()
            && let Some(path) = s.strip_prefix('@')
            && path != "-"
        {
            kept.push(LosslessString::from(path));
        }
    } else if CURL_DATA_OPTIONS.contains(&option)
        && let Some(file) = curl_data_file(option, value)
    {
        kept.push(file);
    } else if option == "--url"
        && let Some(target) = file_url_target(value)
    {
        kept.push(target);
    }
}

fn curl_separate_value_option(opt: &str) -> bool {
    CURL_FILE_OPTIONS.contains(&opt)
        || CURL_DATA_OPTIONS.contains(&opt)
        || CURL_VALUE_OPTIONS.contains(&opt)
        || matches!(opt, "-b" | "--cookie" | "-H" | "--header" | "--url")
}

fn curl_file_args(args: &[LosslessString]) -> Vec<LosslessString> {
    let mut kept = Vec::new();
    let mut positional_only = false;
    let mut index = 0;
    while index < args.len() {
        let token = &args[index];
        let token_str = token.as_str().unwrap_or("");
        if positional_only {
            if let Some(target) = file_url_target(token) {
                kept.push(target);
            }
            index += 1;
            continue;
        }
        if token_str == "--" {
            positional_only = true;
            index += 1;
            continue;
        }
        if let Some(pos) = token_str.find('=')
            && token_str.starts_with("--")
        {
            let opt = &token_str[..pos];
            let val = LosslessString::from(&token_str[pos + 1..]);
            curl_option_value(&mut kept, opt, Some(&val));
            index += 1;
            continue;
        }
        if token_str.starts_with("--") {
            if curl_separate_value_option(token_str) {
                index += 1;
                curl_option_value(&mut kept, token_str, args.get(index));
            }
            index += 1;
            continue;
        }
        let u = units(token);
        if u.len() > 1 && u[0] == 45
        /* - */
        {
            for position in 1..u.len() {
                let option = format!("-{}", char::from_u32(u[position] as u32).unwrap_or(' '));
                let rest = if position + 1 < u.len() {
                    Some(LosslessString::from_utf16(u[position + 1..].to_vec()))
                } else {
                    None
                };
                if curl_separate_value_option(&option) {
                    if let Some(r) = rest {
                        curl_option_value(&mut kept, &option, Some(&r));
                    } else {
                        index += 1;
                        curl_option_value(&mut kept, &option, args.get(index));
                    }
                    break;
                }
                if CURL_SHORT_VALUE_CHARS.contains(&u[position]) {
                    if rest.is_none() {
                        index += 1;
                    }
                    break;
                }
            }
            index += 1;
            continue;
        }
        if let Some(target) = file_url_target(token) {
            kept.push(target);
        }
        index += 1;
    }
    kept
}

fn http_client_file_args(name: &str, args: &[LosslessString]) -> Vec<LosslessString> {
    if name == "curl" {
        return curl_file_args(args);
    }
    let file_options = if name == "wget" {
        WGET_FILE_OPTIONS
    } else {
        HTTPIE_FILE_OPTIONS
    };
    let mut kept = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let token = &args[index];
        let token_str = token.as_str().unwrap_or("");
        if file_options.contains(&token_str) {
            index += 1;
            if let Some(val) = args.get(index) {
                kept.push(val.clone());
            }
            index += 1;
            continue;
        }
        if let Some(pos) = token_str.find('=') {
            let opt = &token_str[..pos];
            if file_options.contains(&opt) {
                kept.push(LosslessString::from(&token_str[pos + 1..]));
                index += 1;
                continue;
            }
        }
        let u = units(token);
        if u.len() > 2 && u[0] == 45 && u[1] != 45 {
            let opt = format!("-{}", char::from_u32(u[1] as u32).unwrap_or(' '));
            if file_options.contains(&opt.as_str()) {
                kept.push(LosslessString::from_utf16(u[2..].to_vec()));
                index += 1;
                continue;
            }
        }
        index += 1;
    }
    kept
}

struct PythonScan {
    text: String,
    values: Vec<String>,
}

fn python_placeholder_scan(code: &str) -> PythonScan {
    let mut values = Vec::new();
    let mut text = String::new();
    let chars: Vec<char> = code.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        if character == '#' {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            text.push('\n');
            continue;
        }
        let previous = text.chars().last().unwrap_or('\0');
        let is_prev_word = previous.is_alphanumeric() || previous == '_';
        let mut literal: Option<(bool, &'static str, usize)> = None;
        if !is_prev_word {
            let slice = &chars[index..];
            let mut prefix_len = 0;
            let mut has_r = false;
            if !slice.is_empty()
                && matches!(slice[0], 'r' | 'R' | 'b' | 'B' | 'u' | 'U' | 'f' | 'F')
            {
                if matches!(slice[0], 'r' | 'R') {
                    has_r = true;
                }
                prefix_len = 1;
                if slice.len() >= 2
                    && matches!(slice[1], 'r' | 'R' | 'b' | 'B' | 'u' | 'U' | 'f' | 'F')
                {
                    if matches!(slice[1], 'r' | 'R') {
                        has_r = true;
                    }
                    prefix_len = 2;
                }
            }
            let rem = &slice[prefix_len..];
            let delim = if rem.starts_with(&['\'', '\'', '\'']) {
                Some("'''")
            } else if rem.starts_with(&['"', '"', '"']) {
                Some("\"\"\"")
            } else if rem.starts_with(&['\'']) {
                Some("'")
            } else if rem.starts_with(&['"']) {
                Some("\"")
            } else {
                None
            };
            if let Some(d) = delim {
                literal = Some((has_r, d, prefix_len + d.len()));
            }
        }
        let Some((raw, delimiter, match_len)) = literal else {
            text.push(character);
            index += 1;
            continue;
        };
        let mut cursor = index + match_len;
        let mut value = String::new();
        let delim_chars: Vec<char> = delimiter.chars().collect();
        while cursor < chars.len() {
            if !raw && chars[cursor] == '\\' && cursor + 1 < chars.len() {
                value.push(chars[cursor + 1]);
                cursor += 2;
                continue;
            }
            if chars[cursor..].starts_with(&delim_chars) {
                break;
            }
            if delim_chars.len() == 1 && chars[cursor] == '\n' {
                break;
            }
            value.push(chars[cursor]);
            cursor += 1;
        }
        text.push('\u{1}');
        text.push_str(&values.len().to_string());
        text.push('\u{2}');
        values.push(value);
        index = (cursor + delim_chars.len()).min(chars.len());
    }
    PythonScan { text, values }
}

struct PythonAccess {
    reads: Vec<LosslessString>,
    writes: Vec<LosslessString>,
}

fn capture_str(captures: &[Option<Vec<u16>>], index: usize) -> Option<String> {
    captures
        .get(index)
        .and_then(|c| c.as_ref())
        .map(|u| String::from_utf16_lossy(u))
}

fn python_file_access(code: &str) -> PythonAccess {
    let scan = python_placeholder_scan(code);
    let mut reads = Vec::new();
    let mut writes = Vec::new();
    let input_units: Vec<u16> = scan.text.encode_utf16().collect();

    let val = |idx_str: &str| -> Option<LosslessString> {
        let idx = idx_str.parse::<usize>().ok()?;
        scan.values
            .get(idx)
            .map(|s| LosslessString::from(s.as_str()))
    };

    let is_write_mode = |mode_str: Option<&str>| -> bool {
        let mode = mode_str.unwrap_or("r");
        mode.chars().any(|c| matches!(c, 'w' | 'a' | 'x' | '+'))
    };

    if let Ok(mut re) = RegExp::new(
        &text(r"\bopen\(\s*(?:file\s*=\s*)?\x01(\d+)\x02(?:\s*,\s*(?:mode\s*=\s*)?\x01(\d+)\x02)?"),
        "g",
    ) {
        let mut budget = Budget::unlimited();
        while let Ok(Some(m)) = re.exec(&input_units, &mut budget) {
            let target_idx = capture_str(&m.captures, 1);
            let mode_idx = capture_str(&m.captures, 2);
            if let Some(target_str) = target_idx.as_deref().and_then(&val) {
                let mode_str = mode_idx.as_deref().and_then(&val);
                let mode_slice = mode_str.as_ref().and_then(|m| m.as_str());
                if is_write_mode(mode_slice) {
                    writes.push(target_str);
                } else {
                    reads.push(target_str);
                }
            }
        }
    }

    if let Ok(mut re) = RegExp::new(
        &text(
            r"\bPath\(\s*\x01(\d+)\x02\s*\)\s*\.\s*(read_text|read_bytes|write_text|write_bytes|touch|unlink|mkdir|rmdir|rename|replace|open)\s*\((?:\s*(?:mode\s*=\s*)?\x01(\d+)\x02)?",
        ),
        "g",
    ) {
        let mut budget = Budget::unlimited();
        while let Ok(Some(m)) = re.exec(&input_units, &mut budget) {
            let target_idx = capture_str(&m.captures, 1);
            let method = capture_str(&m.captures, 2);
            let mode_or_dest_idx = capture_str(&m.captures, 3);
            if let (Some(target), Some(method_name)) =
                (target_idx.as_deref().and_then(&val), method)
            {
                match method_name.as_str() {
                    "read_text" | "read_bytes" => reads.push(target),
                    "open" => {
                        let mode_str = mode_or_dest_idx.as_deref().and_then(&val);
                        let mode_slice = mode_str.as_ref().and_then(|m| m.as_str());
                        if is_write_mode(mode_slice) {
                            writes.push(target);
                        } else {
                            reads.push(target);
                        }
                    }
                    _ => {
                        writes.push(target);
                        if matches!(method_name.as_str(), "rename" | "replace")
                            && let Some(dest) = mode_or_dest_idx.as_deref().and_then(&val)
                        {
                            writes.push(dest);
                        }
                    }
                }
            }
        }
    }

    if let Ok(mut re) = RegExp::new(
        &text(
            r"\b(?:os\.(?:remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs)|shutil\.(?:copy|copy2|copyfile|copytree|move|rmtree))\(([^)]*)\)",
        ),
        "g",
    ) {
        let mut budget = Budget::unlimited();
        while let Ok(Some(m)) = re.exec(&input_units, &mut budget) {
            if let Some(args_units) = m.captures.get(1).and_then(|c| c.as_ref())
                && let Ok(mut sub_re) = RegExp::new(&text(r"\x01(\d+)\x02"), "g")
            {
                let mut sub_budget = Budget::unlimited();
                while let Ok(Some(sub_m)) = sub_re.exec(args_units, &mut sub_budget) {
                    if let Some(target_idx) = capture_str(&sub_m.captures, 1)
                        && let Some(target) = val(&target_idx)
                    {
                        writes.push(target);
                    }
                }
            }
        }
    }

    PythonAccess { reads, writes }
}

const DATABASE_PATTERN: &str = r"\b(?:drop(?:\s|/\*[\s\S]*?\*/)+(?:database|schema|table)|truncate(?:\s|/\*[\s\S]*?\*/)+table|delete(?:\s|/\*[\s\S]*?\*/)+from\b)";
const DATABASE_CLIENTS: &[&str] = &[
    "psql",
    "pgcli",
    "mysql",
    "mycli",
    "mariadb",
    "sqlite",
    "sqlite3",
    "litecli",
    "sqlcmd",
    "sqlplus",
    "isql",
    "usql",
    "duckdb",
    "clickhouse-client",
    "mongosh",
    "cockroach",
];
const BENIGN_SQLITE_FLAGS: &[&str] = &[
    "-batch",
    "-header",
    "-noheader",
    "-column",
    "-box",
    "-table",
    "-csv",
    "-line",
    "-json",
    "-bail",
    "-echo",
    "-quiet",
];

pub(super) struct DatabaseMention {
    pub segment: LosslessString,
    pub confirmed: bool,
    pub uncertain_execution: bool,
}

fn sql_matches(value: &LosslessString, pattern: &str, flags: &str) -> Vec<crate::regexp::Match> {
    let mut regex = RegExp::new(&text(pattern), flags).expect("static SQL boundary pattern");
    let input = units(value);
    let mut budget = Budget::unlimited();
    let mut matches = vec![];
    while let Some(found) = regex
        .exec(&input, &mut budget)
        .expect("unlimited SQL boundary pattern")
    {
        matches.push(found);
    }
    matches
}

fn database_client(segment: &Segment) -> bool {
    segment
        .tokens
        .iter()
        .position(|token| {
            basename(token)
                .as_str()
                .is_some_and(|name| DATABASE_CLIENTS.contains(&name))
        })
        .is_some_and(|index| {
            segment.tokens[..index].iter().all(|token| {
                matches!(
                    basename(token).as_str(),
                    Some("sudo" | "command" | "env" | "nohup")
                ) || units(token).starts_with(&[45])
                    || regex(token, "^[A-Za-z_][A-Za-z0-9_]*=", "")
            })
        })
}

pub(super) fn unknown_sqlite_import(segment: &Segment) -> bool {
    database_client(segment)
        && segment
            .tokens
            .iter()
            .any(|token| matches!(basename(token).as_str(), Some("sqlite" | "sqlite3")))
        && segment.tokens.iter().any(|token| {
            sql_matches(token, r"^\s*\.import\s+([^\n]*)", "gim")
                .iter()
                .any(|found| {
                    let Some(arguments) = found.captures.get(1).and_then(Option::as_ref) else {
                        return false;
                    };
                    sql_matches(
                        &LosslessString::from_utf16(arguments.clone()),
                        r"(?:^|\s)(--[\w-]+)",
                        "g",
                    )
                    .iter()
                    .any(|option| {
                        !matches!(
                            capture_str(&option.captures, 1).as_deref(),
                            Some("--csv" | "--ascii" | "--skip" | "--schema")
                        )
                    })
                })
        })
}

fn psql_commands(sql: &LosslessString) -> Vec<LosslessString> {
    let input = units(sql);
    let mut result = vec![];
    let mut quote = None;
    let mut dollar: Option<Vec<u16>> = None;
    let mut block = false;
    let mut line_start = true;
    let mut index = 0;
    while index < input.len() {
        let rest = &input[index..];
        let unit = input[index];
        if block {
            if rest.starts_with(&[42, 47]) {
                block = false;
                index += 1;
            }
        } else if let Some(tag) = &dollar {
            if rest.starts_with(tag) {
                index += tag.len() - 1;
                dollar = None;
            }
        } else if let Some(delimiter) = quote {
            if unit == 92 {
                index += 1;
            } else if unit == delimiter {
                if input.get(index + 1) == Some(&delimiter) {
                    index += 1;
                } else {
                    quote = None;
                }
            }
        } else if unit == 10 {
            line_start = true;
        } else if line_start && matches!(unit, 32 | 9 | 13) {
        } else if line_start && unit == 92 {
            let length = rest
                .iter()
                .position(|unit| *unit == 10)
                .unwrap_or(rest.len());
            result.push(LosslessString::from_utf16(rest[..length].to_vec()));
            index += length;
            continue;
        } else {
            line_start = false;
            if rest.starts_with(&[45, 45]) {
                index += rest
                    .iter()
                    .position(|unit| *unit == 10)
                    .unwrap_or(rest.len());
                continue;
            }
            if rest.starts_with(&[47, 42]) {
                block = true;
                index += 1;
            } else if matches!(unit, 39 | 34) {
                quote = Some(unit);
            } else if unit == 36
                && let Some(length) = super::regex_match_length(
                    &LosslessString::from_utf16(rest.to_vec()),
                    r"^\$(?:[a-zA-Z_][\w]*)?\$",
                )
            {
                dollar = Some(rest[..length].to_vec());
                index += length - 1;
            }
        }
        index += 1;
    }
    result
}

fn literal_shell_words(segment: &Segment) -> Option<Vec<String>> {
    let mut words = vec![];
    for raw in &segment.raw {
        let raw = raw.as_str()?;
        if raw
            .chars()
            .any(|character| matches!(character, '$' | '`' | '\\'))
        {
            return None;
        }
        let mut quote = None;
        let mut word = String::new();
        for character in raw.chars() {
            if Some(character) == quote {
                quote = None;
            } else if quote.is_none() && matches!(character, '\'' | '"') {
                quote = Some(character);
            } else {
                if quote.is_none()
                    && matches!(
                        character,
                        '*' | '?' | '[' | ']' | '{' | '}' | '~' | '(' | ')' | '<' | '>'
                    )
                {
                    return None;
                }
                word.push(character);
            }
        }
        if quote.is_some() {
            return None;
        }
        words.push(word);
    }
    Some(words)
}

fn sql_code(sql: &str) -> Option<String> {
    let input = sql.as_bytes();
    let mut code = String::new();
    let mut index = 0;
    while index < input.len() {
        let character = input[index];
        if matches!(character, b'\\' | b'$' | b'`') {
            return None;
        }
        if input[index..].starts_with(b"--")
            && input.get(index + 2).is_none_or(u8::is_ascii_whitespace)
        {
            index += input[index..]
                .iter()
                .position(|character| *character == b'\n')
                .unwrap_or(input.len() - index);
            code.push(' ');
        } else if input[index..].starts_with(b"/*") {
            let length = input[index + 2..]
                .windows(2)
                .position(|pair| pair == b"*/")?;
            let body = &input[index + 2..index + 2 + length];
            if matches!(body.first(), Some(b'!' | b'+'))
                || body.starts_with(b"M!")
                || body.starts_with(b"m!")
                || body.windows(2).any(|pair| pair == b"/*")
            {
                return None;
            }
            index += length + 3;
            code.push(' ');
        } else if matches!(character, b'\'' | b'"') {
            let mut closed = false;
            index += 1;
            while index < input.len() {
                if input[index] == b'\\' {
                    return None;
                }
                if input[index] == character {
                    if input.get(index + 1) == Some(&character) {
                        index += 2;
                        continue;
                    }
                    closed = true;
                    break;
                }
                index += 1;
            }
            if !closed {
                return None;
            }
            code.push('0');
        } else {
            code.push(char::from(character));
        }
        index += 1;
    }
    (!regex(&code.as_str().into(), r"^\s*\.", "m")).then_some(code)
}

fn read_only_sql(sql: &str) -> bool {
    let Some(code) = sql_code(sql) else {
        return false;
    };
    code.split(';').filter(|statement| !statement.trim().is_empty()).all(|statement| {
        let value = LosslessString::from(statement);
        regex(&value, r"^\s*(?:explain\s+)?select\b", "i")
            && !regex(&value, r"[^\w\s.,*()=<>!+\-/%0-9]", "")
            && !regex(&value, r"\b(?:drop|truncate|delete|insert|update|create|alter|attach|detach|into|outfile|dumpfile|copy|call|do|execute|analyze|analyzer|pragma)\b", "i")
            && sql_matches(&value, r"(?:\b\w+\s*\.\s*)?(\b\w+)\s*\(", "g").iter().all(|call| {
                let tail = LosslessString::from_utf16(units(&value)[call.index..].to_vec());
                regex(&tail, r"^count\s*\(\s*\*\s*\)", "i")
            })
    })
}

fn qualified_delete(sql: &str) -> bool {
    let Some(code) = sql_code(sql) else {
        return false;
    };
    if regex(&code.as_str().into(), r"[^\w\s.,*()=<>!+\-/%0-9;]", "") {
        return false;
    }
    let statements = code
        .split(';')
        .filter(|statement| !statement.trim().is_empty())
        .collect::<Vec<_>>();
    !statements.is_empty()
        && statements.iter().all(|statement| {
            let value = LosslessString::from(*statement);
            if !regex(&value, r"^\s*delete\s+from\b", "i") || regex(&value, r"\b\w+\s*\(", "") {
                return false;
            }
            let mut depth = 0usize;
            let mut where_end = None;
            for token in sql_matches(&value, r"\(|\)|\b(?:where|returning)\b", "gi") {
                let token_text = capture_str(&token.captures, 0).expect("SQL token");
                match token_text.as_str() {
                    "(" => depth += 1,
                    ")" => {
                        let Some(next) = depth.checked_sub(1) else {
                            return false;
                        };
                        depth = next;
                    }
                    _ if depth == 0
                        && token_text.eq_ignore_ascii_case("returning")
                        && where_end.is_none() =>
                    {
                        return false;
                    }
                    _ if depth == 0
                        && token_text.eq_ignore_ascii_case("where")
                        && where_end.is_none() =>
                    {
                        where_end = Some(token.index + token_text.len())
                    }
                    _ => {}
                }
            }
            depth == 0 && where_end.is_some_and(|index| !statement[index..].trim().is_empty())
        })
}

fn literal_database_queries(segment: &Segment) -> Option<Vec<String>> {
    let words = literal_shell_words(segment)?;
    if !segment.heredoc_bodies.is_empty()
        || words
            .iter()
            .any(|word| redirection(&word.as_str().into()).is_some())
    {
        return None;
    }
    let name = basename(&words.first()?.as_str().into());
    let name = name.as_str()?;
    let sqlite = matches!(name, "sqlite" | "sqlite3");
    if !sqlite && !matches!(name, "psql" | "mysql" | "mariadb") {
        return None;
    }
    let mut queries = vec![];
    let mut database = false;
    let mut index = 1;
    while index < words.len() {
        let token = &words[index];
        if sqlite {
            if BENIGN_SQLITE_FLAGS.contains(&token.as_str()) {
            } else if token.starts_with('-') {
                return None;
            } else if !database {
                database = true;
            } else {
                queries.push(token.clone());
            }
        } else {
            let (short, long) = if name == "psql" {
                ("-c", "--command")
            } else {
                ("-e", "--execute")
            };
            if token == short || token == long {
                index += 1;
                queries.push(words.get(index)?.clone());
            } else if let Some(sql) = token.strip_prefix(&format!("{long}=")) {
                queries.push(sql.into());
            } else {
                let sql = token.strip_prefix(short).filter(|sql| !sql.is_empty())?;
                queries.push(sql.into());
            }
        }
        index += 1;
    }
    (!queries.is_empty()).then_some(queries)
}

fn sql_metadata(segment: &Segment) -> bool {
    let Some(words) = literal_shell_words(segment) else {
        return false;
    };
    if !segment.heredoc_bodies.is_empty()
        || words
            .iter()
            .any(|word| redirection(&word.as_str().into()).is_some())
    {
        return false;
    }
    let name = words.first().map(|word| basename(&word.as_str().into()));
    if name.as_ref().and_then(LosslessString::as_str) == Some("git") {
        if !words.get(1).is_some_and(|word| {
            ["commit", "tag", "merge", "stash", "notes"].contains(&word.as_str())
        }) {
            return false;
        }
        let mut message = false;
        let mut index = 2;
        while index < words.len() {
            let token = &words[index];
            if token == "-m" || token == "--message" {
                index += 1;
                if words.get(index).is_none() {
                    return false;
                }
                message = true;
            } else if token.starts_with("--message=")
                || (token.starts_with("-m") && token.len() > 2)
            {
                message = true;
            } else if ![
                "-a",
                "--all",
                "--amend",
                "--no-edit",
                "--allow-empty",
                "--allow-empty-message",
            ]
            .contains(&token.as_str())
            {
                return false;
            }
            index += 1;
        }
        return message;
    }
    if name.as_ref().and_then(LosslessString::as_str) != Some("gh")
        || words.get(1).map(String::as_str) != Some("api")
        || !words.get(2).is_some_and(|endpoint| {
            regex(
                &endpoint.as_str().into(),
                r"^/repos/[^/]+/[^/]+/issues(?:/\d+)?$",
                "",
            )
        })
    {
        return false;
    }
    let mut index = 3;
    let mut field = false;
    while index < words.len() {
        if !["-f", "--raw-field", "-F", "--field"].contains(&words[index].as_str())
            || !words
                .get(index + 1)
                .is_some_and(|value| regex(&value.as_str().into(), r"^(?:title|body)=(?!@)", ""))
        {
            return false;
        }
        field = true;
        index += 2;
    }
    field
}

fn decoded_printf(value: &LosslessString) -> LosslessString {
    let input = units(value);
    let mut decoded = vec![];
    let mut index = 0;
    while index < input.len() {
        if input[index] != 92 || index + 1 == input.len() {
            decoded.push(input[index]);
            index += 1;
            continue;
        }
        index += 1;
        let (base, length) = if matches!(input[index], 120 | 88) {
            index += 1;
            (16, 2)
        } else if input[index] == 48
            && input
                .get(index + 1)
                .is_some_and(|unit| (48..=55).contains(unit))
        {
            index += 1;
            (8, 3)
        } else {
            (8, 3)
        };
        let start = index;
        let mut number = 0;
        while index < input.len() && index - start < length {
            let Some(digit) = char::from_u32(u32::from(input[index]))
                .and_then(|character| character.to_digit(base))
            else {
                break;
            };
            number = number * base + digit;
            index += 1;
        }
        if index > start {
            decoded.push(number as u16);
        } else if index < input.len() {
            decoded.push(if input[index] == 110 { 10 } else { 32 });
            index += 1;
        }
    }
    LosslessString::from_utf16(decoded)
}

pub(super) fn inert_segments(resource: &LosslessString) -> Vec<bool> {
    let parsed = segments(resource);
    let input = units(resource);
    let mut inert = vec![false; parsed.len()];
    let mut group: Vec<usize> = vec![];
    let settle = |group: &mut Vec<usize>, inert: &mut Vec<bool>| {
        if !group.is_empty()
            && group.iter().all(|index| {
                let segment = &parsed[*index];
                read_only(&LosslessString::from_utf16(
                    input[segment.start..segment.end].to_vec(),
                ))
            })
        {
            for index in group.iter() {
                inert[*index] = true;
            }
        }
        group.clear();
    };
    for (index, segment) in parsed.iter().enumerate() {
        if index > 0 && ["; ", "\n ", " && ", " || "].contains(&segment.separator.as_str()) {
            settle(&mut group, &mut inert);
        }
        group.push(index);
    }
    settle(&mut group, &mut inert);
    inert
}

pub(super) fn database_mention(resource: &LosslessString) -> Option<DatabaseMention> {
    let (segments, comments) = scan(resource);
    let mut groups: Vec<Vec<&Segment>> = vec![];
    for segment in &segments {
        if groups.is_empty() || ["; ", "\n ", " && ", " || "].contains(&segment.separator.as_str())
        {
            groups.push(vec![]);
        }
        groups.last_mut().expect("shell group").push(segment);
    }
    let inert_indexes = inert_segments(resource);
    let inert = comments
        .into_iter()
        .chain(
            segments
                .iter()
                .enumerate()
                .filter(|(index, _)| inert_indexes.get(*index).copied().unwrap_or(false))
                .map(|(_, segment)| (segment.start, segment.end)),
        )
        .collect::<Vec<_>>();
    let mut mentions = sql_matches(resource, DATABASE_PATTERN, "gi")
        .into_iter()
        .map(|found| found.index)
        .collect::<Vec<_>>();
    mentions.extend(
        segments
            .iter()
            .filter(|segment| {
                regex(&super::joined(&segment.tokens), DATABASE_PATTERN, "i")
                    || segment
                        .heredoc_bodies
                        .iter()
                        .any(|body| regex(body, DATABASE_PATTERN, "i"))
                    || (segment
                        .tokens
                        .first()
                        .is_some_and(|token| basename(token).as_str() == Some("printf"))
                        && regex(
                            &decoded_printf(&super::joined(&segment.raw)),
                            DATABASE_PATTERN,
                            "i",
                        ))
            })
            .map(|segment| segment.start),
    );
    let mut candidates = vec![];
    for index in mentions.into_iter().filter(|index| {
        !inert
            .iter()
            .any(|(start, end)| index >= start && index < end)
    }) {
        let segment = segments
            .iter()
            .find(|segment| index >= segment.start && index < segment.end)
            .or_else(|| {
                segments.iter().find(|segment| {
                    segment
                        .heredoc_ranges
                        .iter()
                        .any(|(start, end)| index >= *start && index < *end)
                })
            });
        let group = segment.and_then(|segment| {
            groups
                .iter()
                .find(|group| group.iter().any(|item| item.index == segment.index))
        });
        if let Some(segment) = segment.filter(|_| group.is_some_and(|group| group.len() == 1))
            && (literal_database_queries(segment).is_some_and(|queries| {
                queries.iter().all(|sql| read_only_sql(sql))
                    || queries.iter().all(|sql| qualified_delete(sql))
            }) || sql_metadata(segment))
        {
            continue;
        }
        let confirmed =
            group.is_some_and(|group| group.iter().any(|segment| database_client(segment)));
        let carrier = |segment: &Segment| {
            segment.tokens.first().is_some_and(|token| {
                matches!(
                    basename(token).as_str(),
                    Some("echo" | "printf" | "tee" | "cat")
                )
            })
        };
        candidates.push(DatabaseMention {
            segment: segment.map_or_else(
                || super::collapse(resource),
                |segment| super::joined(&segment.raw),
            ),
            confirmed,
            uncertain_execution: !confirmed
                && (segment.is_none_or(|segment| !carrier(segment))
                    || group.is_some_and(|group| {
                        group
                            .iter()
                            .any(|item| !carrier(item) && !read_only(&super::joined(&item.raw)))
                    })),
        });
    }
    if let Some(index) = candidates
        .iter()
        .position(|candidate| candidate.confirmed)
        .or_else(|| {
            candidates
                .iter()
                .position(|candidate| candidate.uncertain_execution)
        })
    {
        return Some(candidates.remove(index));
    }
    if let Some(group) = groups.iter().find(|group| {
        group.iter().any(|segment| database_client(segment))
            && group.iter().any(|segment| {
                segment
                    .tokens
                    .first()
                    .is_some_and(|token| basename(token).as_str() == Some("printf"))
                    && segment.raw.iter().any(|token| regex(token, "[$`]", ""))
            })
    }) {
        let mut command = vec![];
        for (index, segment) in group.iter().enumerate() {
            if index > 0 {
                command.extend(text(" | "));
            }
            command.extend(units(&super::joined(&segment.raw)));
        }
        return Some(DatabaseMention {
            segment: LosslessString::from_utf16(command),
            confirmed: false,
            uncertain_execution: true,
        });
    }
    if let Some(segment) = segments
        .iter()
        .find(|segment| {
            database_client(segment)
                && segment.tokens.iter().any(|token| {
                    psql_commands(token).iter().any(|command| {
                        regex(command, r"^\\copy\b[^\n]*\b(?:from|to)\s+program\b", "i")
                    })
                })
        })
        .or_else(|| {
            segments.iter().find(|segment| {
                database_client(segment)
                    && segment
                        .tokens
                        .iter()
                        .any(|token| regex(token, r"\$", "") && regex(token, r"\\copy\b", "i"))
            })
        })
    {
        return Some(DatabaseMention {
            segment: super::joined(&segment.raw),
            confirmed: false,
            uncertain_execution: true,
        });
    }
    candidates.into_iter().next()
}

const PYTHON_VALUE_OPTIONS: &[&str] = &["-W", "-X", "--check-hash-based-pycs"];

fn python_script_index(args: &[LosslessString]) -> Option<usize> {
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let arg_str = arg.as_str().unwrap_or("");
        if arg_str == "--" {
            return if index + 1 < args.len() {
                Some(index + 1)
            } else {
                None
            };
        }
        if matches!(arg_str, "-c" | "-m" | "-") {
            return None;
        }
        if PYTHON_VALUE_OPTIONS.contains(&arg_str) {
            index += 2;
            continue;
        }
        if units(arg).starts_with(&[45]) {
            index += 1;
            continue;
        }
        return Some(index);
    }
    None
}

fn command_arguments(
    name: &LosslessString,
    args: &[LosslessString],
    heredoc_bodies: &[LosslessString],
    include_read_targets: bool,
) -> Vec<LosslessString> {
    let name_str = name.as_str();
    if matches!(name_str, Some("echo" | "printf")) {
        return vec![];
    }
    if matches!(name_str, Some("psql" | "mysql" | "mariadb")) {
        let (short, long) = if name_str == Some("psql") {
            ("-c", "--command")
        } else {
            ("-e", "--execute")
        };
        let mut kept = vec![];
        let mut index = 0;
        while index < args.len() {
            let arg = &args[index];
            let sql = if arg.as_str().is_some_and(|arg| arg == short || arg == long) {
                index += 1;
                args.get(index).cloned()
            } else {
                let value = units(arg);
                let long = text(&format!("{long}="));
                let short = text(short);
                value
                    .strip_prefix(long.as_slice())
                    .or_else(|| {
                        value
                            .strip_prefix(short.as_slice())
                            .filter(|sql| !sql.is_empty())
                    })
                    .map(|sql| LosslessString::from_utf16(sql.to_vec()))
            };
            let Some(sql) = sql else {
                kept.push(arg.clone());
                index += 1;
                continue;
            };
            if !sql.as_str().is_some_and(read_only_sql) {
                kept.push(sql.clone());
            }
            if name_str == Some("psql") {
                let commands = psql_commands(&sql);
                let mut command_text = vec![];
                for (index, command) in commands.iter().enumerate() {
                    if index > 0 {
                        command_text.push(10);
                    }
                    command_text.extend(units(command));
                }
                for found in sql_matches(
                    &LosslessString::from_utf16(command_text),
                    r#"(?:^|\n)\s*\\copy\s+(?:\([^\n]*\)|[^\n]*?)\s+\b(?:from|to)\s+(?:'([^']+)'|"([^"]+)"|([^\s;]+))"#,
                    "gi",
                ) {
                    if let Some(target) = found
                        .captures
                        .into_iter()
                        .skip(1)
                        .flatten()
                        .next()
                        .map(LosslessString::from_utf16)
                        && !target
                            .as_str()
                            .is_some_and(|target| target.eq_ignore_ascii_case("program"))
                    {
                        kept.push(target);
                    }
                }
                for command in commands {
                    for found in sql_matches(
                        &command,
                        r#"^\\(?:i|ir|o|w)\s+(?:'([^']+)'|"([^"]+)"|([^\s;]+))"#,
                        "gi",
                    ) {
                        if let Some(target) = found.captures.into_iter().skip(1).flatten().next() {
                            kept.push(LosslessString::from_utf16(target));
                        }
                    }
                }
            }
            index += 1;
        }
        return kept;
    }
    if matches!(name_str, Some("sqlite" | "sqlite3")) {
        let mut targets = args.to_vec();
        for arg in args {
            for (pattern, flags) in [
                (
                    r#"^\s*\.(?:read|open|output|once|import|backup|restore|save|log)\s+(?:(?:--(?:skip|schema)(?:=\S+|\s+\S+)|--(?:csv|ascii))\s+)*(?!-)(?:'([^']+)'|"([^"]+)"|(\S+))"#,
                    "gim",
                ),
                (
                    r#"\b(?:attach(?:\s+database)?|vacuum\s+into|(?:readfile|writefile)\s*\()\s*(?:'([^']+)'|"([^"]+)")"#,
                    "gi",
                ),
            ] {
                for found in sql_matches(arg, pattern, flags) {
                    if let Some(target) = found.captures.into_iter().skip(1).flatten().next() {
                        targets.push(LosslessString::from_utf16(target));
                    }
                }
            }
        }
        return targets;
    }
    if matches!(
        name_str,
        Some(
            "sh" | "bash"
                | "zsh"
                | "node"
                | "bun"
                | "deno"
                | "python"
                | "python3"
                | "ruby"
                | "perl"
        )
    ) {
        let is_python = matches!(name_str, Some("python" | "python3"));
        let script = if is_python {
            python_script_index(args)
        } else {
            args.iter().position(|arg| !units(arg).starts_with(&[45]))
        };
        let argv: Vec<LosslessString> = args
            .iter()
            .enumerate()
            .filter(|(index, _)| include_read_targets || Some(*index) != script)
            .map(|(_, arg)| arg.clone())
            .collect();
        let kept = if is_python {
            drop_named_value_options(&argv, SCRIPT_TRANSPORT_OPTIONS)
        } else {
            argv
        };
        if !is_python {
            return kept;
        }
        let code = args
            .iter()
            .position(|arg| arg.as_str() == Some("-c"))
            .and_then(|idx| args.get(idx + 1));
        let mut sources = Vec::new();
        if let Some(c) = code
            && let Some(s) = c.as_str()
        {
            sources.push(s);
        }
        for body in heredoc_bodies {
            if let Some(s) = body.as_str() {
                sources.push(s);
            }
        }
        let mut result = kept;
        for source in sources {
            let access = python_file_access(source);
            result.extend(access.writes);
            if include_read_targets {
                result.extend(access.reads);
            }
        }
        return result;
    }
    if name_str == Some("git") {
        let previous = |index: usize| index.checked_sub(1).and_then(|i| args[i].as_str());
        let subcommand = args.iter().enumerate().position(|(index, arg)| {
            !units(arg).starts_with(&[45])
                && !matches!(
                    previous(index),
                    Some("-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace")
                )
        });
        let Some(subcommand) = subcommand.filter(|index| {
            matches!(
                args[*index].as_str(),
                Some("commit" | "tag" | "merge" | "stash" | "notes")
            )
        }) else {
            return args.to_vec();
        };
        return args
            .iter()
            .enumerate()
            .filter(|(index, arg)| {
                *index <= subcommand
                    || !(previous(*index).is_some_and(|prev| {
                        prev == "--message" || regex(&prev.into(), "^-[A-Za-z]*m$", "")
                    }) || units(arg).starts_with(&text("--message=")))
            })
            .map(|(_, arg)| arg.clone())
            .collect();
    }
    if name_str == Some("gh") {
        let previous = |index: usize| index.checked_sub(1).and_then(|i| args[i].as_str());
        let endpoint = (args.first().and_then(LosslessString::as_str) == Some("api"))
            .then(|| {
                args.iter().enumerate().position(|(index, arg)| {
                    index > 0
                        && !units(arg).starts_with(&[45])
                        && !matches!(
                            previous(index),
                            Some(
                                "-X" | "--method"
                                    | "-H"
                                    | "--header"
                                    | "-f"
                                    | "--raw-field"
                                    | "-F"
                                    | "--field"
                                    | "-q"
                                    | "--jq"
                                    | "-t"
                                    | "--template"
                                    | "-p"
                                    | "--preview"
                                    | "--input"
                                    | "--hostname"
                                    | "--cache"
                            )
                        )
                })
            })
            .flatten();
        return args
            .iter()
            .enumerate()
            .filter(|(index, arg)| {
                Some(*index) != endpoint
                    && !matches!(
                        previous(*index),
                        Some("--title" | "-t" | "--body" | "-b" | "--notes" | "--subject")
                    )
                    && !regex(arg, "^--(?:title|body|notes|subject)=", "")
            })
            .map(|(_, arg)| arg.clone())
            .collect();
    }
    if matches!(name_str, Some("curl" | "wget" | "http" | "https" | "xh")) {
        return http_client_file_args(name_str.unwrap(), args);
    }
    if name_str == Some("ycoding")
        && let Some(api) = ycoding_api_args(args)
    {
        return api;
    }
    args.to_vec()
}

pub(super) fn executable(
    tokens: &[LosslessString],
) -> Option<(LosslessString, Vec<LosslessString>)> {
    let cleaned = tokens
        .iter()
        .map(|token| {
            let value = units(token);
            let start = value.iter().take_while(|unit| **unit == 40).count();
            let end = value.len() - value.iter().rev().take_while(|unit| **unit == 41).count();
            LosslessString::from_utf16(value[start.min(end)..end].to_vec())
        })
        .collect::<Vec<_>>();
    let index = cleaned
        .iter()
        .position(|token| matches!(basename(token).as_str(), Some("rm" | "cd")))?;
    if cleaned[..index].iter().any(|token| {
        !matches!(
            basename(token).as_str(),
            Some("sudo" | "command" | "env" | "nohup")
        ) && !shell_keyword(token)
            && !units(token).starts_with(&[45])
            && !regex(token, "^[A-Za-z_][A-Za-z0-9_]*=", "")
    }) {
        return None;
    }
    Some((basename(&cleaned[index]), cleaned[index + 1..].to_vec()))
}

pub(super) fn workdirs(command: &LosslessString, paths: &Paths) -> Vec<Operation> {
    let mut states = vec![(paths.workdir.clone(), true)];
    let mut result = vec![];
    for segment in segments(command) {
        let (executing, skipped): (Vec<_>, Vec<_>) =
            states
                .into_iter()
                .partition(|(_, succeeded)| match segment.connector {
                    Connector::Always => true,
                    Connector::And => *succeeded,
                    Connector::Or => !*succeeded,
                });
        let invocation = executable(&segment.tokens);
        let destination = invocation
            .as_ref()
            .filter(|(name, _)| name.as_str() == Some("cd"))
            .and_then(|(_, args)| {
                let target = args
                    .iter()
                    .position(|token| token.as_str() == Some("--"))
                    .and_then(|index| args.get(index + 1))
                    .or_else(|| args.iter().find(|token| !units(token).starts_with(&[45])));
                target.cloned().or_else(|| {
                    args.iter()
                        .all(|token| token.as_str() == Some("--"))
                        .then(|| paths.home.clone())
                })
            });
        let is_cd = invocation
            .as_ref()
            .is_some_and(|(name, _)| name.as_str() == Some("cd"));
        let mut outcomes = skipped;
        for (workdir, _) in executing {
            if is_cd
                || !result.iter().any(|operation: &Operation| {
                    operation.segment.index == segment.index && operation.workdir == workdir
                })
            {
                result.push(Operation {
                    segment: segment.clone(),
                    workdir: workdir.clone(),
                });
            }
            outcomes.push((
                if let Some(destination) = &destination {
                    resolve(destination, &workdir, paths)
                } else {
                    workdir.clone()
                },
                true,
            ));
            outcomes.push((workdir, false));
        }
        states = vec![];
        for outcome in outcomes {
            if !states.contains(&outcome) {
                states.push(outcome);
            }
        }
    }
    result
}

pub(super) fn removals(command: &LosslessString, paths: &Paths) -> Vec<Removal> {
    workdirs(command, paths)
        .into_iter()
        .filter_map(|operation| {
            let (name, args) = executable(&operation.segment.tokens)?;
            if name.as_str() != Some("rm") {
                return None;
            }
            let separator = args.iter().position(|token| token.as_str() == Some("--"));
            let options = &args[..separator.unwrap_or(args.len())];
            let recursive = options.iter().any(|token| {
                token.as_str() == Some("--recursive") || regex(token, "^-[^-].*[rR]|^-[rR]", "")
            });
            let start = operation.segment.tokens.len() - args.len();
            let targets = args
                .into_iter()
                .enumerate()
                .filter(|(index, token)| {
                    separator.is_some_and(|separator| *index > separator)
                        || (token.as_str() != Some("--") && !regex(token, "^-|^[<>]", ""))
                })
                .map(|(index, token)| (start + index, token))
                .collect();
            Some(Removal {
                recursive,
                targets,
                workdir: operation.workdir,
                segment: operation.segment.index,
            })
        })
        .collect()
}

pub(super) fn read_only(command: &LosslessString) -> bool {
    let input = units(command);
    let mut output = vec![];
    let mut quote = None;
    let mut index = 0;
    while index < input.len() {
        let unit = input[index];
        if quote == Some(39) {
            output.push(unit);
            if unit == 39 {
                quote = None;
            }
            index += 1;
            continue;
        }
        if unit == 96 || (quote.is_none() && matches!(unit, 40 | 41 | 123 | 125 | 35)) {
            return false;
        }
        if unit == 36
            && input.get(index + 1).is_some_and(|next| {
                (65..=90).contains(next)
                    || (97..=122).contains(next)
                    || (48..=57).contains(next)
                    || matches!(next, 95 | 123 | 40 | 91 | 64 | 42 | 35 | 63 | 36 | 33 | 45)
            })
        {
            return false;
        }
        if unit == 92 {
            if input.get(index + 1).is_none_or(|unit| *unit == 10) {
                return false;
            }
            output.extend(&input[index..index + 2]);
            index += 2;
            continue;
        }
        if let Some(current) = quote {
            output.push(unit);
            if current == unit {
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(unit, 39 | 34) {
            quote = Some(unit);
            output.push(unit);
            index += 1;
            continue;
        }
        if unit == 60 && matches!(input.get(index + 1), Some(60 | 40)) {
            return false;
        }
        if unit == 62
            || ((48..=57).contains(&unit)
                && input.get(index + 1) == Some(&62)
                && (index == 0
                    || whitespace(input[index - 1])
                    || matches!(input[index - 1], 59 | 124 | 38)))
        {
            let value = LosslessString::from_utf16(input[index..].to_vec());
            let Some(length) = super::regex_match_length(
                &value,
                "^(?:[012])?>(?:>\\s*/dev/null|\\s*/dev/null|&[012])(?=\\s|[;|&]|$)",
            ) else {
                return false;
            };
            output.push(32);
            index += length;
            continue;
        }
        output.push(unit);
        index += 1;
    }
    if quote.is_some() {
        return false;
    }
    let segments = segments(&LosslessString::from_utf16(output));
    !segments.is_empty()
        && segments
            .iter()
            .all(|segment| read_only_invocation(&segment.tokens))
}

fn shell_keyword(token: &LosslessString) -> bool {
    matches!(
        token.as_str(),
        Some("!" | "if" | "then" | "else" | "elif" | "while" | "until" | "do")
    )
}

fn read_only_ycoding_api(args: &[LosslessString]) -> bool {
    if args.first().and_then(LosslessString::as_str) != Some("api") {
        return false;
    }
    let mut positionals = vec![];
    let mut index = 1;
    while index < args.len() {
        let argument = &args[index];
        if matches!(
            argument.as_str(),
            Some("-H" | "--header" | "--param" | "--server")
        ) {
            if args.get(index + 1).is_none() {
                return false;
            }
            index += 2;
            continue;
        }
        if regex(argument, "^--(?:header|param|server)=", "") {
            index += 1;
            continue;
        }
        if units(argument).starts_with(&[45]) {
            return false;
        }
        positionals.push(argument);
        index += 1;
    }
    positionals.len() == 2 && positionals[0].as_str() == Some("GET")
}

fn read_only_invocation(tokens: &[LosslessString]) -> bool {
    let mut start = 0;
    while tokens.get(start).is_some_and(shell_keyword) {
        start += 1;
    }
    while tokens
        .get(start)
        .is_some_and(|token| regex(token, r"^(?:LC_ALL|LC_[A-Z]+|LANG|LANGUAGE|TZ)=[^\s]+$", ""))
    {
        start += 1;
    }
    if tokens.get(start).and_then(LosslessString::as_str) == Some("command") {
        start += 1;
        if matches!(
            tokens.get(start).and_then(LosslessString::as_str),
            Some("-p" | "--")
        ) {
            start += 1;
        }
    }
    let Some(invocation) = tokens.get(start) else {
        return false;
    };
    let name = basename(invocation);
    let Some(name) = name.as_str() else {
        return false;
    };
    if ![
        "cat", "head", "tail", "wc", "ls", "grep", "egrep", "fgrep", "rg", "cut", "tr", "nl",
        "basename", "dirname", "realpath", "readlink", "stat", "file", "du", "df", "pwd", "echo",
        "printf", "which", "type", "true", "false", "test", "diff", "cmp", "comm", "jq", "sed",
        "find", "sort", "uniq", "git", "cd", "exit", "ps", "pgrep", "lsof", "ycoding", "gh",
    ]
    .contains(&name)
    {
        return false;
    }
    if invocation.as_str() != Some(name)
        && !matches!(
            dirname(invocation).as_str(),
            Some("/bin" | "/usr/bin" | "/usr/local/bin" | "/opt/homebrew/bin")
        )
    {
        return false;
    }
    let args = &tokens[start + 1..];
    if name == "sed" {
        let mut scripts = vec![];
        let mut index = 0;
        while index < args.len() {
            let argument = &args[index];
            if matches!(argument.as_str(), Some("-n" | "--quiet" | "--silent")) {
                index += 1;
                continue;
            }
            if matches!(argument.as_str(), Some("-e" | "--expression")) {
                let Some(next) = args.get(index + 1) else {
                    return false;
                };
                scripts.push(next.clone());
                index += 2;
                continue;
            }
            let value = units(argument);
            if value.starts_with(&text("-e")) || value.starts_with(&text("--expression=")) {
                scripts.push(LosslessString::from_utf16(
                    value[if value.starts_with(&text("-e")) {
                        2
                    } else {
                        13
                    }..]
                        .to_vec(),
                ));
                index += 1;
                continue;
            }
            if value.first() == Some(&45) {
                return false;
            }
            if scripts.is_empty() {
                scripts.push(argument.clone());
            }
            index += 1;
        }
        return !scripts.is_empty()
            && scripts.iter().all(|script| {
                units(script).split(|unit| *unit == 59).all(|part| {
                    regex(
                        &LosslessString::from_utf16(part.to_vec()),
                        "^\\s*(?:\\d+|\\$)?\\s*(?:,\\s*(?:\\d+|\\$)\\s*)?[pd=]\\s*$",
                        "",
                    )
                })
            });
    }
    if name == "find" {
        return !args.iter().any(|arg| {
            regex(
                arg,
                "^-(?:exec|execdir|ok|okdir|delete|fprint\\w*|fls)$",
                "",
            )
        });
    }
    if name == "rg" {
        return !args.iter().any(|arg| regex(arg, "^--pre(?:=|$)", ""));
    }
    if name == "sort" {
        return !args.iter().any(|arg| {
            regex(arg, "^-[^-]*o", "") || prefix_option(arg, &["--output", "--compress-program"])
        });
    }
    if name == "uniq" {
        let mut operands = 0;
        let mut index = 0;
        while index < args.len() {
            let argument = &args[index];
            if matches!(
                argument.as_str(),
                Some("-f" | "-s" | "-w" | "--skip-fields" | "--skip-chars" | "--check-chars")
            ) {
                index += 2;
                continue;
            }
            if argument.as_str() == Some("--") {
                operands += args.len() - index - 1;
                break;
            }
            if !units(argument).starts_with(&[45]) || argument.as_str() == Some("-") {
                operands += 1;
            }
            index += 1;
        }
        return operands <= 1;
    }
    if name == "file" {
        return !args
            .iter()
            .any(|arg| regex(arg, "^-[^-]*C", "") || prefix_option(arg, &["--compile"]));
    }
    if name == "jq" {
        return !args.iter().any(|arg| arg.as_str() == Some("--run-tests"));
    }
    if name == "ycoding" {
        return read_only_ycoding_api(args);
    }
    if name == "gh" {
        return args.first().and_then(LosslessString::as_str) == Some("run")
            && matches!(
                args.get(1).and_then(LosslessString::as_str),
                Some("view" | "list")
            );
    }
    if name != "git" {
        return true;
    }
    if args.iter().any(|arg| {
        prefix_option(
            arg,
            &[
                "--output",
                "--ext-diff",
                "--textconv",
                "--filters",
                "--open-files-in-pager",
                "--show-signature",
                "--help",
            ],
        ) || regex(
            arg,
            "%G|%\\(\\*?(?:signature|describe)(?=[:)])|(?:^|=)-?\\*?signature(?=[:]|$)",
            "",
        )
    }) {
        return false;
    }
    let mut index = 0;
    while args
        .get(index)
        .is_some_and(|arg| units(arg).starts_with(&[45]))
    {
        if args[index].as_str() == Some("--no-pager") {
            index += 1;
            continue;
        }
        if args[index].as_str() != Some("-C")
            || args
                .get(index + 1)
                .is_none_or(|arg| units(arg).starts_with(&[45]))
        {
            return false;
        }
        index += 2;
    }
    let args = &args[index..];
    let Some(command) = args.first().and_then(LosslessString::as_str) else {
        return false;
    };
    if [
        "status",
        "log",
        "diff",
        "show",
        "rev-parse",
        "ls-files",
        "blame",
        "merge-base",
        "check-ignore",
        "check-attr",
        "ls-tree",
        "cat-file",
        "rev-list",
        "name-rev",
        "for-each-ref",
        "show-ref",
        "shortlog",
        "count-objects",
        "var",
    ]
    .contains(&command)
    {
        return true;
    }
    match command {
        "describe" => !args[1..]
            .iter()
            .any(|arg| prefix_option(arg, &["--dirty", "--broken"])),
        "grep" => !args[1..].iter().any(|arg| regex(arg, "^-[^-]*O", "")),
        "config" => read_only_git_config(&args[1..]),
        "tag" => read_only_git_tag(&args[1..]),
        "stash" => args
            .get(1)
            .is_some_and(|arg| matches!(arg.as_str(), Some("list" | "show"))),
        "reflog" => !args[1..]
            .iter()
            .any(|arg| matches!(arg.as_str(), Some("expire" | "delete" | "drop" | "write"))),
        "branch" => {
            args.len() > 1
                && args[1..].iter().all(|arg| {
                    matches!(
                        arg.as_str(),
                        Some("--show-current" | "--list" | "-a" | "-r" | "-v")
                    )
                })
        }
        "worktree" => {
            args.get(1).is_some_and(|arg| arg.as_str() == Some("list"))
                && args[2..]
                    .iter()
                    .all(|arg| matches!(arg.as_str(), Some("--porcelain" | "-z" | "-v")))
        }
        "remote" => args.len() == 2 && args[1].as_str() == Some("-v"),
        _ => false,
    }
}

fn prefix_option(argument: &LosslessString, options: &[&str]) -> bool {
    let argument = units(argument);
    if !argument.starts_with(&[45, 45]) || argument.len() <= 2 {
        return false;
    }
    let argument = argument
        .split(|unit| *unit == 61)
        .next()
        .expect("split has one item");
    options
        .iter()
        .any(|option| text(option).starts_with(argument))
}

fn read_only_git_config(args: &[LosslessString]) -> bool {
    let mut operands = 0;
    let mut mode = None;
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if matches!(
            argument.as_str(),
            Some("--get" | "--get-all" | "--get-regexp" | "--list" | "-l")
        ) {
            if mode.is_some() {
                return false;
            }
            mode = argument.as_str();
            index += 1;
            continue;
        }
        if matches!(
            argument.as_str(),
            Some(
                "--show-origin"
                    | "--show-scope"
                    | "--name-only"
                    | "--global"
                    | "--local"
                    | "--system"
            )
        ) {
            index += 1;
            continue;
        }
        if argument.as_str() == Some("--file") {
            if args
                .get(index + 1)
                .is_none_or(|arg| units(arg).starts_with(&[45]))
            {
                return false;
            }
            index += 2;
            continue;
        }
        if regex(argument, "^--file=.+", "") {
            index += 1;
            continue;
        }
        if argument.as_str() == Some("--") {
            operands += args.len() - index - 1;
            break;
        }
        if units(argument).starts_with(&[45]) {
            return false;
        }
        operands += 1;
        index += 1;
    }
    if matches!(mode, Some("--list" | "-l")) {
        return operands == 0;
    }
    mode.is_some() && (1..=2).contains(&operands)
}

fn read_only_git_tag(args: &[LosslessString]) -> bool {
    let mut list = args.is_empty();
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if matches!(argument.as_str(), Some("-l" | "--list")) || regex(argument, "^-n\\d*$", "") {
            list = true;
            index += 1;
            continue;
        }
        if regex(argument, "^--(?:contains|points-at)(?:=|$)", "") {
            list = true;
            if !units(argument).contains(&61)
                && args
                    .get(index + 1)
                    .is_some_and(|arg| !units(arg).starts_with(&[45]))
            {
                index += 1;
            }
            index += 1;
            continue;
        }
        if matches!(argument.as_str(), Some("--sort" | "--format")) {
            if args
                .get(index + 1)
                .is_none_or(|arg| units(arg).starts_with(&[45]))
            {
                return false;
            }
            index += 2;
            continue;
        }
        if regex(argument, "^--(?:sort|format)=", "") {
            index += 1;
            continue;
        }
        if argument.as_str() == Some("--") {
            break;
        }
        if units(argument).starts_with(&[45]) {
            return false;
        }
        index += 1;
    }
    list
}
