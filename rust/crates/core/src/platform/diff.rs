#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub count: usize,
    pub added: bool,
    pub removed: bool,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StructuredPatch {
    pub old_file_name: String,
    pub new_file_name: String,
    pub old_header: Option<String>,
    pub new_header: Option<String>,
    pub hunks: Vec<Hunk>,
}

pub fn diff_lines(old: &str, new: &str) -> Vec<Change> {
    let old_lines = tokenize_lines(old);
    let new_lines = tokenize_lines(new);
    let mut changes = Vec::<Change>::new();
    for (kind, line) in line_edits(&old_lines, &new_lines) {
        let added = kind == '+';
        let removed = kind == '-';
        if let Some(change) = changes
            .last_mut()
            .filter(|change| change.added == added && change.removed == removed)
        {
            change.count += 1;
            change.value.push_str(line);
        } else {
            changes.push(Change {
                count: 1,
                added,
                removed,
                value: line.to_owned(),
            });
        }
    }
    changes
}

pub fn structured_patch(
    old_file_name: &str,
    new_file_name: &str,
    old: &str,
    new: &str,
    old_header: Option<&str>,
    new_header: Option<&str>,
    context: usize,
) -> StructuredPatch {
    let mut changes = diff_lines(old, new)
        .into_iter()
        .map(|change| {
            let lines = tokenize_lines(&change.value);
            (change, lines)
        })
        .collect::<Vec<_>>();
    changes.push((
        Change {
            count: 0,
            added: false,
            removed: false,
            value: String::new(),
        },
        Vec::new(),
    ));
    let mut hunks = Vec::new();
    let mut old_range_start = 0usize;
    let mut new_range_start = 0usize;
    let mut current_range = Vec::new();
    let mut old_line = 1usize;
    let mut new_line = 1usize;
    for index in 0..changes.len() {
        let (change, lines) = &changes[index];
        if change.added || change.removed {
            if old_range_start == 0 {
                old_range_start = old_line;
                new_range_start = new_line;
                if index > 0 {
                    let previous = &changes[index - 1].1;
                    let context_lines = &previous[previous.len().saturating_sub(context)..];
                    current_range.extend(context_lines.iter().map(|line| format!(" {line}")));
                    old_range_start -= context_lines.len();
                    new_range_start -= context_lines.len();
                }
            }
            let marker = if change.added { '+' } else { '-' };
            current_range.extend(lines.iter().map(|line| format!("{marker}{line}")));
            if change.added {
                new_line += lines.len();
            } else {
                old_line += lines.len();
            }
            continue;
        }
        if old_range_start != 0 {
            if lines.len() <= context.saturating_mul(2) && index < changes.len() - 2 {
                current_range.extend(lines.iter().map(|line| format!(" {line}")));
            } else {
                let context_size = lines.len().min(context);
                current_range.extend(lines[..context_size].iter().map(|line| format!(" {line}")));
                hunks.push(Hunk {
                    old_start: old_range_start,
                    old_lines: old_line - old_range_start + context_size,
                    new_start: new_range_start,
                    new_lines: new_line - new_range_start + context_size,
                    lines: std::mem::take(&mut current_range),
                });
                old_range_start = 0;
                new_range_start = 0;
            }
        }
        old_line += lines.len();
        new_line += lines.len();
    }
    for hunk in &mut hunks {
        let mut index = 0;
        while index < hunk.lines.len() {
            if let Some(line) = hunk.lines[index].strip_suffix('\n') {
                hunk.lines[index] = line.to_owned();
                index += 1;
            } else {
                hunk.lines
                    .insert(index + 1, "\\ No newline at end of file".to_owned());
                index += 2;
            }
        }
    }
    StructuredPatch {
        old_file_name: old_file_name.into(),
        new_file_name: new_file_name.into(),
        old_header: old_header.map(str::to_owned),
        new_header: new_header.map(str::to_owned),
        hunks,
    }
}

pub fn create_two_files_patch(
    old_file_name: &str,
    new_file_name: &str,
    old: &str,
    new: &str,
) -> String {
    format_patch(&structured_patch(
        old_file_name,
        new_file_name,
        old,
        new,
        None,
        None,
        4,
    ))
}

