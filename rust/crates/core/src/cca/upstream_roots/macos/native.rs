use super::{Domain, DomainSettings, Policy, SettingResult, TrustSetting, certificate_trusted};
use crate::cca::upstream_roots::{RootError, certificate};
use core_foundation_sys::{
    array::{
        CFArrayCreate, CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFArrayRef,
        kCFTypeArrayCallBacks,
    },
    base::{CFEqual, CFGetTypeID, CFRelease, CFTypeRef, kCFAllocatorDefault},
    data::{CFDataGetBytePtr, CFDataGetLength},
    dictionary::{
        CFDictionaryContainsKey, CFDictionaryCreate, CFDictionaryGetTypeID, CFDictionaryGetValue,
        CFDictionaryRef, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks,
    },
    number::{CFNumberGetTypeID, CFNumberGetValue, kCFNumberIntType},
    string::{CFStringCreateWithCString, CFStringRef, kCFStringEncodingUTF8},
};
use security_framework_sys::{
    base::{SecCertificateRef, SecPolicyRef, errSecItemNotFound, errSecSuccess},
    certificate::{SecCertificateCopyData, kSecPolicyAppleSSL},
    item::{kSecClass, kSecClassCertificate, kSecMatchLimit, kSecMatchLimitAll, kSecReturnRef},
    keychain_item::SecItemCopyMatching,
    policy::{SecPolicyCreateSSL, SecPolicyGetTypeID},
    trust::{SecTrustCreateWithCertificates, SecTrustEvaluateWithError},
    trust_settings::{
        SecTrustSettingsCopyTrustSettings, kSecTrustSettingsDomainAdmin,
        kSecTrustSettingsDomainUser, kSecTrustSettingsResultDeny,
        kSecTrustSettingsResultTrustAsRoot, kSecTrustSettingsResultTrustRoot,
    },
};
use std::{
    ffi::c_void,
    ptr,
    time::{SystemTime, UNIX_EPOCH},
};

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecPolicyCopyProperties(policy: SecPolicyRef) -> CFDictionaryRef;
    static kSecPolicyOid: CFStringRef;
}

struct OwnedCf(CFTypeRef);

impl OwnedCf {
    fn new(value: CFTypeRef) -> Option<Self> {
        (!value.is_null()).then(|| Self(value))
    }
}

impl Drop for OwnedCf {
    fn drop(&mut self) {
        unsafe {
            CFRelease(self.0);
        }
    }
}

struct TrustKeys {
    application: OwnedCf,
    policy_string: OwnedCf,
    policy: OwnedCf,
    result: OwnedCf,
}

impl TrustKeys {
    fn new() -> Result<Self, RootError> {
        fn string(value: &std::ffi::CStr) -> Result<OwnedCf, RootError> {
            OwnedCf::new(
                unsafe {
                    CFStringCreateWithCString(
                        kCFAllocatorDefault,
                        value.as_ptr(),
                        kCFStringEncodingUTF8,
                    )
                }
                .cast(),
            )
            .ok_or_else(|| {
                RootError::RequiredSystemSource("CFStringCreateWithCString failed".into())
            })
        }
        Ok(Self {
            application: string(c"kSecTrustSettingsApplication")?,
            policy_string: string(c"kSecTrustSettingsPolicyString")?,
            policy: string(c"kSecTrustSettingsPolicy")?,
            result: string(c"kSecTrustSettingsResult")?,
        })
    }

    fn setting(&self, dictionary: CFDictionaryRef) -> TrustSetting {
        let application_scoped =
            unsafe { CFDictionaryContainsKey(dictionary, self.application.0) } != 0;
        let policy_string_scoped =
            unsafe { CFDictionaryContainsKey(dictionary, self.policy_string.0) } != 0;
        if application_scoped || policy_string_scoped {
            return TrustSetting {
                application_scoped,
                policy_string_scoped,
                ..TrustSetting::default()
            };
        }
        let policy = if unsafe { CFDictionaryContainsKey(dictionary, self.policy.0) } == 0 {
            Policy::Absent
        } else {
            let policy = unsafe { CFDictionaryGetValue(dictionary, self.policy.0) };
            if policy.is_null() || unsafe { CFGetTypeID(policy) != SecPolicyGetTypeID() } {
                Policy::OtherOrInvalid
            } else if let Some(properties) =
                OwnedCf::new(unsafe { SecPolicyCopyProperties(policy.cast_mut().cast()).cast() })
            {
                let oid =
                    unsafe { CFDictionaryGetValue(properties.0.cast(), kSecPolicyOid.cast()) };
                if !oid.is_null() && unsafe { CFEqual(oid, kSecPolicyAppleSSL.cast()) } != 0 {
                    Policy::AppleSsl
                } else {
                    Policy::OtherOrInvalid
                }
            } else {
                Policy::OtherOrInvalid
            }
        };
        let result = if unsafe { CFDictionaryContainsKey(dictionary, self.result.0) } == 0 {
            SettingResult::Absent
        } else {
            let number = unsafe { CFDictionaryGetValue(dictionary, self.result.0) };
            let mut result = 0i32;
            if number.is_null()
                || unsafe { CFGetTypeID(number) != CFNumberGetTypeID() }
                || !unsafe {
                    CFNumberGetValue(
                        number.cast(),
                        kCFNumberIntType,
                        (&mut result as *mut i32).cast(),
                    )
                }
            {
                SettingResult::Invalid
            } else {
                #[allow(non_upper_case_globals)]
                match result as u32 {
                    kSecTrustSettingsResultTrustRoot => SettingResult::TrustRoot,
                    kSecTrustSettingsResultTrustAsRoot => SettingResult::TrustAsRoot,
                    kSecTrustSettingsResultDeny => SettingResult::Deny,
                    _ => SettingResult::Other,
                }
            }
        };
        TrustSetting {
            application_scoped,
            policy_string_scoped,
            policy,
            result,
        }
    }

