#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Budgets {
    pub event_queue_count: usize,
    pub event_queue_bytes: u64,
    pub event_window_bytes: u64,
    pub bulk_window_bytes: u64,
    pub normal_window_bytes: u64,
    pub normal_queue_bytes: u64,
    pub tiny_queue_count: usize,
    pub tiny_queue_bytes: u64,
    pub delivery_timeout_ms: u64,
    pub relay_peer_bytes: u64,
    pub client_rate: usize,
    pub agent_rate: usize,
    pub rate_window_ms: u64,
    pub tiny_rate: usize,
    pub tiny_rate_bytes: u64,
    pub credit_bytes: u64,
    pub credit_delay_ms: u64,
    pub ping_interval_ms: u64,
    pub interactive_coalesce_ms: u64,
    pub background_coalesce_ms: u64,
}

impl Default for Budgets {
    fn default() -> Self {
        Self {
            event_queue_count: 4096,
            event_queue_bytes: 4 * 1024 * 1024,
            event_window_bytes: 1024 * 1024,
            bulk_window_bytes: 512 * 1024,
            normal_window_bytes: 1024 * 1024,
            normal_queue_bytes: 128 * 1024,
            tiny_queue_count: 32,
            tiny_queue_bytes: 16 * 1024,
            delivery_timeout_ms: 30000,
            relay_peer_bytes: 1024 * 1024,
            client_rate: 120,
            agent_rate: 500,
            rate_window_ms: 10000,
            tiny_rate: 500,
            tiny_rate_bytes: 256 * 1024,
            credit_bytes: 64 * 1024,
            credit_delay_ms: 25,
            ping_interval_ms: 20000,
            interactive_coalesce_ms: 40,
            background_coalesce_ms: 750,
        }
    }
}
