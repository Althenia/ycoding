use super::paths::{basename, dirname, resolve, text, units, whitespace};
use super::{Paths, regex};
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
    };
    let mut quote = None;
    let mut escaped = false;
    let mut index = 0;
    while index < command.len() {
        let unit = command[index];
        if escaped {
            state.token.push(unit);
            escaped = false;
        } else if unit == 92 && quote != Some(39) {
            if state.token.is_empty() {
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
            if state.token.is_empty() {
                state.start = index;
            }
            quote = Some(unit);
            state.quoted = true;
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
            if state.token.is_empty() {
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
            if state.token.is_empty() {
                state.start = index;
            }
            state.token.push(unit);
        }
        index += 1;
    }
    state.push_segment(&command, Connector::Always, "", command.len());
    state.result
}

struct Heredoc {
    delimiter: Vec<u16>,
    strip: bool,
    quoted: bool,
    command: LosslessString,
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
}

impl Tokenizer {
    fn push_token(&mut self, command: &[u16], end: usize) {
        if self.token.is_empty() {
            return;
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
            Some(end) if !piped => end - 2,
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

pub(super) fn operands(tokens: &[LosslessString]) -> Vec<LosslessString> {
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
        ) && !units(token).starts_with(&[45])
            && !regex(token, "^[A-Za-z_][A-Za-z0-9_]*=", "")
    });
    let name = command.map_or_else(|| LosslessString::from(""), |index| basename(&words[index]));
    let args = command_arguments(&name, &words[command.map_or(0, |index| index + 1)..])
        .into_iter()
        .filter_map(|token| {
            let value = units(&token);
            let start = value
                .iter()
                .position(|unit| *unit == 61)
                .filter(|index| *index > 0)
                .map_or(0, |index| index + 1);
            let value = LosslessString::from_utf16(value[start..].to_vec());
            (!value.is_empty()
                && !units(&value).starts_with(&[45])
                && !regex(&value, r"^[a-z][a-z0-9+.-]*:\/\/", "i"))
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

fn command_arguments(name: &LosslessString, args: &[LosslessString]) -> Vec<LosslessString> {
    let previous = |index: usize| index.checked_sub(1).and_then(|index| args[index].as_str());
    match name.as_str() {
        Some("echo" | "printf") => vec![],
        Some(
            "sh" | "bash" | "zsh" | "node" | "bun" | "deno" | "python" | "python3" | "ruby"
            | "perl",
        ) => {
            let script = args.iter().position(|arg| !units(arg).starts_with(&[45]));
            args.iter()
                .enumerate()
                .filter(|(index, _)| Some(*index) != script)
                .map(|(_, arg)| arg.clone())
                .collect()
        }
        Some("git") => {
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
            args.iter()
                .enumerate()
                .filter(|(index, arg)| {
                    *index <= subcommand
                        || !(previous(*index).is_some_and(|previous| {
                            previous == "--message" || regex(&previous.into(), "^-[A-Za-z]*m$", "")
                        }) || units(arg).starts_with(&text("--message=")))
                })
                .map(|(_, arg)| arg.clone())
                .collect()
        }
        Some("gh") => {
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
            args.iter()
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
                .collect()
        }
        _ => args.to_vec(),
    }
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
        ) && !units(token).starts_with(&[45])
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
        if unit == 96 || unit == 36 || (quote.is_none() && matches!(unit, 40 | 41 | 123 | 125 | 35))
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
        if unit == 60 {
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

fn read_only_invocation(tokens: &[LosslessString]) -> bool {
    let name = basename(&tokens[0]);
    let Some(name) = name.as_str() else {
        return false;
    };
    if ![
        "cat", "head", "tail", "wc", "ls", "grep", "egrep", "fgrep", "rg", "cut", "tr", "nl",
        "basename", "dirname", "realpath", "readlink", "stat", "file", "du", "df", "pwd", "echo",
        "printf", "which", "type", "true", "false", "test", "diff", "cmp", "comm", "jq", "sed",
        "find", "sort", "uniq", "git", "cd", "exit", "ps", "pgrep", "lsof",
    ]
    .contains(&name)
    {
        return false;
    }
    if tokens[0].as_str() != Some(name)
        && !matches!(dirname(&tokens[0]).as_str(), Some("/bin" | "/usr/bin"))
    {
        return false;
    }
    let args = &tokens[1..];
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
