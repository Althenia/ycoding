#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StoreLocation {
    LocalMachine,
    LocalMachineGroupPolicy,
    LocalMachineEnterprise,
    CurrentUser,
    CurrentUserGroupPolicy,
}

#[cfg(any(windows, test))]
use StoreLocation::*;

#[cfg(any(windows, test))]
pub(crate) const STORE_SELECTIONS: [(StoreLocation, &str); 13] = [
    (LocalMachine, "ROOT"),
    (LocalMachineGroupPolicy, "ROOT"),
    (LocalMachineEnterprise, "ROOT"),
    (CurrentUser, "ROOT"),
    (CurrentUserGroupPolicy, "ROOT"),
    (LocalMachine, "CA"),
    (LocalMachineGroupPolicy, "CA"),
    (LocalMachineEnterprise, "CA"),
    (CurrentUser, "CA"),
    (CurrentUserGroupPolicy, "CA"),
    (LocalMachine, "TrustedPeople"),
    (LocalMachineGroupPolicy, "TrustedPeople"),
    (LocalMachineEnterprise, "TrustedPeople"),
];

#[cfg(any(windows, test))]
pub(crate) enum EnhancedKeyUsage {
    PropertyError,
    AllPurposes,
    NoPurposes,
    Oids(Vec<String>),
}

#[cfg(any(windows, test))]
pub(crate) fn server_auth_allowed(usage: &EnhancedKeyUsage) -> bool {
    match usage {
        EnhancedKeyUsage::AllPurposes => true,
        EnhancedKeyUsage::Oids(oids) => oids
            .iter()
            .any(|oid| oid == "1.3.6.1.5.5.7.3.1" || oid == "2.5.29.37.0"),
        EnhancedKeyUsage::PropertyError | EnhancedKeyUsage::NoPurposes => false,
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use crate::cca::upstream_roots::RootError;
    use std::{ffi::CStr, mem::size_of, ptr};
    use windows_sys::Win32::{
        Foundation::{CRYPT_E_NOT_FOUND, GetLastError},
        Security::Cryptography::{
            CERT_CONTEXT, CERT_STORE_OPEN_EXISTING_FLAG, CERT_STORE_PROV_SYSTEM_W,
            CERT_STORE_READONLY_FLAG, CERT_SYSTEM_STORE_CURRENT_USER,
            CERT_SYSTEM_STORE_CURRENT_USER_GROUP_POLICY_ID, CERT_SYSTEM_STORE_LOCAL_MACHINE,
            CERT_SYSTEM_STORE_LOCAL_MACHINE_ENTERPRISE_ID,
            CERT_SYSTEM_STORE_LOCAL_MACHINE_GROUP_POLICY_ID, CERT_SYSTEM_STORE_LOCATION_SHIFT,
            CTL_USAGE, CertCloseStore, CertEnumCertificatesInStore, CertFreeCertificateContext,
            CertGetEnhancedKeyUsage, CertOpenStore, HCERTSTORE,
        },
    };

    struct Store(HCERTSTORE);

    struct Cursor(*const CERT_CONTEXT);

    impl Drop for Cursor {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CertFreeCertificateContext(self.0);
                }
            }
        }
    }

    impl Store {
        fn close(mut self) -> Result<(), RootError> {
            let store = std::mem::replace(&mut self.0, ptr::null_mut());
            if unsafe { CertCloseStore(store, 0) } == 0 {
                return Err(RootError::RequiredSystemSource(
                    "CertCloseStore failed".into(),
                ));
            }
            Ok(())
        }
    }

    impl Drop for Store {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CertCloseStore(self.0, 0);
                }
            }
        }
    }

    fn enhanced_key_usage(certificate: *const CERT_CONTEXT) -> EnhancedKeyUsage {
        let mut size = 0;
        if unsafe { CertGetEnhancedKeyUsage(certificate, 0, ptr::null_mut(), &mut size) } == 0
            || (size as usize) < size_of::<CTL_USAGE>()
        {
            return EnhancedKeyUsage::PropertyError;
        }
        let mut buffer = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
        let usage = buffer.as_mut_ptr().cast::<CTL_USAGE>();
        if unsafe { CertGetEnhancedKeyUsage(certificate, 0, usage, &mut size) } == 0 {
            return EnhancedKeyUsage::PropertyError;
        }
        let error = unsafe { GetLastError() };
        let usage = unsafe { &*usage };
        if usage.cUsageIdentifier == 0 {
            return if error == CRYPT_E_NOT_FOUND as u32 {
                EnhancedKeyUsage::AllPurposes
            } else {
                EnhancedKeyUsage::NoPurposes
            };
        }
        if usage.rgpszUsageIdentifier.is_null() {
            return EnhancedKeyUsage::PropertyError;
        }
        let mut oids = Vec::new();
        for index in 0..usage.cUsageIdentifier as usize {
            let oid = unsafe { *usage.rgpszUsageIdentifier.add(index) };
            if oid.is_null() {
                return EnhancedKeyUsage::PropertyError;
            }
            oids.push(
                unsafe { CStr::from_ptr(oid.cast()) }
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        EnhancedKeyUsage::Oids(oids)
    }

    fn location_flags(location: StoreLocation) -> u32 {
        match location {
            LocalMachine => CERT_SYSTEM_STORE_LOCAL_MACHINE,
            LocalMachineGroupPolicy => {
                CERT_SYSTEM_STORE_LOCAL_MACHINE_GROUP_POLICY_ID << CERT_SYSTEM_STORE_LOCATION_SHIFT
            }
            LocalMachineEnterprise => {
                CERT_SYSTEM_STORE_LOCAL_MACHINE_ENTERPRISE_ID << CERT_SYSTEM_STORE_LOCATION_SHIFT
            }
            CurrentUser => CERT_SYSTEM_STORE_CURRENT_USER,
            CurrentUserGroupPolicy => {
                CERT_SYSTEM_STORE_CURRENT_USER_GROUP_POLICY_ID << CERT_SYSTEM_STORE_LOCATION_SHIFT
            }
        }
    }

    pub(crate) fn collect() -> Result<Vec<String>, RootError> {
        let mut roots = Vec::new();
        for (location, name) in STORE_SELECTIONS {
            let name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            let handle = unsafe {
                CertOpenStore(
                    CERT_STORE_PROV_SYSTEM_W,
                    0,
                    0,
                    location_flags(location)
                        | CERT_STORE_OPEN_EXISTING_FLAG
                        | CERT_STORE_READONLY_FLAG,
                    name.as_ptr().cast(),
                )
            };
            if handle.is_null() {
                continue;
            }
            let store = Store(handle);
            let mut cursor = Cursor(ptr::null());
            loop {
                let previous = std::mem::replace(&mut cursor.0, ptr::null());
                let certificate = unsafe { CertEnumCertificatesInStore(store.0, previous) };
                cursor.0 = certificate;
                if certificate.is_null() {
                    break;
                }
                if !server_auth_allowed(&enhanced_key_usage(certificate)) {
                    continue;
                }
                let context = unsafe { &*certificate };
                if context.pbCertEncoded.is_null() || context.cbCertEncoded == 0 {
                    continue;
                }
                let der = unsafe {
                    std::slice::from_raw_parts(
                        context.pbCertEncoded,
                        context.cbCertEncoded as usize,
                    )
                };
                if let Some(pem) = crate::cca::upstream_roots::certificate::decode_system_der(der)?
                {
                    roots.push(pem);
                }
            }
            store.close()?;
        }
        Ok(roots)
    }
}

#[cfg(windows)]
pub(crate) use native::collect;
