use super::{
    encoding::ascii_lower,
    value::{LosslessString, Value, os_text, stringify_json, trim},
};
use std::fmt;

#[derive(Debug, PartialEq)]
pub enum TomlValue {
    String(String),
    Integer(i64),
    Float { value: f64, negative_nan: bool },
    Boolean(bool),
    Datetime(String),
    Array(Vec<TomlValue>),
    Table(TomlTable),
}

#[derive(Debug, Default, PartialEq)]
pub struct TomlTable {
    pub entries: Vec<(String, TomlValue)>,
}

fn absent() -> TomlValue {
    TomlValue::Table(TomlTable::new())
}

fn clone_scalar(value: &TomlValue) -> TomlValue {
    match value {
        TomlValue::String(text) => TomlValue::String(text.clone()),
        TomlValue::Integer(number) => TomlValue::Integer(*number),
        TomlValue::Float {
            value,
            negative_nan,
        } => TomlValue::Float {
            value: *value,
            negative_nan: *negative_nan,
        },
        TomlValue::Boolean(flag) => TomlValue::Boolean(*flag),
        TomlValue::Datetime(text) => TomlValue::Datetime(text.clone()),
        TomlValue::Array(_) | TomlValue::Table(_) => absent(),
    }
}

#[derive(Clone, Copy)]
enum Source<'a> {
    Array(&'a [TomlValue]),
    Table(&'a [(String, TomlValue)]),
}

impl<'a> Source<'a> {
    fn len(self) -> usize {
        match self {
            Self::Array(items) => items.len(),
            Self::Table(entries) => entries.len(),
        }
    }
    fn child(self, index: usize) -> &'a TomlValue {
        match self {
            Self::Array(items) => &items[index],
            Self::Table(entries) => &entries[index].1,
        }
    }
    fn key(self, index: usize) -> Option<&'a String> {
        match self {
            Self::Array(_) => None,
            Self::Table(entries) => Some(&entries[index].0),
        }
    }
}

struct Rebuild<'a> {
    source: Source<'a>,
    position: usize,
    keys: Vec<String>,
    items: Vec<TomlValue>,
}

impl<'a> Rebuild<'a> {
    fn new(source: Source<'a>) -> Self {
        Self {
            source,
            position: 0,
            keys: Vec::new(),
            items: Vec::new(),
        }
    }
    fn finish(self) -> TomlValue {
        match self.source {
            Source::Array(_) => TomlValue::Array(self.items),
            Source::Table(_) => TomlValue::Table(TomlTable {
                entries: self.keys.into_iter().zip(self.items).collect(),
            }),
        }
    }
}

fn source_of(value: &TomlValue) -> Option<Source<'_>> {
    match value {
        TomlValue::Array(items) => Some(Source::Array(items)),
        TomlValue::Table(table) => Some(Source::Table(&table.entries)),
        _ => None,
    }
}

fn rebuild<'a>(
    root: Source<'a>,
    mut leaf: impl FnMut(&'a TomlValue) -> Option<TomlValue>,
) -> TomlValue {
    let mut stack = vec![Rebuild::new(root)];
    loop {
        let next = {
            let Some(frame) = stack.last_mut() else {
                return absent();
            };
            if frame.position < frame.source.len() {
                let index = frame.position;
                frame.position += 1;
                if let Some(key) = frame.source.key(index) {
                    frame.keys.push(key.clone());
                }
                Some(frame.source.child(index))
            } else {
                None
            }
        };
        match next {
            Some(child) => {
                let produced = match leaf(child) {
                    Some(value) => Some(value),
                    None => match source_of(child) {
                        Some(source) => {
                            stack.push(Rebuild::new(source));
                            None
                        }
                        None => Some(clone_scalar(child)),
                    },
                };
                if let Some(value) = produced
                    && let Some(frame) = stack.last_mut()
                {
                    frame.items.push(value);
                }
            }
            None => {
                let Some(finished) = stack.pop() else {
                    return absent();
                };
                let value = finished.finish();
                match stack.last_mut() {
                    Some(parent) => parent.items.push(value),
                    None => return value,
                }
            }
        }
    }
}

impl Clone for TomlValue {
    fn clone(&self) -> Self {
        match source_of(self) {
            Some(source) => rebuild(source, |_| None),
            None => clone_scalar(self),
        }
    }
}

impl Clone for TomlTable {
    fn clone(&self) -> Self {
        rebuild(Source::Table(&self.entries), |_| None)
            .take_table()
            .unwrap_or_default()
    }
}

fn detach_children(value: &mut TomlValue, stack: &mut Vec<TomlValue>) {
    match value {
        TomlValue::Array(items) => stack.append(items),
        TomlValue::Table(table) => stack.extend(
            std::mem::take(&mut table.entries)
                .into_iter()
                .map(|(_, child)| child),
        ),
        _ => {}
    }
}

impl Drop for TomlValue {
    fn drop(&mut self) {
        let mut stack = Vec::new();
        detach_children(self, &mut stack);
        while let Some(mut value) = stack.pop() {
            detach_children(&mut value, &mut stack);
        }
    }
}

impl TomlValue {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::String(_) => "string",
            Self::Integer(_) => "integer",
            Self::Float { .. } => "float",
            Self::Boolean(_) => "boolean",
            Self::Datetime(_) => "datetime",
            Self::Array(_) => "array",
            Self::Table(_) => "table",
        }
    }
    pub fn as_table(&self) -> Option<&TomlTable> {
        match self {
            Self::Table(table) => Some(table),
            _ => None,
        }
    }
    pub fn take_table(mut self) -> Result<TomlTable, TomlValue> {
        match &mut self {
            Self::Table(table) => Ok(std::mem::take(table)),
            _ => Err(self),
        }
    }
}

impl TomlTable {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn from_entries(entries: impl IntoIterator<Item = (String, TomlValue)>) -> Self {
        let mut table = Self::new();
        for (key, value) in entries {
            table.insert(key, value);
        }
        table
    }
    fn position(&self, key: &str) -> Option<usize> {
        self.entries
            .iter()
            .position(|(existing, _)| existing == key)
    }
    pub fn get(&self, key: &str) -> Option<&TomlValue> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
    }
    pub fn get_mut(&mut self, key: &str) -> Option<&mut TomlValue> {
        self.entries
            .iter_mut()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
    }
    pub fn contains_key(&self, key: &str) -> bool {
        self.position(key).is_some()
    }
    pub fn insert(&mut self, key: String, value: TomlValue) {
        match self.position(&key) {
            Some(position) => self.entries[position].1 = value,
            None => self.entries.push((key, value)),
        }
    }
    pub fn remove(&mut self, key: &str) -> Option<TomlValue> {
        self.position(key)
            .map(|position| self.entries.remove(position).1)
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TomlParseError {
    pub line: usize,
    pub column: usize,
    pub detail: LosslessString,
}

impl fmt::Display for TomlParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let detail = match self.detail.to_utf8() {
            Ok(text) => text,
            Err(_) => String::from_utf16_lossy(&self.detail.code_units().collect::<Vec<_>>()),
        };
        write!(formatter, "{}:{}: {}", self.line, self.column, detail)
    }
}

impl std::error::Error for TomlParseError {}

type Parsed<T> = Result<T, TomlParseError>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum TableState {
    Implicit,
    Header,
    Dotted,
    Inline,
}

enum Item {
    Value(TomlValue),
    Table(usize),
    Array(usize),
    ArrayOfTables(Vec<usize>),
}

struct TableNode {
    entries: Vec<(String, Item)>,
    state: TableState,
}

enum Slot {
    Table(usize),
    Array(usize),
}

enum Frame {
    Array(usize),
    Inline {
        table: usize,
        pending: Option<(usize, String)>,
    },
}

enum Step {
    Value,
    Close(Item),
}

enum Begun {
    Scalar(TomlValue),
    OpenArray,
    OpenInline,
}

enum Delivery {
    Array(usize),
    Inline(usize, usize, String),
}

struct Parser {
    text: Vec<u16>,
    index: usize,
    tables: Vec<TableNode>,
    arrays: Vec<Vec<Item>>,
    log: Vec<Slot>,
    current: usize,
}

const NEWLINE: u16 = 0x0A;
const CARRIAGE_RETURN: u16 = 0x0D;
const TAB: u16 = 0x09;
const SPACE: u16 = 0x20;

fn push_char(out: &mut Vec<u16>, character: char) {
    let mut buffer = [0u16; 2];
    out.extend_from_slice(character.encode_utf16(&mut buffer));
}

fn is_key_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn days_in_month(year: u32, month: u32) -> u32 {
    if month == 2 {
        return if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
        {
            29
        } else {
            28
        };
    }
    if matches!(month, 4 | 6 | 9 | 11) {
        30
    } else {
        31
    }
}

fn digit_value(byte: u8) -> u64 {
    match byte {
        b'0'..=b'9' => u64::from(byte - b'0'),
        b'a'..=b'f' => u64::from(byte - b'a') + 10,
        _ => u64::from(byte - b'A') + 10,
    }
}

fn grouped_digits(digits: &[u8], radix: u64) -> bool {
    let mut expect_digit = true;
    for &byte in digits {
        if byte == b'_' {
            if expect_digit {
                return false;
            }
            expect_digit = true;
        } else {
            if !byte.is_ascii_hexdigit() || digit_value(byte) >= radix {
                return false;
            }
            expect_digit = false;
        }
    }
    !expect_digit
}

impl Parser {
    fn byte(&self, at: usize) -> u8 {
        match self.text.get(at) {
            Some(unit) if *unit < 0x80 => *unit as u8,
            _ => 0,
        }
    }

    fn peek(&self, offset: usize) -> Option<u16> {
        self.text.get(self.index + offset).copied()
    }

    fn is_at(&self, offset: usize, character: u8) -> bool {
        self.peek(offset) == Some(u16::from(character))
    }

    fn starts_with(&self, token: &str) -> bool {
        token
            .bytes()
            .enumerate()
            .all(|(offset, byte)| self.peek(offset) == Some(u16::from(byte)))
    }

