use super::{Budget, Error, Match, RegExp, advance};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StringMatch {
    Single(Match),
    Global(Vec<Vec<u16>>),
}

impl RegExp {
    pub fn string_match(
        &mut self,
        input: &[u16],
        budget: &mut Budget<'_>,
    ) -> Result<Option<StringMatch>, Error> {
        if !self.global() {
            return Ok(self.exec(input, budget)?.map(StringMatch::Single));
        }
        self.last_index = 0;
        let matches = self.collect(input, budget)?;
        Ok((!matches.is_empty()).then(|| {
            StringMatch::Global(
                matches
                    .into_iter()
                    .filter_map(|matched| matched.captures.into_iter().next().flatten())
                    .collect(),
            )
        }))
    }

    pub fn match_all(&self, input: &[u16], budget: &mut Budget<'_>) -> Result<Vec<Match>, Error> {
        if !self.global() {
            return Err(Error::RequiresGlobal);
        }
        self.clone().collect(input, budget)
    }

    pub fn search(
        &mut self,
        input: &[u16],
        budget: &mut Budget<'_>,
    ) -> Result<Option<usize>, Error> {
        let last_index = self.last_index;
        self.last_index = 0;
        let result = self.exec(input, budget);
        self.last_index = last_index;
        Ok(result?.map(|matched| matched.index))
    }

    pub fn split(
        &self,
        input: &[u16],
        limit: u32,
        budget: &mut Budget<'_>,
    ) -> Result<Vec<Option<Vec<u16>>>, Error> {
        let mut output = Vec::new();
        if limit == 0 {
            return Ok(output);
        }
        let mut splitter = self.clone();
        splitter.parsed_flags.sticky = true;
        splitter.last_index = 0;
        if input.is_empty() {
            return Ok(if splitter.exec(input, budget)?.is_some() {
                output
            } else {
                vec![Some(Vec::new())]
            });
        }
        let mut previous = 0;
        let mut offset = 0;
        while offset < input.len() {
            budget.step()?;
            splitter.last_index = offset as u64;
            let Some(matched) = splitter.exec(input, budget)? else {
                offset = advance(input, offset, self.parsed_flags.unicode_mode());
                continue;
            };
            let end = splitter.last_index as usize;
            if end == previous {
                offset = advance(input, offset, self.parsed_flags.unicode_mode());
                continue;
            }
            output.push(Some(input[previous..offset].to_vec()));
            if output.len() == limit as usize {
                return Ok(output);
            }
            previous = end;
            for capture in matched.captures.into_iter().skip(1) {
                budget.step()?;
                output.push(capture);
                if output.len() == limit as usize {
                    return Ok(output);
                }
            }
            offset = previous;
        }
        output.push(Some(input[previous..].to_vec()));
        Ok(output)
    }

    pub fn replacement_matches(
        &mut self,
        input: &[u16],
        require_global: bool,
        budget: &mut Budget<'_>,
    ) -> Result<Vec<Match>, Error> {
        if require_global && !self.global() {
            return Err(Error::RequiresGlobal);
        }
        if self.global() {
            self.last_index = 0;
            return self.collect(input, budget);
        }
        Ok(self.exec(input, budget)?.into_iter().collect())
    }

    pub fn replace(
        &mut self,
        input: &[u16],
        replacement: &[u16],
        budget: &mut Budget<'_>,
    ) -> Result<Vec<u16>, Error> {
        let matches = self.replacement_matches(input, false, budget)?;
        replace_matches(
            input,
            &matches,
            |matched| substitution(input, matched, replacement),
            budget,
        )
    }

    pub fn replace_all(
        &mut self,
        input: &[u16],
        replacement: &[u16],
        budget: &mut Budget<'_>,
    ) -> Result<Vec<u16>, Error> {
        if !self.global() {
            return Err(Error::RequiresGlobal);
        }
        self.replace(input, replacement, budget)
    }

    fn collect(&mut self, input: &[u16], budget: &mut Budget<'_>) -> Result<Vec<Match>, Error> {
        let mut output = Vec::new();
        while let Some(matched) = self.exec(input, budget)? {
            budget.step()?;
            if matched.captures[0].as_ref().is_some_and(Vec::is_empty) {
                self.last_index = advance(
                    input,
                    self.last_index as usize,
                    self.parsed_flags.unicode_mode(),
                ) as u64;
            }
            output.push(matched);
        }
        Ok(output)
    }
}

pub fn replace_matches(
    input: &[u16],
    matches: &[Match],
    mut replacement: impl FnMut(&Match) -> Vec<u16>,
    budget: &mut Budget<'_>,
) -> Result<Vec<u16>, Error> {
    let mut output = Vec::new();
    let mut end = 0;
    for matched in matches {
        budget.step()?;
        output.extend_from_slice(&input[end..matched.index]);
        output.extend(replacement(matched));
        end = matched.index + matched.captures[0].as_ref().map_or(0, Vec::len);
    }
    output.extend_from_slice(&input[end..]);
    Ok(output)
}

pub fn substitution(input: &[u16], matched: &Match, replacement: &[u16]) -> Vec<u16> {
    let mut output = Vec::new();
    let mut offset = 0;
    while let Some(ch) = replacement.get(offset).copied() {
        offset += 1;
        if ch != 36 {
            output.push(ch);
            continue;
        }
        let Some(next) = replacement.get(offset).copied() else {
            output.push(ch);
            break;
        };
        match next {
            36 => {
                output.push(36);
                offset += 1;
            }
            38 => {
                output.extend(matched.captures[0].iter().flatten().copied());
                offset += 1;
            }
            96 => {
                output.extend_from_slice(&input[..matched.index]);
                offset += 1;
            }
            39 => {
                output.extend_from_slice(
                    &input[matched.index + matched.captures[0].as_ref().map_or(0, Vec::len)..],
                );
                offset += 1;
            }
            48..=57 => {
                let first = usize::from(next - 48);
                let second = replacement
                    .get(offset + 1)
                    .copied()
                    .filter(|ch| (48..=57).contains(ch))
                    .map(|ch| first * 10 + usize::from(ch - 48));
                let (index, width) = if let Some(second) =
                    second.filter(|second| *second > 0 && *second < matched.captures.len())
                {
                    (second, 2)
                } else {
                    (first, 1)
                };
                if index == 0 || index >= matched.captures.len() {
                    output.push(36);
                    continue;
                }
                output.extend(matched.captures[index].iter().flatten().copied());
                offset += width;
            }
            60 if matched.groups.is_some() => {
                if let Some(end) = replacement[offset + 1..].iter().position(|ch| *ch == 62) {
                    let end = offset + 1 + end;
                    let key = &replacement[offset + 1..end];
                    if let Some((_, value)) = matched
                        .groups
                        .as_ref()
                        .and_then(|groups| groups.iter().find(|(name, _)| name.as_slice() == key))
                    {
                        output.extend(value.iter().flatten().copied());
                    }
                    offset = end + 1;
                } else {
                    output.push(36);
                }
            }
            _ => output.push(36),
        }
    }
    output
}
