use crate::image::{Config, Model};
use ycoding_schema::LosslessString;

pub fn openai(id: impl Into<LosslessString>, config: Config) -> Model {
    crate::openai_images::model(id, config)
}
pub fn zai(id: impl Into<LosslessString>, config: Config) -> Model {
    crate::zai_images::model(id, config)
}
