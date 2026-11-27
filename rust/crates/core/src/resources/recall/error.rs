#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("retrieval index unavailable: {0}")]
    Index(String),
    #[error("another process holds the index writer")]
    Busy,
    #[error("index update exceeded its deadline")]
    Deadline,
    #[error("embedding model unavailable: {0}")]
    Model(String),
    #[error("model provisioning failed: {0}")]
    Provision(String),
}

impl From<tantivy::TantivyError> for Error {
    fn from(error: tantivy::TantivyError) -> Self {
        Self::Index(error.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Index(error.to_string())
    }
}

impl From<tantivy::directory::error::OpenDirectoryError> for Error {
    fn from(error: tantivy::directory::error::OpenDirectoryError) -> Self {
        Self::Index(error.to_string())
    }
}
