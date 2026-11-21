use std::io::{Read, Write};
use ycoding_core::tools::builtin::http_body;

async fn fetch_response(wire: Vec<u8>) -> (reqwest::Response, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        assert!(socket.read(&mut request).unwrap() > 0);
        let _ = socket.write_all(&wire);
    });
    (
        reqwest::Client::new()
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap(),
        server,
    )
}

#[tokio::test]
async fn declared_and_streamed_byte_limits_are_enforced() {
    let (response, server) = fetch_response(
        b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n12345678".to_vec(),
    )
    .await;
    assert_eq!(
        http_body::collect(response, 4).await.unwrap_err(),
        http_body::Error::TooLarge
    );
    server.join().unwrap();
    let (response, server) = fetch_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\none\r\n3\r\ntwo\r\n0\r\n\r\n".to_vec()).await;
    assert_eq!(
        http_body::collect(response, 4).await.unwrap_err(),
        http_body::Error::TooLarge
    );
    server.join().unwrap();
    let (response, server) = fetch_response(
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n1234".to_vec(),
    )
    .await;
    assert_eq!(http_body::collect(response, 4).await.unwrap(), b"1234");
    server.join().unwrap();
}

#[test]
fn declared_size_uses_decimal_parse_int_and_safe_integer_contract() {
    for (header, expected) in [
        ("  +123junk", Some(123)),
        ("0xFF", Some(0)),
        ("-1", None),
        ("9007199254740992", None),
        ("garbage", None),
        ("1e9", Some(1)),
    ] {
        assert_eq!(http_body::declared_size(header), expected);
    }
}
