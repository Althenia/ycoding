use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let source = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join("../../../protocol");
    let file = source.join("ycoding/extension/v5/extension.proto");
    println!("cargo:rerun-if-changed={}", file.display());
    println!("cargo:rerun-if-env-changed=PROTOC");
    let mut config = prost_build::Config::new();
    config.protoc_executable(
        env::var("PROTOC").unwrap_or_else(|_| "/opt/homebrew/bin/protoc".into()),
    );
    let out = PathBuf::from(env::var("OUT_DIR")?);
    config.file_descriptor_set_path(out.join("extension.bin"));
    config.skip_debug([
        ".ycoding.extension.v5.AuthCallback",
        ".ycoding.extension.v5.AuthSubmit",
        ".ycoding.extension.v5.AuthRefresh",
        ".ycoding.extension.v5.AuthLabel",
        ".ycoding.extension.v5.AuthReply",
    ]);
    let set = config.load_fds(&[file], &[source])?;
    let mut rules = String::from("static MESSAGE_FIELDS: &[(&str, &[(u32, &str)])] = &[\n");
    for file in &set.file {
        for message in &file.message_type {
            rules.push_str(&format!(
                "({:?}, &[",
                format!(".{}.{}", file.package(), message.name())
            ));
            for field in &message.field {
                if field.r#type() as i32 == 11 {
                    rules.push_str(&format!("({}, {:?}),", field.number(), field.type_name()));
                }
            }
            rules.push_str("]),\n");
        }
    }
    rules.push_str("];\n");
    fs::write(out.join("extension_rules.rs"), rules)?;
    config.compile_fds(set)?;
    Ok(())
}
