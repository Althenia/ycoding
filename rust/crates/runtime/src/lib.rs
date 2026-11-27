mod auth;
mod autonomy_defaults;
mod browser;
mod browser_convert;
mod browser_stream;
mod catalog_convert;
mod catalog_ops;
mod config_ops;
mod connection;
pub mod connector;
mod convert;
mod coordination;
mod credential;
mod cursor;
mod decision;
mod dispatch;
pub mod dots;
mod ephemeral;
mod event_subscribe;
#[cfg(test)]
#[path = "../../core/tests/filesystem_fixture.rs"]
mod filesystem_fixture;
mod form;
mod fs;
mod goal_decisions;
mod guardrail;
mod handlers;
mod health;
mod ids;
mod incident;
mod integration;
mod integration_convert;
mod interaction;
mod isolated_browser;
mod keep_awake;
pub mod launch;
mod location_ops;
mod locations;
mod log;
mod mcp;
mod mcp_convert;
mod message;
mod permission;
mod platform_services;
mod production;
mod project;
mod project_copy;
mod prompt_attachments;
mod provider_usage;
mod pty;
mod pty_stream;
mod question;
pub mod regex_worker;
mod remote_derived;
mod server;
mod services;
mod session_attachment;
mod session_attachment_upload;
mod session_autonomy;
mod session_create;
mod session_helpers;
mod session_ingress;
mod session_list;
mod session_outstanding;
mod session_placement;
mod session_read_models;
mod session_revert;
mod session_review;
mod session_services;
mod session_state;
mod session_subagent;
mod shell;
mod telemetry;
mod usage;
mod usage_accounting;
mod usage_dashboard;
mod vcs;

pub use auth::LocalAuth;
pub use dispatch::{Boxed, Bulk, Dispatcher, Failure, Invocation, RegistrationError, Settled};
pub use handlers::standard;
pub use locations::{
    Configuration, HelperEnvironment, HelperProvider, LocationServices, Locations, ServiceSet,
    SnapshotSettings,
};
pub use production::owner::{Handle, Joined, OwnerFailure, ProductionOwner, Report};
pub use production::{Composed, Cursor, Production};
pub use server::{Server, serve, serve_with};
pub use services::{
    CatalogProvider, CatalogServices, CatalogTask, Core, DestinationServices, Environment,
    Identity, IsolatedBrowserResolver, PlatformResolver, PlatformServices, ProviderUsageResolver,
    ProviderUsageServices, Services, SessionServices, Subscriptions,
};
pub use services::{IntegrationResolver, IntegrationServices, McpResolver};
pub use session_attachment_upload::{Appended, Clock, Piece, Staging};
