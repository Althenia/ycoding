use ycoding_store::{Catalog, Error, Metadata, Options, Store};

fn main() {
    const { assert!(cfg!(panic = "unwind")) };
    let store = Store::disposable(
        Options {
            cache_bytes: 4 * 1024 * 1024,
            ..Options::core()
        },
        Catalog::EMPTY,
        Metadata::new([1; 16], 1),
    )
    .unwrap();
    let result = store
        .submit::<(), _>(|_| panic!("synthetic release writer recovery check"))
        .unwrap()
        .wait();
    assert!(matches!(result, Err(Error::WriterPanicked)));
    assert!(store.is_fenced());
    assert!(matches!(store.submit(|_| Ok(())), Err(Error::WriterFenced)));
    store.shutdown().unwrap();
    println!("production_store_release_recovery=ok; writer_fenced=true; shutdown_joined=true");
}
