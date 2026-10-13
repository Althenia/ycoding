use std::fmt;

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Storage(redb::Error),
    CommitUncertain(redb::CommitError),
    RollbackFailed(redb::StorageError),
    InvalidConfiguration(&'static str),
    Incompatible(&'static str),
    UnregisteredTable(&'static str),
    UnregisteredIndex,
    UniqueViolation {
        index: &'static str,
    },
    TransactionAborted,
    QueueFull,
    SnapshotLimit,
    WriterFenced,
    WriterPanicked,
    Closed,
    Reentrant,
    Rejected(&'static str),
    Domain {
        kind: &'static str,
        message: &'static str,
    },
    Record(Box<dyn std::error::Error + Send + Sync>),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "store IO: {error}"),
            Self::Storage(error) => write!(f, "redb: {error}"),
            Self::CommitUncertain(error) => write!(
                f,
                "commit outcome uncertain; reopen and reconcile before mutation: {error}"
            ),
            Self::RollbackFailed(error) => write!(f, "rollback failed; writer fenced: {error}"),
            Self::InvalidConfiguration(reason) => {
                write!(f, "invalid store configuration: {reason}")
            }
            Self::Incompatible(reason) => write!(f, "incompatible storage: {reason}"),
            Self::UnregisteredTable(name) => write!(f, "unregistered table: {name}"),
            Self::UnregisteredIndex => f.write_str("unregistered index"),
            Self::UniqueViolation { index } => write!(f, "uniqueness violation: {index}"),
            Self::TransactionAborted => f.write_str("transaction aborted after a failed operation"),
            Self::QueueFull => f.write_str("storage request queue full"),
            Self::SnapshotLimit => f.write_str("read snapshot limit reached"),
            Self::WriterFenced => {
                f.write_str("writer fenced; close, reopen and reconcile before mutation")
            }
            Self::WriterPanicked => f.write_str("writer operation panicked; writer fenced"),
            Self::Closed => f.write_str("store closed"),
            Self::Reentrant => f.write_str("cannot wait for storage on its writer thread"),
            Self::Rejected(reason) => write!(f, "transaction rejected: {reason}"),
            Self::Domain { kind, message } => write!(f, "domain rejection ({kind}): {message}"),
            Self::Record(error) => write!(f, "record codec: {error}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Storage(error) => Some(error),
            Self::CommitUncertain(error) => Some(error),
            Self::RollbackFailed(error) => Some(error),
            Self::Record(error) => Some(error.as_ref()),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

macro_rules! storage_error {
    ($($error:ty),+ $(,)?) => { $(
        impl From<$error> for Error {
            fn from(error: $error) -> Self { Self::Storage(error.into()) }
        }
    )+ };
}
storage_error!(
    redb::DatabaseError,
    redb::StorageError,
    redb::TableError,
    redb::TransactionError,
    redb::SetDurabilityError
);
