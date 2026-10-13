use ycoding_ai::{
    framing::Sse,
    llm::{Request, Response},
    muse::{Connection, Runtime},
};
use ycoding_schema::parse_json;

#[test]
fn muse_one_byte_utf8_crlf_quota_does_not_change_model_events() {
    let runtime = Runtime::new("http://127.0.0.1:1/key".into()).unwrap();
    let route = ycoding_ai::muse::route(Connection::key(
        runtime.clone(),
        "fixture".into(),
        ycoding_ai::muse::BASE_URL.into(),
        None,
    ));
    let request = Request::new(route.model("muse-wonder-1.0"));
    let mut parser = route.protocol.parser(&request.resolved());
    let mut sse = Sse::default();
    let mut events = vec![];
    let stream = concat!(
        "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg\",\"delta\":\"こんにちは\"}\r\n\r\n",
        "data: {\"type\":\"response.completed\",\"response\":{}}\r\n\r\n",
        "data: {\"type\":\"response.subscription_usage\",\"subscription\":{\"window\":{\"used_percent\":\"private invalid value\"}}}\r\n\r\n",
    );
    for byte in stream.bytes() {
        for frame in sse.push(&[byte]) {
            events.extend(parser.push(&parse_json(&frame).unwrap()).unwrap());
        }
    }
    events.extend(parser.finish().unwrap());
    assert_eq!(
        Response::from_events(events).unwrap().text().as_str(),
        Some("こんにちは")
    );
    assert!(runtime.observation(None).is_none());
}
