use std::{env, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let include = PathBuf::from(
        env::var_os("DEP_DUCKDB_INCLUDE").ok_or("bundled DuckDB include metadata is required")?,
    );
    if !include.join("duckdb.hpp").is_file() {
        return Err("bundled DuckDB headers are unavailable".into());
    }
    println!("cargo:rerun-if-env-changed=DEP_DUCKDB_INCLUDE");
    println!("cargo:rerun-if-changed=src/analytics/numeric.cpp");
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .include(include)
        .file("src/analytics/numeric.cpp")
        .define("DUCKDB_STATIC_BUILD", None)
        .flag_if_supported("-std=c++11")
        .flag_if_supported("/utf-8")
        .flag_if_supported("/bigobj");
    if env::var("CARGO_CFG_TARGET_ENV")? == "msvc" {
        build.flag("/EHsc");
    }
    let debug = env::var("DEBUG").is_ok_and(|value| value != "false" && value != "0");
    if !debug {
        build.define("NDEBUG", None);
    }
    build.compile("ycoding_decimal_state");
    Ok(())
}
