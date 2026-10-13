use super::unavailable;
use crate::dispatch::Failure;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use ycoding_core::{
    meeting::{
        config::{AnalysisModel, MeetingConfig},
        discovery,
        intelligence::ServiceMcp,
        runtime::SessionFactory,
        service::{MeetingService, ServiceOptions, saved_config},
        store::MeetingDatabase,
    },
    resources::{config::Roots, mcp},
    session::{
        analysis::{Analysis, Generator},
        execution::Execution,
        store::Service,
    },
    ycoding_schema::{DomainDecode, LosslessString, ObjectEncoder, location, model, project},
    ycoding_store::Client,
};

type Key = (LosslessString, Option<LosslessString>);

pub(super) struct Meetings {
    enabled: bool,
    entries: tokio::sync::Mutex<Option<BTreeMap<Key, Meeting>>>,
}

struct Meeting {
    service: MeetingService,
    analysis: Arc<Analysis>,
    mcp: Arc<ServiceMcp>,
}

pub(super) struct Attached {
    pub analysis: Arc<Analysis>,
    pub database: MeetingDatabase,
}

pub(super) struct Target<'a> {
    pub reference: location::Ref,
    pub project: project::Id,
    pub directory: &'a Path,
    pub mcp: Arc<mcp::Service>,
}

impl Meetings {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            entries: tokio::sync::Mutex::new(Some(BTreeMap::new())),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub async fn attach(
        &self,
        client: &Client,
        roots: &Roots,
        data_home: Option<&Path>,
        target: Target<'_>,
    ) -> Option<Attached> {
        if !self.enabled {
            return None;
        }
        let mut entries = self.entries.lock().await;
        let entries = entries.as_mut()?;
        let key = (
            target.reference.directory.as_lossless().clone(),
            target
                .reference
                .workspace_id
                .as_ref()
                .map(|id| id.as_lossless().clone()),
        );
        if let Some(meeting) = entries.get(&key) {
            meeting.mcp.replace(target.mcp);
            return Some(meeting.attached());
        }
        match start(client, roots, data_home, target).await {
            Ok(meeting) => {
                let attached = meeting.attached();
                entries.insert(key, meeting);
                Some(attached)
            }
            Err(error) => {
                tracing::error!(%error, "Meeting runtime failed to start for this Location");
                None
            }
        }
    }

    pub async fn shutdown(&self) -> Result<(), Failure> {
        let entries = self.entries.lock().await.take().unwrap_or_default();
        let mut failure = None;
        for meeting in entries.into_values() {
            if let Err(error) = meeting.service.shutdown().await {
                tracing::error!(%error, "Meeting runtime shutdown failed");
                failure.get_or_insert_with(|| unavailable("Meeting runtime shutdown"));
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

impl Meeting {
    fn attached(&self) -> Attached {
        Attached {
            analysis: self.analysis.clone(),
            database: self.service.runtime().database().clone(),
        }
    }
}

async fn start(
    client: &Client,
    roots: &Roots,
    data_home: Option<&Path>,
    target: Target<'_>,
) -> Result<Meeting, String> {
    let execution = Execution::global().ok_or("Session execution is not installed")?;
    let directory: PathBuf = discovery::directory(target.directory, data_home, &roots.home)
        .map_err(|error| error.to_string())?;
    let config = saved_config(
        &directory,
        MeetingConfig::defaults().map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let analysis = Analysis::new(config.analysis.max_characters as usize);
    let model = match &config.analysis.model {
        AnalysisModel::Inherit => None,
        AnalysisModel::Explicit {
            id,
            provider_id,
            variant,
            profile,
        } => Some(
            model::Ref::decode(
                &ObjectEncoder::new()
                    .field("id", id.as_str())
                    .field("providerID", provider_id.as_str())
                    .optional("variant", &variant.as_deref().map(LosslessString::from))
                    .optional("profile", &profile.as_deref().map(LosslessString::from))
                    .finish(),
            )
            .map_err(|error| error.to_string())?,
        ),
    };
    let generator = Arc::new(Generator::new(
        Service::new(client.clone()),
        execution.coordinator().clone(),
        analysis.clone(),
        target.reference,
        target.project,
        model,
    ));
    let sessions = generator.clone();
    let create_session: SessionFactory = Arc::new(move |parent| {
        let generator = sessions.clone();
        Box::pin(async move { generator.create_session(parent.as_deref()).await })
    });
    let mcp = Arc::new(ServiceMcp::shared(target.mcp));
    let mut options = ServiceOptions::new(directory, config, create_session);
    options.generator = Some(generator);
    options.analysis = Some(analysis.clone());
    options.mcp = Some(mcp.clone());
    let service = MeetingService::start(options)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Meeting {
        service,
        analysis,
        mcp,
    })
}
