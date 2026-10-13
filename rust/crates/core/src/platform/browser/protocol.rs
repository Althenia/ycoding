use ycoding_schema::{JsonPath, JsonValue, LosslessString, ObjectDecoder, browser, parse_json};

pub const VERSION: u32 = 4;
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_SHARED_TABS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Pair,
    Authenticate,
    Shared,
    Revoked,
    ProfileAccess,
    Takeover,
    Updated,
    Observation,
    Result,
    Error,
    Pong,
    Forget,
    Opened,
    Closed,
    Relinquished,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClientMessage {
    pub kind: Kind,
    pub value: JsonValue,
}

pub fn extension_id_from_origin(origin: &str) -> Option<String> {
    origin
        .strip_prefix("chrome-extension://")
        .filter(|id| extension_id(id))
        .map(String::from)
}

fn extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

pub fn decode_client(frame: &[u8]) -> Option<ClientMessage> {
    if frame.len() > MAX_FRAME_BYTES {
        return None;
    }
    let text = std::str::from_utf8(frame)
        .ok()?
        .trim_start_matches('\u{feff}');
    let value = parse_json(text).ok()?;
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&value, &path).ok()?;
    let tag: LosslessString = object.field("type").ok()?;
    let kind = match tag.as_str()? {
        "pair" => Kind::Pair,
        "authenticate" => Kind::Authenticate,
        "shared" => Kind::Shared,
        "revoked" => Kind::Revoked,
        "profile_access" => Kind::ProfileAccess,
        "takeover" => Kind::Takeover,
        "updated" => Kind::Updated,
        "observation" => Kind::Observation,
        "result" => Kind::Result,
        "error" => Kind::Error,
        "pong" => Kind::Pong,
        "forget" => Kind::Forget,
        "opened" => Kind::Opened,
        "closed" => Kind::Closed,
        "relinquished" => Kind::Relinquished,
        _ => return None,
    };
    let string = |name| object.field::<LosslessString>(name).ok();
    let boolean = |name| object.field::<bool>(name).is_ok();
    let positive = |name| {
        object
            .field::<ycoding_schema::schema::PositiveInt>(name)
            .is_ok()
    };
    let tab = || object.field::<browser::TabId>("tabID").is_ok();
    let call = || object.field::<browser::CallId>("callID").is_ok();
    let optional_string = |name| object.optional::<LosslessString>(name).is_ok();
    let valid = match kind {
        Kind::Pair | Kind::Authenticate => {
            let version = object.field::<f64>("version").ok();
            let id = string("extensionID");
            let secret = string(if kind == Kind::Pair {
                "secret"
            } else {
                "credential"
            });
            version == Some(f64::from(VERSION))
                && id
                    .as_ref()
                    .and_then(LosslessString::as_str)
                    .is_some_and(extension_id)
                && secret.is_some_and(|v| (32..=128).contains(&v.len()))
                && (kind == Kind::Pair
                    || string("serverID").is_some_and(|v| (16..=128).contains(&v.len())))
        }
        Kind::Shared => {
            tab()
                && string("mode").as_ref().and_then(LosslessString::as_str) == Some("profile")
                && string("title").is_some()
                && string("url").is_some()
                && positive("documentGeneration")
                && boolean("active")
        }
        Kind::Revoked => tab(),
        Kind::ProfileAccess => boolean("enabled"),
        Kind::Takeover => tab() && positive("documentGeneration") && boolean("active"),
        Kind::Updated => {
            tab()
                && positive("documentGeneration")
                && string("title").is_some()
                && string("url").is_some()
        }
        Kind::Observation => {
            let elements = object.field::<Vec<JsonValue>>("elements").ok();
            tab()
                && call()
                && positive("generation")
                && positive("documentGeneration")
                && object
                    .field::<browser::ObservationRevision>("revision")
                    .is_ok()
                && string("title").is_some()
                && string("url").is_some()
                && boolean("truncated")
                && elements.is_some_and(|elements| {
                    elements.iter().all(|element| {
                        let Ok(o) = ObjectDecoder::new(element, &path) else {
                            return false;
                        };
                        let Ok(reference) = o.field::<LosslessString>("ref") else {
                            return false;
                        };
                        let Some(reference) = reference.as_str() else {
                            return false;
                        };
                        let bytes = reference.as_bytes();
                        (2..=5).contains(&bytes.len())
                            && bytes[0] == b'b'
                            && (b'1'..=b'9').contains(&bytes[1])
                            && bytes[2..].iter().all(u8::is_ascii_digit)
                            && o.field::<LosslessString>("role").is_ok()
                            && o.field::<LosslessString>("name").is_ok()
                            && o.optional::<LosslessString>("description").is_ok()
                            && o.optional::<bool>("disabled").is_ok()
                            && o.optional::<LosslessString>("destination").is_ok()
                    })
                })
        }
        Kind::Result => {
            tab()
                && call()
                && positive("generation")
                && positive("documentGeneration")
                && object
                    .field::<browser::ObservationRevision>("observationRevision")
                    .is_ok()
                && string("status")
                    .as_ref()
                    .and_then(LosslessString::as_str)
                    .is_some_and(|s| matches!(s, "completed" | "paused"))
                && string("title").is_some()
                && string("url").is_some()
                && optional_string("message")
                && object.optional::<browser::CaptureOutput>("capture").is_ok()
                && object
                    .optional::<ycoding_schema::schema::NonNegativeInt>("groupID")
                    .is_ok()
                && object.optional::<browser::InputKind>("input").is_ok()
        }
        Kind::Error => {
            tab()
                && call()
                && positive("generation")
                && boolean("dispatched")
                && string("message").is_some_and(|s| s.len() <= 1024)
        }
        Kind::Opened => {
            tab()
                && call()
                && positive("generation")
                && positive("documentGeneration")
                && string("title").is_some()
                && string("url").is_some()
                && boolean("active")
        }
        Kind::Closed | Kind::Relinquished => tab() && call() && positive("generation"),
        Kind::Pong | Kind::Forget => true,
    };
    valid.then_some(ClientMessage { kind, value })
}

pub fn encode_server(message: &JsonValue) -> String {
    ycoding_schema::stringify_json(message)
}
