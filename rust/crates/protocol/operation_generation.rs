use std::collections::HashSet;

fn rust_words(name: &str) -> Vec<String> {
    let mut output = Vec::new();
    for word in name
        .split(|char: char| !char.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
    {
        let bytes = word.as_bytes();
        let mut start = 0;
        let mut mode = 0;
        for index in 0..bytes.len().saturating_sub(1) {
            let next_mode = if bytes[index].is_ascii_lowercase() {
                1
            } else if bytes[index].is_ascii_uppercase() {
                2
            } else {
                mode
            };
            if next_mode == 1 && bytes[index + 1].is_ascii_uppercase() {
                output.push(word[start..=index].to_ascii_lowercase());
                start = index + 1;
                mode = 0;
                continue;
            }
            if mode == 2
                && bytes[index].is_ascii_uppercase()
                && bytes[index + 1].is_ascii_lowercase()
            {
                output.push(word[start..index].to_ascii_lowercase());
                start = index;
                mode = 0;
                continue;
            }
            mode = next_mode;
        }
        output.push(word[start..].to_ascii_lowercase());
    }
    output
}

fn rust_type_name(name: &str) -> String {
    let name = rust_words(name)
        .iter()
        .map(|word| format!("{}{}", word[..1].to_ascii_uppercase(), &word[1..]))
        .collect::<String>();
    if name == "Self" {
        return "Self_".into();
    }
    if name.starts_with(|char: char| char.is_ascii_digit()) {
        return format!("_{name}");
    }
    name
}

pub fn validate_codec_names(bytes: &[u8]) -> Result<(), String> {
    let mut names = std::collections::HashMap::new();
    let mut collisions = Vec::new();
    let mut register = |file: &str, package: &str, nesting: &[String], name: &str| {
        let full = nesting
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(name))
            .collect::<Vec<_>>();
        let source = format!("{file}:{package}.{}", full.join("."));
        let module = package
            .split('.')
            .chain(nesting.iter().map(String::as_str))
            .map(|name| rust_words(name).join("_"))
            .collect::<Vec<_>>()
            .join("::");
        let rust = format!("Rust {module}::{}", rust_type_name(name));
        let flat = full.join("_");
        let reserved = "break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield enum implements interface let package private protected public static Object bigint number boolean string object globalThis Uint8Array Partial";
        let ts = if reserved.split(' ').any(|name| name == flat) {
            format!("TypeScript {flat}$")
        } else {
            format!("TypeScript {flat}")
        };
        for key in [rust, ts, format!("TypeScript {flat}Schema")] {
            if let Some(previous) = names.get(&key) {
                if previous != &source {
                    collisions.push(format!(
                        "codec name collision {key}: {previous} and {source}"
                    ));
                }
                continue;
            }
            names.insert(key, source.clone());
        }
    };
    fn visit(
        file: &str,
        package: &str,
        nesting: &[String],
        bytes: &[u8],
        register: &mut impl FnMut(&str, &str, &[String], &str),
    ) -> Result<(), String> {
        let message_type = fields(bytes)?;
        let name = text(&message_type, 1)?;
        register(file, package, nesting, name);
        let nesting = nesting
            .iter()
            .cloned()
            .chain(std::iter::once(name.to_owned()))
            .collect::<Vec<_>>();
        for item in message_type.iter().filter(|field| field.tag == 4) {
            register(file, package, &nesting, text(&fields(item.bytes)?, 1)?);
        }
        for item in message_type.iter().filter(|field| field.tag == 3) {
            visit(file, package, &nesting, item.bytes, register)?;
        }
        Ok(())
    }
    for file in fields(bytes)?.iter().filter(|field| field.tag == 1) {
        let file = fields(file.bytes)?;
        let filename = text(&file, 1)?;
        if !filename.starts_with("ycoding/v5/") {
            continue;
        }
        let package = text(&file, 2)?;
        for item in file.iter().filter(|field| field.tag == 5) {
            register(filename, package, &[], text(&fields(item.bytes)?, 1)?);
        }
        for item in file.iter().filter(|field| field.tag == 4) {
            visit(filename, package, &[], item.bytes, &mut register)?;
        }
    }
    if collisions.is_empty() {
        return Ok(());
    }
    Err(collisions.join("\n"))
}

