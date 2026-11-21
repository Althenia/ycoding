use std::collections::BTreeMap;
use std::sync::OnceLock;

use icu_properties::props::{BasicEmoji, GeneralCategory, GeneralCategoryGroup, Script};
use icu_properties::script::ScriptWithExtensions;
use icu_properties::{
    CodePointMapData, CodePointSetData, CodePointSetDataBorrowed, EmojiSetData, PropertyParser,
};

use super::{Budget, Error, Flags};

#[derive(Debug, Clone)]
pub(super) enum Class {
    Range(u32, u32),
    Union(Vec<Self>),
    Intersection(Box<Self>, Box<Self>),
    Subtraction(Box<Self>, Box<Self>),
    Negation(Box<Self>),
    Digit,
    Word,
    Space,
    Property(Property, bool),
    Strings(Vec<Vec<u32>>),
}

#[derive(Debug, Clone)]
pub(super) enum Property {
    Binary(CodePointSetDataBorrowed<'static>),
    Category(GeneralCategory),
    CategoryGroup(GeneralCategoryGroup),
    Script(Script, bool),
    Any,
    Ascii,
    Assigned,
    BasicEmoji,
}

impl Property {
    pub(super) fn parse(name: &str, flags: Flags) -> Result<Self, Error> {
        if matches!(
            name,
            "Emoji_Keycap_Sequence"
                | "RGI_Emoji_Modifier_Sequence"
                | "RGI_Emoji_Flag_Sequence"
                | "RGI_Emoji_Tag_Sequence"
                | "RGI_Emoji_ZWJ_Sequence"
                | "RGI_Emoji"
        ) && flags.sets
        {
            return Err(Error::UnsupportedStringProperty(name.to_owned()));
        }
        if name == "Basic_Emoji" && flags.sets {
            return Ok(Self::BasicEmoji);
        }
        let (property, value) = name.split_once('=').unwrap_or(("", name));
        if matches!(property, "Script" | "sc" | "Script_Extensions" | "scx") {
            return PropertyParser::<Script>::new()
                .get_strict(value)
                .map(|script| Self::Script(script, matches!(property, "Script_Extensions" | "scx")))
                .ok_or_else(|| Error::Syntax("Invalid Unicode property value".into()));
        }
        if matches!(property, "" | "General_Category" | "gc") {
            if let Some(category) = PropertyParser::<GeneralCategory>::new().get_strict(value) {
                return Ok(Self::Category(category));
            }
            let group = match value {
                "L" | "Letter" => Some(GeneralCategoryGroup::Letter),
                "LC" | "Cased_Letter" => Some(GeneralCategoryGroup::CasedLetter),
                "M" | "Mark" | "Combining_Mark" => Some(GeneralCategoryGroup::Mark),
                "N" | "Number" => Some(GeneralCategoryGroup::Number),
                "P" | "Punctuation" | "punct" => Some(GeneralCategoryGroup::Punctuation),
                "S" | "Symbol" => Some(GeneralCategoryGroup::Symbol),
                "Z" | "Separator" => Some(GeneralCategoryGroup::Separator),
                "C" | "Other" => Some(GeneralCategoryGroup::Other),
                _ => None,
            };
            if let Some(group) = group {
                return Ok(Self::CategoryGroup(group));
            }
        }
        if property.is_empty() {
            match value {
                "Any" => return Ok(Self::Any),
                "ASCII" => return Ok(Self::Ascii),
                "Assigned" => return Ok(Self::Assigned),
                _ => {}
            }
            if let Some(set) = CodePointSetData::new_for_ecma262(value.as_bytes()) {
                return Ok(Self::Binary(set));
            }
        }
        Err(Error::Syntax("Invalid Unicode property name".into()))
    }

