use super::{Driver, Error, protocol_error};
use crate::{
    Dispatcher,
    connector::{
        mcp,
        mcp_state::{Advertisement, stable_id},
    },
    convert,
};
use prost::{Message, Name};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
};
use ycoding_protocol::{decode_strict, v5};

pub(super) const QUEUED: u8 = 0;
pub(super) const STARTED: u8 = 1;
const ABANDONED: u8 = 2;
const HEADERS: [&str; 5] = [
    "content-type",
    "accept",
    "mcp-protocol-version",
    "mcp-method",
    "mcp-name",
];
pub(super) const INVALID: (i32, &str) = (1, "Invalid relay MCP request");
pub(super) const UNAVAILABLE: (i32, &str) = (10, "Relay MCP is not enabled on this connection");
pub(super) const UNKNOWN: (i32, &str) = (
    11,
    "An earlier relay MCP mutation in this lane has an unknown outcome; inspect it, then disable and re-enable relay MCP",
);
const FORBIDDEN: (i32, &str) = (12, "Relay MCP principal does not match this device");

struct Ticket {
    lane: String,
    epoch: String,
    state: Arc<AtomicU8>,
}

#[derive(Default)]
pub(super) struct Relay {
    advertised: Option<Advertisement>,
    tickets: BTreeMap<String, Ticket>,
    transfers: BTreeMap<String, String>,
}

pub(super) struct Admitted {
    pub lane: Option<String>,
    pub state: Arc<AtomicU8>,
}

impl Driver {
    pub(super) fn advertise(&mut self) -> Result<(), Error> {
        let Some(advertisement) = self.control.mcp().advertisement()? else {
            self.relay.advertised = None;
            return Ok(());
        };
        let body = v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::McpState(v5::McpState {
                id: advertisement.id.clone(),
                enabled: advertisement.enabled,
                epoch: advertisement.epoch.clone(),
            })),
        });
        self.machine
            .enqueue(
                body.clone(),
                self.reserve(v5::LedgerClass::Normal, body),
                self.now(),
            )
            .map_err(protocol_error)?;
        self.relay.advertised = Some(advertisement);
        Ok(())
    }

    pub(super) async fn acknowledge(
        &mut self,
        ack: v5::McpStateAck,
        dispatcher: &Arc<Dispatcher>,
    ) -> Result<(), Error> {
        let Some(advertisement) = &self.relay.advertised else {
            return Ok(());
        };
        if advertisement.id != ack.id
            || advertisement.epoch != ack.epoch
            || advertisement.enabled != ack.enabled
            || !self.control.current(self.generation)
        {
            return Ok(());
        }
        let advertisement = advertisement.clone();
        if let Err(error) = self
            .control
            .mcp()
            .acknowledged(&advertisement, &self.epoch, &self.peer, dispatcher.clone())
            .await
        {
            tracing::error!(
                ?error,
                "relay MCP revocation acknowledgement could not be saved"
            );
        }
        Ok(())
    }

    pub(super) fn admit_mcp(
        &mut self,
        request: &v5::Request,
    ) -> Result<Admitted, (i32, &'static str)> {
        if !matches!(request.scope.target, Some(v5::scope::Target::Machine(_))) {
            return Err(INVALID);
        }
        let payload = decode_strict::<v5::McpRequestRequest>(&request.payload)
            .map_err(|_| INVALID)?
            .payload;
        let mut names = BTreeSet::new();
        for header in &payload.headers {
            let value = convert::domain(&header.value).map_err(|_| INVALID)?;
            if !HEADERS.contains(&header.name.as_str())
                || !names.insert(header.name.as_str())
                || value
                    .code_units()
                    .any(|unit| matches!(unit, 0x0000 | 0x000a | 0x000d))
            {
                return Err(INVALID);
            }
        }
        let client = convert::domain(&payload.principal.client_id).map_err(|_| INVALID)?;
        if !stable_id(&payload.principal.owner_id)
            || !stable_id(&payload.principal.device_id)
            || !stable_id(&payload.epoch)
            || client
                .code_units()
                .any(|unit| matches!(unit, 0x0000 | 0x000a | 0x000d))
        {
            return Err(INVALID);
        }
        let body = convert::domain(&payload.body).map_err(|_| INVALID)?;
        let mcp = self.control.mcp();
        let binding = mcp
            .binding(&self.epoch)
            .filter(|binding| {
                binding.epoch == payload.epoch && self.control.current(self.generation)
            })
            .ok_or(UNAVAILABLE)?;
        if binding.peer.device() != payload.principal.device_id {
            return Err(FORBIDDEN);
        }
        let lane = mcp::lane(&body).map(|lane| match lane {
            mcp::Lane::Session(id) => id,
            mcp::Lane::Backend => String::new(),
        });
        if let Some(lane) = &lane
            && mcp.quarantined(&binding.epoch, lane)
        {
            return Err(UNKNOWN);
        }
        let state = Arc::new(AtomicU8::new(QUEUED));
        if let Some(lane) = &lane {
            self.relay.tickets.insert(
                request.request_id.clone(),
                Ticket {
                    lane: lane.clone(),
                    epoch: binding.epoch,
                    state: state.clone(),
                },
            );
        }
        Ok(Admitted { lane, state })
    }

    pub(super) fn reject(
        &mut self,
        request: &v5::Request,
        settlement: i32,
        (code, message): (i32, &'static str),
    ) -> Result<(), Error> {
        let result = v5::Result {
            request_id: request.request_id.clone(),
            operation_id: request.operation_id,
            settlement,
            outcome: Some(v5::result::Outcome::Error(v5::TypedPayload {
                type_name: v5::ConnectorError::full_name(),
                payload: v5::ConnectorError {
                    code,
                    message: convert::text(message),
                }
                .encode_to_vec(),
            })),
        };
        let reserved = self.reserve(
            v5::LedgerClass::Normal,
            v5::frame::Body::Result(result.clone()),
        );
        self.machine
            .respond(result, reserved, self.now())
            .map_err(protocol_error)
    }

    pub(super) fn bulk_ticket(&mut self, request_id: &str, transfer_id: &str) {
        if self.relay.tickets.contains_key(request_id) {
            self.relay
                .transfers
                .insert(transfer_id.to_owned(), request_id.to_owned());
        }
    }

    pub(super) fn delivered(&mut self, body: Option<&v5::frame::Body>) {
        let request = match body {
            Some(v5::frame::Body::Result(result)) => Some(result.request_id.clone()),
            Some(v5::frame::Body::BulkEnd(end)) => self.relay.transfers.remove(&end.transfer_id),
            _ => None,
        };
        if let Some(request) = request {
            self.relay.tickets.remove(&request);
        }
    }

    pub(super) fn abandon(&mut self, request_id: &str) {
        self.relay
            .transfers
            .retain(|_, request| request != request_id);
        if let Some(ticket) = self.relay.tickets.remove(request_id) {
            self.quarantine(ticket);
        }
    }

    pub(super) fn abandon_all(&mut self) {
        self.relay.transfers.clear();
        for ticket in std::mem::take(&mut self.relay.tickets).into_values() {
            self.quarantine(ticket);
        }
    }

    fn quarantine(&self, ticket: Ticket) {
        if ticket.state.swap(ABANDONED, Ordering::AcqRel) == STARTED {
            self.control.mcp().quarantine(&ticket.epoch, &ticket.lane);
        }
    }
}

pub(super) fn begin(state: &AtomicU8) -> bool {
    state
        .compare_exchange(QUEUED, STARTED, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}
