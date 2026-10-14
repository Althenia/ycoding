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
}
