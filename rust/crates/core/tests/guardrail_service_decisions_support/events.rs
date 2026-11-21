impl Harness {
    pub async fn event(&self, kind: &str) -> ycoding_schema::JsonValue {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut events = self._events.lock().await;
            loop {
                let event = events
                    .recv()
                    .await
                    .expect("publisher closed before settlement");
                if event.type_ == kind {
                    return event.data;
                }
            }
        })
        .await
        .expect("service did not publish the expected boundary event")
    }
}