    fn fail_at<T>(&self, detail: impl Into<LosslessString>, at: usize) -> Parsed<T> {
        let mut line = 1;
        let mut column = 1;
        for &unit in self.text.iter().take(at) {
            if unit == NEWLINE {
                line += 1;
                column = 1;
            } else {
                column += 1;
            }
        }
        Err(TomlParseError {
            line,
            column,
            detail: detail.into(),
        })
    }

    fn fail<T>(&self, detail: impl Into<LosslessString>) -> Parsed<T> {
        self.fail_at(detail, self.index)
    }

    fn skip_spaces(&mut self) {
        while self.peek(0) == Some(SPACE) || self.peek(0) == Some(TAB) {
            self.index += 1;
        }
    }

    fn skip_comment(&mut self) -> Parsed<()> {
        if !self.is_at(0, b'#') {
            return Ok(());
        }
        while self.index < self.text.len() && self.peek(0) != Some(NEWLINE) {
            let code = self.text[self.index];
            if ((code < 0x20 && code != TAB) || code == 0x7f)
                && !(code == CARRIAGE_RETURN && self.peek(1) == Some(NEWLINE))
            {
                return self.fail("invalid comment character");
            }
            self.index += 1;
        }
        Ok(())
    }

    fn newline(&mut self) -> bool {
        if self.peek(0) == Some(NEWLINE) {
            self.index += 1;
            return true;
        }
        if self.peek(0) == Some(CARRIAGE_RETURN) && self.peek(1) == Some(NEWLINE) {
            self.index += 2;
            return true;
        }
        false
    }

    fn skip_blank(&mut self) -> Parsed<()> {
        loop {
            self.skip_spaces();
            self.skip_comment()?;
            if !self.newline() {
                return Ok(());
            }
        }
    }

    fn end_of_line(&mut self) -> Parsed<()> {
        self.skip_spaces();
        self.skip_comment()?;
        if self.index >= self.text.len() {
            return Ok(());
        }
        if !self.newline() {
            let mut units: Vec<u16> = "extra `".encode_utf16().collect();
            units.push(self.text[self.index]);
            units.extend("`, expected nothing".encode_utf16());
            return self.fail(LosslessString::from_utf16(units));
        }
        Ok(())
    }

    fn position(&self, table: usize, key: &str) -> Option<usize> {
        self.tables[table]
            .entries
            .iter()
            .position(|(existing, _)| existing == key)
    }

    fn new_table(&mut self, state: TableState) -> usize {
        self.tables.push(TableNode {
            entries: Vec::new(),
            state,
        });
        let id = self.tables.len() - 1;
        self.log.push(Slot::Table(id));
        id
    }

    fn new_array(&mut self) -> usize {
        self.arrays.push(Vec::new());
        let id = self.arrays.len() - 1;
        self.log.push(Slot::Array(id));
        id
    }

    fn resolve(
        item: Item,
        tables: &mut [Option<TomlValue>],
        arrays: &mut [Option<TomlValue>],
    ) -> TomlValue {
        match item {
            Item::Value(value) => value,
            Item::Table(id) => tables[id].take().unwrap_or_else(absent),
            Item::Array(id) => arrays[id].take().unwrap_or_else(absent),
            Item::ArrayOfTables(ids) => TomlValue::Array(
                ids.into_iter()
                    .map(|id| tables[id].take().unwrap_or_else(absent))
                    .collect(),
            ),
        }
    }

    fn build(&mut self) -> TomlTable {
        let mut built_tables: Vec<Option<TomlValue>> =
            (0..self.tables.len()).map(|_| None).collect();
        let mut built_arrays: Vec<Option<TomlValue>> =
            (0..self.arrays.len()).map(|_| None).collect();
        for slot in std::mem::take(&mut self.log).into_iter().rev() {
            match slot {
                Slot::Table(id) => {
                    let entries = std::mem::take(&mut self.tables[id].entries);
                    let mut table = TomlTable::new();
                    for (key, item) in entries {
                        let value = Self::resolve(item, &mut built_tables, &mut built_arrays);
                        table.entries.push((key, value));
                    }
                    built_tables[id] = Some(TomlValue::Table(table));
                }
                Slot::Array(id) => {
                    let items = std::mem::take(&mut self.arrays[id]);
                    let mut values = Vec::with_capacity(items.len());
                    for item in items {
                        values.push(Self::resolve(item, &mut built_tables, &mut built_arrays));
                    }
                    built_arrays[id] = Some(TomlValue::Array(values));
                }
            }
        }
        built_tables[0]
            .take()
            .unwrap_or_else(absent)
            .take_table()
            .unwrap_or_default()
    }

    fn parse(&mut self) -> Parsed<()> {
        loop {
            self.skip_blank()?;
            if self.index >= self.text.len() {
                return Ok(());
            }
            if self.is_at(0, b'[') {
                self.header()?;
            } else {
                self.key_value(self.current)?;
                self.end_of_line()?;
            }
        }
    }

    fn header(&mut self) -> Parsed<()> {
        let array_of_tables = self.starts_with("[[");
        self.index += if array_of_tables { 2 } else { 1 };
        self.skip_spaces();
        let key = self.key()?;
        self.skip_spaces();
        if array_of_tables {
            if !self.starts_with("]]") {
                return self.fail("expected `]]`");
            }
        } else if !self.is_at(0, b']') {
            return self.fail("expected `]`");
        }
        self.index += if array_of_tables { 2 } else { 1 };
        self.end_of_line()?;
        let mut table = 0;
        for part in &key[..key.len() - 1] {
            table = self.descend(table, part)?;
        }
        let last = &key[key.len() - 1];
        let existing = self.position(table, last);
        if array_of_tables {
            match existing {
                None => {
                    let element = self.new_table(TableState::Header);
                    self.tables[table]
                        .entries
                        .push((last.clone(), Item::ArrayOfTables(vec![element])));
                    self.current = element;
                }
                Some(position) => {
                    if !matches!(
                        self.tables[table].entries[position].1,
                        Item::ArrayOfTables(_)
                    ) {
                        return self.fail(format!("duplicate key `{last}`"));
                    }
                    let element = self.new_table(TableState::Header);
                    if let Item::ArrayOfTables(elements) =
                        &mut self.tables[table].entries[position].1
                    {
                        elements.push(element);
                    }
                    self.current = element;
                }
            }
            return Ok(());
        }
        match existing {
            None => {
                let created = self.new_table(TableState::Header);
                self.tables[table]
                    .entries
                    .push((last.clone(), Item::Table(created)));
                self.current = created;
            }
            Some(position) => {
                let implicit = match &self.tables[table].entries[position].1 {
                    Item::Table(index) if self.tables[*index].state == TableState::Implicit => {
                        Some(*index)
                    }
                    _ => None,
                };
                let Some(index) = implicit else {
                    return self.fail(format!("duplicate key `{last}`"));
                };
                self.tables[index].state = TableState::Header;
                self.current = index;
            }
        }
        Ok(())
    }

    fn descend(&mut self, table: usize, part: &str) -> Parsed<usize> {
        let Some(position) = self.position(table, part) else {
            let created = self.new_table(TableState::Implicit);
            self.tables[table]
                .entries
                .push((part.to_owned(), Item::Table(created)));
            return Ok(created);
        };
        let found = match &self.tables[table].entries[position].1 {
            Item::Table(index) if self.tables[*index].state != TableState::Inline => Some(*index),
            Item::ArrayOfTables(elements) => elements.last().copied(),
            _ => None,
        };
        match found {
            Some(index) => Ok(index),
            None => self.fail(format!("duplicate key `{part}`")),
        }
    }

    fn key_prefix(&mut self, table: usize) -> Parsed<(usize, String)> {
        let key_start = self.index;
        let key = self.key()?;
        self.skip_spaces();
        if !self.is_at(0, b'=') {
            return self.fail("expected `=`");
        }
        self.index += 1;
        self.skip_spaces();
        let mut target = table;
        for part in &key[..key.len() - 1] {
            match self.position(target, part) {
                None => {
                    let created = self.new_table(TableState::Dotted);
                    self.tables[target]
                        .entries
                        .push((part.clone(), Item::Table(created)));
                    target = created;
                }
                Some(position) => {
                    let dotted = match &self.tables[target].entries[position].1 {
                        Item::Table(index) if self.tables[*index].state == TableState::Dotted => {
                            Some(*index)
                        }
                        _ => None,
                    };
                    match dotted {
                        Some(index) => target = index,
                        None => return self.fail_at(format!("duplicate key `{part}`"), key_start),
                    }
                }
            }
        }
        let last = key[key.len() - 1].clone();
        if self.position(target, &last).is_some() {
            return self.fail_at(format!("duplicate key `{last}`"), key_start);
        }
        Ok((target, last))
    }

    fn key_value(&mut self, table: usize) -> Parsed<()> {
        let (target, last) = self.key_prefix(table)?;
        let item = self.value()?;
        self.tables[target].entries.push((last, item));
        Ok(())
    }

    fn key(&mut self) -> Parsed<Vec<String>> {
        let mut parts = vec![self.simple_key()?];
        loop {
            self.skip_spaces();
            if !self.is_at(0, b'.') {
                return Ok(parts);
            }
            self.index += 1;
            self.skip_spaces();
            parts.push(self.simple_key()?);
        }
    }

    fn simple_key(&mut self) -> Parsed<String> {
        if self.is_at(0, b'"') {
            if self.starts_with("\"\"\"") {
                return self.fail("multiline strings are not allowed for keys");
            }
            return self.basic_string();
        }
        if self.is_at(0, b'\'') {
            if self.starts_with("'''") {
                return self.fail("multiline strings are not allowed for keys");
            }
            return self.literal_string();
        }
        let start = self.index;
        while self.index < self.text.len() && is_key_byte(self.byte(self.index)) {
            self.index += 1;
        }
        if start == self.index {
            return self.fail("invalid key");
        }
        Ok(String::from_utf16_lossy(&self.text[start..self.index]))
    }

