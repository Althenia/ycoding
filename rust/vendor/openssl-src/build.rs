fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_PATH").expect("Cargo sets CARGO_MANIFEST_PATH");
    println!("cargo:rerun-if-changed={manifest}");
}
