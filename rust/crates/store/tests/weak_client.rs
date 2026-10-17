use ycoding_store::{Catalog, Metadata, Options, Store};

const CATALOG: Catalog = Catalog::new(1, &[]);

fn store(identity: u8) -> Store {
    Store::disposable(Options::core(), CATALOG, Metadata::new([identity; 16], 1)).unwrap()
}

#[test]
fn a_weak_client_upgrades_to_the_store_it_was_taken_from() {
    let store = store(1);
    let client = store.client();
    let weak = client.downgrade();

    assert!(weak.refers_to(&client));
    assert!(weak.refers_to(&store.client()));
    assert!(weak.upgrade().unwrap().snapshot().is_ok());
    assert!(weak.clone().refers_to(&weak.upgrade().unwrap()));
}

#[test]
fn a_weak_client_never_refers_to_another_store() {
    let (first, second) = (store(1), store(1));
    let weak = first.client().downgrade();

    assert!(!weak.refers_to(&second.client()));
    assert!(!second.client().downgrade().refers_to(&first.client()));
}

#[test]
fn a_weak_client_does_not_keep_the_store_alive() {
    let store = store(1);
    let weak = store.client().downgrade();
    assert!(weak.upgrade().is_some());

    store.shutdown().unwrap();

    assert!(weak.upgrade().is_none());
}

#[test]
fn a_weak_client_upgrades_while_any_client_clone_lives_and_not_after() {
    let store = store(1);
    let client = store.client();
    let weak = client.downgrade();
    drop(store);

    assert!(weak.upgrade().is_some());
    assert!(weak.refers_to(&client));

    drop(client);

    assert!(weak.upgrade().is_none());
}

#[test]
fn a_dead_weak_client_never_refers_to_a_later_store() {
    let dead = {
        let store = store(1);
        store.client().downgrade()
    };
    let later = store(1);

    assert!(dead.upgrade().is_none());
    assert!(!dead.refers_to(&later.client()));
}
