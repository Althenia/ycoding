use super::Error;
use crate::Decimal;
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

const BASE: u64 = 1_000_000_000;
const SEEN: u32 = 1;
const NEGATIVE: u32 = 2;
const FAILED: crate::Error = crate::Error::Rejected("native decimal aggregate failed");

#[repr(C)]
#[derive(Clone, Copy)]
struct Sum {
    words: *mut u32,
    length: u32,
    capacity: u32,
    scale: i32,
    flags: u32,
}

#[repr(C)]
struct Allocation {
    data: *mut std::ffi::c_void,
    status: u32,
    reserved: u32,
}

unsafe extern "C" {
    fn ycoding_decimal_state_size(info: ffi::duckdb_function_info) -> ffi::idx_t;
    fn ycoding_decimal_state_init(
        info: ffi::duckdb_function_info,
        state: ffi::duckdb_aggregate_state,
    );
    fn ycoding_decimal_arena_allocate(bytes: u64) -> Allocation;
    fn ycoding_decimal_install_arena(function: ffi::duckdb_aggregate_function) -> u32;
    fn ycoding_decimal_output_prepare(vector: ffi::duckdb_vector) -> u32;
    fn ycoding_decimal_output_assign(
        vector: ffi::duckdb_vector,
        row: u64,
        data: *const std::ffi::c_char,
        length: u64,
    ) -> u32;
}

fn allocate<T>(count: usize) -> Result<*mut T, crate::Error> {
    let bytes = count.checked_mul(std::mem::size_of::<T>()).ok_or(FAILED)?;
    let allocation =
        unsafe { ycoding_decimal_arena_allocate(bytes.try_into().map_err(|_| FAILED)?) };
    if allocation.status != 0 || (bytes != 0 && allocation.data.is_null()) {
        return Err(FAILED);
    }
    Ok(allocation.data.cast())
}

#[derive(Clone, Copy)]
struct Parts<'a> {
    words: &'a [u32],
    scale: i32,
    negative: bool,
}

impl Sum {
    unsafe fn parts(&self) -> Result<Parts<'_>, crate::Error> {
        if self.length > self.capacity || self.length as usize > Decimal::COEFFICIENT_WORDS {
            return Err(FAILED);
        }
        let words = if self.length == 0 {
            &[]
        } else {
            if self.words.is_null() {
                return Err(FAILED);
            }
            unsafe { std::slice::from_raw_parts(self.words, self.length as usize) }
        };
        Ok(Parts {
            words,
            scale: self.scale,
            negative: self.flags & NEGATIVE != 0,
        })
    }

    fn publish(&mut self, value: Parts<'_>, replace_storage: bool) -> Result<(), crate::Error> {
        check_size(value.words)?;
        if replace_storage || value.words.len() > self.capacity as usize {
            let capacity = value.words.len().next_power_of_two();
            let pointer = allocate::<u32>(capacity)?;
            unsafe { ptr::copy_nonoverlapping(value.words.as_ptr(), pointer, value.words.len()) };
            self.words = pointer;
            self.capacity = capacity.try_into().map_err(|_| FAILED)?;
        } else if !value.words.is_empty() {
            unsafe {
                ptr::copy_nonoverlapping(value.words.as_ptr(), self.words, value.words.len());
            }
        }
        self.length = value.words.len().try_into().map_err(|_| FAILED)?;
        self.scale = value.scale;
        self.flags = SEEN | if value.negative { NEGATIVE } else { 0 };
        Ok(())
    }
}

struct Workspace {
    words: *mut u32,
    capacity: usize,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            words: ptr::null_mut(),
            capacity: 0,
        }
    }
}

impl Workspace {
    fn ensure(&mut self, capacity: usize) -> Result<(), crate::Error> {
        if capacity > Decimal::COEFFICIENT_WORDS + 128 {
            return Err(FAILED);
        }
        if capacity > self.capacity {
            let capacity = capacity.max(8).next_power_of_two();
            self.words = allocate(capacity.checked_mul(6).ok_or(FAILED)?)?;
            unsafe { ptr::write_bytes(self.words, 0, capacity * 6) };
            self.capacity = capacity;
        }
        Ok(())
    }

    fn buffers(&mut self) -> [&mut [u32]; 6] {
        let all = unsafe { std::slice::from_raw_parts_mut(self.words, self.capacity * 6) };
        let (a, rest) = all.split_at_mut(self.capacity);
        let (b, rest) = rest.split_at_mut(self.capacity);
        let (c, rest) = rest.split_at_mut(self.capacity);
        let (d, rest) = rest.split_at_mut(self.capacity);
        let (e, f) = rest.split_at_mut(self.capacity);
        [a, b, c, d, e, f]
    }
}

fn trim(words: &[u32]) -> usize {
    words
        .iter()
        .rposition(|word| *word != 0)
        .map_or(0, |index| index + 1)
}

fn check_size(words: &[u32]) -> Result<(), crate::Error> {
    Decimal::check_coefficient_size(words)
}

fn normalize(
    words: &mut [u32],
    mut length: usize,
    mut scale: i32,
    negative: bool,
) -> Result<Parts<'_>, crate::Error> {
    length = trim(&words[..length]);
    if length == 0 {
        return Ok(Parts {
            words: &words[..0],
            scale: 0,
            negative: false,
        });
    }
    while words[0].is_multiple_of(10) {
        let mut carry = 0_u64;
        for word in words[..length].iter_mut().rev() {
            let value = carry * BASE + u64::from(*word);
            *word = (value / 10) as u32;
            carry = value % 10;
        }
        length = trim(&words[..length]);
        scale = scale.checked_sub(1).ok_or(FAILED)?;
    }
    check_size(&words[..length])?;
    Ok(Parts {
        words: &words[..length],
        scale,
        negative,
    })
}

fn multiply(words: &mut [u32], mut length: usize, factor: u32) -> Result<usize, crate::Error> {
    let mut carry = 0_u64;
    for word in &mut words[..length] {
        let value = u64::from(*word) * u64::from(factor) + carry;
        *word = (value % BASE) as u32;
        carry = value / BASE;
    }
    if carry != 0 {
        *words.get_mut(length).ok_or(FAILED)? = carry as u32;
        length += 1;
    }
    Ok(length)
}

