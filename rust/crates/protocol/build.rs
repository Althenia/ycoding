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
    config.compile_fds(set)?;
    Ok(())
}
