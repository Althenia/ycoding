use crate::dispatch::Failure;
use ycoding_core::session::list::{Order, Parent, Query, Scope};
use ycoding_core::ycoding_schema::{
    DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, parse_json,
    project_id::ProjectId, schema::AbsolutePath, session, session_orchestration::ListAnchor,
    stringify_json, workspace_id::WorkspaceId,
};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_CURSOR_BYTES: usize = 1024;

pub fn encode_subagent(parent: &session::Id, anchor: &ListAnchor) -> String {
    base64url(
        stringify_json(
            &ObjectEncoder::new()
                .field("parentID", parent)
                .field("anchor", anchor)
                .finish(),
        )
        .as_bytes(),
    )
}

pub fn encode_project_inventory(
    search: Option<&LosslessString>,
    anchor: &ycoding_core::ycoding_schema::project::InventoryAnchor,
) -> String {
    let search = search.cloned();
    base64url(
        stringify_json(
            &ObjectEncoder::new()
                .optional("search", &search)
                .field("anchor", anchor)
                .finish(),
        )
        .as_bytes(),
    )
}

pub fn decode_project_inventory(
    cursor: &str,
) -> Result<
    (
        Option<LosslessString>,
        ycoding_core::ycoding_schema::project::InventoryAnchor,
    ),
    Failure,
> {
    let invalid = || Failure::InvalidCursor("Invalid cursor".into());
    let bytes = unbase64url(cursor, MAX_CURSOR_BYTES).ok_or_else(invalid)?;
    let value =
        parse_json(std::str::from_utf8(&bytes).map_err(|_| invalid())?).map_err(|_| invalid())?;
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&value, &path).map_err(|_| invalid())?;
    Ok((
        object.optional("search").map_err(|_| invalid())?,
        object.field("anchor").map_err(|_| invalid())?,
    ))
}

pub fn decode_subagent(parent: &session::Id, cursor: &str) -> Result<ListAnchor, Failure> {
    let invalid = || Failure::InvalidCursor("Invalid cursor".into());
    let bytes = unbase64url(cursor, MAX_CURSOR_BYTES).ok_or_else(invalid)?;
    let value =
        parse_json(std::str::from_utf8(&bytes).map_err(|_| invalid())?).map_err(|_| invalid())?;
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&value, &path).map_err(|_| invalid())?;
    let owner = object
        .field::<session::Id>("parentID")
        .map_err(|_| invalid())?;
    (owner.as_lossless() == parent.as_lossless())
        .then(|| object.field::<ListAnchor>("anchor").ok())
        .flatten()
        .ok_or_else(invalid)
}

pub fn encode_list(query: &Query, anchor: &session::ListAnchor) -> String {
    let (directory, project) = match &query.scope {
        Scope::All => (None, None),
        Scope::Directory(directory) => (Some(directory.clone()), None),
        Scope::Project(project) => (None, Some(project.clone())),
    };
    let order = LosslessString::from(match query.order {
        Order::Ascending => "asc",
        Order::Descending => "desc",
    });
    let parent = query.parent.as_ref().map(|parent| match parent {
        Parent::Root => JsonValue::String("null".into()),
        Parent::Child(id) => id.encode(),
    });
    base64url(
        stringify_json(
            &ObjectEncoder::new()
                .optional("workspace", &query.workspace)
                .field("order", &order)
                .optional("search", &query.search)
                .optional("parentID", &parent)
                .optional("directory", &directory)
                .optional("project", &project)
                .field("anchor", anchor)
                .finish(),
        )
        .as_bytes(),
    )
}

pub fn decode_list(cursor: &str, maximum: usize) -> Result<Query, Failure> {
    let bytes = unbase64url(cursor, maximum).ok_or_else(|| invalid_cursor(()))?;
    let value =
        parse_json(std::str::from_utf8(&bytes).map_err(invalid_cursor)?).map_err(invalid_cursor)?;
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&value, &path).map_err(invalid_cursor)?;
    let anchor = object
        .field::<session::ListAnchor>("anchor")
        .map_err(invalid_cursor)?;
    let scope = match (
        object
            .optional::<AbsolutePath>("directory")
            .map_err(invalid_cursor)?,
        object
            .optional::<ProjectId>("project")
            .map_err(invalid_cursor)?,
    ) {
        (Some(directory), _) => Scope::Directory(directory.as_lossless().clone()),
        (None, Some(project)) => Scope::Project(project.as_lossless().clone()),
        (None, None) => Scope::All,
    };
    let order = match object
        .optional::<LosslessString>("order")
        .map_err(invalid_cursor)?
        .as_ref()
        .map(|order| order.as_str())
    {
        None => Order::Descending,
        Some(Some("desc")) => Order::Descending,
        Some(Some("asc")) => Order::Ascending,
        Some(_) => return Err(invalid_cursor(())),
    };
    let parent = match object
        .optional::<LosslessString>("parentID")
        .map_err(invalid_cursor)?
    {
        None => None,
        Some(parent) if parent.as_str() == Some("null") => Some(Parent::Root),
        Some(parent) => Some(Parent::Child(
            session::Id::new(parent).map_err(invalid_cursor)?,
        )),
    };
    Ok(Query {
        scope,
        workspace: object
            .optional::<WorkspaceId>("workspace")
            .map_err(invalid_cursor)?
            .map(|workspace| workspace.as_lossless().clone()),
        search: object
            .optional::<LosslessString>("search")
            .map_err(invalid_cursor)?,
        parent,
        order,
        limit: None,
        anchor: Some(anchor),
    })
}

fn invalid_cursor<E>(_: E) -> Failure {
    Failure::InvalidCursor("Invalid cursor".into())
}

fn base64url(bytes: &[u8]) -> String {
    let mut output = String::new();
    let mut accumulator = 0u32;
    let mut bits = 0;
    for byte in bytes {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            output.push(ALPHABET[((accumulator >> bits) & 63) as usize] as char);
        }
    }
    if bits > 0 {
        output.push(ALPHABET[((accumulator << (6 - bits)) & 63) as usize] as char);
    }
    output
}

fn unbase64url(value: &str, maximum: usize) -> Option<Vec<u8>> {
    if value.is_empty() || value.len() > maximum {
        return None;
    }
    let mut accumulator = 0u32;
    let mut bits = 0;
    let mut bytes = Vec::new();
    for byte in value.bytes() {
        let index = ALPHABET.iter().position(|item| *item == byte)? as u32;
        accumulator = (accumulator << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((accumulator >> bits) as u8);
        }
    }
    (base64url(&bytes) == value).then_some(bytes)
}