    fn value(&mut self) -> Parsed<Item> {
        let mut frames: Vec<Frame> = Vec::new();
        let mut step = Step::Value;
        loop {
            let produced = match step {
                Step::Value => match self.begin_value()? {
                    Begun::Scalar(value) => Item::Value(value),
                    Begun::OpenArray => {
                        let id = self.new_array();
                        frames.push(Frame::Array(id));
                        step = self.array_start(id, &mut frames)?;
                        continue;
                    }
                    Begun::OpenInline => {
                        let table = self.new_table(TableState::Inline);
                        frames.push(Frame::Inline {
                            table,
                            pending: None,
                        });
                        step = self.inline_continue(table, &mut frames)?;
                        continue;
                    }
                },
                Step::Close(item) => item,
            };
            let delivery = match frames.last_mut() {
                None => return Ok(produced),
                Some(Frame::Array(id)) => Delivery::Array(*id),
                Some(Frame::Inline { table, pending }) => match pending.take() {
                    Some((target, last)) => Delivery::Inline(*table, target, last),
                    None => return self.fail("expected `=`"),
                },
            };
            step = match delivery {
                Delivery::Array(id) => {
                    self.arrays[id].push(produced);
                    self.array_after(id, &mut frames)?
                }
                Delivery::Inline(table, target, last) => {
                    self.tables[target].entries.push((last, produced));
                    self.inline_after(table, &mut frames)?
                }
            };
        }
    }

    fn array_after(&mut self, id: usize, frames: &mut Vec<Frame>) -> Parsed<Step> {
        self.skip_blank()?;
        if self.is_at(0, b',') {
            self.index += 1;
            return self.array_start(id, frames);
        }
        if self.is_at(0, b']') {
            self.index += 1;
            frames.pop();
            return Ok(Step::Close(Item::Array(id)));
        }
        self.fail("invalid array, expected `,` or `]`")
    }

    fn array_start(&mut self, id: usize, frames: &mut Vec<Frame>) -> Parsed<Step> {
        self.skip_blank()?;
        if self.is_at(0, b']') {
            self.index += 1;
            frames.pop();
            return Ok(Step::Close(Item::Array(id)));
        }
        Ok(Step::Value)
    }

    fn inline_after(&mut self, table: usize, frames: &mut Vec<Frame>) -> Parsed<Step> {
        self.skip_blank()?;
        if self.is_at(0, b',') {
            self.index += 1;
            return self.inline_continue(table, frames);
        }
        if self.is_at(0, b'}') {
            self.index += 1;
            frames.pop();
            return Ok(Step::Close(Item::Table(table)));
        }
        self.fail("invalid inline table, expected `,` or `}`")
    }

    fn inline_continue(&mut self, table: usize, frames: &mut Vec<Frame>) -> Parsed<Step> {
        self.skip_blank()?;
        if self.is_at(0, b'}') {
            self.index += 1;
            frames.pop();
            return Ok(Step::Close(Item::Table(table)));
        }
        let pair = self.key_prefix(table)?;
        if let Some(Frame::Inline { pending, .. }) = frames.last_mut() {
            *pending = Some(pair);
        }
        Ok(Step::Value)
    }

    fn begin_value(&mut self) -> Parsed<Begun> {
        let Some(unit) = self.peek(0) else {
            return self.fail("expected a value");
        };
        if self.starts_with("\"\"\"") {
            return Ok(Begun::Scalar(TomlValue::String(
                self.multiline_basic_string()?,
            )));
        }
        if self.starts_with("'''") {
            return Ok(Begun::Scalar(TomlValue::String(
                self.multiline_literal_string()?,
            )));
        }
        if unit == u16::from(b'"') {
            return Ok(Begun::Scalar(TomlValue::String(self.basic_string()?)));
        }
        if unit == u16::from(b'\'') {
            return Ok(Begun::Scalar(TomlValue::String(self.literal_string()?)));
        }
        if unit == u16::from(b'[') {
            self.index += 1;
            return Ok(Begun::OpenArray);
        }
        if unit == u16::from(b'{') {
            self.index += 1;
            return Ok(Begun::OpenInline);
        }
        if self.starts_with("true") && !is_key_byte(self.byte(self.index + 4)) {
            self.index += 4;
            return Ok(Begun::Scalar(TomlValue::Boolean(true)));
        }
        if self.starts_with("false") && !is_key_byte(self.byte(self.index + 5)) {
            self.index += 5;
            return Ok(Begun::Scalar(TomlValue::Boolean(false)));
        }
        if self.date_at(self.index).is_some() || self.is_hour_minute(self.index) {
            return Ok(Begun::Scalar(self.datetime()?));
        }
        Ok(Begun::Scalar(self.number()?))
    }

    fn basic_string(&mut self) -> Parsed<String> {
        self.index += 1;
        let mut out: Vec<u16> = Vec::new();
        loop {
            let unit = match self.peek(0) {
                None | Some(NEWLINE) | Some(CARRIAGE_RETURN) => {
                    return self.fail("invalid basic string, expected `\"`");
                }
                Some(unit) => unit,
            };
            self.index += 1;
            if unit == u16::from(b'"') {
                return Ok(String::from_utf16_lossy(&out));
            }
            if unit == u16::from(b'\\') {
                let character = self.escape()?;
                push_char(&mut out, character);
            } else {
                self.check_string_unit(unit)?;
                out.push(unit);
            }
        }
    }

    fn multiline_basic_string(&mut self) -> Parsed<String> {
        self.index += 3;
        self.newline();
        let mut out: Vec<u16> = Vec::new();
        loop {
            if self.index >= self.text.len() {
                return self.fail("invalid multiline basic string, expected `\"\"\"`");
            }
            if self.starts_with("\"\"\"") {
                let mut quotes = 3;
                while self.is_at(quotes, b'"') && quotes < 5 {
                    quotes += 1;
                }
                for _ in 3..quotes {
                    out.push(u16::from(b'"'));
                }
                self.index += quotes;
                return Ok(String::from_utf16_lossy(&out));
            }
            let unit = self.text[self.index];
            if unit == u16::from(b'\\') {
                let mut probe = self.index + 1;
                while matches!(self.text.get(probe).copied(), Some(SPACE) | Some(TAB)) {
                    probe += 1;
                }
                let line_end = self.text.get(probe).copied() == Some(NEWLINE)
                    || (self.text.get(probe).copied() == Some(CARRIAGE_RETURN)
                        && self.text.get(probe + 1).copied() == Some(NEWLINE));
                if line_end {
                    self.index = probe;
                    loop {
                        if self.newline() {
                            continue;
                        }
                        if self.peek(0) == Some(SPACE) || self.peek(0) == Some(TAB) {
                            self.index += 1;
                            continue;
                        }
                        break;
                    }
                    continue;
                }
                self.index += 1;
                let character = self.escape()?;
                push_char(&mut out, character);
                continue;
            }
            if self.newline() {
                out.push(NEWLINE);
                continue;
            }
            self.check_string_unit(unit)?;
            out.push(unit);
            self.index += 1;
        }
    }

    fn literal_string(&mut self) -> Parsed<String> {
        self.index += 1;
        let start = self.index;
        loop {
            let unit = match self.peek(0) {
                None | Some(NEWLINE) | Some(CARRIAGE_RETURN) => {
                    return self.fail("invalid literal string, expected `'`");
                }
                Some(unit) => unit,
            };
            if unit == u16::from(b'\'') {
                let value = String::from_utf16_lossy(&self.text[start..self.index]);
                self.index += 1;
                return Ok(value);
            }
            self.check_string_unit(unit)?;
            self.index += 1;
        }
    }

    fn multiline_literal_string(&mut self) -> Parsed<String> {
        self.index += 3;
        self.newline();
        let mut out: Vec<u16> = Vec::new();
        loop {
            if self.index >= self.text.len() {
                return self.fail("invalid multiline literal string, expected `'''`");
            }
            if self.starts_with("'''") {
                let mut quotes = 3;
                while self.is_at(quotes, b'\'') && quotes < 5 {
                    quotes += 1;
                }
                for _ in 3..quotes {
                    out.push(u16::from(b'\''));
                }
                self.index += quotes;
                return Ok(String::from_utf16_lossy(&out));
            }
            if self.newline() {
                out.push(NEWLINE);
                continue;
            }
            let unit = self.text[self.index];
            self.check_string_unit(unit)?;
            out.push(unit);
            self.index += 1;
        }
    }

    fn check_string_unit(&self, unit: u16) -> Parsed<()> {
        if (unit < 0x20 && unit != TAB) || unit == 0x7f {
            return self.fail("invalid string character");
        }
        Ok(())
    }

    fn escape(&mut self) -> Parsed<char> {
        let unit = self.peek(0);
        self.index += 1;
        let byte = unit.and_then(|unit| u8::try_from(unit).ok());
        match byte {
            Some(b'b') => Ok('\u{8}'),
            Some(b't') => Ok('\t'),
            Some(b'n') => Ok('\n'),
            Some(b'f') => Ok('\u{c}'),
            Some(b'r') => Ok('\r'),
            Some(b'e') => Ok('\u{1b}'),
            Some(b'"') => Ok('"'),
            Some(b'\\') => Ok('\\'),
            Some(b'x') => self.hex_escape(2),
            Some(b'u') => self.hex_escape(4),
            Some(b'U') => self.hex_escape(8),
            _ => self.fail_at("invalid escape sequence", self.index - 1),
        }
    }

    fn hex_escape(&mut self, length: usize) -> Parsed<char> {
        let valid = (0..length).all(|offset| self.byte(self.index + offset).is_ascii_hexdigit());
        if !valid {
            return self.fail("invalid unicode escape");
        }
        let mut code: u32 = 0;
        for offset in 0..length {
            code = code * 16 + digit_value(self.byte(self.index + offset)) as u32;
        }
        let Some(character) = char::from_u32(code) else {
            return self.fail("invalid unicode escape");
        };
        self.index += length;
        Ok(character)
    }

    fn digits_at(&self, at: usize, count: usize) -> bool {
        (0..count).all(|offset| self.byte(at + offset).is_ascii_digit())
    }

