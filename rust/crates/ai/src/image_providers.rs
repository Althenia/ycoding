use crate::image::{Config, Model};
use ycoding_schema::LosslessString;

pub fn openai(id: impl Into<LosslessString>, config: Config) -> Model {
    crate::openai_images::model(id, config)
}
pub fn google(id: impl Into<LosslessString>, config: Config) -> Model {
    crate::google_images::model(id, config)
}
pub fn xai(id: impl Into<LosslessString>, config: Config) -> Model {
    crate::xai_images::model(id, config)
}
pub fn zai(id: impl Into<LosslessString>, config: Config) -> Model {
    crate::zai_images::model(id, config)
}
