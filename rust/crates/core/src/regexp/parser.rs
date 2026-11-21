use icu_properties::CodePointSetData;
use icu_properties::props::{IdContinue, IdStart};

use super::class::{Class, Property};
use super::{Budget, Error, Flags, read_point};

#[derive(Debug, Clone)]
pub(super) enum Node {
    Sequence(Vec<usize>),
    Alternative(Vec<usize>),
    Character(u32),
    Class(Class),
    Any,
    Start,
    End,
    Boundary(bool),
    Capture(usize, usize),
    Look {
        child: usize,
        positive: bool,
        backwards: bool,
    },
    Repeat {
        child: usize,
        min: u64,
        max: Option<u64>,
        greedy: bool,
    },
    Reference(Vec<usize>),
    NamedReference(Vec<u16>),
    Modifiers(Flags, usize),
}

#[derive(Debug, Clone)]
pub(super) struct Program {
    pub nodes: Vec<Node>,
    pub root: usize,
    pub count: usize,
    pub names: Vec<(Vec<u16>, Vec<usize>)>,
}

pub(super) fn parse(
    input: &[u16],
    flags: Flags,
    budget: &mut Budget<'_>,
) -> Result<Program, Error> {
    let (total, named) = capture_count(input, flags, budget)?;
    let mut parser = Parser {
        input,
        offset: 0,
        flags,
        nodes: Vec::new(),
        count: 0,
        total,
        named,
        names: Vec::new(),
        named_paths: Vec::new(),
        paths: Vec::new(),
        next_path: 0,
        budget,
    };
    let root = parser.disjunction()?;
    if parser.offset != input.len() {
        return Err(syntax("Unmatched closing parenthesis"));
    }
    for node in &mut parser.nodes {
        if let Node::NamedReference(name) = node {
            let targets = parser
                .names
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, targets)| targets.clone());
            *node =
                Node::Reference(targets.ok_or_else(|| syntax("Invalid named capture reference"))?);
        }
    }
    Ok(Program {
        nodes: parser.nodes,
        root,
        count: parser.count,
        names: parser.names,
    })
}

fn syntax(message: &str) -> Error {
    Error::Syntax(message.into())
}

fn capture_count(
    input: &[u16],
    flags: Flags,
    budget: &mut Budget<'_>,
) -> Result<(usize, bool), Error> {
    let mut count = 0;
    let mut named = false;
    let mut class_depth = 0usize;
    let mut offset = 0;
    while offset < input.len() {
        budget.step()?;
        let ch = input[offset];
        if ch == 92 {
            offset += 2;
            continue;
        }
        if ch == 91 {
            class_depth += 1;
        }
        if ch == 93 {
            class_depth = class_depth.saturating_sub(1);
        }
        if ch == 40
            && class_depth == 0
            && (input.get(offset + 1) != Some(&63)
                || (input.get(offset + 2) == Some(&60)
                    && !matches!(input.get(offset + 3), Some(61 | 33))))
        {
            count += 1;
            named |= input.get(offset + 1) == Some(&63);
        }
        if !flags.sets && class_depth > 1 {
            class_depth = 1;
        }
        offset += 1;
    }
    Ok((count, named))
}

type BranchPath = Vec<(usize, usize)>;

struct Parser<'a, 'b, 'c> {
    input: &'a [u16],
    offset: usize,
    flags: Flags,
    nodes: Vec<Node>,
    count: usize,
    total: usize,
    named: bool,
    names: Vec<(Vec<u16>, Vec<usize>)>,
    named_paths: Vec<(Vec<u16>, BranchPath)>,
    paths: BranchPath,
    next_path: usize,
    budget: &'b mut Budget<'c>,
}

