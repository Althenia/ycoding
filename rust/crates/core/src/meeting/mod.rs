pub mod ask;
mod assets;
pub mod audio;
pub mod bridge;
pub mod client;
pub mod config;
pub mod discovery;
pub mod history;
pub mod intelligence;
pub mod pcm;
pub mod runtime;
pub mod service;
pub mod store;
pub mod transcription;

use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
