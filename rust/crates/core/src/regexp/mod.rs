use std::fmt;

mod case_data;
mod class;
mod matcher;
mod parser;
mod string;

pub use string::{StringMatch, replace_matches, substitution};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Syntax(String),
    StepLimit,
    Cancelled,
    RequiresGlobal,
    UnsupportedStringProperty(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Syntax(message) => f.write_str(message),
            Self::StepLimit => f.write_str("RegExp work limit exceeded"),
            Self::Cancelled => f.write_str("RegExp matching cancelled"),
            Self::RequiresGlobal => f.write_str("RegExp requires the global flag"),
            Self::UnsupportedStringProperty(name) => write!(
                f,
                "RegExp string property {name} has no approved data source"
            ),
        }
    }
}

impl std::error::Error for Error {}

pub struct Budget<'a> {
    pub remaining: Option<u64>,
    pub cancelled: Option<&'a dyn Fn() -> bool>,
}

impl Budget<'_> {
    pub const fn unlimited() -> Self {
        Self {
            remaining: None,
            cancelled: None,
        }
    }

    fn step(&mut self) -> Result<(), Error> {
        if self.cancelled.is_some_and(|cancelled| cancelled()) {
            return Err(Error::Cancelled);
        }
        if let Some(remaining) = &mut self.remaining {
            *remaining = remaining.checked_sub(1).ok_or(Error::StepLimit)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub captures: Vec<Option<Vec<u16>>>,
    pub index: usize,
    pub groups: Option<NamedGroups<Vec<u16>>>,
    pub indices: Option<Vec<Option<(usize, usize)>>>,
    pub index_groups: Option<NamedGroups<(usize, usize)>>,
}

pub type NamedGroups<T> = Vec<(Vec<u16>, Option<T>)>;

#[derive(Debug, Clone)]
pub struct RegExp {
    source: Vec<u16>,
    flags: String,
    pub last_index: u64,
    parsed_flags: Flags,
    program: parser::Program,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Flags {
    pub indices: bool,
    pub global: bool,
    pub ignore_case: bool,
    pub multiline: bool,
    pub dot_all: bool,
    pub unicode: bool,
    pub sets: bool,
    pub sticky: bool,
}

impl Flags {
    fn parse(input: &str) -> Result<Self, Error> {
        let mut seen = Vec::new();
        for flag in input.chars() {
            if !"dgimsuvy".contains(flag) || seen.contains(&flag) {
                return Err(Error::Syntax("Invalid RegExp flags".into()));
            }
            seen.push(flag);
        }
        if input.contains('u') && input.contains('v') {
            return Err(Error::Syntax(
                "Unicode flags u and v are mutually exclusive".into(),
            ));
        }
        Ok(Self {
            indices: input.contains('d'),
            global: input.contains('g'),
            ignore_case: input.contains('i'),
            multiline: input.contains('m'),
            dot_all: input.contains('s'),
            unicode: input.contains('u'),
            sets: input.contains('v'),
            sticky: input.contains('y'),
        })
    }
    fn unicode_mode(self) -> bool {
        self.unicode || self.sets
    }
    fn set_modifier(&mut self, flag: u16, enabled: bool) {
        match flag {
            105 => self.ignore_case = enabled,
            109 => self.multiline = enabled,
            115 => self.dot_all = enabled,
            _ => {}
        }
    }
}

pub(super) fn append_point(output: &mut Vec<u16>, cp: u32) {
    if cp <= 0xffff {
        output.push(cp as u16);
        return;
    }
    output.push((0xd800 + ((cp - 0x10000) >> 10)) as u16);
    output.push((0xdc00 + ((cp - 0x10000) & 0x3ff)) as u16);
}

pub(super) fn read_point(input: &[u16], offset: usize, unicode: bool) -> Option<(u32, usize)> {
    let first = u32::from(*input.get(offset)?);
    if unicode
        && (0xd800..=0xdbff).contains(&first)
        && let Some(second) = input
            .get(offset + 1)
            .copied()
            .map(u32::from)
            .filter(|second| (0xdc00..=0xdfff).contains(second))
    {
        return Some((0x10000 + ((first - 0xd800) << 10) + second - 0xdc00, 2));
    }
    Some((first, 1))
}

pub(super) fn advance(input: &[u16], offset: usize, unicode: bool) -> usize {
    offset.saturating_add(read_point(input, offset, unicode).map_or(1, |(_, width)| width))
}

impl RegExp {
    pub fn new(pattern: &[u16], flags: &str) -> Result<Self, Error> {
        Self::new_with_budget(pattern, flags, &mut Budget::unlimited())
    }

    pub fn new_with_budget(
        pattern: &[u16],
        flags: &str,
        budget: &mut Budget<'_>,
    ) -> Result<Self, Error> {
        let parsed_flags = Flags::parse(flags)?;
        let program = parser::parse(pattern, parsed_flags, budget)?;
        class::prepare_case(parsed_flags, budget)?;
        for node in &program.nodes {
            if let parser::Node::Modifiers(flags, _) = node {
                class::prepare_case(*flags, budget)?;
            }
        }
        let source = if pattern.is_empty() {
            "(?:)".encode_utf16().collect()
        } else {
            let mut source = Vec::new();
            let mut escaped = false;
            let mut class_depth = 0usize;
            for ch in pattern {
                budget.step()?;
                if !escaped && *ch == 91 && (parsed_flags.sets || class_depth == 0) {
                    class_depth += 1;
                }
                if !escaped && *ch == 93 {
                    class_depth = class_depth.saturating_sub(1);
                }
                if escaped && matches!(*ch, 10 | 13 | 0x2028 | 0x2029) {
                    source.pop();
                }
                match *ch {
                    47 if !escaped && class_depth == 0 => source.extend([92, 47]),
                    10 => source.extend([92, 110]),
                    13 => source.extend([92, 114]),
                    0x2028 => source.extend("\\u2028".encode_utf16()),
                    0x2029 => source.extend("\\u2029".encode_utf16()),
                    ch => source.push(ch),
                }
                escaped = *ch == 92 && !escaped;
            }
            source
        };
        Ok(Self {
            source,
            flags: "dgimsuvy"
                .chars()
                .filter(|flag| flags.contains(*flag))
                .collect(),
            last_index: 0,
            parsed_flags,
            program,
        })
    }

    pub fn source(&self) -> &[u16] {
        &self.source
    }

    pub fn flags(&self) -> &str {
        &self.flags
    }

    pub fn has_indices(&self) -> bool {
        self.parsed_flags.indices
    }
    pub fn global(&self) -> bool {
        self.parsed_flags.global
    }
    pub fn ignore_case(&self) -> bool {
        self.parsed_flags.ignore_case
    }
    pub fn multiline(&self) -> bool {
        self.parsed_flags.multiline
    }
    pub fn dot_all(&self) -> bool {
        self.parsed_flags.dot_all
    }
    pub fn unicode(&self) -> bool {
        self.parsed_flags.unicode
    }
    pub fn unicode_sets(&self) -> bool {
        self.parsed_flags.sets
    }
    pub fn sticky(&self) -> bool {
        self.parsed_flags.sticky
    }

    pub fn literal(&self) -> Vec<u16> {
        std::iter::once(47)
            .chain(self.source.iter().copied())
            .chain(std::iter::once(47))
            .chain(self.flags.encode_utf16())
            .collect()
    }

    pub fn exec(&mut self, input: &[u16], budget: &mut Budget<'_>) -> Result<Option<Match>, Error> {
        budget.step()?;
        let stateful = self.parsed_flags.global || self.parsed_flags.sticky;
        let mut start = if stateful {
            usize::try_from(self.last_index).unwrap_or(usize::MAX)
        } else {
            0
        };
        if self.parsed_flags.unicode_mode()
            && start > 0
            && input
                .get(start)
                .is_some_and(|ch| (0xdc00..=0xdfff).contains(ch))
            && input
                .get(start - 1)
                .is_some_and(|ch| (0xd800..=0xdbff).contains(ch))
        {
            start -= 1;
        }
        while start <= input.len() {
            budget.step()?;
            if let Some((end, mut ranges)) = matcher::run(
                &self.program,
                input,
                matcher::State::start(
                    self.program.root,
                    start,
                    self.parsed_flags,
                    false,
                    vec![None; self.program.count + 1],
                ),
                budget,
            )? {
                ranges[0] = Some((start, end));
                let captures = ranges
                    .iter()
                    .map(|range| range.map(|(start, end)| input[start..end].to_vec()))
                    .collect();
                let groups = (!self.program.names.is_empty()).then(|| {
                    self.program
                        .names
                        .iter()
                        .map(|(name, targets)| {
                            (
                                name.clone(),
                                targets
                                    .iter()
                                    .find_map(|target| ranges[*target])
                                    .map(|(start, end)| input[start..end].to_vec()),
                            )
                        })
                        .collect()
                });
                let index_groups = (self.parsed_flags.indices && !self.program.names.is_empty())
                    .then(|| {
                        self.program
                            .names
                            .iter()
                            .map(|(name, targets)| {
                                (
                                    name.clone(),
                                    targets.iter().find_map(|target| ranges[*target]),
                                )
                            })
                            .collect()
                    });
                if stateful {
                    self.last_index = end as u64;
                }
                return Ok(Some(Match {
                    captures,
                    index: start,
                    groups,
                    indices: self.parsed_flags.indices.then_some(ranges),
                    index_groups,
                }));
            }
            if self.parsed_flags.sticky {
                break;
            }
            start = advance(input, start, self.parsed_flags.unicode_mode());
        }
        if stateful {
            self.last_index = 0;
        }
        Ok(None)
    }

    pub fn test(&mut self, input: &[u16], budget: &mut Budget<'_>) -> Result<bool, Error> {
        Ok(self.exec(input, budget)?.is_some())
    }
}

pub fn escape(input: &[u16]) -> Vec<u16> {
    let mut output = Vec::new();
    let mut offset = 0;
    while let Some((cp, width)) = read_point(input, offset, true) {
        if offset == 0 && matches!(cp,48..=57 | 65..=90 | 97..=122) {
            output.extend(format!("\\x{cp:02x}").encode_utf16());
        } else if matches!(
            cp,
            94 | 36 | 92 | 46 | 42 | 43 | 63 | 40 | 41 | 91 | 93 | 123 | 125 | 124 | 47
        ) {
            output.push(92);
            append_point(&mut output, cp);
        } else if matches!(
            cp,
            44 | 45 | 61 | 60 | 62 | 35 | 38 | 33 | 37 | 58 | 59 | 64 | 126 | 39 | 96 | 34 | 32
        ) {
            output.extend(format!("\\x{cp:02x}").encode_utf16());
        } else if matches!(cp, 9..=13) {
            output.extend([
                92,
                match cp {
                    9 => 116,
                    10 => 110,
                    11 => 118,
                    12 => 102,
                    _ => 114,
                },
            ]);
        } else if (0xd800..=0xdfff).contains(&cp) || class::whitespace(cp) {
            output.extend(
                if cp <= 0xff {
                    format!("\\x{cp:02x}")
                } else {
                    format!("\\u{cp:04x}")
                }
                .encode_utf16(),
            );
        } else {
            append_point(&mut output, cp);
        }
        offset += width;
    }
    output
}