#[derive(Debug)]
pub struct FieldMetadata {
    pub rule: String,
    pub obligations: Vec<String>,
}

pub fn read_constraints(
    bytes: &[u8],
) -> Result<std::collections::HashMap<String, FieldMetadata>, String> {
    let mut output = std::collections::HashMap::new();
    for file in fields(bytes)?.iter().filter(|field| field.tag == 1) {
        let file = fields(file.bytes)?;
        let package = text(&file, 2)?;
        for message_type in file.iter().filter(|field| field.tag == 4) {
            let message_type = fields(message_type.bytes)?;
            let name = text(&message_type, 1)?;
            for field in message_type.iter().filter(|field| field.tag == 2) {
                let field = fields(field.bytes)?;
                let Ok(options) = message(&field, 8) else {
                    continue;
                };
                let options = fields(options)?;
                let Ok(constraints) = message(&options, 51000) else {
                    continue;
                };
                let values = fields(constraints)?;
                let parse_integer = |tag| -> Result<Option<i128>, String> {
                    let Ok(bound) = text(&values, tag) else {
                        return Ok(None);
                    };
                    let value = bound
                        .parse::<i128>()
                        .map_err(|_| "invalid integer constraint")?;
                    if value.to_string() != bound
                        || value < i64::MIN as i128
                        || value > u64::MAX as i128
                    {
                        return Err("invalid integer constraint".into());
                    }
                    Ok(Some(value))
                };
                let min = parse_integer(1)?;
                let max = parse_integer(2)?;
                let bounds: [Option<u64>; 8] =
                    std::array::from_fn(|index| number(&values, index as u32 + 3).ok());
                if bounds
                    .iter()
                    .flatten()
                    .any(|value| *value > 9007199254740991)
                {
                    return Err("constraint bound exceeds safe integer".into());
                }
                if min.zip(max).is_some_and(|(min, max)| min > max)
                    || bounds
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .any(|pair| pair[0].zip(pair[1]).is_some_and(|(min, max)| min > max))
                {
                    return Err("inverted constraint bounds".into());
                }
                let obligations = values
                    .iter()
                    .filter(|field| field.tag == 11)
                    .map(|field| std::str::from_utf8(field.bytes))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| "invalid domain obligation source")?;
                for source in &obligations {
                    let (path, export) = source
                        .split_once('#')
                        .ok_or("invalid domain obligation source")?;
                    if !(path.starts_with("packages/schema/src/")
                        || path.starts_with("packages/remote/src/")
                        || path.starts_with("packages/cli/src/")
                        || path.starts_with("packages/protocol/src/"))
                        || !path.ends_with(".ts")
                        || !path
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"_./-".contains(&byte))
                        || export.is_empty()
                        || !export
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"_.".contains(&byte))
                    {
                        return Err("invalid domain obligation source".into());
                    }
                }
                let kind = number(&field, 5)?;
                let repeated = number(&field, 4)? == 3;
                let is_text =
                    kind == 9 || text(&field, 6).ok() == Some(".ycoding.v5.LosslessString");
                if (![3, 4, 5, 13].contains(&kind) && (min.is_some() || max.is_some()))
                    || (!is_text && bounds[..6].iter().any(Option::is_some))
                    || (!repeated && kind != 12 && bounds[6..].iter().any(Option::is_some))
                {
                    return Err("constraint type mismatch".into());
                }
                let named_bounds = [
                    "utf16_min",
                    "utf16_max",
                    "codepoints_min",
                    "codepoints_max",
                    "utf8_bytes_min",
                    "utf8_bytes_max",
                    "count_min",
                    "count_max",
                ]
                .into_iter()
                .zip(bounds)
                .map(|(name, value)| format!("{name}: {value:?}"))
                .collect::<Vec<_>>()
                .join(", ");
                output.insert(format!("{package}.{name}.{}", number(&field, 3)?), FieldMetadata { rule: format!("Some(Constraints {{ integer_min: {min:?}, integer_max: {max:?}, {named_bounds} }})"), obligations: obligations.iter().map(|source| source.to_string()).collect() });
            }
        }
    }
    Ok(output)
}