fn align(value: Parts<'_>, scale: i32, output: &mut [u32]) -> Result<usize, crate::Error> {
    output.fill(0);
    if value.words.is_empty() {
        return Ok(0);
    }
    let shift = u32::try_from(i64::from(scale) - i64::from(value.scale)).map_err(|_| FAILED)?;
    let zeros = (shift / 9) as usize;
    let length = value
        .words
        .len()
        .checked_add(zeros)
        .filter(|length| *length <= Decimal::COEFFICIENT_WORDS)
        .ok_or(FAILED)?;
    output
        .get_mut(zeros..length)
        .ok_or(FAILED)?
        .copy_from_slice(value.words);
    let length = multiply(output, length, 10_u32.pow(shift % 9))?;
    check_size(&output[..length])?;
    Ok(length)
}

fn add<'a>(
    left: Parts<'_>,
    right: Parts<'_>,
    a: &mut [u32],
    b: &mut [u32],
    output: &'a mut [u32],
) -> Result<Parts<'a>, crate::Error> {
    if left.words.is_empty() || right.words.is_empty() {
        let value = if left.words.is_empty() { right } else { left };
        output
            .get_mut(..value.words.len())
            .ok_or(FAILED)?
            .copy_from_slice(value.words);
        return normalize(output, value.words.len(), value.scale, value.negative);
    }
    let scale = left.scale.max(right.scale);
    let alen = align(left, scale, a)?;
    let blen = align(right, scale, b)?;
    let length = alen.max(blen);
    output.fill(0);
    if left.negative == right.negative {
        let mut carry = 0_u64;
        for index in 0..length {
            let sum = u64::from(a[index]) + u64::from(b[index]) + carry;
            output[index] = (sum % BASE) as u32;
            carry = sum / BASE;
        }
        let length = if carry == 0 {
            length
        } else {
            *output.get_mut(length).ok_or(FAILED)? = carry as u32;
            length + 1
        };
        return normalize(output, length, scale, left.negative);
    }
    let ordering = alen
        .cmp(&blen)
        .then_with(|| a[..alen].iter().rev().cmp(b[..blen].iter().rev()));
    let (greater, lesser, negative) = if ordering.is_lt() {
        (b, a, right.negative)
    } else {
        (a, b, left.negative)
    };
    let mut borrow = 0_i64;
    for index in 0..length {
        let value = i64::from(greater[index]) - i64::from(lesser[index]) - borrow;
        borrow = i64::from(value < 0);
        output[index] = if value < 0 {
            value + BASE as i64
        } else {
            value
        } as u32;
    }
    if borrow != 0 {
        return Err(FAILED);
    }
    normalize(output, length, scale, negative)
}

#[derive(Clone, Copy)]
struct Header {
    scale: i32,
    negative: bool,
    words: usize,
}

fn header(bytes: &[u8]) -> Result<Header, crate::Error> {
    if bytes == [1] {
        return Ok(Header {
            scale: 0,
            negative: false,
            words: 0,
        });
    }
    if bytes.len() < 11 || bytes.len() > super::ROW_BYTES || !matches!(bytes[0], 0 | 2) {
        return Err(FAILED);
    }
    let negative = bytes[0] == 0;
    let mask = if negative { 255 } else { 0 };
    if bytes.last() != Some(&mask) {
        return Err(FAILED);
    }
    let exponent_bytes: [u8; 8] = bytes[1..9].try_into().map_err(|_| FAILED)?;
    let exponent =
        (u64::from_be_bytes(exponent_bytes.map(|byte| byte ^ mask)) ^ (1_u64 << 63)) as i64;
    let digits = &bytes[9..bytes.len() - 1];
    if digits.iter().enumerate().any(|(index, digit)| {
        let digit = digit ^ mask;
        !(1..=10).contains(&digit) || (digit == 1 && (index == 0 || index + 1 == digits.len()))
    }) {
        return Err(FAILED);
    }
    let scale = (digits.len() as i64)
        .checked_sub(exponent)
        .and_then(|scale| i32::try_from(scale).ok())
        .ok_or(FAILED)?;
    Ok(Header {
        scale,
        negative,
        words: digits.len().div_ceil(9),
    })
}

fn decode<'a>(
    bytes: &[u8],
    metadata: Header,
    output: &'a mut [u32],
) -> Result<Parts<'a>, crate::Error> {
    if metadata.words == 0 {
        return normalize(output, 0, 0, false);
    }
    let mask = if metadata.negative { 255 } else { 0 };
    for (index, chunk) in bytes[9..bytes.len() - 1].rchunks(9).enumerate() {
        *output.get_mut(index).ok_or(FAILED)? = chunk.iter().fold(0_u32, |value, byte| {
            value * 10 + u32::from((byte ^ mask) - 1)
        });
    }
    normalize(output, metadata.words, metadata.scale, metadata.negative)
}

fn from_number(value: f64, output: &mut [u32]) -> Result<Parts<'_>, crate::Error> {
    if !value.is_finite() {
        return Err(FAILED);
    }
    let bits = value.to_bits();
    let exponent = ((bits >> 52) & 2047) as i32;
    let mut significand = bits & ((1_u64 << 52) - 1);
    let mut power = if exponent == 0 {
        -1074
    } else {
        exponent - 1075
    };
    if exponent != 0 {
        significand |= 1_u64 << 52;
    }
    if significand == 0 {
        return normalize(output, 0, 0, false);
    }
    let zeros = significand.trailing_zeros();
    significand >>= zeros;
    power += zeros as i32;
    let mut length = 0;
    while significand != 0 {
        *output.get_mut(length).ok_or(FAILED)? = (significand % BASE) as u32;
        significand /= BASE;
        length += 1;
    }
    for _ in 0..power.unsigned_abs() {
        length = multiply(output, length, if power < 0 { 5 } else { 2 })?;
    }
    normalize(
        output,
        length,
        if power < 0 { -power } else { 0 },
        bits >> 63 != 0,
    )
}

fn required(left: Parts<'_>, right: Header) -> Result<usize, crate::Error> {
    if left.words.is_empty() || right.words == 0 {
        return Ok(left.words.len().max(right.words) + 2);
    }
    let scale = left.scale.max(right.scale);
    let a = usize::try_from((i64::from(scale) - i64::from(left.scale)) / 9).map_err(|_| FAILED)?;
    let b = usize::try_from((i64::from(scale) - i64::from(right.scale)) / 9).map_err(|_| FAILED)?;
    Ok((left.words.len() + a).max(right.words + b) + 2)
}

