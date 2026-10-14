use super::Error;
use duckdb::{Connection, ffi};
use std::{
    ffi::CString,
    ops::{Deref, DerefMut},
    path::Path,
    ptr,
};

pub(super) struct Native {
    connection: Connection,
    _database: Database,
}

struct Database(ffi::duckdb_database);
impl Drop for Database {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                ffi::duckdb_close(&mut self.0);
            }
        }
    }
}

impl Deref for Native {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.connection
    }
}
impl DerefMut for Native {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }
}

pub(super) fn open(path: &Path, spill: &Path) -> Result<Native, Error> {
    let path =
        CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| Error::Configuration)?;
    let settings = [
        (
            "temp_directory",
            spill.to_str().ok_or(Error::Configuration)?,
        ),
        ("threads", "1"),
        ("max_expression_depth", "1000"),
        ("max_memory", "256MiB"),
        ("max_temp_directory_size", "256MiB"),
        ("autoload_known_extensions", "false"),
        ("autoinstall_known_extensions", "false"),
        ("enable_external_access", "false"),
        ("lock_configuration", "true"),
    ]
    .into_iter()
    .map(|(key, value)| {
        Ok::<_, Error>((
            CString::new(key).map_err(|_| Error::Configuration)?,
            CString::new(value).map_err(|_| Error::Configuration)?,
        ))
    })
    .collect::<Result<Vec<_>, _>>()?;
    let mut config = ptr::null_mut();
    let configured = unsafe {
        ffi::duckdb_create_config(&mut config) == ffi::duckdb_state_DuckDBSuccess
            && settings.iter().all(|(key, value)| {
                ffi::duckdb_set_config(config, key.as_ptr(), value.as_ptr())
                    == ffi::duckdb_state_DuckDBSuccess
            })
    };
    if !configured {
        unsafe {
            ffi::duckdb_destroy_config(&mut config);
        }
        return Err(Error::Configuration);
    }
    let mut database = Database(ptr::null_mut());
    let mut error = ptr::null_mut();
    let opened =
        unsafe { ffi::duckdb_open_ext(path.as_ptr(), &mut database.0, config, &mut error) };
    unsafe {
        ffi::duckdb_destroy_config(&mut config);
        if !error.is_null() {
            ffi::duckdb_free(error.cast());
        }
    }
    if opened != ffi::duckdb_state_DuckDBSuccess || database.0.is_null() {
        return Err(Error::Unavailable);
    }
    let mut raw = ptr::null_mut();
    if unsafe { ffi::duckdb_connect(database.0, &mut raw) } != ffi::duckdb_state_DuckDBSuccess {
        return Err(Error::Unavailable);
    }
    let registered = unsafe { register(raw) };
    unsafe {
        ffi::duckdb_disconnect(&mut raw);
    }
    registered?;
    let connection = unsafe { Connection::open_from_raw(database.0) }?;
    Ok(Native {
        connection,
        _database: database,
    })
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
struct Sum {
    value: f64,
    error: f64,
    seen: bool,
}
impl Sum {
    fn add(&mut self, value: f64) {
        let next = self.value + value;
        self.error += if self.value.abs() > value.abs() {
            (self.value - next) + value
        } else {
            (value - next) + self.value
        };
        self.value = next;
        self.seen = true;
    }
}

unsafe fn register(connection: ffi::duckdb_connection) -> Result<(), Error> {
    let mut function = unsafe { ffi::duckdb_create_aggregate_function() };
    let mut double =
        unsafe { ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_DOUBLE) };
    if function.is_null() || double.is_null() {
        unsafe {
            ffi::duckdb_destroy_aggregate_function(&mut function);
            ffi::duckdb_destroy_logical_type(&mut double);
        }
        return Err(Error::Unavailable);
    }
    let registered = unsafe {
        ffi::duckdb_aggregate_function_set_name(function, c"sqlite_sum".as_ptr());
        ffi::duckdb_aggregate_function_add_parameter(function, double);
        ffi::duckdb_aggregate_function_set_return_type(function, double);
        ffi::duckdb_aggregate_function_set_functions(
            function,
            Some(size),
            Some(init),
            Some(update),
            Some(combine),
            Some(finalize),
        );
        ffi::duckdb_register_aggregate_function(connection, function)
    };
    unsafe {
        ffi::duckdb_destroy_aggregate_function(&mut function);
        ffi::duckdb_destroy_logical_type(&mut double);
    }
    if registered != ffi::duckdb_state_DuckDBSuccess {
        return Err(Error::Configuration);
    }
    Ok(())
}

unsafe extern "C" fn size(_: ffi::duckdb_function_info) -> ffi::idx_t {
    std::mem::size_of::<Sum>() as ffi::idx_t
}
unsafe extern "C" fn init(_: ffi::duckdb_function_info, state: ffi::duckdb_aggregate_state) {
    unsafe {
        state.cast::<Sum>().write(Sum::default());
    }
}
unsafe extern "C" fn update(
    _: ffi::duckdb_function_info,
    input: ffi::duckdb_data_chunk,
    states: *mut ffi::duckdb_aggregate_state,
) {
    unsafe {
        let vector = ffi::duckdb_data_chunk_get_vector(input, 0);
        let values = ffi::duckdb_vector_get_data(vector).cast::<f64>();
        let validity = ffi::duckdb_vector_get_validity(vector);
        for index in 0..ffi::duckdb_data_chunk_get_size(input) as usize {
            if validity.is_null() || ffi::duckdb_validity_row_is_valid(validity, index as u64) {
                let state = &mut *(*states.add(index)).cast::<Sum>();
                state.add(*values.add(index));
            }
        }
    }
}
unsafe extern "C" fn combine(
    _: ffi::duckdb_function_info,
    source: *mut ffi::duckdb_aggregate_state,
    target: *mut ffi::duckdb_aggregate_state,
    count: ffi::idx_t,
) {
    unsafe {
        for index in 0..count as usize {
            let source = *(*source.add(index)).cast::<Sum>();
            if !source.seen {
                continue;
            }
            let target = &mut *(*target.add(index)).cast::<Sum>();
            if !target.seen {
                *target = source;
                continue;
            }
            target.add(source.value);
            target.add(source.error);
        }
    }
}
unsafe extern "C" fn finalize(
    _: ffi::duckdb_function_info,
    source: *mut ffi::duckdb_aggregate_state,
    result: ffi::duckdb_vector,
    count: ffi::idx_t,
    offset: ffi::idx_t,
) {
    unsafe {
        ffi::duckdb_vector_ensure_validity_writable(result);
        let values = ffi::duckdb_vector_get_data(result).cast::<f64>();
        let validity = ffi::duckdb_vector_get_validity(result);
        for index in 0..count as usize {
            let state = &*(*source.add(index)).cast::<Sum>();
            ffi::duckdb_validity_set_row_validity(validity, offset + index as u64, state.seen);
            if state.seen {
                *values.add(offset as usize + index) = if state.value.is_infinite() {
                    state.value
                } else {
                    state.value + state.error
                };
            }
        }
    }
}
