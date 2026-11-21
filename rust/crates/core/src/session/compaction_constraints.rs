use super::prompt_cache::sha256;

pub const DEFAULT_MAX_BYTES: usize = 32 * 1024;

struct Item {
    text: String,
    bytes: usize,
    index: usize,
}

pub fn assemble(parts: &[Option<&str>], max_bytes: usize) -> Vec<String> {
    if max_bytes == 0 {
        return Vec::new();
    }
    let mut included: Vec<Item> = Vec::new();
    let mut omitted: Vec<Item> = Vec::new();
    let mut used = 0;
    for (index, text) in parts
        .iter()
        .flatten()
        .filter(|part| !part.trim().is_empty())
        .enumerate()
    {
        let item = Item {
            text: (*text).to_string(),
            bytes: text.len(),
            index,
        };
        if used + item.bytes <= max_bytes {
            used += item.bytes;
            included.push(item);
        } else {
            omitted.push(item);
        }
    }
    if omitted.is_empty() {
        return included.into_iter().map(|item| item.text).collect();
    }
    loop {
        omitted.sort_by_key(|item| item.index);
        let marker = notice(&omitted);
        if marker.len() > max_bytes {
            return Vec::new();
        }
        if used + marker.len() <= max_bytes {
            return included
                .into_iter()
                .map(|item| item.text)
                .chain(std::iter::once(marker))
                .collect();
        }
        let Some(removed) = included.pop() else {
            return vec![marker];
        };
        used -= removed.bytes;
        omitted.push(removed);
    }
}

fn notice(items: &[Item]) -> String {
    let bytes = items.iter().map(|item| item.bytes).sum::<usize>();
    let digest = sha256(
        &items
            .iter()
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("\0"),
    );
    format!(
        "[Omitted {} compaction constraint block(s), {bytes} UTF-8 bytes; sha256={digest}. Reload source rules after compaction if needed.]",
        items.len()
    )
}
