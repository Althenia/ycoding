use super::class::{Class, canonical, line_terminator, word};
use super::parser::{Node, Program};
use super::{Budget, Error, Flags, read_point};

type Ranges = Vec<Option<(usize, usize)>>;

#[derive(Clone)]
enum Task {
    Node(usize),
    CaptureEnd(usize, usize),
    Repeat {
        child: usize,
        min: u64,
        max: Option<u64>,
        greedy: bool,
        count: u64,
    },
    RepeatAfter {
        child: usize,
        min: u64,
        max: Option<u64>,
        greedy: bool,
        count: u64,
        before: usize,
    },
    RestoreFlags(Flags),
}

#[derive(Clone)]
pub(super) struct State {
    offset: usize,
    ranges: Ranges,
    tasks: Vec<Task>,
    flags: Flags,
    backwards: bool,
}

impl State {
    pub(super) fn start(
        root: usize,
        offset: usize,
        flags: Flags,
        backwards: bool,
        ranges: Ranges,
    ) -> Self {
        Self {
            offset,
            ranges,
            tasks: vec![Task::Node(root)],
            flags,
            backwards,
        }
    }
}

pub(super) fn run(
    program: &Program,
    input: &[u16],
    initial: State,
    budget: &mut Budget<'_>,
) -> Result<Option<(usize, Ranges)>, Error> {
    let backwards = initial.backwards;
    let mut alternatives = vec![initial];
    while let Some(mut state) = alternatives.pop() {
        loop {
            budget.step()?;
            let Some(task) = state.tasks.pop() else {
                return Ok(Some((state.offset, state.ranges)));
            };
            let success = match task {
                Task::RestoreFlags(flags) => {
                    state.flags = flags;
                    true
                }
                Task::CaptureEnd(index, start) => {
                    state.ranges[index] = Some((start.min(state.offset), start.max(state.offset)));
                    true
                }
                Task::Repeat {
                    child,
                    min,
                    max,
                    greedy,
                    count,
                } => {
                    let can_stop = count >= min;
                    let can_repeat = max.is_none_or(|max| count < max);
                    if !can_repeat {
                        can_stop
                    } else {
                        let mut repeat = state.clone();
                        clear_captures(program, child, &mut repeat.ranges, budget)?;
                        repeat.tasks.push(Task::RepeatAfter {
                            child,
                            min,
                            max,
                            greedy,
                            count,
                            before: state.offset,
                        });
                        repeat.tasks.push(Task::Node(child));
                        if can_stop && greedy {
                            alternatives.push(state.clone());
                            state = repeat;
                        } else if can_stop {
                            alternatives.push(repeat);
                        } else {
                            state = repeat;
                        }
                        true
                    }
                }
                Task::RepeatAfter {
                    child,
                    min,
                    max,
                    greedy,
                    count,
                    before,
                } => {
                    if state.offset == before && count >= min {
                        false
                    } else {
                        let terminal_position = if backwards {
                            state.offset == 0
                        } else {
                            state.offset == input.len()
                        };
                        let count = if state.offset == before
                            && (terminal_position || !can_consume(program, child, budget)?)
                        {
                            min
                        } else {
                            count.saturating_add(1)
                        };
                        state.tasks.push(Task::Repeat {
                            child,
                            min,
                            max,
                            greedy,
                            count,
                        });
                        true
                    }
                }
                Task::Node(index) => match &program.nodes[index] {
                    Node::Sequence(nodes) => {
                        if backwards {
                            state.tasks.extend(nodes.iter().copied().map(Task::Node));
                        } else {
                            state
                                .tasks
                                .extend(nodes.iter().rev().copied().map(Task::Node));
                        }
                        true
                    }
                    Node::Alternative(nodes) => {
                        for node in nodes.iter().skip(1).rev() {
                            budget.step()?;
                            let mut branch = state.clone();
                            branch.tasks.push(Task::Node(*node));
                            alternatives.push(branch);
                        }
                        if let Some(node) = nodes.first() {
                            state.tasks.push(Task::Node(*node));
                        }
                        true
                    }
                    Node::Capture(index, child) => {
                        state.tasks.push(Task::CaptureEnd(*index, state.offset));
                        state.tasks.push(Task::Node(*child));
                        true
                    }
                    Node::Repeat {
                        child,
                        min,
                        max,
                        greedy,
                    } => {
                        state.tasks.push(Task::Repeat {
                            child: *child,
                            min: *min,
                            max: *max,
                            greedy: *greedy,
                            count: 0,
                        });
                        true
                    }
                    Node::Modifiers(flags, child) => {
                        state.tasks.push(Task::RestoreFlags(state.flags));
                        state.flags = *flags;
                        state.tasks.push(Task::Node(*child));
                        true
                    }
                    Node::Look {
                        child,
                        positive,
                        backwards,
                    } => {
                        let matched = run(
                            program,
                            input,
                            State::start(
                                *child,
                                state.offset,
                                state.flags,
                                *backwards,
                                state.ranges.clone(),
                            ),
                            budget,
                        )?;
                        if *positive {
                            if let Some((_, ranges)) = matched {
                                state.ranges = ranges;
                                true
                            } else {
                                false
                            }
                        } else {
                            matched.is_none()
                        }
                    }
                    Node::Start => {
                        state.offset == 0
                            || (state.flags.multiline
                                && input
                                    .get(state.offset - 1)
                                    .is_some_and(|ch| line_terminator(u32::from(*ch))))
                    }
                    Node::End => {
                        state.offset == input.len()
                            || (state.flags.multiline
                                && input
                                    .get(state.offset)
                                    .is_some_and(|ch| line_terminator(u32::from(*ch))))
                    }
                    Node::Boundary(positive) => {
                        let left = previous_point(input, state.offset, state.flags.unicode_mode())
                            .is_some_and(|(cp, _)| word(cp, state.flags));
                        let right = read_point(input, state.offset, state.flags.unicode_mode())
                            .is_some_and(|(cp, _)| word(cp, state.flags));
                        (left != right) == *positive
                    }
                    Node::Character(expected) => consume(
                        input,
                        &mut state.offset,
                        backwards,
                        state.flags.unicode_mode(),
                        |cp| canonical(cp, state.flags) == canonical(*expected, state.flags),
                    ),
                    Node::Any => consume(
                        input,
                        &mut state.offset,
                        backwards,
                        state.flags.unicode_mode(),
                        |cp| state.flags.dot_all || !line_terminator(cp),
                    ),
                    Node::Class(class) => {
                        let ends =
                            class_ends(class, input, state.offset, backwards, state.flags, budget)?;
                        for end in ends.iter().skip(1).rev() {
                            let mut branch = state.clone();
                            branch.offset = *end;
                            alternatives.push(branch);
                        }
                        if let Some(end) = ends.first() {
                            state.offset = *end;
                            true
                        } else {
                            false
                        }
                    }
                    Node::Reference(targets) => {
                        if let Some((start, end)) =
                            targets.iter().find_map(|target| state.ranges[*target])
                        {
                            let source = points(&input[start..end], state.flags.unicode_mode());
                            let mut cursor = state.offset;
                            let mut matched = true;
                            for expected in if backwards {
                                source.into_iter().rev().collect::<Vec<_>>()
                            } else {
                                source
                            } {
                                budget.step()?;
                                if !consume(
                                    input,
                                    &mut cursor,
                                    backwards,
                                    state.flags.unicode_mode(),
                                    |cp| {
                                        canonical(cp, state.flags)
                                            == canonical(expected, state.flags)
                                    },
                                ) {
                                    matched = false;
                                    break;
                                }
                            }
                            if matched {
                                state.offset = cursor;
                            }
                            matched
                        } else {
                            true
                        }
                    }
                    Node::NamedReference(_) => {
                        return Err(Error::Syntax("Unresolved named reference".into()));
                    }
                },
            };
            if !success {
                break;
            }
        }
    }
    Ok(None)
}

