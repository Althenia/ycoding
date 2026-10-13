use icu_normalizer::DecomposingNormalizer;
use icu_properties::{CodePointMapData, props::Script};

pub fn find(query: &str, targets: &[String], limit: usize) -> Vec<String> {
    if query.is_empty() {
        return Vec::new();
    }
    let mut heap: Vec<(f64, usize)> = Vec::new();
    let limit = if limit == 0 { usize::MAX } else { limit };
    for (index, target) in targets.iter().enumerate() {
        if target.is_empty() {
            continue;
        }
        let Some(score) = score(super::trim(query), target) else {
            continue;
        };
        if heap.len() < limit {
            heap.push((score, index));
            let mut child = heap.len() - 1;
            while child > 0 && heap[child].0 < heap[(child - 1) / 2].0 {
                heap.swap(child, (child - 1) / 2);
                child = (child - 1) / 2;
            }
        } else if score > heap[0].0 {
            heap[0] = (score, index);
            sift(&mut heap);
        }
    }
    let mut output = Vec::with_capacity(heap.len());
    while !heap.is_empty() {
        let best = heap[0];
        let last = heap.pop().expect("Nonempty heap");
        if !heap.is_empty() {
            heap[0] = last;
            sift(&mut heap);
        }
        output.push(targets[best.1].clone());
    }
    output.reverse();
    output
}

fn sift(heap: &mut [(f64, usize)]) {
    let root = heap[0];
    let mut index = 0;
    let mut child = 1;
    while child < heap.len() {
        index = child;
        if child + 1 < heap.len() && heap[child + 1].0 < heap[child].0 {
            index = child + 1;
        }
        heap[(index - 1) / 2] = heap[index];
        child = 1 + index * 2;
    }
    let mut parent = index.saturating_sub(1) / 2;
    while index > 0 && root.0 < heap[parent].0 {
        heap[index] = heap[parent];
        index = parent;
        parent = index.saturating_sub(1) / 2;
    }
    heap[index] = root;
}

