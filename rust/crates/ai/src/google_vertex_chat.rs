use crate::{
    Error,
    google_vertex_shared::{self, Config},
    providers::Api,
    route::Route,
};
pub fn route(config: Config) -> Result<Route, Error> {
    google_vertex_shared::openai_route(config, Api::Chat)
}
