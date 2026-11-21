use std::{env, fs, path::PathBuf};
#[path = "src/contract_hash.rs"]
mod contract_hash;
mod operation_generation;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?)
        .join("../../..")
        .canonicalize()?;
    let source = root.join("protocol");
    println!(
        "cargo:rerun-if-changed={}",
        source.join("ycoding/v5").display()
    );
    let mut files = fs::read_dir(source.join("ycoding/v5"))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    files.retain(|file| file.extension().is_some_and(|ext| ext == "proto"));
    files.sort();
    let out = PathBuf::from(env::var("OUT_DIR")?);
    let mut canonical = Vec::new();
    for file in &files {
        println!("cargo:rerun-if-changed={}", file.display());
        canonical.extend(
            file.strip_prefix(&source)?
                .to_string_lossy()
                .replace('\\', "/")
                .as_bytes(),
        );
        canonical.push(0);
        canonical.extend(fs::read(file)?);
    }
    println!("cargo:rerun-if-changed=src/contract_hash.rs");
    let hash = contract_hash::sha256(&canonical)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    fs::write(
        out.join("digest.rs"),
        format!("pub const CONTRACT_DIGEST: &str = {hash:?};\n"),
    )?;
    let mut config = prost_build::Config::new();
    config.enable_type_names();
    config.file_descriptor_set_path(out.join("contract.bin"));
    println!("cargo:rerun-if-env-changed=PROTOC");
    let set = config.load_fds(&files, &[source])?;
    operation_generation::validate_codec_names(&fs::read(out.join("contract.bin"))?)?;
    let types = set
        .file
        .iter()
        .flat_map(|file| {
            file.message_type
                .iter()
                .map(|message| format!("{}.{}", file.package(), message.name()))
        })
        .collect();
    let operations =
        operation_generation::read_operations(&fs::read(out.join("contract.bin"))?, &types)?;
    let constraints = operation_generation::read_constraints(&fs::read(out.join("contract.bin"))?)?;
    let public_events =
        operation_generation::read_public_events(&fs::read(out.join("contract.bin"))?)?;
    fs::write(
        out.join("public_events.rs"),
        format!(
            "pub const PUBLIC_EVENTS: &[(&str, bool, u32, &str)] = &[{}];\n",
            public_events
                .iter()
                .map(|(name, durable, tag, ty)| format!("({name:?}, {durable}, {tag}, {ty:?})"))
                .collect::<Vec<_>>()
                .join(",")
        ),
    )?;
    let roles = set
        .file
        .iter()
        .flat_map(|file| &file.enum_type)
        .filter(|item| item.name() == "PeerRole")
        .flat_map(|item| item.value.iter().map(|role| role.number() as u64))
        .collect::<Vec<_>>();
    let allowlists = operation_generation::read_role_allowlists(&operations, &roles)?;
    fs::write(
        out.join("role_allowlists.rs"),
        format!(
            "pub const OPERATION_IDS_BY_ROLE: &[(i32, &[u32])] = &[{}];\n",
            allowlists
                .iter()
                .map(|(role, ids)| format!("({role}, &{ids:?})"))
                .collect::<Vec<_>>()
                .join(",")
        ),
    )?;
    let mut obligations = constraints
        .iter()
        .filter(|(_, field)| !field.obligations.is_empty())
        .collect::<Vec<_>>();
    obligations.sort_by_key(|(name, _)| *name);
    fs::write(
        out.join("domain_obligations.rs"),
        format!(
            "pub const DOMAIN_OBLIGATIONS: &[(&str, &[&str])] = &[{}];\n",
            obligations
                .iter()
                .map(|(name, field)| format!("({name:?}, &{:?})", field.obligations))
                .collect::<Vec<_>>()
                .join(",")
        ),
    )?;
    fs::write(
        out.join("operations.rs"),
        format!(
            "pub static OPERATIONS: std::sync::LazyLock<Vec<v5::OperationDescriptor>> = std::sync::LazyLock::new(|| [{}].into_iter().map(|bytes: &[u8]| <v5::OperationDescriptor as prost::Message>::decode(bytes).expect(\"validated operation descriptor\")).collect());\n",
            operations
                .iter()
                .map(|(_, bytes)| format!("&{bytes:?}[..]"))
                .collect::<Vec<_>>()
                .join(",")
        ),
    )?;
    println!("cargo:rerun-if-changed=operation_generation.rs");
    println!("cargo:rerun-if-changed=src/field_constraints.rs");
    let mut rules = String::from("static MESSAGES: &[MessageRule] = &[\n");
    for file in &set.file {
        for message in &file.message_type {
            rules.push_str(&format!(
                "MessageRule {{ name: {:?}, oneofs: {}, fields: &[",
                format!("{}.{}", file.package(), message.name()),
                message.oneof_decl.len()
            ));
            for field in &message.field {
                let mut key = String::new();
                for (index, letter) in message.name().chars().enumerate() {
                    if index > 0 && letter.is_uppercase() {
                        key.push('_');
                    }
                    key.push(letter.to_ascii_uppercase());
                }
                key.push('_');
                key.push_str(&field.name().to_ascii_uppercase());
                let constraint = |suffix: &str| {
                    set.file
                        .iter()
                        .flat_map(|file| &file.enum_type)
                        .filter(|item| {
                            ["CollectionLimit", "CodePointLimit", "FieldTextPolicy"]
                                .contains(&item.name())
                        })
                        .flat_map(|item| &item.value)
                        .find(|value| value.name() == format!("{key}_{suffix}"))
                        .map(|value| value.number() as usize)
                };
                rules.push_str(&format!("FieldRule {{ tag: {}, kind: {}, required: {}, repeated: {}, target: {:?}, group: {:?}, max_count: {:?}, max_codepoints: {:?}, text_policy: {}, constraints: {} }},", field.number(), field.r#type() as i32, field.label() as i32 == 2, field.label() as i32 == 3, field.type_name().trim_start_matches('.'), field.oneof_index, constraint("MAX_COUNT"), constraint("MAX_CODEPOINTS"), constraint("TEXT_POLICY").unwrap_or(0), constraints.get(&format!("{}.{}.{}", file.package(), message.name(), field.number())).map(|field| field.rule.as_str()).unwrap_or("None")));
            }
            rules.push_str("] },\n");
        }
    }
    rules.push_str("];\nstatic ENUMS: &[(&str, &[u64])] = &[\n");
    for file in &set.file {
        for item in &file.enum_type {
            rules.push_str(&format!(
                "({:?}, &{:?}),\n",
                format!("{}.{}", file.package(), item.name()),
                item.value
                    .iter()
                    .map(|value| value.number() as u64)
                    .collect::<Vec<_>>()
            ));
        }
    }
    rules.push_str("];\n");
    for file in &set.file {
        for item in &file.enum_type {
            if item.name() == "WireLimit" {
                rules.push_str("pub mod limits {\n");
                for value in &item.value {
                    rules.push_str(&format!(
                        "pub const {}: u64 = {};\n",
                        value.name(),
                        value.number()
                    ));
                }
                rules.push_str("}\n");
            }
            if item.name() == "SenderMask" {
                rules.push_str("static SENDER_MASKS: &[(&str, u64)] = &[\n");
                for value in &item.value {
                    rules.push_str(&format!("({:?}, {}),\n", value.name(), value.number()));
                }
                rules.push_str("];\n");
            }
        }
    }
    fs::write(out.join("rules.rs"), rules)?;
    fs::write(
        out.join("domain_metadata.rs"),
        domain_metadata(&fs::read(out.join("contract.bin"))?)?,
    )?;
    config.compile_fds(set)?;
    Ok(())
}

fn domain_metadata(contract: &[u8]) -> Result<String, String> {
    let mut messages = Vec::new();
    let mut enums = Vec::new();
    for file in wire_fields(contract)?
        .into_iter()
        .filter(|field| field.0 == 1)
    {
        let file = wire_fields(file.2)?;
        let package = wire_text(&file, 2)?.unwrap_or_default();
        for message in file.iter().filter(|field| field.0 == 4) {
            let message = wire_fields(message.2)?;
            let name = format!("{package}.{}", wire_text(&message, 1)?.unwrap_or_default());
            let oneofs = message
                .iter()
                .filter(|field| field.0 == 8)
                .map(|oneof| wire_text(&wire_fields(oneof.2)?, 1).map(Option::unwrap_or_default))
                .collect::<Result<Vec<_>, _>>()?;
            let mut fields = Vec::new();
            for field in message.iter().filter(|field| field.0 == 2) {
                let field = wire_fields(field.2)?;
                fields.push((
                    wire_number(&field, 3)?,
                    format!(
                        "Field {{ name: {:?}, tag: {}, kind: {}, required: {}, repeated: {}, target: {:?}, oneof: {:?}, literal: {:?} }},",
                        wire_text(&field, 1)?.unwrap_or_default(),
                        wire_number(&field, 3)?,
                        wire_number(&field, 5)?,
                        wire_number(&field, 4)? == 2,
                        wire_number(&field, 4)? == 3,
                        wire_text(&field, 6)?.unwrap_or_default().trim_start_matches('.'),
                        field
                            .iter()
                            .find(|item| item.0 == 9 && item.1 == 0)
                            .map(|item| item.3 as u32),
                        wire_option(&field, 8, 51002)?,
                    ),
                ));
            }
            fields.sort_by_key(|field| field.0);
            messages.push((
                name.clone(),
                format!(
                    "Message {{ name: {name:?}, oneofs: &{oneofs:?}, fields: &[{}] }},\n",
                    fields.into_iter().map(|field| field.1).collect::<String>()
                ),
            ));
        }
        for item in file.iter().filter(|field| field.0 == 5) {
            let item = wire_fields(item.2)?;
            let name = format!("{package}.{}", wire_text(&item, 1)?.unwrap_or_default());
            let mut values = String::new();
            for value in item.iter().filter(|field| field.0 == 2) {
                let value = wire_fields(value.2)?;
                values.push_str(&format!(
                    "Value {{ number: {}, name: {:?}, label: {:?} }},",
                    wire_number(&value, 2)?,
                    wire_text(&value, 1)?.unwrap_or_default(),
                    wire_option(&value, 3, 51000)?,
                ));
            }
            enums.push((
                name.clone(),
                format!("Enumeration {{ name: {name:?}, values: &[{values}] }},\n"),
            ));
        }
    }
    messages.sort();
    enums.sort();
    Ok(format!(
        "static MESSAGES: &[Message] = &[\n{}];\nstatic ENUMERATIONS: &[Enumeration] = &[\n{}];\n",
        messages.into_iter().map(|item| item.1).collect::<String>(),
        enums.into_iter().map(|item| item.1).collect::<String>(),
    ))
}

type WireField<'a> = (u64, u64, &'a [u8], u64);

