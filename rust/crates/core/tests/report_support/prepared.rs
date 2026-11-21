use ycoding_core::ycoding_store::{Client, analytics, usage_cells};

pub fn publish(client: &Client, views: &ycoding_core::usage_view::Service) {
    while !usage_cells::maintain(client).unwrap() {}
    let handle = client.analytics().unwrap();
    while handle.maintain().unwrap() == analytics::Maintenance::Pending {}
    assert!(views.publish().unwrap());
    let _ = views.read_prepared(&[]).unwrap();
    handle.prepare_presentations().unwrap();
}
