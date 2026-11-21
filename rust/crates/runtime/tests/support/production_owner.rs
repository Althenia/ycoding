use std::{
    cell::RefCell,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    rc::Rc,
};
use ycoding_core::ycoding_store::{Client, Store};
use ycoding_runtime::{Handle, ProductionOwner};

pub struct Host {
    pub owner: Handle,
    held: Rc<RefCell<Held>>,
}

#[derive(Default)]
struct Held {
    stores: Vec<Store>,
    roots: Vec<PathBuf>,
}

impl Host {
    pub fn retain(&self, store: Store, root: Option<&Path>) -> Client {
        let client = store.client();
        let mut held = self.held.borrow_mut();
        held.stores.push(store);
        if let Some(root) = root {
            held.roots.push(root.to_owned());
        }
        client
    }
}

pub fn run(body: impl for<'a> FnOnce(&'a Host) -> Pin<Box<dyn Future<Output = ()> + 'a>>) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let held = Rc::new(RefCell::new(Held::default()));
    let joined = ProductionOwner::scope(&runtime, |owner| {
        let host = Host {
            owner,
            held: held.clone(),
        };
        runtime.block_on(body(&host))
    });
    let owners = std::mem::take(&mut *held.borrow_mut());
    let errors = owners
        .stores
        .into_iter()
        .filter_map(|store| store.shutdown().err())
        .collect::<Vec<_>>();
    let roots = if joined.cleanup.failures.is_empty() && errors.is_empty() {
        owners
            .roots
            .into_iter()
            .filter_map(|root| std::fs::remove_dir_all(root).err())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    assert!(
        joined.cleanup.failures.is_empty() && errors.is_empty() && roots.is_empty(),
        "owner cleanup: {:?}; Store cleanup: {errors:?}; fixture cleanup: {roots:?}",
        joined.cleanup.failures
    );
    if let Err(panic) = joined.body {
        std::panic::resume_unwind(panic);
    }
}