fn accents(text: &str) -> String {
    text.chars()
        .flat_map(|c| {
            if CodePointMapData::<Script>::new().get(c) == Script::Latin {
                DecomposingNormalizer::new_nfd()
                    .normalize(&c.to_string())
                    .into_owned()
                    .chars()
                    .collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect()
}

fn lower(text: &str) -> Vec<u16> {
    let text = accents(text);
    text.to_lowercase()
        .encode_utf16()
        .take(text.encode_utf16().count())
        .collect()
}

fn beginnings(text: &str) -> Vec<usize> {
    let target: Vec<_> = accents(text).encode_utf16().collect();
    let mut was_upper = false;
    let mut was_alphanumeric = false;
    let mut starts = Vec::new();
    for (i, c) in target.iter().copied().enumerate() {
        let upper = (65..=90).contains(&c);
        let alphanumeric = upper || (97..=122).contains(&c) || (48..=57).contains(&c);
        if upper && !was_upper || !was_alphanumeric || !alphanumeric {
            starts.push(i);
        }
        was_upper = upper;
        was_alphanumeric = alphanumeric;
    }
    (0..target.len())
        .map(|index| {
            starts
                .iter()
                .copied()
                .find(|start| *start > index)
                .unwrap_or(target.len())
        })
        .collect()
}

fn score(query: &str, target: &str) -> Option<f64> {
    let codes = lower(query);
    let target_codes = lower(target);
    let mut next = beginnings(target);
    if !codes.contains(&32) {
        return algorithm(&codes, &codes, &target_codes, &next).map(|result| result.0);
    }
    let mut searches = Vec::new();
    for part in query.split_whitespace() {
        if !searches.contains(&part) {
            searches.push(part);
        }
    }
    let mut result = 0.0;
    let mut previous = 0;
    for (i, part) in searches.iter().enumerate() {
        let (score, indexes) = algorithm(
            &lower(part),
            &part.to_lowercase().encode_utf16().collect::<Vec<_>>(),
            &target_codes,
            &next,
        )?;
        if i + 1 < searches.len() && indexes.windows(2).all(|pair| pair[1] == pair[0] + 1) {
            let beginning = indexes.last()? + 1;
            if beginning > 0 && beginning - 1 < next.len() {
                let replaced = next[beginning - 1];
                for index in (0..beginning).rev() {
                    if next[index] != replaced {
                        break;
                    }
                    next[index] = beginning;
                }
            }
        }
        result += score / searches.len() as f64;
        if indexes[0] < previous {
            result -= (previous - indexes[0]) as f64 * 2.0;
        }
        previous = indexes[0];
    }
    Some(
        algorithm(&codes, &codes, &target_codes, &beginnings(target))
            .map_or(result, |matched| result.max(matched.0)),
    )
}

fn algorithm(
    search: &[u16],
    substring_search: &[u16],
    target: &[u16],
    next: &[usize],
) -> Option<(f64, Vec<usize>)> {
    if search.is_empty() || target.is_empty() {
        return None;
    }
    let mut simple = Vec::new();
    for (i, c) in target.iter().copied().enumerate() {
        if search[simple.len()] == c {
            simple.push(i);
            if simple.len() == search.len() {
                break;
            }
        }
    }
    if simple.len() != search.len() {
        return None;
    }
    let mut strict = Vec::new();
    let mut index = if simple[0] == 0 {
        0
    } else {
        next[simple[0] - 1]
    };
    let mut backtracks = 0;
    while index != target.len() || !strict.is_empty() {
        if index >= target.len() {
            if strict.is_empty() {
                break;
            }
            backtracks += 1;
            if backtracks > 200 {
                break;
            }
            index = next[strict.pop().expect("Strict match exists")];
        } else if search[strict.len()] == target[index] {
            strict.push(index);
            if strict.len() == search.len() {
                break;
            }
            index += 1;
        } else {
            index = next[index];
        }
    }
    let success_strict = strict.len() == search.len();
    let mut substring = if search.len() <= 1 || substring_search.is_empty() {
        None
    } else {
        target
            .windows(substring_search.len())
            .enumerate()
            .skip(simple[0])
            .find(|(_, value)| *value == substring_search)
            .map(|(index, _)| index)
    };
    let mut substring_beginning = substring.is_some_and(|i| i == 0 || next[i - 1] == i);
    if let Some(start) = substring
        && !substring_beginning
    {
        let mut index = 0;
        while index < next.len() {
            if index > start && target.get(index..index + search.len()) == Some(search) {
                substring = Some(index);
                substring_beginning = true;
                break;
            }
            index = next[index];
        }
    }
    let matches = if !success_strict || substring_beginning {
        if let Some(start) = substring {
            (start..start + search.len()).collect::<Vec<_>>()
        } else {
            simple
        }
    } else {
        strict
    };
    let mut score = 0.0;
    let mut groups = 0;
    for pair in matches.windows(2) {
        if pair[1] != pair[0] + 1 {
            score -= pair[1] as f64;
            groups += 1;
        }
    }
    let distance = matches[search.len() - 1] - matches[0] - (search.len() - 1);
    score -= (12 + distance) as f64 * groups as f64;
    if matches[0] != 0 {
        score -= (matches[0] * matches[0]) as f64 * 0.2;
    }
    if !success_strict {
        score *= 1000.0;
    } else {
        let mut unique = 1;
        let mut index = next[0];
        while index < target.len() {
            unique += 1;
            index = next[index];
        }
        if unique > 24 {
            score *= (unique - 24) as f64 * 10.0;
        }
    }
    score -= (target.len() - search.len()) as f64 / 2.0;
    if substring.is_some() {
        score /= 1.0 + (search.len() * search.len()) as f64;
    }
    if substring_beginning {
        score /= 1.0 + (search.len() * search.len()) as f64;
    }
    score -= (target.len() - search.len()) as f64 / 2.0;
    Some((score, matches))
}
