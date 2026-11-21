use crate::schema::Finite;
use crate::{DecodeError, DomainDecode, DomainEncode, JsonPath, JsonValue};

macro_rules! money_type {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, PartialEq)]
        pub struct $name(Finite);
        impl $name {
            pub fn new(value: f64) -> Result<Self, DecodeError> {
                Finite::new(value).map(Self)
            }
            pub fn zero() -> Self {
                Self(Finite::new(0.0).expect("zero is finite"))
            }
            pub fn get(self) -> f64 {
                self.0.get()
            }
        }
        impl DomainDecode for $name {
            fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
                Finite::decode_at(value, path).map(Self)
            }
        }
        impl DomainEncode for $name {
            fn encode(&self) -> JsonValue {
                self.0.encode()
            }
        }
    };
}
money_type!(Usd);
money_type!(UsdPerMillionTokens);