    fn contains(&self, cp: u32) -> bool {
        match self {
            Self::Binary(set) => set.contains32(cp),
            Self::Category(category) => {
                CodePointMapData::<GeneralCategory>::new().get32(cp) == *category
            }
            Self::CategoryGroup(group) => {
                group.contains(CodePointMapData::<GeneralCategory>::new().get32(cp))
            }
            Self::Script(script, true) => ScriptWithExtensions::new().has_script32(cp, *script),
            Self::Script(script, false) => CodePointMapData::<Script>::new().get32(cp) == *script,
            Self::Any => true,
            Self::Ascii => cp <= 127,
            Self::Assigned => {
                CodePointMapData::<GeneralCategory>::new().get32(cp) != GeneralCategory::Unassigned
            }
            Self::BasicEmoji => EmojiSetData::new::<BasicEmoji>().contains32(cp),
        }
    }
}

static UNICODE_CASES: OnceLock<BTreeMap<u32, Vec<u32>>> = OnceLock::new();
static LEGACY_CASES: OnceLock<BTreeMap<u32, Vec<u32>>> = OnceLock::new();

pub(super) fn prepare_case(flags: Flags, budget: &mut Budget<'_>) -> Result<(), Error> {
    if !flags.ignore_case {
        return Ok(());
    }
    let table = if flags.unicode_mode() {
        &UNICODE_CASES
    } else {
        &LEGACY_CASES
    };
    if table.get().is_some() {
        return Ok(());
    }
    let mut groups = BTreeMap::<u32, Vec<u32>>::new();
    let data = if flags.unicode_mode() {
        super::case_data::UNICODE
    } else {
        super::case_data::LEGACY
    };
    for (cp, folded) in data {
        budget.step()?;
        groups.entry(*folded).or_default().push(*cp);
    }
    for (folded, members) in &mut groups {
        members.push(*folded);
    }
    let _ = table.set(groups);
    Ok(())
}

pub(super) fn canonical(cp: u32, flags: Flags) -> u32 {
    if !flags.ignore_case {
        return cp;
    }
    let data = if flags.unicode_mode() {
        super::case_data::UNICODE
    } else {
        super::case_data::LEGACY
    };
    data.binary_search_by_key(&cp, |(point, _)| *point)
        .map_or(cp, |index| data[index].1)
}

fn equivalents(cp: u32, flags: Flags) -> impl Iterator<Item = u32> {
    let table = if flags.unicode_mode() {
        &UNICODE_CASES
    } else {
        &LEGACY_CASES
    };
    let members = flags
        .ignore_case
        .then(|| {
            table
                .get()
                .and_then(|table| table.get(&canonical(cp, flags)))
        })
        .flatten();
    std::iter::once(cp).chain(members.into_iter().flatten().copied())
}

pub(super) fn whitespace(cp: u32) -> bool {
    matches!(cp, 9..=13 | 32 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

pub(super) fn line_terminator(cp: u32) -> bool {
    matches!(cp, 10 | 13 | 0x2028 | 0x2029)
}

pub(super) fn word(cp: u32, flags: Flags) -> bool {
    let cp = if flags.unicode_mode() && flags.ignore_case {
        canonical(cp, flags)
    } else {
        cp
    };
    matches!(cp, 48..=57 | 65..=90 | 95 | 97..=122)
}

impl Class {
    pub(super) fn has_strings(&self) -> bool {
        match self {
            Self::Property(Property::BasicEmoji, _) => true,
            Self::Strings(strings) => strings.iter().any(|string| string.len() != 1),
            Self::Union(parts) => parts.iter().any(Self::has_strings),
            Self::Intersection(left, right) => left.has_strings() && right.has_strings(),
            Self::Subtraction(left, _) | Self::Negation(left) => left.has_strings(),
            _ => false,
        }
    }

    pub(super) fn contains(
        &self,
        cp: u32,
        flags: Flags,
        budget: &mut Budget<'_>,
    ) -> Result<bool, Error> {
        budget.step()?;
        Ok(match self {
            Self::Range(start, end) => equivalents(cp, flags).any(|cp| *start <= cp && cp <= *end),
            Self::Union(parts) => {
                let mut matched = false;
                for part in parts {
                    if part.contains(cp, flags, budget)? {
                        matched = true;
                        break;
                    }
                }
                matched
            }
            Self::Intersection(left, right) => {
                left.contains(cp, flags, budget)? && right.contains(cp, flags, budget)?
            }
            Self::Subtraction(left, right) => {
                left.contains(cp, flags, budget)? && !right.contains(cp, flags, budget)?
            }
            Self::Negation(part) => !part.contains(cp, flags, budget)?,
            Self::Digit => matches!(cp, 48..=57),
            Self::Space => whitespace(cp),
            Self::Word => word(cp, flags),
            Self::Property(property, negative) => {
                if *negative && !flags.sets {
                    equivalents(cp, flags).any(|cp| !property.contains(cp))
                } else {
                    equivalents(cp, flags).any(|cp| property.contains(cp)) != *negative
                }
            }
            Self::Strings(strings) => strings.iter().any(|string| {
                string.len() == 1 && canonical(string[0], flags) == canonical(cp, flags)
            }),
        })
    }

    pub(super) fn strings(
        &self,
        output: &mut Vec<Vec<u32>>,
        budget: &mut Budget<'_>,
    ) -> Result<(), Error> {
        budget.step()?;
        match self {
            Self::Property(Property::BasicEmoji, false) => {
                let data = EmojiSetData::new::<BasicEmoji>().static_to_owned();
                if let Some(set) = data.as_code_point_inversion_list_string_list() {
                    for string in set.strings().iter() {
                        budget.step()?;
                        output.push(string.chars().map(u32::from).collect());
                    }
                }
            }
            Self::Strings(strings) => output.extend(strings.iter().cloned()),
            Self::Union(parts) => {
                for part in parts {
                    part.strings(output, budget)?;
                }
            }
            Self::Intersection(left, right) | Self::Subtraction(left, right) => {
                left.strings(output, budget)?;
                right.strings(output, budget)?;
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn contains_string(
        &self,
        string: &[u32],
        flags: Flags,
        budget: &mut Budget<'_>,
    ) -> Result<bool, Error> {
        budget.step()?;
        if string.len() == 1 {
            return self.contains(string[0], flags, budget);
        }
        Ok(match self {
            Self::Strings(strings) => strings.iter().any(|candidate| {
                candidate.len() == string.len()
                    && candidate
                        .iter()
                        .zip(string)
                        .all(|(left, right)| canonical(*left, flags) == canonical(*right, flags))
            }),
            Self::Property(Property::BasicEmoji, false) => EmojiSetData::new::<BasicEmoji>()
                .contains_str(
                    &string
                        .iter()
                        .filter_map(|cp| char::from_u32(*cp))
                        .collect::<String>(),
                ),
            Self::Union(parts) => {
                let mut matched = false;
                for part in parts {
                    if part.contains_string(string, flags, budget)? {
                        matched = true;
                        break;
                    }
                }
                matched
            }
            Self::Intersection(left, right) => {
                left.contains_string(string, flags, budget)?
                    && right.contains_string(string, flags, budget)?
            }
            Self::Subtraction(left, right) => {
                left.contains_string(string, flags, budget)?
                    && !right.contains_string(string, flags, budget)?
            }
            _ => false,
        })
    }
}
