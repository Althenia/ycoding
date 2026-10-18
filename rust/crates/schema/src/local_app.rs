use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue,
    LosslessString, ObjectDecoder, ObjectEncoder, mcp_events::Principal, session,
};

macro_rules! literals {
    ($name:ident {$($variant:ident => $value:literal),+ $(,)?}) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum $name {$($variant),+}
        impl $name {pub const fn as_str(self)-> &'static str {match self {$(Self::$variant=>$value),+}}}
        impl DomainDecode for $name {
            fn decode_at(value:&JsonValue,path:&JsonPath)->Result<Self,DecodeError>{
                let value=crate::domain::literal_enum(value,&[$($value),+],path)?;
                match value.as_str() {$(Some($value)=>Ok(Self::$variant),)+ _=>unreachable!()}
            }
        }
        impl DomainEncode for $name {fn encode(&self)->JsonValue{self.as_str().encode()}}
    };
}

literals!(Host {V4=>"127.0.0.1",V6=>"[::1]"});
literals!(Method {Get=>"GET",Head=>"HEAD",Post=>"POST",Put=>"PUT",Patch=>"PATCH",Delete=>"DELETE",Options=>"OPTIONS"});
literals!(RouteMatch {Exact=>"exact",Prefix=>"prefix"});
literals!(Category {InvalidRegistration=>"invalid_registration",Forbidden=>"forbidden",NotFound=>"not_found",Expired=>"expired",Busy=>"busy",UnsupportedStream=>"unsupported_stream",UpstreamUnavailable=>"upstream_unavailable",TooLarge=>"too_large",RedirectRejected=>"redirect_rejected"});

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub category: Category,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.category.as_str())
    }
}
impl std::error::Error for Failure {}
impl DomainDecode for Failure {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(value, path, &["_tag", "category"])?;
        o.literal("_tag", &"LocalApp.Failure".encode())?;
        Ok(Self {
            category: o.field("category")?,
        })
    }
}
impl DomainEncode for Failure {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("_tag", "LocalApp.Failure")
            .field("category", &self.category)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Scope {
    pub principal: Principal,
    pub session_id: session::Id,
}
impl DomainDecode for Scope {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(
            value,
            path,
            &[
                "ownerID",
                "deviceID",
                "sessionID",
                "clientID",
                "grantID",
                "epoch",
            ],
        )?;
        for key in ["ownerID", "deviceID", "grantID", "epoch"] {
            let value: LosslessString = o.field(key)?;
            if !value.as_str().is_some_and(|value| {
                !value.is_empty()
                    && value.len() <= 256
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            }) {
                return Err(path.key(key).error(DecodeErrorKind::Expected("identifier")));
            }
        }
        let JsonValue::Object(fields) = value else {
            unreachable!()
        };
        let mut principal = JsonObject::new();
        for (key, value) in fields
            .iter()
            .filter(|(key, _)| key.as_str() != Some("sessionID"))
        {
            principal.insert(key.clone(), value.clone());
        }
        Ok(Self {
            principal: Principal::decode_at(&JsonValue::Object(principal), path)?,
            session_id: o.field("sessionID")?,
        })
    }
}
impl DomainEncode for Scope {
    fn encode(&self) -> JsonValue {
        let JsonValue::Object(mut fields) = self.principal.encode() else {
            unreachable!()
        };
        fields.insert("sessionID".into(), self.session_id.encode());
        JsonValue::Object(fields)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub path: LosslessString,
    pub match_kind: RouteMatch,
    pub methods: Vec<Method>,
}
impl DomainDecode for Route {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(value, path, &["path", "match", "methods"])?;
        let methods: Vec<Method> = o.field("methods")?;
        count(methods.len(), 1, 7, &path.key("methods"))?;
        Ok(Self {
            path: text(&o, "path", 4096, path)?,
            match_kind: o.field("match")?,
            methods,
        })
    }
}
impl DomainEncode for Route {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("path", &self.path)
            .field("match", &self.match_kind)
            .field("methods", &self.methods)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Register {
    pub session_id: session::Id,
    pub host: Host,
    pub port: u16,
    pub entry_path: LosslessString,
    pub routes: Vec<Route>,
    pub ttl_ms: Option<u64>,
}
impl DomainDecode for Register {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(
            value,
            path,
            &["sessionID", "host", "port", "entryPath", "routes", "ttlMs"],
        )?;
        let routes: Vec<Route> = o.field("routes")?;
        count(routes.len(), 1, 64, &path.key("routes"))?;
        let ttl_ms = o
            .optional::<JsonValue>("ttlMs")?
            .map(|value| {
                crate::domain::integer_range(&value, 1, 3_600_000, &path.key("ttlMs"))
                    .map(|number| number as u64)
            })
            .transpose()?;
        Ok(Self {
            session_id: o.field("sessionID")?,
            host: o.field("host")?,
            port: crate::domain::integer_range(
                &o.field::<JsonValue>("port")?,
                1,
                65535,
                &path.key("port"),
            )? as u16,
            entry_path: text(&o, "entryPath", 4096, path)?,
            routes,
            ttl_ms,
        })
    }
}
impl DomainEncode for Register {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("host", &self.host)
            .field("port", &JsonValue::Number(f64::from(self.port)))
            .field("entryPath", &self.entry_path)
            .field("routes", &self.routes)
            .optional(
                "ttlMs",
                &self.ttl_ms.map(|number| JsonValue::Number(number as f64)),
            )
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Registration {
    pub id: LosslessString,
    pub generation: LosslessString,
    pub session_id: session::Id,
    pub expires_at: i64,
    pub entry_path: LosslessString,
    pub allowed_methods: Vec<Method>,
    pub routes: Vec<Route>,
}
impl DomainDecode for Registration {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let o = object(
            value,
            path,
            &[
                "id",
                "generation",
                "sessionID",
                "expiresAt",
                "entryPath",
                "allowedMethods",
                "routes",
            ],
        )?;
        let id: LosslessString = o.field("id")?;
        opaque(&id, "app_", &path.key("id"))?;
        let generation: LosslessString = o.field("generation")?;
        opaque(&generation, "generation_", &path.key("generation"))?;
        let routes: Vec<Route> = o.field("routes")?;
        count(routes.len(), 1, 64, &path.key("routes"))?;
        let allowed_methods: Vec<Method> = o.field("allowedMethods")?;
        count(allowed_methods.len(), 1, 7, &path.key("allowedMethods"))?;
        Ok(Self {
            id,
            generation,
            session_id: o.field("sessionID")?,
            expires_at: crate::domain::integer_range(
                &o.field::<JsonValue>("expiresAt")?,
                0,
                9_007_199_254_740_991,
                &path.key("expiresAt"),
            )? as i64,
            entry_path: text(&o, "entryPath", 4096, path)?,
            allowed_methods,
            routes,
        })
    }
}
impl DomainEncode for Registration {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("generation", &self.generation)
            .field("sessionID", &self.session_id)
            .field("expiresAt", &JsonValue::Number(self.expires_at as f64))
            .field("entryPath", &self.entry_path)
            .field("allowedMethods", &self.allowed_methods)
            .field("routes", &self.routes)
            .finish()
    }
}