impl Parser<'_, '_, '_> {
    fn push(&mut self, node: Node) -> usize {
        self.nodes.push(node);
        self.nodes.len() - 1
    }
    fn peek(&self) -> Option<u16> {
        self.input.get(self.offset).copied()
    }
    fn eat(&mut self, ch: u16) -> bool {
        if self.peek() != Some(ch) {
            return false;
        }
        self.offset += 1;
        true
    }
    fn require(&mut self, ch: u16, message: &str) -> Result<(), Error> {
        if self.eat(ch) {
            Ok(())
        } else {
            Err(syntax(message))
        }
    }

    fn disjunction(&mut self) -> Result<usize, Error> {
        let identity = self.next_path;
        self.next_path += 1;
        let mut alternatives = Vec::new();
        loop {
            self.paths.push((identity, alternatives.len()));
            let mut terms = Vec::new();
            while !matches!(self.peek(), None | Some(41 | 124)) {
                self.budget.step()?;
                let atom = self.atom()?;
                let quantifier = self.quantifier()?;
                let node = if let Some((min, max, greedy)) = quantifier {
                    if matches!(
                        self.nodes[atom],
                        Node::Start | Node::End | Node::Boundary(_)
                    ) || (matches!(
                        self.nodes[atom],
                        Node::Look {
                            backwards: true,
                            ..
                        }
                    ) || (self.flags.unicode_mode()
                        && matches!(self.nodes[atom], Node::Look { .. })))
                    {
                        return Err(syntax("Invalid quantifier on assertion"));
                    }
                    self.push(Node::Repeat {
                        child: atom,
                        min,
                        max,
                        greedy,
                    })
                } else {
                    atom
                };
                terms.push(node);
            }
            alternatives.push(self.push(Node::Sequence(terms)));
            self.paths.pop();
            if !self.eat(124) {
                break;
            }
        }
        Ok(self.push(Node::Alternative(alternatives)))
    }

    fn atom(&mut self) -> Result<usize, Error> {
        let ch = self
            .peek()
            .ok_or_else(|| syntax("Unexpected end of pattern"))?;
        self.offset += 1;
        Ok(match ch {
            94 => self.push(Node::Start),
            36 => self.push(Node::End),
            46 => self.push(Node::Any),
            40 => return self.group(),
            91 => {
                let class = self.class()?;
                self.push(Node::Class(class))
            }
            92 => {
                let escaped = self.escape(false)?;
                match escaped {
                    Escape::Character(cp) => self.push(Node::Character(cp)),
                    Escape::Class(class) => self.push(Node::Class(class)),
                    Escape::Node(node) => self.push(node),
                }
            }
            42 | 43 | 63 => return Err(syntax("Nothing to repeat")),
            123 if self.flags.unicode_mode() || self.valid_braces(self.offset - 1).is_some() => {
                return Err(syntax("Invalid quantifier"));
            }
            93 | 125 if self.flags.unicode_mode() => return Err(syntax("Lone syntax character")),
            _ => {
                self.offset -= 1;
                let (cp, width) = read_point(self.input, self.offset, self.flags.unicode_mode())
                    .ok_or_else(|| syntax("Invalid character"))?;
                self.offset += width;
                self.push(Node::Character(cp))
            }
        })
    }

    fn group(&mut self) -> Result<usize, Error> {
        let mut capture = None;
        let mut look = None;
        let original_flags = self.flags;
        let mut modifiers = false;
        if !self.eat(63) {
            self.count += 1;
            capture = Some(self.count);
        } else if self.eat(58) {
        } else if self.eat(61) {
            look = Some((true, false));
        } else if self.eat(33) {
            look = Some((false, false));
        } else if self.eat(60) {
            if self.eat(61) {
                look = Some((true, true));
            } else if self.eat(33) {
                look = Some((false, true));
            } else {
                let name = self.group_name()?;
                self.count += 1;
                capture = Some(self.count);
                for (key, path) in &self.named_paths {
                    if *key == name
                        && !path.iter().any(|(identity, choice)| {
                            self.paths
                                .iter()
                                .any(|(other, selected)| other == identity && selected != choice)
                        })
                    {
                        return Err(syntax("Duplicate capture group name"));
                    }
                }
                self.named_paths.push((name.clone(), self.paths.clone()));
                if let Some((_, targets)) = self.names.iter_mut().find(|(key, _)| *key == name) {
                    targets.push(self.count);
                } else {
                    self.names.push((name, vec![self.count]));
                }
            }
        } else {
            let mut positive = Vec::new();
            let mut negative = Vec::new();
            while matches!(self.peek(), Some(105 | 109 | 115)) {
                positive.push(self.peek().unwrap_or_default());
                self.offset += 1;
            }
            let dash = self.eat(45);
            if dash {
                while matches!(self.peek(), Some(105 | 109 | 115)) {
                    negative.push(self.peek().unwrap_or_default());
                    self.offset += 1;
                }
            }
            if positive.is_empty() && negative.is_empty() {
                return Err(syntax("Invalid group"));
            }
            let combined = positive
                .iter()
                .chain(&negative)
                .copied()
                .collect::<Vec<_>>();
            if combined
                .iter()
                .enumerate()
                .any(|(i, ch)| combined[..i].contains(ch))
            {
                return Err(syntax("Duplicate modifier flag"));
            }
            self.require(58, "Invalid modifier group")?;
            for flag in positive {
                self.flags.set_modifier(flag, true);
            }
            for flag in negative {
                self.flags.set_modifier(flag, false);
            }
            modifiers = true;
        }
        let modified_flags = self.flags;
        let child = self.disjunction()?;
        self.require(41, "Unterminated group")?;
        self.flags = original_flags;
        if let Some(index) = capture {
            return Ok(self.push(Node::Capture(index, child)));
        }
        if let Some((positive, backwards)) = look {
            return Ok(self.push(Node::Look {
                child,
                positive,
                backwards,
            }));
        }
        if modifiers {
            return Ok(self.push(Node::Modifiers(modified_flags, child)));
        }
        Ok(child)
    }

    fn group_name(&mut self) -> Result<Vec<u16>, Error> {
        let mut name = Vec::new();
        let mut first = true;
        while !self.eat(62) {
            self.budget.step()?;
            let cp = if self.eat(92) {
                self.require(117, "Invalid capture group name")?;
                let high = self.unicode_escape(true)?;
                if (0xd800..=0xdbff).contains(&high)
                    && self.input.get(self.offset..self.offset + 2) == Some(&[92, 117])
                {
                    let saved = self.offset;
                    self.offset += 2;
                    if let Some(low @ 0xdc00..=0xdfff) = self.hex(4) {
                        0x10000 + ((high - 0xd800) << 10) + low - 0xdc00
                    } else {
                        self.offset = saved;
                        high
                    }
                } else {
                    high
                }
            } else {
                let (cp, width) = read_point(self.input, self.offset, true)
                    .ok_or_else(|| syntax("Unterminated capture group name"))?;
                self.offset += width;
                cp
            };
            let valid = matches!(cp, 36 | 95)
                || if first {
                    CodePointSetData::new::<IdStart>().contains32(cp)
                } else {
                    matches!(cp, 0x200c | 0x200d)
                        || CodePointSetData::new::<IdContinue>().contains32(cp)
                };
            if !valid {
                return Err(syntax("Invalid capture group name"));
            }
            super::append_point(&mut name, cp);
            first = false;
        }
        if first {
            return Err(syntax("Empty capture group name"));
        }
        Ok(name)
    }

    fn valid_braces(&self, start: usize) -> Option<(u64, Option<u64>, usize)> {
        if self.input.get(start) != Some(&123) {
            return None;
        }
        let mut offset = start + 1;
        let min_start = offset;
        let mut min = 0u64;
        while let Some(ch @ 48..=57) = self.input.get(offset).copied() {
            min = min.saturating_mul(10).saturating_add(u64::from(ch - 48));
            offset += 1;
        }
        if offset == min_start {
            return None;
        }
        if self.input.get(offset) == Some(&125) {
            return Some((min, Some(min), offset + 1));
        }
        if self.input.get(offset) != Some(&44) {
            return None;
        }
        offset += 1;
        let max_start = offset;
        let mut max = 0u64;
        while let Some(ch @ 48..=57) = self.input.get(offset).copied() {
            max = max.saturating_mul(10).saturating_add(u64::from(ch - 48));
            offset += 1;
        }
        if self.input.get(offset) != Some(&125) {
            return None;
        }
        Some((min, (offset != max_start).then_some(max), offset + 1))
    }

    fn quantifier(&mut self) -> Result<Option<(u64, Option<u64>, bool)>, Error> {
        let bounds = match self.peek() {
            Some(42) => {
                self.offset += 1;
                Some((0, None))
            }
            Some(43) => {
                self.offset += 1;
                Some((1, None))
            }
            Some(63) => {
                self.offset += 1;
                Some((0, Some(1)))
            }
            Some(123) => {
                if let Some((min, max, end)) = self.valid_braces(self.offset) {
                    if max.is_some_and(|max| max < min) {
                        return Err(syntax("Quantifier range out of order"));
                    }
                    self.offset = end;
                    Some((min, max))
                } else if self.flags.unicode_mode() {
                    return Err(syntax("Incomplete quantifier"));
                } else {
                    None
                }
            }
            _ => None,
        };
        Ok(bounds.map(|(min, max)| (min, max, !self.eat(63))))
    }

    fn escape(&mut self, in_class: bool) -> Result<Escape, Error> {
        let ch = self.peek().ok_or_else(|| syntax("Trailing backslash"))?;
        self.offset += 1;
        Ok(match ch {
            98 if !in_class => Escape::Node(Node::Boundary(true)),
            66 if !in_class => Escape::Node(Node::Boundary(false)),
            98 => Escape::Character(8),
            100 => Escape::Class(Class::Digit),
            68 => Escape::Class(Class::Negation(Box::new(Class::Digit))),
            115 => Escape::Class(Class::Space),
            83 => Escape::Class(Class::Negation(Box::new(Class::Space))),
            119 => Escape::Class(Class::Word),
            87 => Escape::Class(Class::Negation(Box::new(Class::Word))),
            102 => Escape::Character(12),
            110 => Escape::Character(10),
            114 => Escape::Character(13),
            116 => Escape::Character(9),
            118 => Escape::Character(11),
            99 => {
                let next = self.peek();
                if next.is_some_and(|ch| {
                    matches!(ch, 65..=90 | 97..=122)
                        || (in_class && !self.flags.unicode_mode() && matches!(ch, 48..=57 | 95))
                }) {
                    self.offset += 1;
                    Escape::Character(u32::from(next.unwrap_or_default() % 32))
                } else if self.flags.unicode_mode() {
                    return Err(syntax("Invalid control escape"));
                } else {
                    self.offset -= 1;
                    Escape::Character(92)
                }
            }
            120 => {
                if let Some(cp) = self.hex(2) {
                    Escape::Character(cp)
                } else if self.flags.unicode_mode() {
                    return Err(syntax("Invalid hexadecimal escape"));
                } else {
                    Escape::Character(120)
                }
            }
            117 => {
                let saved = self.offset;
                match self.unicode_escape(self.flags.unicode_mode()) {
                    Ok(mut cp) => {
                        if self.flags.unicode_mode()
                            && (0xd800..=0xdbff).contains(&cp)
                            && self.input.get(self.offset..self.offset + 2) == Some(&[92, 117])
                        {
                            let after_high = self.offset;
                            self.offset += 2;
                            if let Some(low @ 0xdc00..=0xdfff) = self.hex(4) {
                                cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00;
                            } else {
                                self.offset = after_high;
                            }
                        }
                        Escape::Character(cp)
                    }
                    Err(error) if self.flags.unicode_mode() => return Err(error),
                    Err(_) => {
                        self.offset = saved;
                        Escape::Character(117)
                    }
                }
            }
            112 | 80 if self.flags.unicode_mode() => {
                self.require(123, "Invalid Unicode property escape")?;
                let start = self.offset;
                while self
                    .peek()
                    .is_some_and(|ch| matches!(ch, 65..=90 | 97..=122 | 48..=57 | 95 | 61))
                {
                    self.offset += 1;
                    self.budget.step()?;
                }
                let name = String::from_utf16(&self.input[start..self.offset])
                    .map_err(|_| syntax("Invalid property name"))?;
                self.require(125, "Invalid Unicode property escape")?;
                let property = Property::parse(&name, self.flags)?;
                if ch == 80 && matches!(property, Property::BasicEmoji) {
                    return Err(syntax("Cannot complement a property of strings"));
                }
                Escape::Class(Class::Property(property, ch == 80))
            }
            107 if self.flags.unicode_mode() || self.named => {
                if in_class {
                    return Err(syntax("Invalid named capture reference in class"));
                }
                self.require(60, "Invalid named reference")?;
                Escape::Node(Node::NamedReference(self.group_name()?))
            }
            48..=57 => {
                let start = self.offset - 1;
                let mut end = self.offset;
                let mut value = u64::from(ch - 48);
                while let Some(digit @ 48..=57) = self.input.get(end).copied() {
                    value = value
                        .saturating_mul(10)
                        .saturating_add(u64::from(digit - 48));
                    end += 1;
                }
                if !in_class && ch != 48 && value <= self.total as u64 {
                    self.offset = end;
                    Escape::Node(Node::Reference(vec![value as usize]))
                } else if ch == 48 && !matches!(self.peek(), Some(48..=57)) {
                    Escape::Character(0)
                } else if self.flags.unicode_mode() {
                    return Err(syntax("Invalid decimal escape"));
                } else if ch >= 56 {
                    Escape::Character(u32::from(ch))
                } else {
                    let mut octal = u32::from(ch - 48);
                    let max = if ch <= 51 { 3 } else { 2 };
                    while self.offset - start < max {
                        let Some(digit @ 48..=55) = self.peek() else {
                            break;
                        };
                        octal = octal * 8 + u32::from(digit - 48);
                        self.offset += 1;
                    }
                    Escape::Character(octal)
                }
            }
            _ => {
                let legal = ch >= 128
                    || matches!(
                        ch,
                        94 | 36 | 92 | 46 | 42 | 43 | 63 | 40 | 41 | 91 | 93 | 123 | 125 | 124 | 47
                    )
                    || (in_class && ch == 45)
                    || (in_class
                        && self.flags.sets
                        && matches!(
                            ch,
                            38 | 33 | 35 | 37 | 44 | 58 | 59 | 60 | 61 | 62 | 64 | 96 | 126
                        ));
                if self.flags.unicode_mode() && !legal {
                    return Err(syntax("Invalid identity escape"));
                }
                Escape::Character(u32::from(ch))
            }
        })
    }

    fn hex(&mut self, count: usize) -> Option<u32> {
        let input = self.input.get(self.offset..self.offset + count)?;
        let mut cp = 0u32;
        for ch in input {
            cp = cp * 16 + char::from_u32(u32::from(*ch))?.to_digit(16)?;
        }
        self.offset += count;
        Some(cp)
    }

    fn unicode_escape(&mut self, braces: bool) -> Result<u32, Error> {
        if braces && self.eat(123) {
            let start = self.offset;
            let mut cp = 0u32;
            while let Some(digit) = self
                .peek()
                .and_then(|ch| char::from_u32(u32::from(ch)))
                .and_then(|ch| ch.to_digit(16))
            {
                self.budget.step()?;
                cp = cp
                    .checked_mul(16)
                    .and_then(|cp| cp.checked_add(digit))
                    .ok_or_else(|| syntax("Unicode escape out of range"))?;
                self.offset += 1;
            }
            if self.offset == start || cp > 0x10ffff {
                return Err(syntax("Unicode escape out of range"));
            }
            self.require(125, "Unterminated Unicode escape")?;
            return Ok(cp);
        }
        self.hex(4).ok_or_else(|| syntax("Invalid Unicode escape"))
    }

    fn class(&mut self) -> Result<Class, Error> {
        let negative = self.eat(94);
        let mut parts = Vec::new();
        let mut operation = None;
        while !self.eat(93) {
            self.budget.step()?;
            if self.peek().is_none() {
                return Err(syntax("Unterminated character class"));
            }
            let mut left = self.class_atom()?;
            let mut range = false;
            if self.peek() == Some(45)
                && self.input.get(self.offset + 1) != Some(&93)
                && !(self.flags.sets && self.input.get(self.offset + 1) == Some(&45))
            {
                self.offset += 1;
                let right = self.class_atom()?;
                if let (Class::Range(start, end), Class::Range(right_start, right_end)) =
                    (&left, &right)
                {
                    if start != end || right_start != right_end || start > right_start {
                        return Err(syntax("Character class range out of order"));
                    }
                    left = Class::Range(*start, *right_start);
                    range = true;
                } else if self.flags.unicode_mode() {
                    return Err(syntax("Invalid character class range"));
                } else {
                    left = Class::Union(vec![left, Class::Range(45, 45), right]);
                }
            }
            if self.flags.sets
                && matches!(
                    self.input.get(self.offset..self.offset + 2),
                    Some([38, 38] | [45, 45])
                )
            {
                if range || !parts.is_empty() {
                    return Err(syntax("Invalid operation in class set"));
                }
                let op = self.peek().unwrap_or_default();
                operation = Some(op);
                self.offset += 2;
                loop {
                    let right = self.class_atom()?;
                    left = if op == 38 {
                        Class::Intersection(Box::new(left), Box::new(right))
                    } else {
                        Class::Subtraction(Box::new(left), Box::new(right))
                    };
                    if self.input.get(self.offset..self.offset + 2) == Some(&[op, op]) {
                        self.offset += 2;
                        continue;
                    }
                    if self.peek() != Some(93) {
                        return Err(syntax("Invalid operation in class set"));
                    }
                    break;
                }
            }
            parts.push(left);
            if operation.is_some() && self.peek() != Some(93) {
                return Err(syntax("Invalid class set union"));
            }
        }
        let class = Class::Union(parts);
        if negative && class.has_strings() {
            return Err(syntax("Negated class may contain strings"));
        }
        Ok(if negative {
            Class::Negation(Box::new(class))
        } else {
            class
        })
    }

    fn class_atom(&mut self) -> Result<Class, Error> {
        if self.flags.sets && self.eat(91) {
            return self.class();
        }
        if self.eat(92) {
            if self.flags.sets && self.eat(113) {
                self.require(123, "Invalid class string disjunction")?;
                let mut strings = vec![Vec::new()];
                while !self.eat(125) {
                    self.budget.step()?;
                    if self.eat(124) {
                        strings.push(Vec::new());
                        continue;
                    }
                    let cp = match self.class_atom()? {
                        Class::Range(cp, end) if cp == end => cp,
                        _ => return Err(syntax("Invalid character in class string")),
                    };
                    if let Some(string) = strings.last_mut() {
                        string.push(cp);
                    }
                }
                return Ok(Class::Strings(strings));
            }
            return match self.escape(true)? {
                Escape::Character(cp) => Ok(Class::Range(cp, cp)),
                Escape::Class(class) => Ok(class),
                Escape::Node(_) => Err(syntax("Invalid class escape")),
            };
        }
        let (cp, width) = read_point(self.input, self.offset, self.flags.unicode_mode())
            .ok_or_else(|| syntax("Unterminated character class"))?;
        if self.flags.sets {
            if matches!(cp, 40 | 41 | 47 | 91 | 93 | 123 | 125 | 124 | 45) {
                return Err(syntax("Invalid class set character"));
            }
            if matches!(
                cp,
                33 | 35
                    | 36
                    | 37
                    | 38
                    | 42
                    | 43
                    | 44
                    | 46
                    | 58
                    | 59
                    | 60
                    | 61
                    | 62
                    | 63
                    | 64
                    | 94
                    | 96
                    | 126
            ) && self.input.get(self.offset + 1).copied().map(u32::from) == Some(cp)
            {
                return Err(syntax("Reserved double class set punctuator"));
            }
        }
        self.offset += width;
        Ok(Class::Range(cp, cp))
    }
}

enum Escape {
    Character(u32),
    Class(Class),
    Node(Node),
}
