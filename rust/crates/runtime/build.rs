fn main() {
    println!("cargo:rerun-if-env-changed=YCODING_BUNDLED_MODELS_PATH");
    let path = std::env::var_os("YCODING_BUNDLED_MODELS_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
                .join("../../../packages/cli/script/models-dev.snapshot.json")
        });
    println!("cargo:rerun-if-changed={}", path.display());
    let text = std::fs::read_to_string(path).expect("bundled model catalog must be readable UTF-8");
    std::fs::write(
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("bundled_models.rs"),
        format!("const BUNDLED_MODELS: &str = {text:?};"),
    )
    .expect("bundled model catalog source must be writable");
    regex_metadata();
}

fn regex_metadata() {
    let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.join("../../..");
    let script = root.join("packages/cli/script/regex-worker-metadata.ts");
    for path in [
        script.clone(),
        root.join("packages/codemode/src/internal/regex-process.ts"),
        root.join("packages/codemode/src/interpreter/regex-runtime.ts"),
        manifest.join("src/regex_worker.rs"),
    ] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rerun-if-env-changed=PATH");
    let output = std::process::Command::new("bun")
        .arg(script)
        .current_dir(root)
        .output()
        .expect("installed Bun is required to read the native regex recipe metadata");
    assert!(
        output.status.success() && output.stderr.is_empty(),
        "native regex recipe metadata command failed"
    );
    let receipt =
        std::str::from_utf8(&output.stdout).expect("native regex recipe metadata must be UTF-8");
    let (sha256, bytes) = parse_regex_metadata(receipt)
        .expect("native regex recipe metadata must contain exactly a SHA-256 and byte length");
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    std::fs::write(
        out.join("regex_worker_metadata.rs"),
        format!(
            "const REGEX_RECIPE_SHA256: &str = {sha256:?};\nconst REGEX_RECIPE_BYTES: usize = {bytes};\n"
        ),
    )
    .expect("native regex recipe constants must be writable");
    std::fs::write(out.join("regex_worker.metadata"), receipt)
        .expect("native regex recipe metadata receipt must be writable");
}

fn parse_regex_metadata(receipt: &str) -> Option<(&str, usize)> {
    let (sha256, length) = receipt.strip_suffix('\n')?.split_once('\n')?;
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || length.is_empty()
        || !length.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let length = length.parse().ok()?;
    (length != 0).then_some((sha256, length))
}

#[cfg(test)]
mod tests {
    use super::parse_regex_metadata;

    #[test]
    fn metadata_requires_exact_lowercase_digest_and_nonzero_decimal_bytes() {
        let digest = "0123456789abcdef".repeat(4);
        let receipt = format!("{digest}\n1234\n");
        assert_eq!(
            parse_regex_metadata(&receipt),
            Some((digest.as_str(), 1234))
        );
        for receipt in [
            String::new(),
            format!("{digest}\n1234"),
            format!("{digest}\n1234\n\n"),
            format!("{}\n1234\n", digest.to_ascii_uppercase()),
            format!("{}\n1234\n", &digest[..63]),
            format!("g{}\n1234\n", &digest[1..]),
            format!("{digest}\n\n"),
            format!("{digest}\n0\n"),
            format!("{digest}\n+1\n"),
            format!("{digest}\n-1\n"),
            format!("{digest}\n 1\n"),
            format!("{digest}\n{}0\n", usize::MAX),
            format!("{digest}\r\n1234\r\n"),
        ] {
            assert_eq!(parse_regex_metadata(&receipt), None);
        }
    }
}
