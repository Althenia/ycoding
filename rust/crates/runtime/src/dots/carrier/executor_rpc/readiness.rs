use super::{
    types::{BackendFeatures, EnvironmentInfo},
    wire_base::unbacked_capability,
};
use crate::dots::carrier::supervisor::PrepareError;
#[cfg(test)]
use crate::dots::carrier::supervisor::{Boxed, Prepare};

pub fn held_reason(capability: &str) -> &'static str {
    match capability {
        "networkProxyLaunch" => "advertised capability networkProxyLaunch is not backed",
        "networkProxyReviewDomains" => {
            "advertised capability networkProxyReviewDomains is not backed"
        }
        "credentialMasking" => "advertised capability credentialMasking is not backed",
        "credentialMaskingCustomProviders" => {
            "advertised capability credentialMaskingCustomProviders is not backed"
        }
        "capabilityDiscoverySandbox" => {
            "advertised capability capabilityDiscoverySandbox is not backed"
        }
        "capabilityDiscoveryV2" => "advertised capability capabilityDiscoveryV2 is not backed",
        "environmentConfigRead" => "advertised capability environmentConfigRead is not backed",
        "httpHeaderEnvVars" => "advertised capability httpHeaderEnvVars is not backed",
        "sandboxedFileStreaming" => "advertised capability sandboxedFileStreaming is not backed",
        "fileWriteStreaming" => "advertised capability fileWriteStreaming is not backed",
        "shellSnapshotV2" => "advertised capability shellSnapshotV2 is not backed",
        _ => "an advertised capability is not backed",
    }
}

pub fn check(advertised: &EnvironmentInfo, features: &BackendFeatures) -> Result<(), PrepareError> {
    match unbacked_capability(&advertised.capabilities, features) {
        Some(capability) => Err(PrepareError::Held {
            reason: held_reason(capability),
        }),
        None => Ok(()),
    }
}

#[cfg(test)]
pub fn prepare(
    operator: Prepare,
    advertised: EnvironmentInfo,
    features: BackendFeatures,
) -> Prepare {
    Box::new(move || {
        let future: Boxed<Result<(), PrepareError>> = Box::pin(async move {
            operator().await?;
            check(&advertised, &features)
        });
        future
    })
}
