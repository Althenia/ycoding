use std::path::PathBuf;
use ycoding_schema::{LosslessString, project, project_artifact};

#[derive(Clone, Debug, PartialEq)]
pub struct StandardSource {
    pub scope: LosslessString,
    pub managed_scope_id: Option<project_artifact::ScopeId>,
    pub managed_version_id: Option<project_artifact::VersionId>,
    pub managed_digest: Option<project_artifact::Digest>,
}
#[derive(Clone)]
pub struct Record {
    pub source: StandardSource,
    pub project_id: Option<project::Id>,
    pub kind: project_artifact::Kind,
    pub id: project_artifact::Id,
    pub path: Option<PathBuf>,
}
#[derive(Default)]
pub struct Registry {
    snapshots: Vec<(String, Vec<Record>)>,
}
impl Registry {
    pub fn replace(&mut self, location: String, records: Vec<Record>) {
        if let Some(snapshot) = self
            .snapshots
            .iter_mut()
            .find(|snapshot| snapshot.0 == location)
        {
            snapshot.1 = records;
            return;
        }
        self.snapshots.push((location, records));
    }
    pub fn remove(&mut self, location: &str) {
        self.snapshots.retain(|snapshot| snapshot.0 != location);
    }
    pub fn size(&self) -> usize {
        self.snapshots.len()
    }
    pub fn resolve(
        &self,
        scope: &str,
        project_id: Option<&project::Id>,
        kind: &project_artifact::Kind,
        id: &project_artifact::Id,
    ) -> Vec<StandardSource> {
        let mut result = Vec::new();
        for record in self
            .snapshots
            .iter()
            .flat_map(|snapshot| &snapshot.1)
            .filter(|record| {
                record.source.scope.as_str() == Some(scope)
                    && &record.kind == kind
                    && &record.id == id
                    && (scope == "global" || record.project_id.as_ref() == project_id)
            })
        {
            if !result.contains(&record.source) {
                result.push(record.source.clone());
            }
        }
        result
    }
}