enum Input<'a> {
    Blob(&'a [u8]),
    Number(f64),
    State(Parts<'a>),
}

fn accumulate(
    state: &mut Sum,
    input: Input<'_>,
    workspace: &mut Workspace,
) -> Result<(), crate::Error> {
    let old = *state;
    let left = unsafe { old.parts()? };
    let source_alias = matches!(&input, Input::State(parts) if !parts.words.is_empty() && std::ptr::eq(parts.words.as_ptr(), old.words));
    let metadata = match input {
        Input::Blob(bytes) => header(bytes)?,
        Input::Number(value) => Header {
            scale: if value == 0.0 { 0 } else { 1074 },
            negative: value.is_sign_negative(),
            words: 128,
        },
        Input::State(parts) => Header {
            scale: parts.scale,
            negative: parts.negative,
            words: parts.words.len(),
        },
    };
    let capacity = if matches!(input, Input::Number(_)) {
        left.words.len().max(256) + 128
    } else {
        required(left, metadata)?
    };
    workspace.ensure(capacity)?;
    let [input_buffer, a, b, output, _, _] = workspace.buffers();
    let right = match input {
        Input::Blob(bytes) => decode(bytes, metadata, input_buffer)?,
        Input::Number(value) => from_number(value, input_buffer)?,
        Input::State(parts) => parts,
    };
    let value = add(left, right, a, b, output)?;
    state.publish(value, source_alias)
}

fn encode(value: Parts<'_>) -> Result<(*const u8, usize), crate::Error> {
    static ZERO: [u8; 1] = [1];
    check_size(value.words)?;
    if value.words.is_empty() {
        return Ok((ZERO.as_ptr(), 1));
    }
    let digits =
        (value.words.len() - 1) * 9 + value.words.last().ok_or(FAILED)?.ilog10() as usize + 1;
    let length = digits + 10;
    let output = allocate::<u8>(length)?;
    unsafe { ptr::write_bytes(output, 0, length) };
    let bytes = unsafe { std::slice::from_raw_parts_mut(output, length) };
    let mask = if value.negative { 255 } else { 0 };
    bytes[0] = if value.negative { 0 } else { 2 };
    bytes[1..9].copy_from_slice(
        &(((digits as i64 - i64::from(value.scale)) as u64 ^ (1_u64 << 63))
            .to_be_bytes()
            .map(|byte| byte ^ mask)),
    );
    let mut position = 9;
    for (index, word) in value.words.iter().rev().enumerate() {
        let width = if index == 0 { word.ilog10() + 1 } else { 9 };
        let mut divisor = 10_u32.pow(width - 1);
        for _ in 0..width {
            bytes[position] = (((word / divisor) % 10) as u8 + 1) ^ mask;
            position += 1;
            divisor /= 10;
        }
    }
    bytes[position] = mask;
    Ok((output, length))
}

fn binary(words: &[u32], output: &mut [u32]) -> Result<usize, crate::Error> {
    output.fill(0);
    let mut length = 0;
    for word in words.iter().rev() {
        let mut carry = u64::from(*word);
        for target in &mut output[..length] {
            let value = u64::from(*target) * BASE + carry;
            *target = value as u32;
            carry = value >> 32;
        }
        if carry != 0 {
            *output.get_mut(length).ok_or(FAILED)? = carry as u32;
            length += 1;
        }
    }
    Ok(length)
}

fn binary_bits(words: &[u32], length: usize) -> i32 {
    if length == 0 {
        0
    } else {
        ((length - 1) * 32) as i32 + (32 - words[length - 1].leading_zeros()) as i32
    }
}

fn binary_cmp(a: &[u32], alen: usize, b: &[u32], blen: usize) -> std::cmp::Ordering {
    alen.cmp(&blen)
        .then_with(|| a[..alen].iter().rev().cmp(b[..blen].iter().rev()))
}

fn binary_shift(
    words: &[u32],
    length: usize,
    shift: u32,
    output: &mut [u32],
) -> Result<usize, crate::Error> {
    output.fill(0);
    let offset = (shift / 32) as usize;
    let bits = shift % 32;
    let mut carry = 0_u64;
    for (index, word) in words[..length].iter().enumerate() {
        let value = (u64::from(*word) << bits) | carry;
        *output.get_mut(offset + index).ok_or(FAILED)? = value as u32;
        carry = value >> 32;
    }
    let length = offset + length;
    if carry == 0 {
        Ok(length)
    } else {
        *output.get_mut(length).ok_or(FAILED)? = carry as u32;
        Ok(length + 1)
    }
}

fn binary_subtract(
    words: &mut [u32],
    length: usize,
    other: &[u32],
    other_length: usize,
) -> Result<usize, crate::Error> {
    let mut borrow = 0_i64;
    for index in 0..length {
        let value = i64::from(words[index])
            - if index < other_length {
                i64::from(other[index])
            } else {
                0
            }
            - borrow;
        borrow = i64::from(value < 0);
        words[index] = value as u32;
    }
    if borrow != 0 {
        return Err(FAILED);
    }
    Ok(trim(&words[..length]))
}

fn public_number(value: Parts<'_>, workspace: &mut Workspace) -> Result<f64, crate::Error> {
    if value.words.is_empty() {
        return Ok(0.0);
    }
    let scale = value.scale.max(0);
    let one = Parts {
        words: &[1],
        scale: 0,
        negative: false,
    };
    workspace.ensure(
        required(
            value,
            Header {
                scale: 0,
                negative: false,
                words: 1,
            },
        )?
        .max(256),
    )?;
    let [decimal_n, decimal_d, numerator, denominator, temporary, _] = workspace.buffers();
    let nlength = align(value, scale, decimal_n)?;
    let dlength = align(one, scale, decimal_d)?;
    let mut nlength = binary(&decimal_n[..nlength], numerator)?;
    let mut dlength = binary(&decimal_d[..dlength], denominator)?;
    let mut exponent = binary_bits(numerator, nlength) - binary_bits(denominator, dlength);
    let ordering = if exponent >= 0 {
        let length = binary_shift(denominator, dlength, exponent as u32, temporary)?;
        binary_cmp(numerator, nlength, temporary, length)
    } else {
        let length = binary_shift(numerator, nlength, (-exponent) as u32, temporary)?;
        binary_cmp(temporary, length, denominator, dlength)
    };
    if ordering.is_lt() {
        exponent -= 1;
    }
    if exponent > 1023 {
        return Err(FAILED);
    }
    if exponent < -1075 {
        return Ok(f64::from_bits(u64::from(value.negative) << 63));
    }
    let shift = if exponent < -1022 {
        1074
    } else {
        52 - exponent
    };
    if shift >= 0 {
        nlength = binary_shift(numerator, nlength, shift as u32, temporary)?;
        numerator[..nlength].copy_from_slice(&temporary[..nlength]);
    } else {
        dlength = binary_shift(denominator, dlength, (-shift) as u32, temporary)?;
        denominator[..dlength].copy_from_slice(&temporary[..dlength]);
    }
    let width = binary_bits(numerator, nlength) - binary_bits(denominator, dlength);
    if width > 53 {
        return Err(FAILED);
    }
    let mut significand = 0_u64;
    for bit in (0..=width).rev() {
        let length = binary_shift(denominator, dlength, bit as u32, temporary)?;
        if !binary_cmp(numerator, nlength, temporary, length).is_lt() {
            nlength = binary_subtract(numerator, nlength, temporary, length)?;
            significand |= 1_u64 << bit;
        }
    }
    let remainder = binary_shift(numerator, nlength, 1, temporary)?;
    let rounding = binary_cmp(temporary, remainder, denominator, dlength);
    if rounding.is_gt() || (rounding.is_eq() && significand & 1 != 0) {
        significand += 1;
    }
    let magnitude = if exponent < -1022 {
        significand
    } else {
        if significand == 1_u64 << 53 {
            significand >>= 1;
            exponent += 1;
        }
        if exponent > 1023 {
            return Err(FAILED);
        }
        ((exponent + 1023) as u64) << 52 | significand.checked_sub(1_u64 << 52).ok_or(FAILED)?
    };
    let result = f64::from_bits(magnitude | u64::from(value.negative) << 63);
    if !result.is_finite() {
        return Err(FAILED);
    }
    Ok(result)
}

unsafe fn register(connection: ffi::duckdb_connection) -> Result<(), Error> {
    let mut result = unsafe { std::mem::zeroed() };
    let created = unsafe {
        ffi::duckdb_query(
            connection,
            c"SELECT count(*) FROM duckdb_types() WHERE schema_name='main' AND type_name='ycoding_decimal'".as_ptr(),
            &mut result,
        )
    };
    let exists = created == ffi::duckdb_state_DuckDBSuccess
        && unsafe { ffi::duckdb_value_int64(&mut result, 0, 0) } != 0;
    unsafe { ffi::duckdb_destroy_result(&mut result) };
    if created != ffi::duckdb_state_DuckDBSuccess {
        return Err(Error::Configuration);
    }
    if !exists {
        let mut kind =
            unsafe { ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BLOB) };
        if kind.is_null() {
            return Err(Error::Unavailable);
        }
        let registered = unsafe {
            ffi::duckdb_logical_type_set_alias(kind, c"ycoding_decimal".as_ptr());
            ffi::duckdb_register_logical_type(connection, kind, ptr::null_mut())
        };
        unsafe { ffi::duckdb_destroy_logical_type(&mut kind) };
        if registered != ffi::duckdb_state_DuckDBSuccess {
            return Err(Error::Configuration);
        }
    }
    unsafe {
        register_cast(connection)?;
    }
    for (name, decimal) in [(c"sqlite_sum", false), (c"decimal_sum", true)] {
        unsafe {
            register_sum(connection, name, decimal)?;
        }
    }
    unsafe {
        register_constructor(connection)?;
    }
    Ok(())
}

