use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Diagnostic {
    CredentialUnavailable,
    EnrollmentFailed,
    EnrollmentRejected,
    EnrollmentUncertain,
    EnrollmentUnreadable,
    EnrollmentAccountMismatch,
    RegistrationRejected,
    Connected,
    ConnectionFailed,
    ConnectionDropped,
    ScopeUnavailable,
    ChannelOpened,
    ChannelFailed,
    RegistrationExecutorChanged,
    RegistrationRenameExecutorChanged,
    RegistrationRenameUnconfirmed,
    RegistrationUpdateFailed,
    CleanupFailed,
}

impl Diagnostic {
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::CredentialUnavailable => "credential-unavailable",
            Self::EnrollmentFailed => "enrollment-failed",
            Self::EnrollmentRejected => "enrollment-rejected",
            Self::EnrollmentUncertain => "enrollment-uncertain",
            Self::EnrollmentUnreadable => "enrollment-unreadable",
            Self::EnrollmentAccountMismatch => "enrollment-account-mismatch",
            Self::RegistrationRejected => "registration-rejected",
            Self::Connected => "connected",
            Self::ConnectionFailed => "connection-failed",
            Self::ConnectionDropped => "connection-dropped",
            Self::ScopeUnavailable => "scope-unavailable",
            Self::ChannelOpened => "channel-opened",
            Self::ChannelFailed => "channel-failed",
            Self::RegistrationExecutorChanged => "registration-executor-changed",
            Self::RegistrationRenameExecutorChanged => "registration-rename-executor-changed",
            Self::RegistrationRenameUnconfirmed => "registration-rename-unconfirmed",
            Self::RegistrationUpdateFailed => "registration-update-failed",
            Self::CleanupFailed => "cleanup-failed",
        }
    }

    pub(super) fn rejection(category: &str) -> Self {
        match category {
            "enrollment-rejected" => Self::EnrollmentRejected,
            "enrollment-uncertain" => Self::EnrollmentUncertain,
            "enrollment-unreadable" => Self::EnrollmentUnreadable,
            "enrollment-account-mismatch" => Self::EnrollmentAccountMismatch,
            _ => Self::EnrollmentFailed,
        }
    }

    pub(super) fn note(note: &str) -> Option<Self> {
        match note {
            "registration-executor-changed" => Some(Self::RegistrationExecutorChanged),
            "registration-update-failed" => Some(Self::RegistrationUpdateFailed),
            _ => None,
        }
    }
}

pub(crate) type Sink = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Diagnostics(Sink);

impl Diagnostics {
    pub(crate) fn new(sink: Sink) -> Self {
        Self(sink)
    }

    pub(crate) fn report(&self, diagnostic: Diagnostic) {
        (self.0)(&format!("CCA executor {}", diagnostic.name()));
    }

    pub(super) fn report_detail(&self, diagnostic: Diagnostic, detail: &str) {
        (self.0)(&format!("CCA executor {} {detail}", diagnostic.name()));
    }

    pub(super) fn line(&self, line: &str) {
        (self.0)(line);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum End {
    Channel,
    Connection,
    Failed,
}

impl End {
    const fn name(self) -> &'static str {
        match self {
            Self::Channel => "channel",
            Self::Connection => "connection",
            Self::Failed => "failed",
        }
    }
}

pub(crate) const SUMMARY_ENTRIES: usize = 64;

#[derive(Default)]
struct Entries {
    shown: Vec<String>,
    omitted: usize,
}

#[derive(Clone, Default)]
pub(crate) struct Summary(Arc<Mutex<Entries>>);

impl Summary {
    pub(crate) fn received(&self, method: &str, resume_requested: bool) {
        let resume = if resume_requested { "(resume)" } else { "" };
        self.push(format!(">{method}{resume}"));
    }

    pub(crate) fn responded(&self, method: &str, outcome: &str) {
        self.push(format!("<{method}={outcome}"));
    }

    pub(crate) fn notified(&self, method: &str, outcome: &str) {
        if outcome == "notification" {
            self.push(format!("~{method}"));
        } else {
            self.push(format!("~{method}={outcome}"));
        }
    }

    fn push(&self, entry: String) {
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if entries.shown.len() < SUMMARY_ENTRIES {
            entries.shown.push(entry);
        } else {
            entries.omitted += 1;
        }
    }

    pub(super) fn line(&self, end: End) -> String {
        let entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let rpc = if entries.shown.is_empty() {
            "-".to_owned()
        } else {
            entries.shown.join(",")
        };
        let omitted = if entries.omitted == 0 {
            String::new()
        } else {
            format!(" omitted={}", entries.omitted)
        };
        format!(
            "CCA executor channel-summary end={} rpc={rpc}{omitted}",
            end.name()
        )
    }
}
