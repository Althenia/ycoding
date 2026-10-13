use std::{
    collections::{HashMap, VecDeque},
    io,
    time::{Duration, Instant},
};
use ycoding_schema::{
    pty::{Access, Id},
    pty_ticket::ConnectToken,
    session_id::SessionId,
};
#[derive(Clone, Debug, PartialEq)]
pub struct Scope {
    pub pty_id: Id,
    pub session_id: SessionId,
    pub access: Access,
    pub generation: u64,
    pub fence: Option<u64>,
    pub directory: Option<String>,
    pub workspace_id: Option<String>,
}
pub struct Tickets {
    ttl: Duration,
    entries: HashMap<String, (Scope, Instant)>,
    order: VecDeque<String>,
}
impl Tickets {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }
    pub fn issue(&mut self, scope: Scope) -> io::Result<ConnectToken> {
        use ycoding_schema::schema::PositiveInt;
        let generation =
            PositiveInt::new(i64::try_from(scope.generation).map_err(io::Error::other)?)
                .map_err(io::Error::other)?;
        let fence = scope
            .fence
            .map(|fence| {
                PositiveInt::new(i64::try_from(fence).map_err(io::Error::other)?)
                    .map_err(io::Error::other)
            })
            .transpose()?;
        let mut bytes = crate::platform::random::<16>()?;
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let ticket = format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        );
        let token = ConnectToken {
            ticket: ticket.clone().into(),
            expires_in: PositiveInt::new(self.ttl.as_secs_f64().round().max(1.0) as i64)
                .map_err(io::Error::other)?,
            access: scope.access,
            generation,
            fence,
        };
        self.entries
            .insert(ticket.clone(), (scope, Instant::now() + self.ttl));
        self.order.push_back(ticket);
        if self.entries.len() > 10000 {
            self.entries
                .remove(&self.order.pop_front().expect("ticket capacity exceeded"));
        }
        Ok(token)
    }
    pub fn consume(&mut self, ticket: &str, scope: &Scope) -> bool {
        let Some((stored, expires)) = self.entries.get(ticket) else {
            return false;
        };
        if *expires <= Instant::now() {
            self.entries.remove(ticket);
            self.order.retain(|entry| entry != ticket);
            return false;
        }
        if stored != scope {
            return false;
        }
        self.entries.remove(ticket);
        self.order.retain(|entry| entry != ticket);
        true
    }
}
impl Default for Tickets {
    fn default() -> Self {
        Self::new(Duration::from_secs(60))
    }
}
