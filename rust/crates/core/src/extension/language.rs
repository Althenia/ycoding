use super::{
    Extension,
    supervisor::{Shared, language_error},
    v5, wire,
};
use std::sync::Arc;
use ycoding_ai::route::{LanguageAttempt, LanguageFuture, ProcessInput};
use ycoding_schema::JsonValue;

pub async fn claim(
    extensions: &[Arc<Extension>],
    package: &str,
    model: &JsonValue,
    options: &JsonValue,
) -> Result<Option<Arc<dyn LanguageAttempt>>, ycoding_ai::Error> {
    wire::check_value(model).map_err(|error| language_error(error.into()))?;
    wire::check_value(options).map_err(|error| language_error(error.into()))?;
    if package.len() > 4096 || package.contains('\0') {
        return Err(ycoding_ai::Error::invalid("Invalid language model package"));
    }
    for extension in extensions.iter().filter(|extension| extension.trusted()) {
        let shared = extension.shared();
        let handled = shared
            .resolve_language(v5::LanguageResolve {
                request: 0,
                package: package.into(),
                model: wire::value(model),
                options: wire::value(options),
            })
            .await
            .map_err(language_error)?;
        if handled {
            return Ok(Some(Arc::new(ProcessLanguage {
                shared: shared.clone(),
                package: package.into(),
                model: model.clone(),
                options: options.clone(),
            })));
        }
    }
    Ok(None)
}

struct ProcessLanguage {
    shared: Arc<Shared>,
    package: String,
    model: JsonValue,
    options: JsonValue,
}

impl LanguageAttempt for ProcessLanguage {
    fn attempt(&self, input: ProcessInput) -> LanguageFuture<'_> {
        Box::pin(async move {
            wire::check_value(&input.body).map_err(|_| {
                ycoding_ai::Error::invalid("Plugin language model request does not fit one frame")
            })?;
            let attempt = v5::LanguageAttempt {
                request: 0,
                package: self.package.clone(),
                model: wire::value(&self.model),
                options: wire::value(&self.options),
                body: wire::value(&input.body),
            };
            if prost::Message::encoded_len(&attempt) >= wire::FRAME_BYTES - 1024 {
                return Err(ycoding_ai::Error::invalid(
                    "Plugin language model request does not fit one frame",
                ));
            }
            self.shared
                .language(attempt)
                .await
                .map_err(super::supervisor::language_error)
        })
    }
}