    fn number_at(&self, at: usize, count: usize) -> u32 {
        (0..count).fold(0, |value, offset| {
            value * 10 + u32::from(self.byte(at + offset).wrapping_sub(b'0'))
        })
    }

    fn ascii_text(&self, at: usize, length: usize) -> String {
        (at..at + length)
            .map(|position| char::from(self.byte(position)))
            .collect()
    }

    fn date_at(&self, at: usize) -> Option<(u32, u32, u32)> {
        if self.digits_at(at, 4)
            && self.byte(at + 4) == b'-'
            && self.digits_at(at + 5, 2)
            && self.byte(at + 7) == b'-'
            && self.digits_at(at + 8, 2)
        {
            return Some((
                self.number_at(at, 4),
                self.number_at(at + 5, 2),
                self.number_at(at + 8, 2),
            ));
        }
        None
    }

    fn is_hour_minute(&self, at: usize) -> bool {
        self.digits_at(at, 2) && self.byte(at + 2) == b':' && self.digits_at(at + 3, 2)
    }

    fn offset_length_at(&self, at: usize) -> Option<usize> {
        let byte = self.byte(at);
        if byte == b'Z' || byte == b'z' {
            return Some(1);
        }
        if (byte == b'+' || byte == b'-')
            && self.digits_at(at + 1, 2)
            && self.byte(at + 3) == b':'
            && self.digits_at(at + 4, 2)
        {
            return Some(6);
        }
        None
    }

    fn time(&self, at: usize) -> Parsed<(String, usize)> {
        if !self.is_hour_minute(at) {
            return self.fail("invalid time");
        }
        let hour = self.number_at(at, 2);
        let minute = self.number_at(at + 3, 2);
        let mut length = 5;
        let mut second_text = "00".to_owned();
        let mut second = 0;
        let mut fraction = String::new();
        if self.byte(at + 5) == b':' && self.digits_at(at + 6, 2) {
            second = self.number_at(at + 6, 2);
            second_text = self.ascii_text(at + 6, 2);
            length = 8;
            if self.byte(at + 8) == b'.' && self.byte(at + 9).is_ascii_digit() {
                let mut end = at + 9;
                while self.byte(end).is_ascii_digit() {
                    end += 1;
                }
                fraction = self.ascii_text(at + 9, end - (at + 9));
                length = end - at;
            }
        }
        if hour > 23 || minute > 59 || second > 60 {
            return self.fail("invalid time");
        }
        let mut normalized = format!(
            "{}:{}:{}",
            self.ascii_text(at, 2),
            self.ascii_text(at + 3, 2),
            second_text
        );
        if !fraction.is_empty() {
            let mut nanos: String = fraction.chars().take(9).collect();
            while nanos.len() < 9 {
                nanos.push('0');
            }
            let trimmed = nanos.trim_end_matches('0');
            if !trimmed.is_empty() {
                normalized.push('.');
                normalized.push_str(trimmed);
            }
        }
        Ok((normalized, length))
    }

    fn datetime(&mut self) -> Parsed<TomlValue> {
        let start = self.index;
        let mut consumed;
        let mut out;
        if let Some((year, month, day)) = self.date_at(start) {
            if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
                return self.fail("invalid date");
            }
            out = self.ascii_text(start, 10);
            consumed = 10;
            let separator = self.byte(start + consumed);
            if (separator == b'T' || separator == b't' || separator == b' ')
                && self.is_hour_minute(start + consumed + 1)
            {
                consumed += 1;
                let (time_text, time_length) = self.time(start + consumed)?;
                out.push('T');
                out.push_str(&time_text);
                consumed += time_length;
                if let Some(length) = self.offset_length_at(start + consumed) {
                    let first = self.byte(start + consumed);
                    if first != b'Z' && first != b'z' {
                        let hours = self.number_at(start + consumed + 1, 2);
                        let minutes = self.number_at(start + consumed + 4, 2);
                        if hours > 23 || minutes > 59 {
                            return self.fail("invalid offset");
                        }
                    }
                    if first == b'z' {
                        out.push('Z');
                    } else {
                        out.push_str(&self.ascii_text(start + consumed, length));
                    }
                    consumed += length;
                }
            }
        } else {
            let (time_text, time_length) = self.time(start)?;
            out = time_text;
            consumed = time_length;
        }
        let next = self.byte(start + consumed);
        if next.is_ascii_alphanumeric() || matches!(next, b'_' | b'.' | b':' | b'+' | b'-') {
            return self.fail("invalid datetime");
        }
        self.index += consumed;
        Ok(TomlValue::Datetime(out))
    }

    fn skip_digit_groups(&self, mut cursor: usize) -> usize {
        loop {
            if self.byte(cursor).is_ascii_digit() {
                cursor += 1;
            } else if self.byte(cursor) == b'_' && self.byte(cursor + 1).is_ascii_digit() {
                cursor += 2;
            } else {
                return cursor;
            }
        }
    }

    fn check_value_end(&self) -> Parsed<()> {
        let byte = self.byte(self.index);
        if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.' {
            return self.fail("invalid number");
        }
        Ok(())
    }

    fn number(&mut self) -> Parsed<TomlValue> {
        let start = self.index;
        let sign = self.byte(start);
        let signed = sign == b'+' || sign == b'-';
        let body = if signed { start + 1 } else { start };
        let is_inf = (0..3).all(|offset| self.byte(body + offset) == b"inf"[offset]);
        let is_nan = (0..3).all(|offset| self.byte(body + offset) == b"nan"[offset]);
        if (is_inf || is_nan) && !is_word_byte(self.byte(body + 3)) {
            self.index = body + 3;
            let negative = signed && sign == b'-';
            if is_inf {
                return Ok(TomlValue::Float {
                    value: if negative {
                        f64::NEG_INFINITY
                    } else {
                        f64::INFINITY
                    },
                    negative_nan: false,
                });
            }
            return Ok(TomlValue::Float {
                value: f64::NAN,
                negative_nan: negative,
            });
        }
        if self.byte(start) == b'0' && matches!(self.byte(start + 1), b'x' | b'o' | b'b') {
            let mut end = start + 2;
            while self.byte(end).is_ascii_hexdigit() || self.byte(end) == b'_' {
                end += 1;
            }
            if end > start + 2 {
                let digits: Vec<u8> = (start + 2..end).map(|at| self.byte(at)).collect();
                let radix: u64 = match self.byte(start + 1) {
                    b'x' => 16,
                    b'o' => 8,
                    _ => 2,
                };
                if !grouped_digits(&digits, radix) {
                    return self.fail("invalid integer");
                }
                let mut value: Option<u64> = Some(0);
                for &byte in digits.iter().filter(|byte| **byte != b'_') {
                    value = value
                        .and_then(|value| value.checked_mul(radix))
                        .and_then(|value| value.checked_add(digit_value(byte)));
                }
                let Some(value) = value.filter(|value| *value <= i64::MAX as u64) else {
                    return self.fail("integer number overflowed");
                };
                self.index = end;
                self.check_value_end()?;
                return Ok(TomlValue::Integer(value as i64));
            }
        }
        let mut cursor = body;
        if self.byte(cursor) == b'0' {
            cursor += 1;
        } else if (b'1'..=b'9').contains(&self.byte(cursor)) {
            cursor = self.skip_digit_groups(cursor + 1);
        } else {
            return self.fail("invalid value");
        }
        if self.byte(cursor) == b'.' && self.byte(cursor + 1).is_ascii_digit() {
            cursor = self.skip_digit_groups(cursor + 2);
        }
        if matches!(self.byte(cursor), b'e' | b'E') {
            let mut probe = cursor + 1;
            if matches!(self.byte(probe), b'+' | b'-') {
                probe += 1;
            }
            if self.byte(probe).is_ascii_digit() {
                cursor = self.skip_digit_groups(probe + 1);
            }
        }
        let text = self.ascii_text(start, cursor - start);
        self.index = cursor;
        self.check_value_end()?;
        let clean = text.replace('_', "");
        if clean.contains(['.', 'e', 'E']) {
            let value: f64 = match clean.parse() {
                Ok(value) => value,
                Err(_) => return self.fail("invalid float"),
            };
            if !value.is_finite() {
                return self.fail("invalid float");
            }
            return Ok(TomlValue::Float {
                value,
                negative_nan: false,
            });
        }
        match clean.parse::<i64>() {
            Ok(value) => Ok(TomlValue::Integer(value)),
            Err(_) => self.fail("integer number overflowed"),
        }
    }
}

pub fn parse_toml(text: &str) -> Result<TomlTable, TomlParseError> {
    let mut parser = Parser {
        text: text.encode_utf16().collect(),
        index: 0,
        tables: Vec::new(),
        arrays: Vec::new(),
        log: Vec::new(),
        current: 0,
    };
    parser.new_table(TableState::Header);
    parser.parse()?;
    Ok(parser.build())
}

const KEY_ALIASES: [(&[&str], &[&str]); 3] = [
    (&["tui", "whimsy"], &["tui", "effects", "starfield"]),
    (
        &["memories", "no_memories_if_mcp_or_web_search"],
        &["memories", "disable_on_external_context"],
    ),
    (
        &["agents", "max_threads"],
        &["agents", "max_concurrent_threads_per_session"],
    ),
];
const STRUCTURED_FEATURES: [&str; 5] = [
    "code_mode",
    "multi_agent_v2",
    "network_proxy",
    "sleep_tool",
    "runtime_agent_instances",
];

fn same_path(left: &[String], right: &[&str]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(segment, other)| segment == other)
}