unsafe fn register_cast(connection: ffi::duckdb_connection) -> Result<(), Error> {
    unsafe {
        let mut function = ffi::duckdb_create_cast_function();
        let mut input = ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BLOB);
        let mut output = ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BLOB);
        if function.is_null() || input.is_null() || output.is_null() {
            ffi::duckdb_destroy_cast_function(&mut function);
            ffi::duckdb_destroy_logical_type(&mut input);
            ffi::duckdb_destroy_logical_type(&mut output);
            return Err(Error::Unavailable);
        }
        ffi::duckdb_logical_type_set_alias(output, c"ycoding_decimal".as_ptr());
        ffi::duckdb_cast_function_set_source_type(function, input);
        ffi::duckdb_cast_function_set_target_type(function, output);
        ffi::duckdb_cast_function_set_implicit_cast_cost(function, 0);
        ffi::duckdb_cast_function_set_function(function, Some(from_blob));
        let registered = ffi::duckdb_register_cast_function(connection, function);
        ffi::duckdb_destroy_cast_function(&mut function);
        ffi::duckdb_destroy_logical_type(&mut input);
        ffi::duckdb_destroy_logical_type(&mut output);
        if registered != ffi::duckdb_state_DuckDBSuccess {
            return Err(Error::Configuration);
        }
        Ok(())
    }
}

unsafe extern "C" fn from_blob(
    _: ffi::duckdb_function_info,
    count: ffi::idx_t,
    input: ffi::duckdb_vector,
    output: ffi::duckdb_vector,
) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        copy_blob(count, input, output)
    }))
    .unwrap_or(false)
}

unsafe fn copy_blob(
    count: ffi::idx_t,
    input: ffi::duckdb_vector,
    output: ffi::duckdb_vector,
) -> bool {
    unsafe {
        let values = ffi::duckdb_vector_get_data(input).cast::<ffi::duckdb_string_t>();
        let validity = ffi::duckdb_vector_get_validity(input);
        if ycoding_decimal_output_prepare(output) != 0 {
            return false;
        }
        let output_validity = ffi::duckdb_vector_get_validity(output);
        for row in 0..count {
            let valid = validity.is_null() || ffi::duckdb_validity_row_is_valid(validity, row);
            ffi::duckdb_validity_set_row_validity(output_validity, row, valid);
            if valid {
                let value = values.add(row as usize);
                if ycoding_decimal_output_assign(
                    output,
                    row,
                    ffi::duckdb_string_t_data(value),
                    ffi::duckdb_string_t_length(*value).into(),
                ) != 0
                {
                    return false;
                }
            }
        }
        true
    }
}

