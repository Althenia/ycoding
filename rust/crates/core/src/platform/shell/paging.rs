#[derive(Debug, PartialEq)]
pub struct Page {
    pub output: String,
    pub cursor: usize,
    pub size: usize,
    pub truncated: bool,
}

pub fn page(bytes: &[u8], cursor: usize, limit: usize, settled: bool) -> Page {
    let cursor = cursor.min(bytes.len());
    let window = cursor
        .saturating_add(limit.saturating_add(3))
        .min(bytes.len());
    let end = cursor
        + page_end(
            &bytes[cursor..window],
            limit,
            settled && window == bytes.len(),
        );
    Page {
        output: String::from_utf8_lossy(&bytes[cursor..end]).into_owned(),
        cursor: end,
        size: bytes.len(),
        truncated: false,
    }
}

pub(crate) fn page_end(bytes: &[u8], budget: usize, flush_tail: bool) -> usize {
    let mut index = 0;
    while index < bytes.len() {
        if index == budget {
            return index;
        }
        let Some(end) = unit_end(bytes, index) else {
            return if flush_tail { bytes.len() } else { index };
        };
        if end > budget {
            return end;
        }
        index = end;
    }
    bytes.len()
}

fn unit_end(bytes: &[u8], start: usize) -> Option<usize> {
    let lead = bytes[start];
    let width = match lead {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return Some(start + 1),
    };
    for offset in 1..width {
        let byte = *bytes.get(start + offset)?;
        let lower = match (offset, lead) {
            (1, 0xe0) => 0xa0,
            (1, 0xf0) => 0x90,
            _ => 0x80,
        };
        let upper = match (offset, lead) {
            (1, 0xed) => 0x9f,
            (1, 0xf4) => 0x8f,
            _ => 0xbf,
        };
        if byte < lower || byte > upper {
            return Some(start + offset);
        }
    }
    Some(start + width)
}

pub async fn read(
    file: &std::path::Path,
    cursor: usize,
    limit: usize,
    size: usize,
    settled: bool,
) -> std::io::Result<Page> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let cursor = cursor.min(size);
    if cursor == size || limit == 0 {
        return Ok(Page {
            output: String::new(),
            cursor,
            size,
            truncated: false,
        });
    }
    let mut file = tokio::fs::File::open(file).await?;
    file.seek(std::io::SeekFrom::Start(cursor as u64)).await?;
    let mut bytes = vec![0; limit.saturating_add(3).min(size - cursor)];
    let mut read = 0;
    while read < bytes.len() {
        let count = file.read(&mut bytes[read..]).await?;
        if count == 0 {
            break;
        }
        read += count;
    }
    bytes.truncate(read);
    let end = page_end(&bytes, limit.min(read), settled && read == size - cursor);
    Ok(Page {
        output: String::from_utf8_lossy(&bytes[..end]).into_owned(),
        cursor: cursor + end,
        size,
        truncated: false,
    })
}