struct Field<'a> {
    tag: u32,
    number: u64,
    bytes: &'a [u8],
}

fn varint(bytes: &mut &[u8]) -> Result<u64, String> {
    let mut value = 0;
    for shift in (0..70).step_by(7) {
        let byte = *bytes.first().ok_or("truncated descriptor")?;
        *bytes = &bytes[1..];
        if shift == 63 && byte > 1 {
            return Err("invalid descriptor varint".into());
        }
        value |= u64::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return Ok(value);
        }
    }
    Err("invalid descriptor varint".into())
}

fn fields(mut bytes: &[u8]) -> Result<Vec<Field<'_>>, String> {
    let mut output = Vec::new();
    while !bytes.is_empty() {
        let key = varint(&mut bytes)?;
        let mut field = Field {
            tag: (key >> 3) as u32,
            number: 0,
            bytes: &[],
        };
        let size = match key & 7 {
            0 => {
                field.number = varint(&mut bytes)?;
                0
            }
            1 => 8,
            2 => usize::try_from(varint(&mut bytes)?).map_err(|_| "descriptor size overflow")?,
            5 => 4,
            _ => return Err("invalid descriptor wire type".into()),
        };
        field.bytes = bytes.get(..size).ok_or("truncated descriptor")?;
        bytes = &bytes[size..];
        output.push(field);
    }
    Ok(output)
}

fn message<'a>(fields: &[Field<'a>], tag: u32) -> Result<&'a [u8], String> {
    fields
        .iter()
        .find(|field| field.tag == tag)
        .map(|field| field.bytes)
        .ok_or_else(|| format!("missing descriptor field {tag}"))
}

fn number(fields: &[Field<'_>], tag: u32) -> Result<u64, String> {
    fields
        .iter()
        .find(|field| field.tag == tag)
        .map(|field| field.number)
        .ok_or_else(|| format!("missing descriptor field {tag}"))
}

fn text<'a>(fields: &[Field<'a>], tag: u32) -> Result<&'a str, String> {
    std::str::from_utf8(message(fields, tag)?).map_err(|_| "invalid descriptor text".into())
}

fn append_text(bytes: &mut Vec<u8>, tag: u8, value: &str) {
    bytes.push(tag << 3 | 2);
    let mut size = value.len();
    while size >= 128 {
        bytes.push((size as u8 & 127) | 128);
        size >>= 7;
    }
    bytes.push(size as u8);
    bytes.extend(value.as_bytes());
}