unsafe fn register_constructor(connection: ffi::duckdb_connection) -> Result<(), Error> {
    unsafe {
        let mut function = ffi::duckdb_create_scalar_function();
        let mut input = ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_DOUBLE);
        let mut output = ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BLOB);
        if function.is_null() || input.is_null() || output.is_null() {
            ffi::duckdb_destroy_scalar_function(&mut function);
            ffi::duckdb_destroy_logical_type(&mut input);
            ffi::duckdb_destroy_logical_type(&mut output);
            return Err(Error::Unavailable);
        }
        ffi::duckdb_logical_type_set_alias(output, c"ycoding_decimal".as_ptr());
        ffi::duckdb_scalar_function_set_name(function, c"decimal_from_double".as_ptr());
        ffi::duckdb_scalar_function_add_parameter(function, input);
        ffi::duckdb_scalar_function_set_return_type(function, output);
        ffi::duckdb_scalar_function_set_function(function, Some(from_double));
        let registered = ffi::duckdb_register_scalar_function(connection, function);
        ffi::duckdb_destroy_scalar_function(&mut function);
        ffi::duckdb_destroy_logical_type(&mut input);
        ffi::duckdb_destroy_logical_type(&mut output);
        if registered != ffi::duckdb_state_DuckDBSuccess {
            return Err(Error::Configuration);
        }
        Ok(())
    }
}

unsafe extern "C" fn from_double(
    info: ffi::duckdb_function_info,
    input: ffi::duckdb_data_chunk,
    output: ffi::duckdb_vector,
) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        construct_double(info, input, output)
    }))
    .is_err()
    {
        unsafe {
            ffi::duckdb_scalar_function_set_error(
                info,
                c"Native decimal constructor failed".as_ptr(),
            );
        }
    }
}

unsafe fn construct_double(
    info: ffi::duckdb_function_info,
    input: ffi::duckdb_data_chunk,
    output: ffi::duckdb_vector,
) {
    unsafe {
        let vector = ffi::duckdb_data_chunk_get_vector(input, 0);
        let values = ffi::duckdb_vector_get_data(vector).cast::<f64>();
        let validity = ffi::duckdb_vector_get_validity(vector);
        if ycoding_decimal_output_prepare(output) != 0 {
            ffi::duckdb_scalar_function_set_error(
                info,
                c"Native decimal constructor failed".as_ptr(),
            );
            return;
        }
        let output_validity = ffi::duckdb_vector_get_validity(output);
        for row in 0..ffi::duckdb_data_chunk_get_size(input) {
            let valid = validity.is_null() || ffi::duckdb_validity_row_is_valid(validity, row);
            ffi::duckdb_validity_set_row_validity(output_validity, row, valid);
            if !valid {
                continue;
            }
            match crate::Decimal::from_f64(*values.add(row as usize))
                .and_then(|value| value.to_bytes())
                .and_then(|value| {
                    if ycoding_decimal_output_assign(
                        output,
                        row,
                        value.as_ptr().cast(),
                        value.len() as u64,
                    ) == 0
                    {
                        Ok(())
                    } else {
                        Err(FAILED)
                    }
                }) {
                Ok(()) => {}
                Err(_) => {
                    ffi::duckdb_scalar_function_set_error(
                        info,
                        c"Invalid native decimal input".as_ptr(),
                    );
                    return;
                }
            }
        }
    }
}

static DECIMAL: bool = true;
static DOUBLE: bool = false;

unsafe fn register_sum(
    connection: ffi::duckdb_connection,
    name: &std::ffi::CStr,
    decimal: bool,
) -> Result<(), Error> {
    let mut function = unsafe { ffi::duckdb_create_aggregate_function() };
    let mut kind = unsafe {
        ffi::duckdb_create_logical_type(if decimal {
            ffi::DUCKDB_TYPE_DUCKDB_TYPE_BLOB
        } else {
            ffi::DUCKDB_TYPE_DUCKDB_TYPE_DOUBLE
        })
    };
    if function.is_null() || kind.is_null() {
        unsafe {
            ffi::duckdb_destroy_aggregate_function(&mut function);
            ffi::duckdb_destroy_logical_type(&mut kind);
        }
        return Err(Error::Unavailable);
    }
    let registered = unsafe {
        if decimal {
            ffi::duckdb_logical_type_set_alias(kind, c"ycoding_decimal".as_ptr());
        }
        ffi::duckdb_aggregate_function_set_name(function, name.as_ptr());
        ffi::duckdb_aggregate_function_set_extra_info(
            function,
            (if decimal { &DECIMAL } else { &DOUBLE }) as *const bool as *mut std::ffi::c_void,
            None,
        );
        ffi::duckdb_aggregate_function_add_parameter(function, kind);
        ffi::duckdb_aggregate_function_set_return_type(function, kind);
        ffi::duckdb_aggregate_function_set_functions(
            function,
            Some(ycoding_decimal_state_size),
            Some(ycoding_decimal_state_init),
            Some(update),
            Some(combine),
            Some(finalize),
        );
        if ycoding_decimal_install_arena(function) == 0 {
            ffi::duckdb_register_aggregate_function(connection, function)
        } else {
            ffi::duckdb_state_DuckDBError
        }
    };
    unsafe {
        ffi::duckdb_destroy_aggregate_function(&mut function);
        ffi::duckdb_destroy_logical_type(&mut kind);
    }
    if registered != ffi::duckdb_state_DuckDBSuccess {
        return Err(Error::Configuration);
    }
    Ok(())
}

fn aggregate_callback(
    info: ffi::duckdb_function_info,
    callback: impl FnOnce() -> Result<(), crate::Error>,
) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        #[cfg(test)]
        if PANIC_CALLBACK.with(|flag| flag.replace(false)) {
            panic!("synthetic native callback panic");
        }
        callback()
    }));
    if !matches!(result, Ok(Ok(()))) {
        unsafe {
            ffi::duckdb_aggregate_function_set_error(
                info,
                c"Native decimal aggregate failed".as_ptr(),
            );
        }
    }
}

