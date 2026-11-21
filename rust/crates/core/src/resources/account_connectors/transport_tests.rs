use super::{Failure, library::*};
use crate::cca::value::{Value, parse_json, stringify_json};

#[test]
fn private_transport_accepts_only_create_estuary_transfer_and_completion_posts() {
    for route in [
        "/files",
        "/files/process_upload_stream",
        "/estuary/upload_content_bytes?upload_url=x",
    ] {
        assert!(native_route("POST", route));
        assert!(!native_route("GET", route));
        assert!(!native_route("PUT", route));
    }
    for route in [
        "/files/library",
        "/files/",
        "/files?x=1",
        "/files/process_upload_stream#x",
        "//evil.invalid/files",
        "/estuary/content",
        "/estuary/upload_content_bytes/extra",
        "/estuary/upload_content_bytes?x=#fragment",
    ] {
        assert!(!native_route("POST", route));
    }
}

#[test]
fn signed_transfers_reject_credential_origin_port_fragment_and_host_escape() {
    for value in [
        "http://synthetic.blob.core.windows.net/file",
        "https://evil.invalid/file",
        "https://u:p@synthetic.blob.core.windows.net/file",
        "https://synthetic.blob.core.windows.net:8443/file",
        "https://synthetic.blob.core.windows.net/file#fragment",
        "https://synthetic.oaiusercontent.com.evil.invalid/file",
        "https://fake-oaiusercontent.com/file",
        "https://127.0.0.1/file",
        "https://[::1]/file",
        "/file",
    ] {
        assert!(signed_destination(value).is_err(), "{value}");
    }
    for value in [
        "https://synthetic.blob.core.windows.net/file?sig=synthetic",
        "https://synthetic.s3.amazonaws.com/file",
        "https://files.oaiusercontent.com/file",
        "https://sdmntpsynthetic.oaiusercontent.com/file",
    ] {
        assert!(signed_destination(value).is_ok());
    }
}

#[test]
fn estuary_upload_routes_normalize_only_the_exact_first_party_origin() {
    for prefix in [
        "/estuary/",
        "/backend-api/estuary/",
        "https://chatgpt.com/estuary/",
        "https://chatgpt.com/backend-api/estuary/",
    ] {
        assert_eq!(
            native_file_route(&format!("{prefix}upload_content_bytes?upload_url=x")),
            Some("/estuary/upload_content_bytes?upload_url=x".into())
        );
    }
    for value in [
        "https://evil.invalid/estuary/upload_content_bytes",
        "https://u:p@chatgpt.com/estuary/upload_content_bytes",
        "https://chatgpt.com:8443/estuary/upload_content_bytes",
        "/estuary/upload_content_bytes#x",
        "/estuary/upload_content_bytes/extra",
    ] {
        assert!(native_file_route(value).is_none());
    }
}

#[test]
fn exact_create_and_finalize_bodies_keep_private_upload_intent() {
    let body = create_body(&"report.txt".into(), &"text/plain".into(), 17);
    let Value::Object(map) = body else { panic!() };
    assert_eq!(map.len(), 13);
    assert_eq!(map.get(&"file_size".into()), Some(&Value::Number(17.0)));
    assert_eq!(
        map.get(&"store_in_library".into()),
        Some(&Value::Bool(true))
    );
    assert_eq!(
        map.get(&"supports_direct_azure_multipart".into()),
        Some(&Value::Bool(false))
    );
    assert_eq!(finalize_body(&"file-one".into(), &"report.txt".into(), &"text/plain".into()), parse_json(r#"{"entry_surface":"codex_library_upload","file_id":"file-one","file_name":"report.txt","index_for_retrieval":true,"library_persistence_mode":"opportunistic","metadata":{"store_in_library":true},"mime_type":"text/plain","upload_source":"codex_library_upload","use_case":"my_files"}"#).unwrap());
}

#[test]
fn completion_requires_matching_terminal_and_persisted_identity_with_lossless_receipt_name() {
    let valid = b"{\"event\":\"file.indexing.completed\",\"file_id\":\"file-one\",\"extra\":{\"metadata_object_id\":\"library-one\",\"library_file_name\":\"\\ud800\"}}\r\n{\"event\":\"file.processing.completed\",\"file_id\":\"file-one\"}\n";
    let result = completion(valid, &"file-one".into(), &"report.txt".into()).unwrap();
    assert!(stringify_json(&result).contains(r#""file_name":"\ud800""#));
    for bytes in [
        b"{\"event\":\"file.processing.completed\",\"file_id\":\"other\"}".as_slice(),
        b"{\"event\":\"file.processing.completed\",\"file_id\":\"file-one\"}".as_slice(),
        b"{\"event\":\"file.processing.completed\",\"file_id\":\"file-one\",\"extra\":{\"metadata_object_id\":\"library-one\",\"library_persistence_result\":\"temporary\"}}".as_slice(),
        b"{\"event\":\"file.processing.failed\",\"file_id\":\"other\"}".as_slice(),
        b"not-json".as_slice(),
    ] {
        assert!(matches!(completion(bytes, &"file-one".into(), &"report.txt".into()), Err(Failure::Uncertain)));
    }
    assert!(
        completion(
            &vec![b' '; RESPONSE_LIMIT + 1],
            &"file-one".into(),
            &"report.txt".into()
        )
        .is_err()
    );
}

#[test]
fn completion_rejects_library_ids_that_are_path_segments() {
    for id in [
        ".",
        "..",
        "https://evil.invalid",
        "file/other",
        "file%2Fother",
    ] {
        let bytes = format!(
            "{{\"event\":\"file.processing.completed\",\"file_id\":\"file-one\",\"extra\":{{\"metadata_object_id\":\"{id}\"}}}}\n"
        );
        assert!(matches!(
            completion(bytes.as_bytes(), &"file-one".into(), &"report.txt".into()),
            Err(Failure::Uncertain)
        ));
    }
    for id in ["library-one", "file.v1", "...", "a._:~-1"] {
        let bytes = format!(
            "{{\"event\":\"file.processing.completed\",\"file_id\":\"file-one\",\"extra\":{{\"metadata_object_id\":\"{id}\"}}}}\n"
        );
        assert!(completion(bytes.as_bytes(), &"file-one".into(), &"report.txt".into()).is_ok());
    }
}
