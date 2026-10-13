#[allow(clippy::large_enum_variant)]
pub mod v5 {
    include!(concat!(env!("OUT_DIR"), "/ycoding.v5.rs"));
}
include!(concat!(env!("OUT_DIR"), "/digest.rs"));
include!(concat!(env!("OUT_DIR"), "/operations.rs"));
include!(concat!(env!("OUT_DIR"), "/role_allowlists.rs"));
include!(concat!(env!("OUT_DIR"), "/domain_obligations.rs"));
pub mod connection;
mod field_constraints;
mod validate;
pub use validate::limits;
pub use validate::{
    WireConnection, WireError, decode_lossless, decode_strict, encode_lossless, validate_binary,
};
