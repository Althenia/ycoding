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
    snapshots: Vec<(String, Vec<(u64, Vec<Record>)>)>,
    generation: u64,
}
impl Registry {
    pub fn replace(&mut self, location: String, records: Vec<Record>) -> u64 {
        self.generation += 1;
        let owner = self.generation;
        if let Some(snapshot) = self
            .snapshots
            .iter_mut()
            .find(|snapshot| snapshot.0 == location)
        {
            snapshot.1.push((owner, records));
            return owner;
        }
        self.snapshots.push((location, vec![(owner, records)]));
        owner
    }
    pub fn update(&mut self, location: &str, owner: u64, records: Vec<Record>) {
        if let Some(snapshot) = self
            .snapshots
            .iter_mut()
            .find(|snapshot| snapshot.0 == location)
            && let Some(entry) = snapshot.1.iter_mut().find(|entry| entry.0 == owner)
        {
            entry.1 = records;
        }
    }
    pub fn remove_owner(&mut self, location: &str, owner: u64) {
        if let Some(snapshot) = self
            .snapshots
            .iter_mut()
            .find(|snapshot| snapshot.0 == location)
        {
            snapshot.1.retain(|entry| entry.0 != owner);
        }
        self.snapshots.retain(|snapshot| !snapshot.1.is_empty());
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
            .flat_map(|snapshot| snapshot.1.last().into_iter().flat_map(|entry| &entry.1))
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