fn object<'a>(
    value: &'a JsonValue,
    path: &'a JsonPath,
    keys: &[&str],
) -> Result<ObjectDecoder<'a>, DecodeError> {
    let o = ObjectDecoder::new(value, path)?;
    if let JsonValue::Object(fields) = value {
        for (key, _) in fields.iter() {
            if !keys
                .iter()
                .any(|allowed| key == &LosslessString::from(*allowed))
            {
                return Err(path
                    .key(key.clone())
                    .error(DecodeErrorKind::Expected("known field")));
            }
        }
    }
    Ok(o)
}
fn text(
    o: &ObjectDecoder<'_>,
    key: &str,
    max: usize,
    path: &JsonPath,
) -> Result<LosslessString, DecodeError> {
    let value: LosslessString = o.field(key)?;
    count(value.len(), 1, max, &path.key(key))?;
    Ok(value)
}
fn count(value: usize, min: usize, max: usize, path: &JsonPath) -> Result<(), DecodeError> {
    if !(min..=max).contains(&value) {
        return Err(path.error(DecodeErrorKind::Length {
            minimum: min,
            maximum: max,
        }));
    }
    Ok(())
}
fn opaque(value: &LosslessString, prefix: &str, path: &JsonPath) -> Result<(), DecodeError> {
    if !value
        .as_str()
        .and_then(|value| value.strip_prefix(prefix))
        .is_some_and(|suffix| {
            suffix.len() == 32
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
    {
        return Err(path.error(DecodeErrorKind::Expected("opaque identifier")));
    }
    Ok(())
}