fn clear_captures(
    program: &Program,
    root: usize,
    ranges: &mut Ranges,
    budget: &mut Budget<'_>,
) -> Result<(), Error> {
    let mut pending = vec![root];
    while let Some(index) = pending.pop() {
        budget.step()?;
        match &program.nodes[index] {
            Node::Capture(index, child) => {
                ranges[*index] = None;
                pending.push(*child);
            }
            Node::Sequence(children) | Node::Alternative(children) => pending.extend(children),
            Node::Look { child, .. } | Node::Repeat { child, .. } | Node::Modifiers(_, child) => {
                pending.push(*child)
            }
            _ => {}
        }
    }
    Ok(())
}

fn can_consume(program: &Program, root: usize, budget: &mut Budget<'_>) -> Result<bool, Error> {
    let mut pending = vec![root];
    while let Some(index) = pending.pop() {
        budget.step()?;
        match &program.nodes[index] {
            Node::Character(_) | Node::Class(_) | Node::Any | Node::Reference(_) => {
                return Ok(true);
            }
            Node::Capture(_, child) | Node::Repeat { child, .. } | Node::Modifiers(_, child) => {
                pending.push(*child)
            }
            Node::Sequence(children) | Node::Alternative(children) => pending.extend(children),
            _ => {}
        }
    }
    Ok(false)
}

