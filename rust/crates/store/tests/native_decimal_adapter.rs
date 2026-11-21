use duckdb::{Connection, ffi, params};
use std::ptr;

struct Database(ffi::duckdb_database);

impl Drop for Database {
    fn drop(&mut self) {
        unsafe { ffi::duckdb_close(&mut self.0) };
    }
}

unsafe extern "C" fn identity(
    _: ffi::duckdb_function_info,
    input: ffi::duckdb_data_chunk,
    result: ffi::duckdb_vector,
) {
    unsafe {
        let vector = ffi::duckdb_data_chunk_get_vector(input, 0);
        copy(vector, ffi::duckdb_data_chunk_get_size(input), result);
    }
}

unsafe extern "C" fn cast(
    _: ffi::duckdb_function_info,
    count: ffi::idx_t,
    input: ffi::duckdb_vector,
    output: ffi::duckdb_vector,
) -> bool {
    unsafe {
        copy(input, count, output);
    }
    true
}

unsafe fn copy(input: ffi::duckdb_vector, count: ffi::idx_t, result: ffi::duckdb_vector) {
    unsafe {
        let values = ffi::duckdb_vector_get_data(input).cast::<ffi::duckdb_string_t>();
        let validity = ffi::duckdb_vector_get_validity(input);
        ffi::duckdb_vector_ensure_validity_writable(result);
        let output_validity = ffi::duckdb_vector_get_validity(result);
        for index in 0..count {
            let valid = validity.is_null() || ffi::duckdb_validity_row_is_valid(validity, index);
            ffi::duckdb_validity_set_row_validity(output_validity, index, valid);
            if valid {
                let value = values.add(index as usize);
                ffi::duckdb_vector_assign_string_element_len(
                    result,
                    index,
                    ffi::duckdb_string_t_data(value),
                    ffi::duckdb_string_t_length(*value).into(),
                );
            }
        }
    }
}

#[test]
fn native_decimal_transport_keeps_variable_coefficients_and_nulls() {
    let mut database = Database(ptr::null_mut());
    let mut raw = ptr::null_mut();
    unsafe {
        assert_eq!(
            ffi::duckdb_open(ptr::null(), &mut database.0),
            ffi::duckdb_state_DuckDBSuccess
        );
        assert_eq!(
            ffi::duckdb_connect(database.0, &mut raw),
            ffi::duckdb_state_DuckDBSuccess
        );
        let mut decimal = ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BLOB);
        let mut blob = ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BLOB);
        ffi::duckdb_logical_type_set_alias(decimal, c"ycoding_decimal".as_ptr());
        assert_eq!(
            ffi::duckdb_register_logical_type(raw, decimal, ptr::null_mut()),
            ffi::duckdb_state_DuckDBSuccess
        );
        let mut function = ffi::duckdb_create_scalar_function();
        ffi::duckdb_scalar_function_set_name(function, c"decimal_identity".as_ptr());
        ffi::duckdb_scalar_function_add_parameter(function, blob);
        ffi::duckdb_scalar_function_set_return_type(function, decimal);
        ffi::duckdb_scalar_function_set_function(function, Some(identity));
        assert_eq!(
            ffi::duckdb_register_scalar_function(raw, function),
            ffi::duckdb_state_DuckDBSuccess
        );
        ffi::duckdb_destroy_scalar_function(&mut function);
        let mut cast_function = ffi::duckdb_create_cast_function();
        ffi::duckdb_cast_function_set_source_type(cast_function, blob);
        ffi::duckdb_cast_function_set_target_type(cast_function, decimal);
        ffi::duckdb_cast_function_set_implicit_cast_cost(cast_function, 0);
        ffi::duckdb_cast_function_set_function(cast_function, Some(cast));
        assert_eq!(
            ffi::duckdb_register_cast_function(raw, cast_function),
            ffi::duckdb_state_DuckDBSuccess
        );
        ffi::duckdb_destroy_cast_function(&mut cast_function);
        ffi::duckdb_destroy_logical_type(&mut decimal);
        ffi::duckdb_destroy_logical_type(&mut blob);
        ffi::duckdb_disconnect(&mut raw);
    }
    let connection = unsafe { Connection::open_from_raw(database.0) }.unwrap();
    connection
        .execute_batch("CREATE TABLE coefficients (id BIGINT, amount ycoding_decimal)")
        .unwrap();
    let coefficients = [vec![], vec![0], vec![255; 512], (0..=255).collect()];
    for (index, coefficient) in coefficients.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO coefficients VALUES (?, decimal_identity(?))",
                params![index as i64, coefficient],
            )
            .unwrap();
        let actual: Vec<u8> = connection
            .query_row(
                "SELECT amount FROM coefficients WHERE id=?",
                [index as i64],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(&actual, coefficient);
    }
    let kind: String = connection
        .query_row(
            "SELECT typeof(amount) FROM coefficients LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kind, "ycoding_decimal");
    let null: Option<Vec<u8>> = connection
        .query_row("SELECT decimal_identity(NULL::BLOB)", [], |row| row.get(0))
        .unwrap();
    assert_eq!(null, None);
    connection
        .execute(
            "INSERT INTO coefficients VALUES (99, ?)",
            [vec![255_u8; 1024]],
        )
        .unwrap();
    let direct: Vec<u8> = connection
        .query_row("SELECT amount FROM coefficients WHERE id=99", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(direct, vec![255_u8; 1024]);
    let null: Option<Vec<u8>> = connection
        .query_row("SELECT CAST(NULL::BLOB AS ycoding_decimal)", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(null, None);
}