fn normalize_table_aliases(path: &[String], entries: &mut TomlTable) {
    'aliases: for (legacy, canonical) in KEY_ALIASES {
        let table_path = &legacy[..legacy.len() - 1];
        let legacy_key = legacy[legacy.len() - 1];
        if !same_path(path, table_path) || canonical.get(..table_path.len()) != Some(table_path) {
            continue;
        }
        let Some(value) = entries.remove(legacy_key) else {
            continue;
        };
        let canonical_path = &canonical[table_path.len()..];
        let mut destination: &mut TomlTable = &mut *entries;
        for parent in &canonical_path[..canonical_path.len() - 1] {
            if !destination.contains_key(parent) {
                destination.insert((*parent).to_owned(), TomlValue::Table(TomlTable::new()));
            }
            let position = destination.position(parent).unwrap_or(0);
            match &mut destination.entries[position].1 {
                TomlValue::Table(child) => destination = child,
                _ => continue 'aliases,
            }
        }
        let key = canonical_path[canonical_path.len() - 1];
        if !destination.contains_key(key) {
            destination.insert(key.to_owned(), value);
        }
    }
}

fn normalize_key_aliases(value: &TomlValue, path: &[String]) -> TomlValue {
    let relevant = KEY_ALIASES
        .iter()
        .any(|(legacy, _)| path.len() <= legacy.len() && same_path(path, &legacy[..path.len()]));
    if !relevant {
        return value.clone();
    }
    match value {
        TomlValue::Array(items) => rebuild(Source::Array(items), |child| match child {
            TomlValue::Table(_) => Some(normalize_key_aliases(child, path)),
            _ => None,
        }),
        TomlValue::Table(table) => {
            let mut normalized = TomlTable::new();
            for (key, child) in &table.entries {
                let mut child_path = path.to_vec();
                child_path.push(key.clone());
                normalized.insert(key.clone(), normalize_key_aliases(child, &child_path));
            }
            normalize_table_aliases(path, &mut normalized);
            TomlValue::Table(normalized)
        }
        other => clone_scalar(other),
    }
}

fn normalize_base_key_aliases(base: &mut TomlTable, overlay: &TomlTable) {
    for (key, value) in &overlay.entries {
        if let (Some(TomlValue::Table(existing)), TomlValue::Table(_)) = (base.get_mut(key), value)
        {
            normalize_table_aliases(std::slice::from_ref(key), existing);
        }
    }
}

fn is_structured_feature_path(path: &[String]) -> bool {
    if path.len() == 4 && path[0] == "profiles" {
        return path[2] == "features" && STRUCTURED_FEATURES.contains(&path[3].as_str());
    }
    path.len() == 2 && path[0] == "features" && STRUCTURED_FEATURES.contains(&path[1].as_str())
}

fn is_network_domains_path(path: &[String]) -> bool {
    (path.len() == 4 && path[0] == "permissions" && path[2] == "network" && path[3] == "domains")
        || same_path(path, &["application", "network", "domains"])
}

fn segment_ends(
    text: &[u8],
    at: usize,
    limit: usize,
    accepts: impl Fn(&[u8]) -> bool,
) -> Vec<usize> {
    (1..=limit)
        .filter(|length| text.get(at..at + length).is_some_and(&accepts))
        .map(|length| at + length)
        .collect()
}

fn ipv4_segment_ends(text: &[u8], at: usize) -> Vec<usize> {
    segment_ends(text, at, 3, |segment| {
        segment.iter().all(u8::is_ascii_digit)
            && (segment.len() == 1 || segment[0] != b'0')
            && std::str::from_utf8(segment)
                .is_ok_and(|digits| digits.parse::<u16>().is_ok_and(|value| value <= 255))
    })
}

fn ipv6_segment_ends(text: &[u8], at: usize) -> Vec<usize> {
    segment_ends(text, at, 4, |segment| {
        segment.iter().all(u8::is_ascii_hexdigit)
    })
}

fn colon_ends(text: &[u8], at: usize) -> Vec<usize> {
    if text.get(at) == Some(&b':') {
        vec![at + 1]
    } else {
        Vec::new()
    }
}

fn ipv4_ends(text: &[u8], at: usize) -> Vec<usize> {
    let mut ends = vec![at];
    for _ in 0..3 {
        ends = unique(
            ends.iter()
                .flat_map(|end| ipv4_segment_ends(text, *end))
                .flat_map(|end| dot_ends(text, end))
                .collect(),
        );
    }
    unique(
        ends.iter()
            .flat_map(|end| ipv4_segment_ends(text, *end))
            .collect(),
    )
}

fn dot_ends(text: &[u8], at: usize) -> Vec<usize> {
    if text.get(at) == Some(&b'.') {
        vec![at + 1]
    } else {
        Vec::new()
    }
}

fn unique(mut positions: Vec<usize>) -> Vec<usize> {
    positions.sort_unstable();
    positions.dedup();
    positions
}

fn then(text: &[u8], starts: &[usize], step: fn(&[u8], usize) -> Vec<usize>) -> Vec<usize> {
    unique(starts.iter().flat_map(|start| step(text, *start)).collect())
}

fn colon_ipv6_ends(text: &[u8], at: usize) -> Vec<usize> {
    let after_colon = colon_ends(text, at);
    then(text, &after_colon, ipv6_segment_ends)
}

fn colon_ipv4_ends(text: &[u8], at: usize) -> Vec<usize> {
    let after_colon = colon_ends(text, at);
    then(text, &after_colon, ipv4_ends)
}

fn ipv6_group_ends(text: &[u8], at: usize) -> Vec<usize> {
    let after_segment = ipv6_segment_ends(text, at);
    then(text, &after_segment, colon_ends)
}

fn repeated(
    text: &[u8],
    starts: &[usize],
    step: fn(&[u8], usize) -> Vec<usize>,
    min: usize,
    max: usize,
) -> Vec<usize> {
    let mut current = unique(starts.to_vec());
    let mut ends = if min == 0 {
        current.clone()
    } else {
        Vec::new()
    };
    for count in 1..=max {
        current = then(text, &current, step);
        if count >= min {
            ends.extend(current.iter().copied());
        }
    }
    unique(ends)
}

fn ipv6_tail_ends(text: &[u8], starts: &[usize], groups: usize) -> Vec<usize> {
    let mut ends = then(text, starts, colon_ends);
    match groups {
        7 => ends.extend(then(text, starts, ipv6_segment_ends)),
        6 => {
            ends.extend(then(text, starts, ipv4_ends));
            ends.extend(repeated(text, starts, colon_ipv6_ends, 1, 1));
        }
        _ => {
            let before_ipv4 = repeated(text, starts, colon_ipv6_ends, 0, 5 - groups);
            ends.extend(then(text, &before_ipv4, colon_ipv4_ends));
            ends.extend(repeated(text, starts, colon_ipv6_ends, 1, 7 - groups));
        }
    }
    unique(ends)
}

fn is_ipv4(text: &str) -> bool {
    ipv4_ends(text.as_bytes(), 0).contains(&text.len())
}

fn is_ipv6(text: &str) -> bool {
    let (address, zone) = match text.split_once('%') {
        Some((address, zone)) => (address, Some(zone)),
        None => (text, None),
    };
    if zone.is_some_and(|zone| {
        zone.is_empty()
            || !zone
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b':'))
    }) {
        return false;
    }
    let bytes = address.as_bytes();
    let matches_form = (1..=7).any(|groups| {
        let starts = repeated(bytes, &[0], ipv6_group_ends, groups, groups);
        ipv6_tail_ends(bytes, &starts, groups).contains(&bytes.len())
    });
    matches_form
        || (bytes.first() == Some(&b':') && ipv6_tail_ends(bytes, &[1], 0).contains(&bytes.len()))
}

fn is_ip(text: &str) -> bool {
    is_ipv4(text) || is_ipv6(text)
}

fn normalize_ip_literal(host: &str) -> String {
    if !host.contains('%') && is_ip(host) {
        return host.to_owned();
    }
    for delimiter in ["%25", "%"] {
        let Some(at) = host.find(delimiter) else {
            continue;
        };
        let ip = &host[..at];
        if !ip.contains('%') && is_ip(ip) {
            return format!("{ip}%{}", &host[at + delimiter.len()..]);
        }
    }
    host.to_owned()
}

fn normalize_dns_host_or_ip_literal(host: &str) -> String {
    normalize_ip_literal(ascii_lower(host).trim_end_matches('.'))
}

fn normalize_host(raw: &str) -> String {
    let trimmed = os_text(&trim(&LosslessString::from(raw)));
    let host = trimmed.as_str();
    if host.starts_with('[')
        && let Some(end) = host.find(']')
    {
        return normalize_dns_host_or_ip_literal(&host[1..end]);
    }
    if host.matches(':').count() == 1 {
        return normalize_dns_host_or_ip_literal(host.split(':').next().unwrap_or(host));
    }
    normalize_dns_host_or_ip_literal(host)
}

fn rekey(table: &mut TomlTable, normalize: impl Fn(&str) -> String) {
    let previous = std::mem::take(&mut table.entries);
    for (key, value) in previous {
        table.insert(normalize(&key), value);
    }
}