fn previous_point(input: &[u16], offset: usize, unicode: bool) -> Option<(u32, usize)> {
    let index = offset.checked_sub(1)?;
    if unicode
        && (0xdc00..=0xdfff).contains(input.get(index)?)
        && index > 0
        && (0xd800..=0xdbff).contains(input.get(index - 1)?)
    {
        return read_point(input, index - 1, true);
    }
    read_point(input, index, false)
}

fn consume(
    input: &[u16],
    offset: &mut usize,
    backwards: bool,
    unicode: bool,
    predicate: impl FnOnce(u32) -> bool,
) -> bool {
    let point = if backwards {
        previous_point(input, *offset, unicode)
    } else {
        read_point(input, *offset, unicode)
    };
    let Some((cp, width)) = point else {
        return false;
    };
    if !predicate(cp) {
        return false;
    }
    *offset = if backwards {
        *offset - width
    } else {
        *offset + width
    };
    true
}

fn points(input: &[u16], unicode: bool) -> Vec<u32> {
    let mut output = Vec::new();
    let mut offset = 0;
    while let Some((cp, width)) = read_point(input, offset, unicode) {
        output.push(cp);
        offset += width;
    }
    output
}

fn class_ends(
    class: &Class,
    input: &[u16],
    start: usize,
    backwards: bool,
    flags: Flags,
    budget: &mut Budget<'_>,
) -> Result<Vec<usize>, Error> {
    let mut ends = Vec::new();
    let point = if backwards {
        previous_point(input, start, flags.unicode_mode())
    } else {
        read_point(input, start, flags.unicode_mode())
    };
    if let Some((cp, width)) = point
        && class.contains(cp, flags, budget)?
    {
        ends.push(if backwards {
            start - width
        } else {
            start + width
        });
    }
    if class.has_strings() {
        let mut strings = Vec::new();
        class.strings(&mut strings, budget)?;
        for string in strings {
            budget.step()?;
            if !class.contains_string(&string, flags, budget)? {
                continue;
            }
            let mut offset = start;
            let mut matches = true;
            let chars = if backwards {
                string.into_iter().rev().collect::<Vec<_>>()
            } else {
                string
            };
            for expected in chars {
                budget.step()?;
                if !consume(input, &mut offset, backwards, flags.unicode_mode(), |cp| {
                    canonical(cp, flags) == canonical(expected, flags)
                }) {
                    matches = false;
                    break;
                }
            }
            if matches {
                ends.push(offset);
            }
        }
    }
    ends.sort_unstable_by_key(|end| std::cmp::Reverse(start.abs_diff(*end)));
    ends.dedup();
    Ok(ends)
}