unsafe extern "C" fn update(
    info: ffi::duckdb_function_info,
    input: ffi::duckdb_data_chunk,
    states: *mut ffi::duckdb_aggregate_state,
) {
    aggregate_callback(info, || unsafe {
        let vector = ffi::duckdb_data_chunk_get_vector(input, 0);
        let values = ffi::duckdb_vector_get_data(vector);
        let extra = ffi::duckdb_aggregate_function_get_extra_info(info).cast::<bool>();
        if extra.is_null() || states.is_null() {
            return Err(FAILED);
        }
        let decimal = *extra;
        let validity = ffi::duckdb_vector_get_validity(vector);
        let mut workspace = Workspace::default();
        for index in 0..ffi::duckdb_data_chunk_get_size(input) as usize {
            if validity.is_null() || ffi::duckdb_validity_row_is_valid(validity, index as u64) {
                let pointer = (*states.add(index)).cast::<Sum>();
                if pointer.is_null() || values.is_null() {
                    return Err(FAILED);
                }
                let mut state = *pointer;
                let value = if decimal {
                    let value = values.cast::<ffi::duckdb_string_t>().add(index);
                    Input::Blob(std::slice::from_raw_parts(
                        ffi::duckdb_string_t_data(value).cast::<u8>(),
                        ffi::duckdb_string_t_length(*value) as usize,
                    ))
                } else {
                    Input::Number(*values.cast::<f64>().add(index))
                };
                accumulate(&mut state, value, &mut workspace)?;
                ptr::write(pointer, state);
            }
        }
        Ok(())
    });
}
unsafe extern "C" fn combine(
    info: ffi::duckdb_function_info,
    source: *mut ffi::duckdb_aggregate_state,
    target: *mut ffi::duckdb_aggregate_state,
    count: ffi::idx_t,
) {
    aggregate_callback(info, || unsafe {
        if count != 0 && (source.is_null() || target.is_null()) {
            return Err(FAILED);
        }
        let mut workspace = Workspace::default();
        for index in 0..count as usize {
            let source_pointer = (*source.add(index)).cast::<Sum>();
            let target_pointer = (*target.add(index)).cast::<Sum>();
            if source_pointer.is_null() || target_pointer.is_null() {
                return Err(FAILED);
            }
            let source = *source_pointer;
            if source.flags & SEEN == 0 {
                continue;
            }
            let mut target = *target_pointer;
            accumulate(&mut target, Input::State(source.parts()?), &mut workspace)?;
            ptr::write(target_pointer, target);
        }
        Ok(())
    });
}
unsafe extern "C" fn finalize(
    info: ffi::duckdb_function_info,
    source: *mut ffi::duckdb_aggregate_state,
    result: ffi::duckdb_vector,
    count: ffi::idx_t,
    offset: ffi::idx_t,
) {
    aggregate_callback(info, || unsafe {
        let extra = ffi::duckdb_aggregate_function_get_extra_info(info).cast::<bool>();
        if extra.is_null() {
            return Err(FAILED);
        }
        emit(source, result, count, offset, *extra)
    });
}

