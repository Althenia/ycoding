use super::Error;
use std::collections::BTreeMap;
use yaml_rust2::{
    YamlLoader,
    parser::{Event, Parser},
};

pub(super) fn split(content: &str) -> Result<(&str, Option<&str>), Error> {
    let text = content.strip_prefix('\u{feff}').unwrap_or(content);
    let rest = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))
        .ok_or(Error::InvalidConcept)?;
    let mut end = 0;
    for line in rest.split_inclusive('\n') {
        if line == "---\n" || line == "---\r\n" || line == "---" {
            return Ok((&rest[..end], Some(&rest[end + line.len()..])));
        }
        end += line.len();
    }
    Ok((rest, None))
}

pub(super) fn mapping(block: &str) -> Result<yaml_rust2::Yaml, Error> {
    let mut parser = Parser::new_from_str(block);
    let mut anchors = BTreeMap::new();
    let mut stack: Vec<(usize, usize)> = Vec::new();
    let mut allocation = 0usize;
    loop {
        let (event, _) = parser.next_token().map_err(|_| Error::InvalidYaml)?;
        let (anchor, size, allocated) = match event {
            Event::StreamEnd => break,
            Event::Scalar(value, _, anchor, _) => (anchor, value.len() + 64, value.len() + 64),
            Event::SequenceStart(anchor, _) | Event::MappingStart(anchor, _) => {
                if stack.len() >= 128 {
                    return Err(Error::TooLarge);
                }
                stack.push((anchor, 64));
                continue;
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let (anchor, size) = stack.pop().ok_or(Error::InvalidYaml)?;
                (anchor, size, 64)
            }
            Event::Alias(id) => {
                let size = *anchors.get(&id).ok_or(Error::InvalidYaml)?;
                (0, size, size)
            }
            _ => continue,
        };
        allocation = allocation.saturating_add(allocated);
        if anchor != 0 {
            anchors.insert(anchor, size);
            allocation = allocation.saturating_add(size);
        }
        if allocation > 8 * 1024 * 1024 {
            return Err(Error::TooLarge);
        }
        if let Some((_, parent)) = stack.last_mut() {
            *parent = parent.saturating_add(size);
        }
    }
    let mut documents = YamlLoader::load_from_str(block).map_err(|_| Error::InvalidYaml)?;
    if documents.len() != 1 {
        return Err(Error::InvalidYaml);
    }
    let document = documents.pop().ok_or(Error::InvalidYaml)?;
    if document.as_hash().is_none() {
        return Err(Error::InvalidYaml);
    }
    if !document["type"]
        .as_str()
        .is_some_and(|t| !t.trim().is_empty())
    {
        return Err(Error::InvalidConcept);
    }
    Ok(document)
}