    fn settings(&self, certificate: SecCertificateRef, domain: Domain) -> DomainSettings {
        let mut settings: CFArrayRef = ptr::null();
        let status = unsafe {
            SecTrustSettingsCopyTrustSettings(
                certificate,
                match domain {
                    Domain::User => kSecTrustSettingsDomainUser,
                    Domain::Admin => kSecTrustSettingsDomainAdmin,
                },
                &mut settings,
            )
        };
        let settings = OwnedCf::new(settings.cast());
        if status != errSecSuccess && status != errSecItemNotFound {
            return DomainSettings::ReadError;
        }
        let Some(settings) = settings else {
            return DomainSettings::Missing;
        };
        if status != errSecSuccess || unsafe { CFGetTypeID(settings.0) != CFArrayGetTypeID() } {
            return DomainSettings::ReadError;
        }
        let array = settings.0.cast();
        let mut entries = Vec::new();
        for index in 0..unsafe { CFArrayGetCount(array) } {
            let value = unsafe { CFArrayGetValueAtIndex(array, index) };
            if value.is_null() || unsafe { CFGetTypeID(value) != CFDictionaryGetTypeID() } {
                entries.push(TrustSetting {
                    result: SettingResult::Invalid,
                    ..TrustSetting::default()
                });
            } else {
                entries.push(self.setting(value.cast()));
            }
        }
        DomainSettings::Present(entries)
    }
}

fn evaluate(certificate: SecCertificateRef) -> bool {
    let entries = [certificate.cast::<c_void>().cast_const()];
    let Some(array) = OwnedCf::new(
        unsafe {
            CFArrayCreate(
                kCFAllocatorDefault,
                entries.as_ptr(),
                1,
                &kCFTypeArrayCallBacks,
            )
        }
        .cast(),
    ) else {
        return false;
    };
    let Some(policy) = OwnedCf::new(unsafe { SecPolicyCreateSSL(0, ptr::null()) }.cast()) else {
        return false;
    };
    let mut trust = ptr::null_mut();
    let status = unsafe { SecTrustCreateWithCertificates(array.0, policy.0, &mut trust) };
    let trust = OwnedCf::new(trust.cast());
    status == errSecSuccess
        && trust.is_some_and(|trust| unsafe {
            SecTrustEvaluateWithError(trust.0.cast_mut().cast(), ptr::null_mut())
        })
}

pub(crate) fn collect_native() -> Result<Vec<String>, RootError> {
    let keys = TrustKeys::new()?;
    let search_keys = unsafe {
        [
            kSecClass.cast(),
            kSecMatchLimit.cast(),
            kSecReturnRef.cast(),
        ]
    };
    let search_values = unsafe {
        [
            kSecClassCertificate.cast(),
            kSecMatchLimitAll.cast(),
            core_foundation_sys::number::kCFBooleanTrue.cast(),
        ]
    };
    let search = OwnedCf::new(
        unsafe {
            CFDictionaryCreate(
                kCFAllocatorDefault,
                search_keys.as_ptr(),
                search_values.as_ptr(),
                3,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            )
        }
        .cast(),
    )
    .ok_or_else(|| RootError::RequiredSystemSource("CFDictionaryCreate failed".into()))?;
    let mut items = ptr::null();
    let status = unsafe { SecItemCopyMatching(search.0.cast(), &mut items) };
    let items = OwnedCf::new(items);
    if status != errSecSuccess {
        return Ok(Vec::new());
    }
    let items = items.ok_or_else(|| {
        RootError::RequiredSystemSource("SecItemCopyMatching returned NULL".into())
    })?;
    if unsafe { CFGetTypeID(items.0) != CFArrayGetTypeID() } {
        return Err(RootError::RequiredSystemSource(
            "SecItemCopyMatching returned a non-array".into(),
        ));
    }
    let array = items.0.cast();
    let mut roots = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for index in 0..unsafe { CFArrayGetCount(array) } {
        let item = unsafe { CFArrayGetValueAtIndex(array, index) }
            .cast_mut()
            .cast();
        let Some(data) = OwnedCf::new(unsafe { SecCertificateCopyData(item) }.cast()) else {
            continue;
        };
        let length = unsafe { CFDataGetLength(data.0.cast()) };
        let bytes = unsafe { CFDataGetBytePtr(data.0.cast()) };
        if length <= 0 || bytes.is_null() {
            continue;
        }
        let Some(decoded) =
            certificate::decode_mac(unsafe { std::slice::from_raw_parts(bytes, length as usize) })?
        else {
            continue;
        };
        if !certificate_trusted(
            decoded.self_issued,
            |domain| keys.settings(item, domain),
            || evaluate(item),
        ) {
            continue;
        }
        if seen.contains(&decoded.identity) {
            continue;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| RootError::RequiredSystemSource(error.to_string()))?;
        if decoded.expired_at(now) {
            continue;
        }
        seen.insert(decoded.identity);
        roots.push(decoded.pem);
    }
    Ok(roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_cf_copy_result_has_no_owner() {
        assert!(OwnedCf::new(ptr::null()).is_none());
    }
}