fn env_sources(value: Option<&TomlValue>) -> Option<Vec<String>> {
    let env = match value {
        Some(TomlValue::Table(table)) => table.get("env"),
        _ => None,
    };
    match env {
        Some(TomlValue::Array(items)) => Some(
            items
                .iter()
                .filter_map(|item| match item {
                    TomlValue::String(text) => Some(text.clone()),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    }
}

pub(crate) fn env_keys_match(left: &str, right: &str) -> bool {
    left == right || (cfg!(windows) && ascii_lower(left) == ascii_lower(right))
}

fn replace_filter_representation(base: &mut TomlValue, overlay: &TomlValue, path: &[String]) {
    if !same_path(path, &["shell_environment_policy"]) {
        return;
    }
    let (TomlValue::Table(base), TomlValue::Table(overlay)) = (base, overlay) else {
        return;
    };
    if overlay.contains_key("filters") {
        for field in ["exclude", "include_only"] {
            base.remove(field);
        }
    } else if overlay.contains_key("exclude") || overlay.contains_key("include_only") {
        base.remove("filters");
    }
}

enum Merged {
    Done(TomlValue),
    Descend(TomlTable, TomlTable),
}

fn merge_value(mut base: TomlValue, overlay: TomlValue, path: &[String]) -> Merged {
    replace_filter_representation(&mut base, &overlay, path);
    if is_structured_feature_path(path) {
        let base_is_boolean = matches!(base, TomlValue::Boolean(_));
        let base_is_table = matches!(base, TomlValue::Table(_));
        let overlay_is_boolean = matches!(overlay, TomlValue::Boolean(_));
        let overlay_is_table = matches!(overlay, TomlValue::Table(_));
        if base_is_boolean && overlay_is_table {
            base = TomlValue::Table(TomlTable {
                entries: vec![("enabled".to_owned(), base)],
            });
        } else if base_is_table && overlay_is_boolean {
            if let TomlValue::Table(table) = &mut base {
                table.insert("enabled".to_owned(), overlay);
            }
            return Merged::Done(base);
        }
    }
    match (base.take_table(), overlay.take_table()) {
        (Ok(base_table), Ok(overlay_table)) => Merged::Descend(base_table, overlay_table),
        (_, Ok(overlay_table)) => Merged::Done(TomlValue::Table(overlay_table)),
        (_, Err(overlay_value)) => Merged::Done(overlay_value),
    }
}

fn prepare_merge(base: &mut TomlTable, overlay: &mut TomlTable, path: &[String]) {
    if is_network_domains_path(path) {
        rekey(base, normalize_host);
        rekey(overlay, normalize_host);
    }
    if same_path(path, &["shell_environment_policy", "filters"]) {
        rekey(base, |key| key.to_lowercase());
        rekey(overlay, |key| key.to_lowercase());
    }
    if path.last().map(String::as_str) == Some("credentials")
        && is_structured_feature_path(&path[..path.len() - 1])
    {
        for (provider_id, provider) in &overlay.entries {
            let Some(claimed) = env_sources(Some(provider)) else {
                continue;
            };
            base.entries.retain(|(existing_id, existing)| {
                if existing_id == provider_id {
                    return true;
                }
                let sources =
                    env_sources(overlay.get(existing_id)).or_else(|| env_sources(Some(existing)));
                !sources.is_some_and(|sources| {
                    sources.iter().any(|source| {
                        claimed
                            .iter()
                            .any(|candidate| env_keys_match(source, candidate))
                    })
                })
            });
        }
    }
}

struct MergeFrame {
    base: TomlTable,
    overlay: std::vec::IntoIter<(String, TomlValue)>,
    slot: usize,
}

fn merge_tables(mut base: TomlTable, mut overlay: TomlTable) -> TomlTable {
    let mut path: Vec<String> = Vec::new();
    prepare_merge(&mut base, &mut overlay, &path);
    let mut stack = vec![MergeFrame {
        overlay: std::mem::take(&mut overlay.entries).into_iter(),
        base,
        slot: 0,
    }];
    loop {
        let next = {
            let Some(frame) = stack.last_mut() else {
                return TomlTable::new();
            };
            frame.overlay.next()
        };
        match next {
            Some((key, value)) => {
                path.push(key.clone());
                let Some(frame) = stack.last_mut() else {
                    return TomlTable::new();
                };
                match frame.base.position(&key) {
                    None => {
                        frame.base.entries.push((key, value));
                        path.pop();
                    }
                    Some(position) => {
                        let existing = std::mem::replace(
                            &mut frame.base.entries[position].1,
                            TomlValue::Boolean(false),
                        );
                        match merge_value(existing, value, &path) {
                            Merged::Done(result) => {
                                frame.base.entries[position].1 = result;
                                path.pop();
                            }
                            Merged::Descend(mut base_table, mut overlay_table) => {
                                prepare_merge(&mut base_table, &mut overlay_table, &path);
                                stack.push(MergeFrame {
                                    overlay: std::mem::take(&mut overlay_table.entries).into_iter(),
                                    base: base_table,
                                    slot: position,
                                });
                            }
                        }
                    }
                }
            }
            None => {
                let Some(finished) = stack.pop() else {
                    return TomlTable::new();
                };
                match stack.last_mut() {
                    Some(parent) => {
                        parent.base.entries[finished.slot].1 = TomlValue::Table(finished.base);
                        path.pop();
                    }
                    None => return finished.base,
                }
            }
        }
    }
}

pub fn merge_toml(base: TomlTable, overlay: &TomlTable) -> TomlTable {
    let mut normalized = TomlTable::new();
    for (key, value) in &overlay.entries {
        normalized.insert(
            key.clone(),
            normalize_key_aliases(value, std::slice::from_ref(key)),
        );
    }
    normalize_table_aliases(&[], &mut normalized);
    let mut merged = base;
    normalize_base_key_aliases(&mut merged, &normalized);
    merge_tables(merged, normalized)
}

struct SelectorNode {
    terminal: bool,
    children: Vec<(Option<String>, usize)>,
}

fn selector(paths: &[Vec<Option<String>>]) -> Vec<SelectorNode> {
    let mut nodes = vec![SelectorNode {
        terminal: false,
        children: Vec::new(),
    }];
    for path in paths {
        let mut node = 0;
        for segment in path {
            if nodes[node].terminal {
                break;
            }
            let existing = nodes[node]
                .children
                .iter()
                .find(|(key, _)| key == segment)
                .map(|(_, child)| *child);
            node = match existing {
                Some(child) => child,
                None => {
                    nodes.push(SelectorNode {
                        terminal: false,
                        children: Vec::new(),
                    });
                    let child = nodes.len() - 1;
                    nodes[node].children.push((segment.clone(), child));
                    child
                }
            };
        }
        if !nodes[node].terminal {
            nodes[node].terminal = true;
            nodes[node].children.clear();
        }
    }
    nodes
}

struct ProjectFrame<'a> {
    entries: &'a [(String, TomlValue)],
    node: usize,
    position: usize,
    out: Vec<(String, TomlValue)>,
    pending: Option<String>,
}

fn project_value(value: &TomlValue, nodes: &[SelectorNode]) -> TomlValue {
    let TomlValue::Table(table) = value else {
        return value.clone();
    };
    if nodes[0].terminal {
        return value.clone();
    }
    let mut stack = vec![ProjectFrame {
        entries: &table.entries,
        node: 0,
        position: 0,
        out: Vec::new(),
        pending: None,
    }];
    loop {
        let Some(frame) = stack.last_mut() else {
            return absent();
        };
        if frame.position >= frame.entries.len() {
            let Some(finished) = stack.pop() else {
                return absent();
            };
            let projected = TomlValue::Table(TomlTable {
                entries: finished.out,
            });
            match stack.last_mut() {
                Some(parent) => {
                    if let Some(key) = parent.pending.take() {
                        parent.out.push((key, projected));
                    }
                }
                None => return projected,
            }
            continue;
        }
        let entries = frame.entries;
        let (key, child) = &entries[frame.position];
        frame.position += 1;
        let child_node = nodes[frame.node]
            .children
            .iter()
            .find(|(segment, _)| segment.as_deref() == Some(key.as_str()))
            .map(|(_, index)| *index);
        let Some(child_node) = child_node else {
            continue;
        };
        match child {
            TomlValue::Table(child_table) if !nodes[child_node].terminal => {
                frame.pending = Some(key.clone());
                stack.push(ProjectFrame {
                    entries: &child_table.entries,
                    node: child_node,
                    position: 0,
                    out: Vec::new(),
                    pending: None,
                });
            }
            _ => frame.out.push((key.clone(), child.clone())),
        }
    }
}

pub fn project_toml_selectors(
    value: &TomlValue,
    paths: &[Vec<Option<String>>],
) -> Option<TomlValue> {
    let nodes = selector(paths);
    let projected = project_value(value, &nodes);
    if !nodes[0].terminal
        && let TomlValue::Table(table) = &projected
        && table.is_empty()
    {
        return None;
    }
    Some(projected)
}

pub fn project_toml(value: &TomlValue, paths: &[Vec<String>]) -> Option<TomlValue> {
    let selectors: Vec<Vec<Option<String>>> = paths
        .iter()
        .map(|path| path.iter().cloned().map(Some).collect())
        .collect();
    project_toml_selectors(value, &selectors)
}

fn key_repr(key: &str) -> String {
    if !key.is_empty() && key.bytes().all(is_key_byte) {
        return key.to_owned();
    }
    let mut escape_codes = false;
    let mut escape = false;
    let mut double_quotes = false;
    let mut single_quotes = false;
    for character in key.chars() {
        let code = u32::from(character);
        if character == '\'' {
            single_quotes = true;
        } else if character == '"' {
            double_quotes = true;
        } else if character == '\\' {
            escape = true;
        } else if character != '\t' && (code <= 0x1f || code == 0x7f) {
            escape_codes = true;
        }
    }
    if !escape_codes && !escape && !double_quotes {
        return format!("\"{key}\"");
    }
    if !escape_codes && !single_quotes {
        return format!("'{key}'");
    }
    format!("\"{}\"", escape_basic(key, false))
}

fn escape_basic(value: &str, multiline: bool) -> String {
    let max_quotes = if multiline { 2 } else { 0 };
    let mut out = String::new();
    let mut quotes = 0;
    for character in value.chars() {
        if character == '"' {
            quotes += 1;
            if quotes > max_quotes {
                out.push_str("\\\"");
                quotes = 0;
            } else {
                out.push('"');
            }
            continue;
        }
        quotes = 0;
        let code = u32::from(character);
        match character {
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str(if multiline { "\n" } else { "\\n" }),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '\\' => out.push_str("\\\\"),
            _ if code <= 0x1f || code == 0x7f => out.push_str(&format!("\\u{code:04X}")),
            _ => out.push(character),
        }
    }
    out
}

fn string_repr(value: &str) -> String {
    let mut max_singles = 0;
    let mut max_doubles = 0;
    let mut singles = 0;
    let mut doubles = 0;
    let mut escape_codes = false;
    let mut escape = false;
    let mut newline = false;
    for character in value.chars() {
        singles = if character == '\'' { singles + 1 } else { 0 };
        doubles = if character == '"' { doubles + 1 } else { 0 };
        max_singles = max_singles.max(singles);
        max_doubles = max_doubles.max(doubles);
        let code = u32::from(character);
        if character == '\\' {
            escape = true;
        } else if character == '\n' {
            newline = true;
        } else if character != '\t' && (code <= 0x1f || code == 0x7f) {
            escape_codes = true;
        }
    }
    let prefix = if newline { "\n" } else { "" };
    if !escape_codes && !escape && max_doubles == 0 && !newline {
        return format!("\"{}\"", escape_basic(value, false));
    }
    if !escape_codes && max_singles == 0 && !newline {
        return format!("'{value}'");
    }
    if !escape_codes && !escape && max_doubles <= 2 {
        return format!("\"\"\"{prefix}{}\"\"\"", escape_basic(value, true));
    }
    if !escape_codes && max_singles <= 2 {
        return format!("'''{prefix}{value}'''");
    }
    if newline {
        return format!("\"\"\"{prefix}{}\"\"\"", escape_basic(value, true));
    }
    format!("\"{}\"", escape_basic(value, false))
}

fn plain_decimal(magnitude: f64) -> String {
    let text = stringify_json(&Value::Number(magnitude));
    let Some((mantissa, exponent)) = text.split_once('e') else {
        return text;
    };
    let Ok(exponent) = exponent.parse::<i64>() else {
        return text;
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{whole}{fraction}");
    let point = whole.len() as i64 + exponent;
    if point <= 0 {
        return format!("0.{}{digits}", "0".repeat((-point) as usize));
    }
    if point >= digits.len() as i64 {
        return format!(
            "{digits}{}",
            "0".repeat((point - digits.len() as i64) as usize)
        );
    }
    format!(
        "{}.{}",
        &digits[..point as usize],
        &digits[point as usize..]
    )
}

fn float_repr(value: f64, negative_nan: bool) -> String {
    if value.is_nan() {
        return String::from(if negative_nan { "-nan" } else { "nan" });
    }
    if value == 0.0 {
        return String::from(if value.is_sign_negative() {
            "-0.0"
        } else {
            "0.0"
        });
    }
    if value == f64::INFINITY {
        return "inf".to_owned();
    }
    if value == f64::NEG_INFINITY {
        return "-inf".to_owned();
    }
    let text = format!(
        "{}{}",
        if value < 0.0 { "-" } else { "" },
        plain_decimal(value.abs())
    );
    if value % 1.0 == 0.0 {
        format!("{text}.0")
    } else {
        text
    }
}

enum Piece<'a> {
    Value(&'a TomlValue),
    Text(&'static str),
    Key(&'a str),
}

fn inline_repr(value: &TomlValue) -> String {
    let mut out = String::new();
    let mut stack = vec![Piece::Value(value)];
    while let Some(piece) = stack.pop() {
        match piece {
            Piece::Text(text) => out.push_str(text),
            Piece::Key(key) => {
                out.push_str(&key_repr(key));
                out.push_str(" = ");
            }
            Piece::Value(value) => match value {
                TomlValue::String(text) => out.push_str(&string_repr(text)),
                TomlValue::Integer(number) => out.push_str(&number.to_string()),
                TomlValue::Float {
                    value,
                    negative_nan,
                } => out.push_str(&float_repr(*value, *negative_nan)),
                TomlValue::Boolean(flag) => out.push_str(if *flag { "true" } else { "false" }),
                TomlValue::Datetime(text) => out.push_str(text),
                TomlValue::Array(items) => {
                    out.push('[');
                    stack.push(Piece::Text("]"));
                    for (index, item) in items.iter().enumerate().rev() {
                        stack.push(Piece::Value(item));
                        if index > 0 {
                            stack.push(Piece::Text(", "));
                        }
                    }
                }
                TomlValue::Table(table) => {
                    if table.is_empty() {
                        out.push_str("{}");
                    } else {
                        out.push_str("{ ");
                        stack.push(Piece::Text(" }"));
                        for (index, (key, item)) in table.entries.iter().enumerate().rev() {
                            stack.push(Piece::Value(item));
                            stack.push(Piece::Key(key));
                            if index > 0 {
                                stack.push(Piece::Text(", "));
                            }
                        }
                    }
                }
            },
        }
    }
    out
}

fn is_array_of_tables(value: &TomlValue) -> bool {
    matches!(value, TomlValue::Array(items) if !items.is_empty() && items.iter().all(|item| matches!(item, TomlValue::Table(_))))
}

struct Work<'a> {
    table: &'a TomlTable,
    depth: usize,
    key: Option<&'a str>,
    element: bool,
}

pub fn stringify_toml(root: &TomlTable) -> String {
    let mut sections: Vec<String> = Vec::new();
    let mut path: Vec<&str> = Vec::new();
    let mut stack = vec![Work {
        table: root,
        depth: 0,
        key: None,
        element: false,
    }];
    while let Some(work) = stack.pop() {
        path.truncate(work.depth);
        if let Some(key) = work.key {
            path.push(key);
        }
        let table = work.table;
        let mut lines: Vec<String> = Vec::new();
        let mut children: Vec<(&str, &TomlValue)> = Vec::new();
        for (key, value) in &table.entries {
            if matches!(value, TomlValue::Table(_)) || is_array_of_tables(value) {
                children.push((key.as_str(), value));
            } else {
                lines.push(format!("{} = {}", key_repr(key), inline_repr(value)));
            }
        }
        if !path.is_empty() && (work.element || !lines.is_empty() || table.is_empty()) {
            let header = path
                .iter()
                .map(|segment| key_repr(segment))
                .collect::<Vec<_>>()
                .join(".");
            lines.insert(
                0,
                if work.element {
                    format!("[[{header}]]")
                } else {
                    format!("[{header}]")
                },
            );
        }
        if !lines.is_empty() {
            sections.push(format!("{}\n", lines.join("\n")));
        }
        let depth = path.len();
        for (key, value) in children.into_iter().rev() {
            match value {
                TomlValue::Table(child) => stack.push(Work {
                    table: child,
                    depth,
                    key: Some(key),
                    element: false,
                }),
                TomlValue::Array(items) => {
                    for item in items.iter().rev() {
                        if let TomlValue::Table(child) = item {
                            stack.push(Work {
                                table: child,
                                depth,
                                key: Some(key),
                                element: true,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }
    sections.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> TomlTable {
        parse_toml(text).expect("synthetic document parses")
    }

    fn merge(base: &str, overlay: &str) -> String {
        stringify_toml(&merge_toml(parsed(base), &parsed(overlay)))
    }

    fn selectors(paths: &[&[Option<&str>]]) -> Vec<Vec<Option<String>>> {
        paths
            .iter()
            .map(|path| {
                path.iter()
                    .map(|segment| segment.map(str::to_owned))
                    .collect()
            })
            .collect()
    }

    fn project(text: &str, paths: &[&[Option<&str>]]) -> Option<String> {
        let value = TomlValue::Table(parsed(text));
        project_toml_selectors(&value, &selectors(paths)).map(|projected| match &projected {
            TomlValue::Table(table) => stringify_toml(table),
            other => inline_repr(other),
        })
    }

    #[test]
    fn legacy_key_aliases_move_to_canonical_keys_in_overlay_and_reached_base_tables() {
        assert_eq!(
            merge(
                "",
                "[tui]\nwhimsy = true\n[agents]\nmax_threads = 3\n[memories]\nno_memories_if_mcp_or_web_search = true\n"
            ),
            "[tui.effects]\nstarfield = true\n\n[agents]\nmax_concurrent_threads_per_session = 3\n\n[memories]\ndisable_on_external_context = true\n"
        );
        assert_eq!(
            merge(
                "[agents]\nmax_threads = 3\n[memories]\nno_memories_if_mcp_or_web_search = false\n",
                "[agents]\nmax_depth = 2\n"
            ),
            "[agents]\nmax_concurrent_threads_per_session = 3\nmax_depth = 2\n\n[memories]\nno_memories_if_mcp_or_web_search = false\n"
        );
        assert_eq!(
            merge(
                "",
                "[agents]\nmax_threads = 3\nmax_concurrent_threads_per_session = 5\n"
            ),
            "[agents]\nmax_concurrent_threads_per_session = 5\n"
        );
    }

    #[test]
    fn structured_features_keep_a_boolean_as_enabled_when_tables_and_booleans_meet() {
        assert_eq!(
            merge(
                "[features]\nnetwork_proxy = true\n",
                "[features.network_proxy]\ncredential_broker = true\n"
            ),
            "[features.network_proxy]\nenabled = true\ncredential_broker = true\n"
        );
        assert_eq!(
            merge(
                "[features.multi_agent_v2]\nenabled = true\nmax = 2\n",
                "[features]\nmulti_agent_v2 = false\n"
            ),
            "[features.multi_agent_v2]\nenabled = false\nmax = 2\n"
        );
        assert_eq!(
            merge(
                "[profiles.p.features]\ncode_mode = false\n",
                "[profiles.p.features.code_mode]\nlimit = 1\n"
            ),
            "[profiles.p.features.code_mode]\nenabled = false\nlimit = 1\n"
        );
        assert_eq!(
            merge(
                "[features]\nshell_snapshot = { a = 1 }\n",
                "[features]\nshell_snapshot = true\n"
            ),
            "[features]\nshell_snapshot = true\n"
        );
    }

    #[test]
    fn credential_providers_claiming_the_same_environment_source_replace_earlier_providers() {
        assert_eq!(
            merge(
                "[features.network_proxy.credentials.old]\nenv = [\"TOKEN\"]\n[features.network_proxy.credentials.other]\nenv = [\"OTHER\"]\n",
                "[features.network_proxy.credentials.new]\nenv = [\"TOKEN\"]\n"
            ),
            "[features.network_proxy.credentials.other]\nenv = [\"OTHER\"]\n\n[features.network_proxy.credentials.new]\nenv = [\"TOKEN\"]\n"
        );
    }

    #[test]
    fn shell_environment_filter_representations_replace_each_other_and_filter_keys_fold_case() {
        assert_eq!(
            merge(
                "[shell_environment_policy]\nexclude = [\"A\"]\ninherit = \"all\"\n",
                "[shell_environment_policy.filters]\nAWS = false\n"
            ),
            "[shell_environment_policy]\ninherit = \"all\"\n\n[shell_environment_policy.filters]\nAWS = false\n"
        );
        assert_eq!(
            merge(
                "[shell_environment_policy.filters]\nAWS = true\n",
                "[shell_environment_policy.filters]\naws = false\n"
            ),
            "[shell_environment_policy.filters]\naws = false\n"
        );
        assert_eq!(
            merge(
                "[shell_environment_policy.filters]\nAWS = true\n",
                "[shell_environment_policy]\ninclude_only = [\"PATH\"]\n"
            ),
            "[shell_environment_policy]\ninclude_only = [\"PATH\"]\n"
        );
    }

    #[test]
    fn network_domain_keys_normalize_hosts_before_merging() {
        assert_eq!(
            merge(
                "[permissions.p.network.domains]\n\"Example.COM.\" = \"allow\"\n",
                "[permissions.p.network.domains]\n\"example.com:443\" = \"deny\"\n\"[::1]\" = \"allow\"\n"
            ),
            "[permissions.p.network.domains]\n\"example.com\" = \"deny\"\n\"::1\" = \"allow\"\n"
        );
        assert_eq!(
            merge(
                "[application.network.domains]\nold = \"allow\"\n",
                "[application.network.domains]\n\"  Fe80::1%25ETH0  \" = \"allow\"\n\"1.2.3.4.\" = \"deny\"\n"
            ),
            "[application.network.domains]\nold = \"allow\"\n\"fe80::1%eth0\" = \"allow\"\n\"1.2.3.4\" = \"deny\"\n"
        );
    }

    #[test]
    fn merge_replaces_in_place_and_appends_new_keys_without_reordering() {
        assert_eq!(
            merge("a = 1\nb = 2\nc = 3\n", "b = 20\nd = 4\n"),
            "a = 1\nb = 20\nc = 3\nd = 4\n"
        );
    }

    #[test]
    fn nested_tables_merge_through_every_level_and_replace_non_table_values() {
        assert_eq!(
            merge(
                "[a.b]\nx = 1\ny = 2\n[a.c]\nz = 3\n",
                "[a.b]\ny = 20\nw = 4\n[a]\nc = 5\n"
            ),
            "[a]\nc = 5\n\n[a.b]\nx = 1\ny = 20\nw = 4\n"
        );
    }

    #[test]
    fn unmatchable_selector_segments_keep_the_parent_without_selecting_a_key() {
        let source = "a = 1\n[b]\nc = 2\n";
        assert_eq!(
            project(source, &[&[Some("b"), None]]),
            Some("[b]\n".to_owned())
        );
        assert_eq!(
            project(source, &[&[Some("a"), None]]),
            Some("a = 1\n".to_owned())
        );
        assert_eq!(
            project(source, &[&[Some("b")]]),
            Some("[b]\nc = 2\n".to_owned())
        );
        assert_eq!(project(source, &[&[None]]), None);
        assert_eq!(project("\"\u{FFFD}\" = 1\n", &[&[None]]), None);
        assert_eq!(
            project("\"\u{FFFD}\" = 1\n", &[&[Some("\u{FFFD}")]]),
            Some("\"\u{FFFD}\" = 1\n".to_owned())
        );
    }

    #[test]
    fn terminal_selector_prefixes_dominate_children_and_scalars_stay_whole() {
        let source = "[t]\nx = 1\ny = 2\n";
        assert_eq!(
            project(source, &[&[Some("t"), Some("x")], &[Some("t")]]),
            Some("[t]\nx = 1\ny = 2\n".to_owned())
        );
        assert_eq!(
            project(source, &[&[Some("t")], &[Some("t"), Some("x")]]),
            Some("[t]\nx = 1\ny = 2\n".to_owned())
        );
    }

    #[test]
    fn extra_character_error_keeps_a_half_astral_code_unit_lossless() {
        let error = parse_toml("a = 1 \u{1F600}\n")
            .map(|_| ())
            .expect_err("trailing astral character is rejected");
        let mut expected: Vec<u16> = "extra `".encode_utf16().collect();
        expected.push(0xD83D);
        expected.extend("`, expected nothing".encode_utf16());
        assert_eq!((error.line, error.column), (1, 7));
        assert_eq!(error.detail, LosslessString::from_utf16(expected));
        assert!(error.detail.as_str().is_none());
        assert!(error.to_string().starts_with("1:7: extra `"));
    }

    #[test]
    fn nesting_has_no_cutoff_for_parse_clone_merge_stringify_and_drop() {
        let depth = 200_000;
        let arrays = parsed(&format!("x = {}{}\n", "[".repeat(depth), "]".repeat(depth)));
        let copy = arrays.clone();
        let merged = merge_toml(arrays, &copy);
        assert_eq!(stringify_toml(&merged).len(), "x = ".len() + 2 * depth + 1);
        drop(copy);
        drop(merged);

        let inline = parsed(&format!(
            "x = {}1{}\n",
            "{ a = ".repeat(50_000),
            " }".repeat(50_000)
        ));
        let rendered = stringify_toml(&inline);
        assert!(rendered.starts_with("[x.a.a") && rendered.ends_with("a = 1\n"));

        let header = format!("[{}]\nv = 1\n", vec!["a"; 100_000].join("."));
        let tables = parsed(&header);
        let overlay = tables.clone();
        let merged = merge_toml(tables, &overlay);
        assert!(stringify_toml(&merged).ends_with("v = 1\n"));
        let projected = project_toml(&TomlValue::Table(merged), &[vec!["a".to_owned()]]);
        assert!(projected.is_some());
    }

    #[test]
    fn table_insert_keeps_position_and_remove_shifts() {
        let mut table = TomlTable::from_entries([
            ("a".to_owned(), TomlValue::Integer(1)),
            ("b".to_owned(), TomlValue::Integer(2)),
            ("c".to_owned(), TomlValue::Integer(3)),
        ]);
        table.insert("a".to_owned(), TomlValue::Integer(10));
        assert_eq!(table.remove("a"), Some(TomlValue::Integer(10)));
        table.insert("a".to_owned(), TomlValue::Integer(11));
        let keys: Vec<&str> = table.entries.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(keys, ["b", "c", "a"]);
    }

    #[test]
    fn host_normalization_follows_the_node_isip_grammar_and_the_javascript_trim_set() {
        for (raw, expected) in [
            ("\u{feff} Example.COM. \u{2028}", "example.com"),
            ("\u{85}x", "\u{85}x"),
            ("[::1]", "::1"),
            ("[FE80::1%25ETH0]", "fe80::1%eth0"),
            ("[FE80::1%ETH0]:443", "fe80::1%eth0"),
            ("::ffff:1.2.3.4", "::ffff:1.2.3.4"),
            ("1.2.3.4:80", "1.2.3.4"),
            ("host:80", "host"),
            ("a:b:c", "a:b:c"),
        ] {
            assert_eq!(normalize_host(raw), expected, "{raw}");
        }
    }

    #[test]
    fn ipv4_and_ipv6_acceptance_matches_the_node_regular_expressions() {
        for accepted in [
            "0.0.0.0",
            "255.255.255.255",
            "1.2.3.4",
            "::",
            "::1",
            "1::",
            "1:2:3:4:5:6:7:8",
            "1:2:3:4:5:6:7::",
            "::2:3:4:5:6:7:8",
            "1::8",
            "::ffff:1.2.3.4",
            "1:2:3:4:5:6:1.2.3.4",
            "1::1.2.3.4",
            "FFFF::abcd",
            "2001:db8::1",
            "fe80::1%eth0",
            "fe80::1%a-b.c:d",
        ] {
            assert!(is_ip(accepted), "{accepted}");
        }
        for rejected in [
            "",
            "1.2.3",
            "1.2.3.4.5",
            "01.2.3.4",
            "256.1.1.1",
            "1.2.3.",
            ":::",
            "1:::2",
            "1:2:3:4:5:6:7:8:9",
            "1::2::3",
            "12345::1",
            "g::1",
            "::1.2.3",
            "::ffff:01.2.3.4",
            "1:2:3:4:5:6:7",
            " ::1",
            "::1 ",
            "::\u{661}",
            "fe80::1%",
            "fe80::1%a b",
            "1.2.3.4%x",
        ] {
            assert!(!is_ip(rejected), "{rejected}");
        }
    }

    #[test]
    fn float_text_expands_javascript_number_strings_without_exponents() {
        for (value, expected) in [
            (1e21, format!("1{}.0", "0".repeat(21))),
            (1e300, format!("1{}.0", "0".repeat(300))),
            (1e-7, "0.0000001".to_owned()),
            (1.5e-7, "0.00000015".to_owned()),
            (1e-6, "0.000001".to_owned()),
            (5e-324, format!("0.{}5", "0".repeat(323))),
            (
                1.7976931348623157e308,
                format!("17976931348623157{}.0", "0".repeat(292)),
            ),
            (
                123456789012345680000.0,
                "123456789012345680000.0".to_owned(),
            ),
            (9007199254740993.0, "9007199254740992.0".to_owned()),
            (1967805326562213.2, "1967805326562213.2".to_owned()),
            (0.30000000000000004, "0.30000000000000004".to_owned()),
            (0.1, "0.1".to_owned()),
            (100.0, "100.0".to_owned()),
            (-2.5, "-2.5".to_owned()),
            (-1e21, format!("-1{}.0", "0".repeat(21))),
            (
                2.2250738585072014e-308,
                format!("0.{}22250738585072014", "0".repeat(307)),
            ),
        ] {
            assert_eq!(float_repr(value, false), expected, "{value:e}");
        }
        assert_eq!(float_repr(f64::NAN, true), "-nan");
        assert_eq!(float_repr(f64::NAN, false), "nan");
        assert_eq!(float_repr(-0.0, false), "-0.0");
        assert_eq!(float_repr(0.0, false), "0.0");
        assert_eq!(float_repr(f64::INFINITY, false), "inf");
        assert_eq!(float_repr(f64::NEG_INFINITY, false), "-inf");
    }
}