fn wire_fields(mut bytes: &[u8]) -> Result<Vec<WireField<'_>>, String> {
    let mut fields = Vec::new();
    while !bytes.is_empty() {
        let key = wire_varint(&mut bytes)?;
        let (tag, kind) = (key >> 3, key & 7);
        match kind {
            0 => {
                let value = wire_varint(&mut bytes)?;
                fields.push((tag, kind, &[][..], value));
            }
            1 | 5 => {
                let width = if kind == 1 { 8 } else { 4 };
                let (value, rest) = bytes
                    .split_at_checked(width)
                    .ok_or("truncated fixed descriptor field")?;
                fields.push((tag, kind, value, 0));
                bytes = rest;
            }
            2 => {
                let length = wire_varint(&mut bytes)? as usize;
                let (value, rest) = bytes
                    .split_at_checked(length)
                    .ok_or("truncated descriptor field")?;
                fields.push((tag, kind, value, 0));
                bytes = rest;
            }
            _ => return Err(format!("unsupported descriptor wire type {kind}")),
        }
    }
    Ok(fields)
}

fn wire_varint(bytes: &mut &[u8]) -> Result<u64, String> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let (&byte, rest) = bytes.split_first().ok_or("truncated descriptor varint")?;
        *bytes = rest;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err("overlong descriptor varint".into())
}

fn wire_text(fields: &[WireField<'_>], tag: u64) -> Result<Option<String>, String> {
    fields
        .iter()
        .find(|field| field.0 == tag && field.1 == 2)
        .map(|field| {
            String::from_utf8(field.2.to_vec()).map_err(|_| "descriptor text is not UTF-8".into())
        })
        .transpose()
}

fn wire_number(fields: &[WireField<'_>], tag: u64) -> Result<u64, String> {
    fields
        .iter()
        .find(|field| field.0 == tag && field.1 == 0)
        .map(|field| field.3)
        .ok_or_else(|| format!("descriptor number {tag} missing"))
}

fn wire_option(
    fields: &[WireField<'_>],
    tag: u64,
    extension: u64,
) -> Result<Option<String>, String> {
    let Some(options) = fields.iter().find(|field| field.0 == tag && field.1 == 2) else {
        return Ok(None);
    };
    wire_text(&wire_fields(options.2)?, extension)
}
