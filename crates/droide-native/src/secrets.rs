//! Credential storage.
//!
//! Contract: `specs/90-native-layer.md` §"keytar (keyring)" and
//! `specs/50-transport-and-auth.md` (credentials file layout). The helper's job
//! is narrow and auditable: seal a byte string with the OS facility and unseal it.
//!
//! * Windows — DPAPI (`CryptProtectData`), user scope, optional entropy.
//! * Other targets — not implemented yet; the call fails loudly rather than
//!   storing a secret in plaintext.
//!
//! The `unsafe` here is confined to four FFI calls with explicit buffer
//! handling; every pointer is checked before use and every allocation is freed.

/// Why sealing or unsealing failed.
#[derive(Debug, PartialEq, Eq)]
pub enum SecretError {
    /// The platform has no implementation yet.
    Unsupported(&'static str),
    /// The OS rejected the operation (DPAPI returns a Win32 error code).
    Platform(u32),
    /// The sealed blob is empty or too large to be one of ours.
    InvalidBlob(usize),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(platform) => {
                write!(
                    formatter,
                    "credential sealing is not implemented for {platform}"
                )
            }
            Self::Platform(code) => write!(
                formatter,
                "the operating system refused the operation (code {code})"
            ),
            Self::InvalidBlob(size) => {
                write!(formatter, "sealed blob has an unusable size ({size} bytes)")
            }
        }
    }
}

impl std::error::Error for SecretError {}

/// Upper bound for a sealed secret; anything bigger is a caller bug.
pub const MAX_SECRET_BYTES: usize = 64 * 1024;

/// Seal `plaintext` so that only this user on this machine can open it.
pub fn protect(plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, SecretError> {
    if plaintext.len() > MAX_SECRET_BYTES {
        return Err(SecretError::InvalidBlob(plaintext.len()));
    }
    platform::protect(plaintext, entropy)
}

/// Unseal a blob produced by [`protect`].
pub fn unprotect(sealed: &[u8], entropy: &[u8]) -> Result<Vec<u8>, SecretError> {
    if sealed.is_empty() || sealed.len() > MAX_SECRET_BYTES * 2 {
        return Err(SecretError::InvalidBlob(sealed.len()));
    }
    platform::unprotect(sealed, entropy)
}

// FFI is unavoidable for DPAPI. The allow is scoped to this module, and each
// `unsafe` block states the pointer/lifetime invariant it relies on.
#[cfg(windows)]
#[allow(unsafe_code)]
mod platform {
    //! DPAPI bindings. `unsafe` is limited to calling four documented APIs and
    //! copying out of the buffers they hand back.

    use super::{SecretError, MAX_SECRET_BYTES};
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            data_in: *const DataBlob,
            description: *const u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            data_in: *const DataBlob,
            description: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    /// DPAPI user scope; no UI prompt.
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    fn blob(bytes: &[u8]) -> Option<DataBlob> {
        if bytes.is_empty() {
            return None;
        }
        let length = u32::try_from(bytes.len()).ok()?;
        Some(DataBlob {
            cb_data: length,
            pb_data: bytes.as_ptr().cast_mut(),
        })
    }

    fn take(out: DataBlob) -> Result<Vec<u8>, SecretError> {
        if out.pb_data.is_null() {
            return Err(SecretError::Platform(0));
        }
        let length = out.cb_data as usize;
        if length > MAX_SECRET_BYTES * 2 {
            // Free before refusing: the buffer belongs to us now.
            unsafe {
                LocalFree(out.pb_data.cast::<c_void>());
            }
            return Err(SecretError::InvalidBlob(length));
        }
        // SAFETY: DPAPI returned a buffer of `cb_data` bytes that we own.
        let copied = unsafe { std::slice::from_raw_parts(out.pb_data, length) }.to_vec();
        unsafe {
            LocalFree(out.pb_data.cast::<c_void>());
        }
        Ok(copied)
    }

    pub fn protect(plaintext: &[u8], entropy: &[u8]) -> Result<Vec<u8>, SecretError> {
        let input = blob(plaintext).ok_or(SecretError::InvalidBlob(plaintext.len()))?;
        let entropy_blob = blob(entropy);
        let entropy_ptr = entropy_blob
            .as_ref()
            .map_or(ptr::null(), |value| value as *const DataBlob);
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };

        // SAFETY: pointers refer to live locals for the duration of the call;
        // input lengths were bounded above.
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                entropy_ptr,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(SecretError::Platform(last_error()));
        }
        take(output)
    }

    pub fn unprotect(sealed: &[u8], entropy: &[u8]) -> Result<Vec<u8>, SecretError> {
        let input = blob(sealed).ok_or(SecretError::InvalidBlob(sealed.len()))?;
        let entropy_blob = blob(entropy);
        let entropy_ptr = entropy_blob
            .as_ref()
            .map_or(ptr::null(), |value| value as *const DataBlob);
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let mut description: *mut u16 = ptr::null_mut();

        // SAFETY: as above; `description` is freed immediately below.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                &mut description,
                entropy_ptr,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if !description.is_null() {
            unsafe {
                LocalFree(description.cast::<c_void>());
            }
        }
        if ok == 0 {
            return Err(SecretError::Platform(last_error()));
        }
        take(output)
    }

    fn last_error() -> u32 {
        std::io::Error::last_os_error()
            .raw_os_error()
            .and_then(|code| u32::try_from(code).ok())
            .unwrap_or(0)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::SecretError;

    pub fn protect(_plaintext: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, SecretError> {
        Err(SecretError::Unsupported(std::env::consts::OS))
    }

    pub fn unprotect(_sealed: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, SecretError> {
        Err(SecretError::Unsupported(std::env::consts::OS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn round_trips_a_secret() {
        let sealed = protect(b"api-key-123", b"droide-cli").expect("seal");
        assert_ne!(sealed, b"api-key-123");
        let opened = unprotect(&sealed, b"droide-cli").expect("unseal");
        assert_eq!(opened, b"api-key-123");
    }

    #[cfg(windows)]
    #[test]
    fn a_tampered_blob_is_refused() {
        let mut sealed = protect(b"secret", b"entropy").expect("seal");
        let last = sealed.len() - 1;
        sealed[last] ^= 0xff;
        assert!(unprotect(&sealed, b"entropy").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn the_wrong_entropy_is_refused() {
        let sealed = protect(b"secret", b"right").expect("seal");
        assert!(unprotect(&sealed, b"wrong").is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn unsupported_platforms_fail_loudly() {
        assert_eq!(
            protect(b"x", b""),
            Err(SecretError::Unsupported(std::env::consts::OS))
        );
    }

    #[test]
    fn an_oversized_secret_is_refused_before_the_platform_call() {
        let huge = vec![0u8; MAX_SECRET_BYTES + 1];
        assert_eq!(
            protect(&huge, b""),
            Err(SecretError::InvalidBlob(MAX_SECRET_BYTES + 1))
        );
    }

    #[test]
    fn an_empty_blob_is_refused() {
        assert_eq!(unprotect(&[], b""), Err(SecretError::InvalidBlob(0)));
    }
}
