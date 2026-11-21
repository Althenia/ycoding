#[path = "../shell/paging.rs"]
pub mod paging;
#[path = "../process/mod.rs"]
pub mod process;
#[path = "windows.rs"]
pub mod windows;
pub mod shell {
    pub use crate::paging;
}
pub mod platform {
    pub use crate::process;
}
