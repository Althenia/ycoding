use std::time::Duration;
use ycoding_core::platform::pty::{
    protocol::{self, ControlFrame, ServerFrame},
    ticket::{Scope, Tickets},
};
use ycoding_schema::{DomainDecode, JsonValue, pty::Access, session_id::SessionId};
#[test]
fn tagged_frames_utf8_bounds_and_replay_chunks() {
    let control = ControlFrame::Replay {
        generation: 1,
        start_offset: 10,
        end_offset: 20,
        gap: false,
    };
    assert_eq!(
        protocol::decode_server_frame(&protocol::control_frame(&control)),
        Some(ServerFrame::Control(control))
    );
    assert_eq!(
        protocol::decode_server_frame(&protocol::data_frame(&[0, 255, 1])),
        Some(ServerFrame::Data(vec![0, 255, 1]))
    );
    assert!(protocol::decode_server_frame(b"\0{\"type\":\"replay\",\"generation\":0}").is_none());
    assert!(protocol::decode_server_frame(&[0, 255]).is_none());
    assert!(protocol::decode_input(&[255]).is_none());
    assert!(protocol::decode_input(&vec![b'x'; 65536]).is_some());
    assert!(protocol::decode_input(&vec![b'x'; 65537]).is_none());
    let chunks = protocol::chunks(&vec![0; 65537], 10);
    assert_eq!(chunks.len(), 2);
    assert_eq!(
        (chunks[1].start_offset, chunks[1].end_offset),
        (65546, 65547)
    );
}
#[test]
fn tickets_are_one_use_scope_bound_and_expiring() {
    let scope = Scope {
        pty_id: ycoding_schema::pty::Id::decode(&JsonValue::String("pty_test".into())).unwrap(),
        session_id: SessionId::new("ses_test").unwrap(),
        access: Access::Control,
        generation: 1,
        fence: Some(2),
        directory: Some("/synthetic".into()),
        workspace_id: None,
    };
    let mut tickets = Tickets::new(Duration::from_secs(60));
    let token = tickets.issue(scope.clone()).unwrap();
    let mut wrong = scope.clone();
    wrong.fence = Some(3);
    assert!(!tickets.consume(&token.ticket.to_utf8().unwrap(), &wrong));
    assert!(tickets.consume(&token.ticket.to_utf8().unwrap(), &scope));
    assert!(!tickets.consume(&token.ticket.to_utf8().unwrap(), &scope));
    let mut expired = Tickets::new(Duration::ZERO);
    let token = expired.issue(scope.clone()).unwrap();
    assert!(!expired.consume(&token.ticket.to_utf8().unwrap(), &scope));
}
#[test]
fn binary_decoder_strips_one_leading_bom_but_keeps_embedded_boms() {
    use ycoding_core::platform::pty::protocol;
    assert_eq!(
        protocol::decode_input(b"\xef\xbb\xbfx\xef\xbb\xbf"),
        Some("x\u{feff}".into())
    );
    assert_eq!(protocol::decode_input(b"\xef\xbb\xbf"), Some(String::new()));
    assert_eq!(protocol::decode_input(b"\xef\xbb"), None);
    assert_eq!(
        protocol::decode_text_input("\u{feff}x"),
        Some("\u{feff}x".into())
    );
    assert!(protocol::decode_text_input(&"x".repeat(65537)).is_none());
    let mut frame = vec![0, 0xef, 0xbb, 0xbf];
    frame.extend_from_slice(br#"{"type":"end","generation":1,"reason":"exit"}"#);
    assert!(protocol::decode_server_frame(&frame).is_some());
}