pub fn read_operations(
    bytes: &[u8],
    types: &HashSet<String>,
) -> Result<Vec<(u64, Vec<u8>)>, String> {
    let mut output = Vec::new();
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for file in fields(bytes)?.iter().filter(|field| field.tag == 1) {
        let file = fields(file.bytes)?;
        for service in file.iter().filter(|field| field.tag == 6) {
            for method in fields(service.bytes)?.iter().filter(|field| field.tag == 2) {
                let method = fields(method.bytes)?;
                let options =
                    fields(message(&method, 4).map_err(|_| "missing operation annotation")?)?;
                let option_bytes =
                    message(&options, 51000).map_err(|_| "missing operation annotation")?;
                let options = fields(option_bytes)?;
                let file_options =
                    fields(message(&file, 8).map_err(|_| "missing operation range")?)?;
                let range =
                    fields(message(&file_options, 51000).map_err(|_| "missing operation range")?)?;
                let id = number(&options, 1)?;
                let first = number(&range, 1)?;
                let last = number(&range, 2)?;
                if first > last || id < first || id > last {
                    return Err("operation ID outside declared range".into());
                }
                if !ids.insert(id) {
                    return Err("duplicate operation ID".into());
                }
                let name = text(&options, 2)?;
                if name.is_empty() || !names.insert(name.to_owned()) {
                    return Err("empty or duplicate diagnostic name".into());
                }
                if !options.iter().any(|field| field.tag == 6) {
                    return Err("missing operation roles".into());
                }
                if method
                    .iter()
                    .any(|field| [5, 6].contains(&field.tag) && field.number != 0)
                {
                    return Err("gRPC streaming is not a v5 transport".into());
                }
                let request = text(&method, 2)?.trim_start_matches('.');
                let result = text(&method, 3)?.trim_start_matches('.');
                for name in std::iter::once(request)
                    .chain(std::iter::once(result))
                    .chain(
                        options
                            .iter()
                            .filter(|field| [5, 15].contains(&field.tag))
                            .map(|field| std::str::from_utf8(field.bytes))
                            .collect::<Result<Vec<_>, _>>()
                            .map_err(|_| "invalid descriptor text")?,
                    )
                {
                    if !types.contains(name) {
                        return Err(format!("unknown operation type: {name}"));
                    }
                }
                let roles = options
                    .iter()
                    .filter(|field| field.tag == 6)
                    .map(|field| field.number)
                    .collect::<HashSet<_>>();
                let mut scoped_roles = HashSet::new();
                for rule in options.iter().filter(|field| field.tag == 14) {
                    let rule = fields(rule.bytes)?;
                    let role = number(&rule, 1)?;
                    let scopes = rule
                        .iter()
                        .filter(|field| field.tag == 2)
                        .map(|field| field.number)
                        .collect::<Vec<_>>();
                    if !roles.contains(&role)
                        || !scoped_roles.insert(role)
                        || scopes.is_empty()
                        || scopes.iter().any(|scope| !(1..=7).contains(scope))
                        || scopes.iter().collect::<HashSet<_>>().len() != scopes.len()
                    {
                        return Err("invalid operation role scopes".into());
                    }
                }
                let mut encoded = option_bytes.to_vec();
                append_text(&mut encoded, 3, request);
                append_text(&mut encoded, 4, result);
                output.push((id, encoded));
            }
        }
    }
    output.sort_by_key(|operation| operation.0);
    Ok(output)
}

pub fn read_public_events(bytes: &[u8]) -> Result<Vec<(String, bool, u32, String)>, String> {
    let mut output = Vec::new();
    let mut names = HashSet::new();
    for file in fields(bytes)?.iter().filter(|field| field.tag == 1) {
        let file = fields(file.bytes)?;
        for message_type in file.iter().filter(|field| field.tag == 4) {
            let message_type = fields(message_type.bytes)?;
            if text(&message_type, 1)? != "PublicEvent" {
                continue;
            }
            for field in message_type.iter().filter(|field| field.tag == 2) {
                let field = fields(field.bytes)?;
                let options = fields(message(&field, 8)?)?;
                let event =
                    fields(message(&options, 51001).map_err(|_| "missing public event metadata")?)?;
                let name = text(&event, 1)?;
                if name.is_empty() || !names.insert(name.to_owned()) {
                    return Err("invalid public event metadata".into());
                }
                output.push((
                    name.to_owned(),
                    number(&event, 2)? == 1,
                    number(&field, 3)? as u32,
                    text(&field, 6)?.trim_start_matches('.').to_owned(),
                ));
            }
        }
    }
    Ok(output)
}

pub fn read_role_allowlists(
    operations: &[(u64, Vec<u8>)],
    roles: &[u64],
) -> Result<std::collections::BTreeMap<u64, Vec<u64>>, String> {
    let mut output: std::collections::BTreeMap<_, Vec<_>> =
        roles.iter().map(|role| (*role, Vec::new())).collect();
    for (id, bytes) in operations {
        let operation_roles = fields(bytes)?
            .iter()
            .filter(|field| field.tag == 6)
            .map(|field| field.number)
            .collect::<HashSet<_>>();
        for role in operation_roles {
            output
                .get_mut(&role)
                .ok_or("unknown operation role")?
                .push(*id);
        }
    }
    Ok(output)
}