pub fn format_patch(patch: &StructuredPatch) -> String {
    let mut output = Vec::new();
    if patch.old_file_name == patch.new_file_name {
        output.push(format!("Index: {}", patch.old_file_name));
    }
    output.push("===================================================================".to_owned());
    output.push(format!(
        "--- {}{}",
        patch.old_file_name,
        patch
            .old_header
            .as_ref()
            .map_or_else(String::new, |header| format!("\t{header}"))
    ));
    output.push(format!(
        "+++ {}{}",
        patch.new_file_name,
        patch
            .new_header
            .as_ref()
            .map_or_else(String::new, |header| format!("\t{header}"))
    ));
    for hunk in &patch.hunks {
        let old_start = hunk
            .old_start
            .saturating_sub(usize::from(hunk.old_lines == 0));
        let new_start = hunk
            .new_start
            .saturating_sub(usize::from(hunk.new_lines == 0));
        output.push(format!(
            "@@ -{old_start},{} +{new_start},{} @@",
            hunk.old_lines, hunk.new_lines
        ));
        output.extend(hunk.lines.iter().cloned());
    }
    format!("{}\n", output.join("\n"))
}

fn tokenize_lines(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut start = 0;
    while start < text.len() {
        if let Some(offset) = text[start..].find('\n') {
            let end = start + offset + 1;
            lines.push(text[start..end].to_owned());
            start = end;
        } else {
            lines.push(text[start..].to_owned());
            break;
        }
    }
    lines
}

fn line_edits<'a>(old: &'a [String], new: &'a [String]) -> Vec<(char, &'a str)> {
    let max = old.len() + new.len();
    if max == 0 {
        return Vec::new();
    }
    let offset = max as isize;
    let mut frontier = vec![0isize; max * 2 + 1];
    let mut trace = Vec::new();
    let mut distance = 0;
    'search: for d in 0..=max as isize {
        for diagonal in (-d..=d).step_by(2) {
            let index = (offset + diagonal) as usize;
            let mut x =
                if diagonal == -d || (diagonal != d && frontier[index - 1] < frontier[index + 1]) {
                    frontier[index + 1]
                } else {
                    frontier[index - 1] + 1
                };
            let mut y = x - diagonal;
            while x < old.len() as isize
                && y < new.len() as isize
                && old[x as usize] == new[y as usize]
            {
                x += 1;
                y += 1;
            }
            frontier[index] = x;
            if x >= old.len() as isize && y >= new.len() as isize {
                trace.push(frontier.clone());
                distance = d as usize;
                break 'search;
            }
        }
        trace.push(frontier.clone());
    }
    let mut x = old.len() as isize;
    let mut y = new.len() as isize;
    let mut edits = Vec::new();
    for d in (1..=distance).rev() {
        let diagonal = x - y;
        let previous = &trace[d - 1];
        let index = (offset + diagonal) as usize;
        let previous_diagonal = if diagonal == -(d as isize)
            || (diagonal != d as isize && previous[index - 1] < previous[index + 1])
        {
            diagonal + 1
        } else {
            diagonal - 1
        };
        let previous_x = previous[(offset + previous_diagonal) as usize];
        let previous_y = previous_x - previous_diagonal;
        while x > previous_x && y > previous_y {
            edits.push((' ', old[(x - 1) as usize].as_str()));
            x -= 1;
            y -= 1;
        }
        if x == previous_x {
            edits.push(('+', new[(y - 1) as usize].as_str()));
            y -= 1;
        } else {
            edits.push(('-', old[(x - 1) as usize].as_str()));
            x -= 1;
        }
    }
    while x > 0 && y > 0 {
        edits.push((' ', old[(x - 1) as usize].as_str()));
        x -= 1;
        y -= 1;
    }
    while x > 0 {
        edits.push(('-', old[(x - 1) as usize].as_str()));
        x -= 1;
    }
    while y > 0 {
        edits.push(('+', new[(y - 1) as usize].as_str()));
        y -= 1;
    }
    edits.reverse();
    edits
}
