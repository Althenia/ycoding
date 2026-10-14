use ycoding_ai::{
    auth::Auth,
    image::{Config, Kind, Model, Request},
};
use ycoding_schema::parse_json;

#[test]
fn raw_native_alias_replacement_is_shallow_before_recursive_http_overlays() {
    let mut request = Request::new(
        Model::new("model", Kind::OpenAI, Config::new(Auth::None)),
        "test",
    );
    request.options =
        parse_json(r#"{"outputFormat":{"alias":1},"output_format":{"native":2}}"#).unwrap();
    request.http.body = Some(parse_json(r#"{"output_format":{"http":3}}"#).unwrap());
    assert_eq!(
        std::str::from_utf8(&request.model.prepare(&request).unwrap().body).unwrap(),
        r#"{"model":"model","prompt":"test","output_format":{"native":2,"http":3}}"#
    );
}
