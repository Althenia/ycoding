pub mod boundary;
pub mod bridged;
pub mod electron;
pub mod macos;
pub mod service;
pub mod types;

pub type Future<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;