unsafe fn emit(
    source: *mut ffi::duckdb_aggregate_state,
    result: ffi::duckdb_vector,
    count: ffi::idx_t,
    offset: ffi::idx_t,
    decimal: bool,
) -> Result<(), crate::Error> {
    unsafe {
        if count != 0 && source.is_null() {
            return Err(FAILED);
        }
        if ycoding_decimal_output_prepare(result) != 0 {
            return Err(FAILED);
        }
        let values = ffi::duckdb_vector_get_data(result).cast::<f64>();
        let validity = ffi::duckdb_vector_get_validity(result);
        let mut workspace = Workspace::default();
        for index in 0..count as usize {
            let pointer = (*source.add(index)).cast::<Sum>();
            if pointer.is_null() {
                return Err(FAILED);
            }
            let state = *pointer;
            let row = offset.checked_add(index as u64).ok_or(FAILED)?;
            let seen = state.flags & SEEN != 0;
            ffi::duckdb_validity_set_row_validity(validity, row, seen);
            if !seen {
                continue;
            }
            if decimal {
                let (pointer, length) = encode(state.parts()?)?;
                if ycoding_decimal_output_assign(result, row, pointer.cast(), length as u64) != 0 {
                    return Err(FAILED);
                }
            } else {
                if values.is_null() {
                    return Err(FAILED);
                }
                *values.add(row as usize) = public_number(state.parts()?, &mut workspace)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
thread_local! {
    static PANIC_CALLBACK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(super) mod proof {
    use super::*;

    #[repr(C)]
    struct Observation {
        memory: u64,
        temporary: u64,
        status: u32,
        reserved: u32,
    }

    unsafe extern "C" {
        fn ycoding_decimal_probe_observe(raw: ffi::duckdb_connection) -> Observation;
        fn ycoding_decimal_probe_scope(
            raw: ffi::duckdb_connection,
            callback: unsafe extern "C" fn(*mut std::ffi::c_void) -> u32,
            context: *mut std::ffi::c_void,
        ) -> u32;
        fn ycoding_decimal_probe_set(
            callback: Option<unsafe extern "C" fn(*mut std::ffi::c_void, u32)>,
            context: *mut std::ffi::c_void,
        );
        fn ycoding_decimal_probe_layout(field: u32) -> u64;
        fn ycoding_decimal_state_destroy(
            states: *mut ffi::duckdb_aggregate_state,
            count: ffi::idx_t,
        );
    }

    struct Probe(ffi::duckdb_connection);
    impl Probe {
        fn new(native: &Native) -> Self {
            let mut raw = ptr::null_mut();
            assert_eq!(
                unsafe { ffi::duckdb_connect(native._database.0, &mut raw) },
                ffi::duckdb_state_DuckDBSuccess
            );
            Self(raw)
        }
        fn observe(&self) -> (u64, u64) {
            let observation = unsafe { ycoding_decimal_probe_observe(self.0) };
            assert_eq!(observation.status, 0);
            (observation.memory, observation.temporary)
        }
        fn scope(&self, callback: impl FnOnce()) {
            struct Context<F> {
                callback: Option<F>,
                panic: Option<Box<dyn std::any::Any + Send>>,
            }
            impl<F: FnOnce()> Context<F> {
                unsafe extern "C" fn invoke(context: *mut std::ffi::c_void) -> u32 {
                    let context = unsafe { &mut *context.cast::<Self>() };
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        context.callback.take().unwrap()()
                    }));
                    match result {
                        Ok(()) => 0,
                        Err(panic) => {
                            context.panic = Some(panic);
                            4
                        }
                    }
                }
                fn run(&mut self, raw: ffi::duckdb_connection) -> u32 {
                    unsafe {
                        ycoding_decimal_probe_scope(raw, Self::invoke, (self as *mut Self).cast())
                    }
                }
            }
            let mut context = Context {
                callback: Some(callback),
                panic: None,
            };
            let status = context.run(self.0);
            if let Some(panic) = context.panic {
                std::panic::resume_unwind(panic);
            }
            assert_eq!(status, 0);
        }
    }
    impl Drop for Probe {
        fn drop(&mut self) {
            unsafe { ffi::duckdb_disconnect(&mut self.0) }
        }
    }

    fn state() -> Sum {
        let mut state = std::mem::MaybeUninit::<Sum>::uninit();
        unsafe {
            ycoding_decimal_state_init(ptr::null_mut(), state.as_mut_ptr().cast());
            state.assume_init()
        }
    }
    fn bytes(state: Sum) -> Vec<u8> {
        let (pointer, length) = encode(unsafe { state.parts().unwrap() }).unwrap();
        unsafe { std::slice::from_raw_parts(pointer, length).to_vec() }
    }

    pub(in crate::analytics) fn lifecycle(native: &Native) {
        let layout = [
            std::mem::size_of::<Sum>(),
            std::mem::align_of::<Sum>(),
            std::mem::offset_of!(Sum, words),
            std::mem::offset_of!(Sum, length),
            std::mem::offset_of!(Sum, capacity),
            std::mem::offset_of!(Sum, scale),
            std::mem::offset_of!(Sum, flags),
            std::mem::size_of::<Allocation>(),
            std::mem::align_of::<Allocation>(),
        ];
        for (field, expected) in layout.into_iter().enumerate() {
            assert_eq!(
                unsafe { ycoding_decimal_probe_layout(field as u32) },
                expected as u64
            );
        }
        assert!((24..=32).contains(&std::mem::size_of::<Sum>()));
        assert_eq!(unsafe { ycoding_decimal_arena_allocate(8) }.status, 1);
        let probe = Probe::new(native);
        let mut kind =
            unsafe { ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BLOB) };
        let mut chunk = unsafe { ffi::duckdb_create_data_chunk(&mut kind, 1) };
        unsafe {
            ffi::duckdb_destroy_logical_type(&mut kind);
            ffi::duckdb_data_chunk_set_size(chunk, 8);
        }
        let vector = unsafe { ffi::duckdb_data_chunk_get_vector(chunk, 0) };
        for row in 0..8 {
            unsafe {
                ffi::duckdb_vector_assign_string_element_len(
                    vector,
                    row,
                    [99_u8].as_ptr().cast(),
                    1,
                )
            }
        }
        probe.scope(|| {
            assert_eq!(unsafe { ycoding_decimal_arena_allocate(0) }.status, 0);
            assert_eq!(
                unsafe { ycoding_decimal_arena_allocate(u64::MAX) }.status,
                2
            );
            let mut source = state();
            let mut target = state();
            let mut workspace = Workspace::default();
            accumulate(&mut source, Input::Number(3.0), &mut workspace).unwrap();
            accumulate(&mut target, Input::Number(1.0), &mut workspace).unwrap();
            let original = bytes(source);
            let target_words = target.words;
            accumulate(
                &mut target,
                Input::State(unsafe { source.parts().unwrap() }),
                &mut workspace,
            )
            .unwrap();
            assert_eq!(bytes(source), original);
            assert_eq!(bytes(target), Decimal::from_i64(4).to_bytes().unwrap());
            assert_eq!(target.words, target_words);
            let alias = target;
            let aliased_original = bytes(alias);
            accumulate(
                &mut target,
                Input::State(unsafe { alias.parts().unwrap() }),
                &mut workspace,
            )
            .unwrap();
            assert_eq!(bytes(target), Decimal::from_i64(8).to_bytes().unwrap());
            assert_ne!(target.words, alias.words);
            assert_eq!(bytes(alias), aliased_original);
            probe.scope(|| {
                let mut inner = state();
                accumulate(&mut inner, Input::Number(-7.0), &mut Workspace::default()).unwrap();
                assert_eq!(bytes(inner), Decimal::from_i64(-7).to_bytes().unwrap());
            });
            assert_eq!(bytes(source), original);
            let mut zero = state();
            accumulate(&mut zero, Input::Number(-0.0), &mut workspace).unwrap();
            let mut absent = state();
            let mut states = [
                (&mut source as *mut Sum).cast(),
                (&mut absent as *mut Sum).cast(),
                (&mut zero as *mut Sum).cast(),
            ];
            unsafe {
                emit(states.as_mut_ptr(), vector, 3, 2, true).unwrap();
            }
        });
        let data = unsafe { ffi::duckdb_vector_get_data(vector).cast::<ffi::duckdb_string_t>() };
        let validity = unsafe { ffi::duckdb_vector_get_validity(vector) };
        for row in 0..8 {
            if row == 3 {
                assert!(!unsafe { ffi::duckdb_validity_row_is_valid(validity, row) });
                continue;
            }
            let value = unsafe { data.add(row as usize) };
            let actual = unsafe {
                std::slice::from_raw_parts(
                    ffi::duckdb_string_t_data(value).cast::<u8>(),
                    ffi::duckdb_string_t_length(*value) as usize,
                )
            };
            let expected = match row {
                2 => Decimal::from_i64(3).to_bytes().unwrap(),
                4 => vec![1],
                _ => vec![99],
            };
            assert_eq!(actual, expected);
        }
        unsafe {
            ffi::duckdb_destroy_data_chunk(&mut chunk);
        }
        assert_eq!(unsafe { ycoding_decimal_arena_allocate(8) }.status, 1);
    }

    pub(in crate::analytics) fn accounting(native: &Native) {
        let probe = Probe::new(native);
        let baseline = probe.observe();
        probe.scope(|| {
            let mut value = state();
            let mut workspace = Workspace::default();
            accumulate(&mut value, Input::Number(2.0), &mut workspace).unwrap();
            let first = probe.observe();
            assert!(first.0 > baseline.0);
            let mut coefficient = vec![2];
            coefficient.extend((10_000_u64 ^ (1_u64 << 63)).to_be_bytes());
            coefficient.extend(std::iter::repeat_n(10, 10_000));
            coefficient.push(0);
            accumulate(&mut value, Input::Blob(&coefficient), &mut workspace).unwrap();
            let _encoded = bytes(value);
            let grown = probe.observe();
            assert!(grown.0 > first.0);
            let mut states = [(&mut value as *mut Sum).cast()];
            unsafe {
                ycoding_decimal_state_destroy(states.as_mut_ptr(), 1);
            }
            assert_eq!(value.length, 0);
            assert!(value.words.is_null());
            assert_eq!(probe.observe(), grown);
        });
        assert_eq!(probe.observe(), baseline);
    }

    pub(in crate::analytics) fn budget(native: &Native) {
        let probe = Probe::new(native);
        let baseline = probe.observe();
        probe.scope(|| {
            let mut value = state();
            let mut workspace = Workspace::default();
            accumulate(&mut value, Input::Number(17.0), &mut workspace).unwrap();
            let original = bytes(value);
            let before = probe.observe();
            let failure = unsafe { ycoding_decimal_arena_allocate(268_435_456) };
            assert_eq!(failure.status, 3);
            assert!(failure.data.is_null());
            assert_eq!(bytes(value), original);
            assert_eq!(probe.observe(), before);
            accumulate(&mut value, Input::Number(-2.0), &mut workspace).unwrap();
            assert_eq!(bytes(value), Decimal::from_i64(15).to_bytes().unwrap());
        });
        assert_eq!(probe.observe(), baseline);
        assert_eq!(
            native
                .query_row("SELECT sqlite_sum(1.0::DOUBLE)", [], |row| row
                    .get::<_, f64>(0))
                .unwrap(),
            1.0
        );
        for setting in ["memory_limit", "max_temp_directory_size"] {
            assert_eq!(
                native
                    .query_row(
                        &format!("SELECT current_setting('{setting}')::VARCHAR"),
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                "256.0 MiB"
            );
        }
    }

    struct Hook {
        probe: Probe,
        memory: u64,
        temporary: u64,
        calls: [u64; 3],
        failed: bool,
        panic_after_update: bool,
        pause: Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>,
    }
    unsafe extern "C" fn observe_hook(context: *mut std::ffi::c_void, event: u32) {
        let hook = unsafe { &mut *context.cast::<Hook>() };
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let (memory, temporary) = hook.probe.observe();
            hook.memory = hook.memory.max(memory);
            hook.temporary = hook.temporary.max(temporary);
            hook.calls[(event - 1) as usize] += 1;
            if event == 1 && hook.panic_after_update {
                hook.panic_after_update = false;
                PANIC_CALLBACK.with(|flag| flag.set(true));
            }
            if let Some((started, release)) = hook.pause.take() {
                started.send(()).unwrap();
                release
                    .recv_timeout(std::time::Duration::from_secs(20))
                    .unwrap();
            }
        }))
        .is_err()
        {
            hook.failed = true;
        }
    }
    struct HookGuard;
    impl Drop for HookGuard {
        fn drop(&mut self) {
            unsafe {
                ycoding_decimal_probe_set(None, ptr::null_mut());
            }
        }
    }
    fn attach(hook: &mut Hook) -> HookGuard {
        unsafe {
            ycoding_decimal_probe_set(Some(observe_hook), (hook as *mut Hook).cast());
        }
        HookGuard
    }

    pub(in crate::analytics) fn spill(native: &Native) {
        let mut hook = Hook {
            probe: Probe::new(native),
            memory: 0,
            temporary: 0,
            calls: [0; 3],
            failed: false,
            panic_after_update: false,
            pause: None,
        };
        let baseline = hook.probe.observe();
        let guard = attach(&mut hook);
        let result=native.query_row("SELECT count(*),count(*) FILTER(WHERE amount=decimal_from_double(2)) FROM (SELECT repeat('x',762)||lpad(g::VARCHAR,6,'x') AS k,decimal_sum(decimal_from_double(1.0::DOUBLE)) AS amount FROM range(350000) groups(g) CROSS JOIN range(2) terms(term) GROUP BY k)",[],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?)));
        drop(guard);
        assert_eq!(result.unwrap(), (350_000, 350_000));
        assert!(!hook.failed);
        assert!(hook.calls[0] > 0 && hook.calls[1] > 0 && hook.calls[2] > 0);
        assert!(hook.memory > baseline.0 && hook.memory <= 268_435_456);
        assert!(hook.temporary > 0 && hook.temporary <= 268_435_456);
        assert_eq!(hook.probe.observe().1, 0);
    }

    pub(in crate::analytics) fn errors(native: &Native) {
        let probe = Probe::new(native);
        let baseline = probe.observe();
        let mut panic_hook = Hook {
            probe: Probe::new(native),
            memory: 0,
            temporary: 0,
            calls: [0; 3],
            failed: false,
            panic_after_update: true,
            pause: None,
        };
        let panic_guard = attach(&mut panic_hook);
        let error = native
            .query_row::<f64, _, _>(
                "SELECT sqlite_sum(i::DOUBLE) FROM range(4096) t(i)",
                [],
                |row| row.get(0),
            )
            .unwrap_err();
        drop(panic_guard);
        assert!(
            error
                .to_string()
                .contains("Native decimal aggregate failed")
        );
        assert!(!panic_hook.failed && panic_hook.calls[0] > 0 && panic_hook.memory > baseline.0);
        assert_eq!(unsafe { ycoding_decimal_arena_allocate(8) }.status, 1);
        assert_eq!(probe.observe(), baseline);
        let (started, reached) = std::sync::mpsc::channel();
        let (release, barrier) = std::sync::mpsc::channel();
        let interrupt = native.interrupt_handle();
        let canceller = std::thread::spawn(move || {
            reached
                .recv_timeout(std::time::Duration::from_secs(20))
                .unwrap();
            interrupt.interrupt();
            release.send(()).unwrap();
        });
        let mut hook = Hook {
            probe: Probe::new(native),
            memory: 0,
            temporary: 0,
            calls: [0; 3],
            failed: false,
            panic_after_update: false,
            pause: Some((started, barrier)),
        };
        let guard = attach(&mut hook);
        let interrupted = native.query_row::<f64, _, _>(
            "SELECT sqlite_sum(i::DOUBLE) FROM range(1000000000) t(i)",
            [],
            |row| row.get(0),
        );
        drop(guard);
        canceller.join().unwrap();
        assert!(
            interrupted
                .unwrap_err()
                .to_string()
                .to_lowercase()
                .contains("interrupt")
        );
        assert!(!hook.failed && hook.calls[0] > 0 && hook.memory > baseline.0);
        assert_eq!(unsafe { ycoding_decimal_arena_allocate(8) }.status, 1);
        assert_eq!(probe.observe(), baseline);
        assert_eq!(
            native
                .query_row("SELECT sqlite_sum(3.0::DOUBLE)", [], |row| row
                    .get::<_, f64>(0))
                .unwrap(),
            3.0
        );
    }
}
