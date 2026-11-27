use crate::resources::recall::hybrid::Retriever;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Default)]
pub(super) struct Cache {
    current: Option<(PathBuf, Arc<Retriever>)>,
}

impl Cache {
    pub fn retriever(&mut self, directory: &Path) -> Arc<Retriever> {
        match &self.current {
            Some((path, retriever)) if path == directory => retriever.clone(),
            _ => {
                let retriever = Arc::new(Retriever::open(
                    Some(directory.join("tantivy-v1")),
                    None,
                    Default::default(),
                ));
                self.current = Some((directory.to_owned(), retriever.clone()));
                retriever
            }
        }
    }
}
