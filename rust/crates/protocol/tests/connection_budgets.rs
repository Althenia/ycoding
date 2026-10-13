use ycoding_protocol::connection::Budgets;
use ycoding_protocol::limits;

#[test]
fn defaults_match_protocol_plan_handshake_byte_work_ledger_and_tiny_flow_sections() {
    assert_eq!(
        Budgets::default(),
        Budgets {
            event_queue_count: 4096,
            event_queue_bytes: 4194304,
            event_window_bytes: 1048576,
            bulk_window_bytes: 524288,
            normal_window_bytes: 1048576,
            normal_queue_bytes: 131072,
            tiny_queue_count: 32,
            tiny_queue_bytes: 16384,
            delivery_timeout_ms: 30000,
            relay_peer_bytes: 1048576,
            client_rate: 120,
            agent_rate: 500,
            rate_window_ms: 10000,
            tiny_rate: 500,
            tiny_rate_bytes: 262144,
            credit_bytes: 65536,
            credit_delay_ms: 25,
            ping_interval_ms: 20000,
            interactive_coalesce_ms: 40,
            background_coalesce_ms: 750,
        },
        "plans/rust-backend/protocol.md: Routes and bootstrap; Proposed byte and work budgets; Complete consumption ledger and scheduling; Tiny-flow exception bounds (96,152–199)"
    );
}

#[test]
fn fixed_wire_limits_match_protocol_plan_96_and_159_to_178() {
    assert_eq!(
        [
            limits::CLIENT_FRAME_BYTES,
            limits::SERVER_FRAME_BYTES,
            limits::HANDSHAKE_BYTES,
            limits::HANDSHAKE_RETAINED_BYTES,
            limits::HANDSHAKE_TIMEOUT_MS,
            limits::TINY_FRAME_BYTES,
            limits::INLINE_BODY_BYTES,
            limits::BULK_PIECE_BYTES,
            limits::BULK_MESSAGE_BYTES,
            limits::BULK_PIECES,
            limits::BULK_TRANSFERS,
            limits::EVENT_BATCH_COUNT,
            limits::EVENT_BATCH_BYTES,
            limits::PENDING_REQUESTS,
            limits::SUBSCRIPTIONS,
        ],
        [
            131072, 1048576, 16384, 32768, 5000, 512, 65536, 65536, 67108864, 1024, 2, 64, 262144,
            32, 64
        ],
        "plans/rust-backend/protocol.md: Routes and bootstrap and Proposed byte and work budgets (96,159–178)"
    );
}
