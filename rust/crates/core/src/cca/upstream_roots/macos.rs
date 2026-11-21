#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Trust {
    Unspecified,
    Trusted,
    Distrusted,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum Policy {
    #[default]
    Absent,
    AppleSsl,
    OtherOrInvalid,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SettingResult {
    #[default]
    Absent,
    Invalid,
    TrustRoot,
    TrustAsRoot,
    Deny,
    Other,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct TrustSetting {
    pub(crate) application_scoped: bool,
    pub(crate) policy_string_scoped: bool,
    pub(crate) policy: Policy,
    pub(crate) result: SettingResult,
}

impl TrustSetting {
    pub(crate) fn trust(&self, self_issued: bool) -> Trust {
        if self.application_scoped
            || self.policy_string_scoped
            || self.policy == Policy::OtherOrInvalid
        {
            return Trust::Unspecified;
        }
        match self.result {
            SettingResult::Deny => Trust::Distrusted,
            SettingResult::TrustAsRoot => Trust::Trusted,
            SettingResult::Absent | SettingResult::TrustRoot if self_issued => Trust::Trusted,
            _ => Trust::Unspecified,
        }
    }
}

pub(crate) fn settings_trust(settings: &[TrustSetting], self_issued: bool) -> Trust {
    if settings.is_empty() {
        return if self_issued {
            Trust::Trusted
        } else {
            Trust::Unspecified
        };
    }
    settings
        .iter()
        .map(|setting| setting.trust(self_issued))
        .find(|trust| *trust != Trust::Unspecified)
        .unwrap_or(Trust::Unspecified)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Domain {
    User,
    Admin,
}

#[derive(Clone, Debug)]
pub(crate) enum DomainSettings {
    ReadError,
    Missing,
    Present(Vec<TrustSetting>),
}

pub(crate) fn certificate_trusted(
    self_issued: bool,
    mut settings: impl FnMut(Domain) -> DomainSettings,
    mut evaluate_ssl_client_without_hostname: impl FnMut() -> bool,
) -> bool {
    let mut evaluated = false;
    for domain in [Domain::User, Domain::Admin] {
        match settings(domain) {
            DomainSettings::ReadError => continue,
            DomainSettings::Present(settings) => match settings_trust(&settings, self_issued) {
                Trust::Trusted => return true,
                Trust::Distrusted => return false,
                Trust::Unspecified => {}
            },
            DomainSettings::Missing if !evaluated => {
                if evaluate_ssl_client_without_hostname() {
                    return true;
                }
                evaluated = true;
            }
            DomainSettings::Missing => {}
        }
    }
    false
}

#[cfg(target_os = "macos")]
mod native;

#[cfg(target_os = "macos")]
pub(crate) use native::collect_native;
