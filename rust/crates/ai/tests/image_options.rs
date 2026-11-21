use ycoding_ai::{
    auth::Auth,
    image::{Config, Kind, Model, Request},
};
use ycoding_schema::parse_json;

#[test]
fn raw_native_alias_replacement_is_shallow_before_recursive_http_overlays() {
    let mut request = Request::new(
        Model::new("model", Kind::Xai, Config::new(Auth::None)),
        "test",
    );
    request.options =
        parse_json(r#"{"aspectRatio":{"alias":1},"aspect_ratio":{"native":2}}"#).unwrap();
    request.http.body = Some(parse_json(r#"{"aspect_ratio":{"http":3}}"#).unwrap());
    assert_eq!(
        std::str::from_utf8(&request.model.prepare(&request).unwrap().body).unwrap(),
        r#"{"model":"model","prompt":"test","aspect_ratio":{"native":2,"http":3}}"#
    );
}
