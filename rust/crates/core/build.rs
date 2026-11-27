use std::{env, fs, path::PathBuf, process::Command};

fn link_clang_runtime() -> Result<(), Box<dyn std::error::Error>> {
    if env::var("CARGO_CFG_TARGET_OS")? != "macos" {
        return Ok(());
    }
    let output = Command::new("cc").arg("--print-resource-dir").output()?;
    if !output.status.success() {
        return Err("cc --print-resource-dir failed".into());
    }
    let resource = String::from_utf8(output.stdout)?;
    println!(
        "cargo:rustc-link-search=native={}/lib/darwin",
        resource.trim()
    );
    println!("cargo:rustc-link-lib=clang_rt.osx");
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    link_clang_runtime()?;
    let source = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join("../../../protocol");
    let file = source.join("ycoding/extension/v5/extension.proto");
    println!("cargo:rerun-if-changed={}", file.display());
    println!("cargo:rerun-if-env-changed=PROTOC");
    let mut config = prost_build::Config::new();
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
