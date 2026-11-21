use super::super::evaluator::Vm;
use super::super::program::Position;
use super::super::values::{Fault, Value, int32, number_string, uint32};

pub(crate) fn parse(
    vm: &Vm,
    name: &str,
    args: &[Value],
    location: &Position,
) -> Result<Value, Fault> {
    let text = vm.state().text(args.first().unwrap_or(&Value::Undefined))?;
    let Some(text) = text.as_str() else {
        return Ok(Value::Number(f64::NAN));
    };
    let text = text.trim_start_matches(super::string::whitespace);
    if name == "parseFloat" {
        if text.starts_with("Infinity") || text.starts_with("+Infinity") {
            return Ok(Value::Number(f64::INFINITY));
        }
        if text.starts_with("-Infinity") {
            return Ok(Value::Number(f64::NEG_INFINITY));
        }
        let end = text
            .bytes()
            .take_while(|byte| byte.is_ascii_digit() || b"+-.eE".contains(byte))
            .count();
        let value = (1..=end)
            .rev()
            .find_map(|end| text[..end].parse::<f64>().ok())
            .unwrap_or(f64::NAN);
        return Ok(Value::Number(value));
    }
    let radix = match args.get(1) {
        None | Some(Value::Undefined) => 0,
        Some(Value::Number(value)) => int32(*value),
        _ => {
            return Err(Fault::error(
                "TypeError",
                format!("{name} expects a numeric radix."),
                location,
            ));
        }
    };
    let (negative, text) = if let Some(text) = text.strip_prefix('-') {
        (true, text)
    } else {
        (false, text.strip_prefix('+').unwrap_or(text))
    };
    let hex = text.starts_with("0x") || text.starts_with("0X");
    let radix = if radix == 0 {
        if hex { 16 } else { 10 }
    } else {
        radix
    };
    if !(2..=36).contains(&radix) {
        return Ok(Value::Number(f64::NAN));
    }
    let text = if radix == 16 && hex { &text[2..] } else { text };
    let mut integer = Nat::default();
    let mut digits = 0;
    for character in text.chars() {
        let Some(digit) = character.to_digit(radix as u32) else {
            break;
        };
        integer.multiply(radix as u32);
        integer.add_small(digit);
        digits += 1;
    }
    let value = if digits == 0 {
        f64::NAN
    } else {
        integer.float(0, negative)
    };
    Ok(Value::Number(value))
}

pub(crate) fn static_method(
    vm: &Vm,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    if name == "parseInt" || name == "parseFloat" {
        return parse(vm, name, &args, location);
    }
    let value = args.first().unwrap_or(&Value::Undefined);
    Ok(Value::Boolean(match (name, value) {
        ("isFinite", Value::Number(value)) => value.is_finite(),
        ("isNaN", Value::Number(value)) => value.is_nan(),
        ("isInteger", Value::Number(value)) => value.is_finite() && value.fract() == 0.0,
        ("isSafeInteger", Value::Number(value)) => {
            value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
        }
        _ => false,
    }))
}

pub(crate) fn method(
    _vm: &Vm,
    value: f64,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    if name == "valueOf" {
        return Ok(Value::Number(value));
    }
    let argument = match args.first() {
        None | Some(Value::Undefined) => None,
        Some(Value::Number(value)) => Some(if value.is_nan() { 0.0 } else { value.trunc() }),
        _ => {
            return Err(Fault::error(
                "TypeError",
                format!("Number.{name} expects a number argument."),
                location,
            ));
        }
    };
    let text = match name {
        "toString" => {
            let radix = argument.unwrap_or(10.0);
            if !(2.0..=36.0).contains(&radix) {
                return Err(Fault::error(
                    "Error",
                    "Number.toString radix must be between 2 and 36.",
                    location,
                ));
            }
            if radix == 10.0 || !value.is_finite() || value == 0.0 {
                number_string(value)
            } else {
                radix_string(value, radix as u32)
            }
        }
        "toFixed" => {
            let digits = argument.unwrap_or(0.0);
            if !(0.0..=100.0).contains(&digits) {
                return Err(Fault::error(
                    "RangeError",
                    "toFixed() digits argument must be between 0 and 100",
                    location,
                ));
            }
            if !value.is_finite() || value.abs() >= 1e21 {
                number_string(value)
            } else {
                let digits = digits as usize;
                let mut text = scaled(value.abs(), digits as i32).decimal();
                if digits > 0 {
                    if text.len() <= digits {
                        text = format!("{}{}", "0".repeat(digits + 1 - text.len()), text);
                    }
                    text.insert(text.len() - digits, '.');
                }
                if value < 0.0 {
                    text.insert(0, '-');
                }
                text
            }
        }
        "toPrecision" | "toExponential" => {
            if name == "toPrecision" && argument.is_none() {
                return Ok(Value::String(number_string(value).into()));
            }
            if let Some(digits) = argument {
                let minimum = if name == "toPrecision" { 1.0 } else { 0.0 };
                if !(minimum..=100.0).contains(&digits) {
                    return Err(Fault::error(
                        "RangeError",
                        format!("{name}() precision argument is out of range"),
                        location,
                    ));
                }
            }
            if !value.is_finite() {
                number_string(value)
            } else if name == "toExponential" && argument.is_none() {
                scientific_short(value)
            } else {
                let precision =
                    argument.unwrap_or(0.0) as usize + if name == "toExponential" { 1 } else { 0 };
                let mut exponent = decimal_exponent(value.abs());
                let mut digits = scaled(value.abs(), precision as i32 - 1 - exponent).decimal();
                if digits.len() > precision {
                    exponent += 1;
                    digits.pop();
                }
                if digits.len() < precision {
                    digits.push_str(&"0".repeat(precision - digits.len()));
                }
                let text =
                    if name == "toExponential" || exponent >= precision as i32 || exponent < -6 {
                        let mut text = digits;
                        if precision > 1 {
                            text.insert(1, '.');
                        }
                        format!("{text}e{}{exponent}", if exponent >= 0 { "+" } else { "" })
                    } else {
                        let point = exponent + 1;
                        if point <= 0 {
                            format!("0.{}{digits}", "0".repeat((-point) as usize))
                        } else if point as usize >= digits.len() {
                            format!("{digits}{}", "0".repeat(point as usize - digits.len()))
                        } else {
                            digits.insert(point as usize, '.');
                            digits
                        }
                    };
                if value < 0.0 {
                    format!("-{text}")
                } else {
                    text
                }
            }
        }
        _ => {
            return Err(Fault::error(
                "TypeError",
                format!("Number method '{name}' is not available in CodeMode."),
                location,
            ));
        }
    };
    Ok(Value::String(text.into()))
}

pub(crate) fn math_method(name: &str) -> bool {
    [
        "random",
        "max",
        "min",
        "abs",
        "acos",
        "acosh",
        "asin",
        "asinh",
        "atan",
        "atan2",
        "atanh",
        "floor",
        "ceil",
        "round",
        "trunc",
        "sign",
        "sqrt",
        "cbrt",
        "pow",
        "hypot",
        "cos",
        "cosh",
        "sin",
        "sinh",
        "tan",
        "tanh",
        "log",
        "log2",
        "log10",
        "log1p",
        "exp",
        "expm1",
        "f16round",
        "fround",
        "clz32",
        "imul",
        "sumPrecise",
    ]
    .contains(&name)
}

pub(crate) fn math(
    vm: &Vm,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    if name == "random" {
        let mut state = vm.state();
        state.random ^= state.random << 13;
        state.random ^= state.random >> 7;
        state.random ^= state.random << 17;
        return Ok(Value::Number(
            (state.random >> 11) as f64 / 9_007_199_254_740_992.0,
        ));
    }
    if name == "sumPrecise" {
        let items = vm.iterable(args.first().unwrap_or(&Value::Undefined), location)?;
        let numbers = items
            .into_iter()
            .map(|value| match value {
                Value::Number(value) => Ok(value),
                _ => Err(Fault::error(
                    "TypeError",
                    "Math.sumPrecise expects an iterable of numbers.",
                    location,
                )),
            })
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(Value::Number(exact_sum(&numbers)));
    }
    let number = |index: usize| -> Result<f64, Fault> {
        match args.get(index) {
            None => Ok(f64::NAN),
            Some(Value::Number(value)) => Ok(*value),
            _ => Err(Fault::error(
                "Error",
                format!("Math.{name} expects number arguments."),
                location,
            )),
        }
    };
    if ["max", "min", "hypot"].contains(&name) {
        let values = (0..args.len()).map(number).collect::<Result<Vec<_>, _>>()?;
        let value = if values.iter().any(|value| value.is_nan()) {
            if name == "hypot" && values.iter().any(|value| value.is_infinite()) {
                f64::INFINITY
            } else {
                f64::NAN
            }
        } else {
            match name {
                "max" => values.into_iter().fold(f64::NEG_INFINITY, |a, b| {
                    if a == 0.0 && b == 0.0 {
                        if a.is_sign_positive() || b.is_sign_positive() {
                            0.0
                        } else {
                            -0.0
                        }
                    } else {
                        a.max(b)
                    }
                }),
                "min" => values.into_iter().fold(f64::INFINITY, |a, b| {
                    if a == 0.0 && b == 0.0 {
                        if a.is_sign_negative() || b.is_sign_negative() {
                            -0.0
                        } else {
                            0.0
                        }
                    } else {
                        a.min(b)
                    }
                }),
                _ => values.into_iter().fold(0.0, f64::hypot),
            }
        };
        return Ok(Value::Number(value));
    }
    let a = number(0)?;
    let value = match name {
        "abs" => a.abs(),
        "acos" => a.acos(),
        "acosh" => a.acosh(),
        "asin" => a.asin(),
        "asinh" => a.asinh(),
        "atan" => a.atan(),
        "atan2" => a.atan2(number(1)?),
        "atanh" => a.atanh(),
        "floor" => a.floor(),
        "ceil" => a.ceil(),
        "round" => {
            if (-0.5..0.0).contains(&a) {
                -0.0
            } else if a.is_finite() && a.abs() < 4_503_599_627_370_496.0 {
                let floor = a.floor();
                if a - floor < 0.5 { floor } else { floor + 1.0 }
            } else {
                a
            }
        }
        "trunc" => a.trunc(),
        "sign" => {
            if a == 0.0 || a.is_nan() {
                a
            } else {
                a.signum()
            }
        }
        "sqrt" => a.sqrt(),
        "cbrt" => a.cbrt(),
        "pow" => {
            let b = number(1)?;
            if b == 0.0 {
                1.0
            } else if a.abs() == 1.0 && b.is_infinite() {
                f64::NAN
            } else {
                a.powf(b)
            }
        }
        "cos" => a.cos(),
        "cosh" => a.cosh(),
        "sin" => a.sin(),
        "sinh" => a.sinh(),
        "tan" => a.tan(),
        "tanh" => a.tanh(),
        "log" => a.ln(),
        "log2" => a.log2(),
        "log10" => a.log10(),
        "log1p" => a.ln_1p(),
        "exp" => a.exp(),
        "expm1" => a.exp_m1(),
        "fround" => (a as f32) as f64,
        "f16round" => half_round(a),
        "clz32" => uint32(a).leading_zeros() as f64,
        "imul" => int32(a).wrapping_mul(int32(number(1)?)) as f64,
        _ => {
            return Err(Fault::error(
                "Error",
                format!("Math.{name} is not available in CodeMode."),
                location,
            ));
        }
    };
    Ok(Value::Number(value))
}

#[derive(Clone, Default)]
struct Nat(Vec<u32>);

impl Nat {
    fn from_u64(value: u64) -> Self {
        let mut value = Self(vec![value as u32, (value >> 32) as u32]);
        value.trim();
        value
    }
    fn trim(&mut self) {
        while self.0.last() == Some(&0) {
            self.0.pop();
        }
    }
    fn bits(&self) -> usize {
        self.0.last().map_or(0, |word| {
            (self.0.len() - 1) * 32 + 32 - word.leading_zeros() as usize
        })
    }
    fn bit(&self, index: usize) -> bool {
        self.0
            .get(index / 32)
            .is_some_and(|word| word & (1 << (index % 32)) != 0)
    }
    fn compare(&self, other: &Self) -> std::cmp::Ordering {
        self.0
            .len()
            .cmp(&other.0.len())
            .then_with(|| self.0.iter().rev().cmp(other.0.iter().rev()))
    }
    fn add_small(&mut self, value: u32) {
        let mut carry = value as u64;
        let mut index = 0;
        while carry != 0 {
            if index == self.0.len() {
                self.0.push(0)
            }
            let sum = self.0[index] as u64 + carry;
            self.0[index] = sum as u32;
            carry = sum >> 32;
            index += 1;
        }
    }
    fn add(&mut self, other: &Self) {
        self.0.resize(self.0.len().max(other.0.len()), 0);
        let mut carry = 0u64;
        for (index, word) in self.0.iter_mut().enumerate() {
            let sum = *word as u64 + other.0.get(index).copied().unwrap_or(0) as u64 + carry;
            *word = sum as u32;
            carry = sum >> 32;
        }
        if carry != 0 {
            self.0.push(carry as u32)
        }
    }
    fn subtract(&mut self, other: &Self) {
        let mut borrow = 0u64;
        for (index, word) in self.0.iter_mut().enumerate() {
            let value = other.0.get(index).copied().unwrap_or(0) as u64 + borrow;
            let current = *word as u64;
            *word = current.wrapping_sub(value) as u32;
            borrow = u64::from(current < value);
        }
        self.trim();
    }
    fn multiply(&mut self, value: u32) {
        let mut carry = 0u64;
        for word in &mut self.0 {
            let product = *word as u64 * value as u64 + carry;
            *word = product as u32;
            carry = product >> 32;
        }
        if carry != 0 {
            self.0.push(carry as u32)
        }
        self.trim();
    }
    fn shift(&mut self, bits: usize) {
        if self.0.is_empty() {
            return;
        }
        let words = bits / 32;
        self.0.splice(0..0, std::iter::repeat_n(0, words));
        let bits = bits % 32;
        if bits == 0 {
            return;
        }
        let mut carry = 0u64;
        for word in &mut self.0 {
            let value = ((*word as u64) << bits) | carry;
            *word = value as u32;
            carry = value >> 32;
        }
        if carry != 0 {
            self.0.push(carry as u32)
        }
    }
    fn divide_small(&mut self, value: u32) -> u32 {
        let mut remainder = 0u64;
        for word in self.0.iter_mut().rev() {
            let current = (remainder << 32) | *word as u64;
            *word = (current / value as u64) as u32;
            remainder = current % value as u64;
        }
        self.trim();
        remainder as u32
    }
    fn divide(&self, divisor: &Self) -> (Self, Self) {
        let mut remainder = self.clone();
        let mut quotient = Self::default();
        if remainder.compare(divisor).is_lt() {
            return (quotient, remainder);
        }
        let shift = remainder.bits() - divisor.bits();
        quotient.0.resize(shift / 32 + 1, 0);
        for bit in (0..=shift).rev() {
            let mut current = divisor.clone();
            current.shift(bit);
            if !remainder.compare(&current).is_lt() {
                remainder.subtract(&current);
                quotient.0[bit / 32] |= 1 << (bit % 32);
            }
        }
        quotient.trim();
        (quotient, remainder)
    }
    fn decimal(self) -> String {
        self.radix(10)
    }
    fn radix(mut self, radix: u32) -> String {
        if self.0.is_empty() {
            return "0".into();
        }
        let mut digits = Vec::new();
        while !self.0.is_empty() {
            digits.push(
                char::from_digit(self.divide_small(radix), radix)
                    .expect("A radix remainder is a valid digit"),
            );
        }
        digits.into_iter().rev().collect()
    }
    fn float(&self, scale: i32, negative: bool) -> f64 {
        let bits = self.bits();
        if bits == 0 {
            return if negative { -0.0 } else { 0.0 };
        }
        let high = bits - 1;
        let shift = high.saturating_sub(52);
        let mut mantissa = 0u64;
        for index in shift..=high {
            if self.bit(index) {
                mantissa |= 1 << (index - shift)
            }
        }
        if shift > 0
            && self.bit(shift - 1)
            && ((0..shift - 1).any(|index| self.bit(index)) || mantissa & 1 != 0)
        {
            mantissa += 1
        }
        let mut exponent = high as i32 + scale;
        if mantissa == 1 << 53 {
            mantissa >>= 1;
            exponent += 1
        }
        let sign = if negative { 1 << 63 } else { 0 };
        if exponent > 1023 {
            return f64::from_bits(sign | (0x7ff << 52));
        }
        if exponent >= -1022 {
            mantissa <<= 52 - (63 - mantissa.leading_zeros() as usize);
            return f64::from_bits(
                sign | (((exponent + 1023) as u64) << 52) | (mantissa & ((1 << 52) - 1)),
            );
        }
        let shift = scale + 1074;
        if shift >= 0 {
            f64::from_bits(sign | (mantissa << (shift as usize)))
        } else {
            f64::from_bits(sign | (mantissa >> ((-shift) as usize)))
        }
    }
}

fn scaled(value: f64, scale: i32) -> Nat {
    let bits = value.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1 << 52) - 1)) | if exponent == 0 { 0 } else { 1 << 52 };
    let exponent = if exponent == 0 {
        -1074
    } else {
        exponent - 1075
    };
    let mut numerator = Nat::from_u64(mantissa);
    let mut denominator = Nat::from_u64(1);
    if exponent >= 0 {
        numerator.shift(exponent as usize)
    } else {
        denominator.shift((-exponent) as usize)
    }
    if scale >= 0 {
        for _ in 0..scale {
            numerator.multiply(10)
        }
    } else {
        for _ in 0..-scale {
            denominator.multiply(10)
        }
    }
    let (mut quotient, mut remainder) = numerator.divide(&denominator);
    remainder.multiply(2);
    if !remainder.compare(&denominator).is_lt() {
        quotient.add_small(1)
    }
    quotient
}

fn decimal_exponent(value: f64) -> i32 {
    if value == 0.0 {
        return 0;
    }
    let mut exponent = value.log10().floor() as i32;
    while value < 10f64.powi(exponent) {
        exponent -= 1
    }
    while exponent < 308 && value >= 10f64.powi(exponent + 1) {
        exponent += 1
    }
    exponent
}
fn scientific_short(value: f64) -> String {
    if value == 0.0 {
        return "0e+0".into();
    }
    let text = number_string(value.abs());
    let mut exponent = decimal_exponent(value.abs());
    let mut digits = if let Some((coefficient, power)) = text.split_once('e') {
        exponent = power.parse().unwrap_or(exponent);
        coefficient.replace('.', "")
    } else {
        text.replace('.', "").trim_start_matches('0').to_owned()
    };
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }
    if digits.len() > 1 {
        digits.insert(1, '.');
    }
    format!(
        "{}{digits}e{}{exponent}",
        if value < 0.0 { "-" } else { "" },
        if exponent >= 0 { "+" } else { "" }
    )
}

fn radix_string(value: f64, radix: u32) -> String {
    let raw = value.abs().to_bits();
    let exp = ((raw >> 52) & 0x7ff) as i32;
    let mantissa = (raw & ((1 << 52) - 1)) | if exp == 0 { 0 } else { 1 << 52 };
    let exp = if exp == 0 { -1074 } else { exp - 1075 };
    let mut numerator = Nat::from_u64(mantissa);
    let mut denominator = Nat::from_u64(1);
    if exp >= 0 {
        numerator.shift(exp as usize)
    } else {
        denominator.shift((-exp) as usize)
    }
    let (integer, mut remainder) = numerator.divide(&denominator);
    let mut text = integer.radix(radix);
    if remainder.bits() != 0 {
        denominator.multiply(4);
        remainder.multiply(4);
        let mut low = Nat::from_u64(if mantissa == 1 << 52 { 1 } else { 2 });
        let mut high = Nat::from_u64(2);
        let mut digits = Vec::new();
        loop {
            remainder.multiply(radix);
            low.multiply(radix);
            high.multiply(radix);
            let (digit, rest) = remainder.divide(&denominator);
            let digit = digit.0.first().copied().unwrap_or(0);
            digits.push(digit);
            remainder = rest;
            let lower = remainder.compare(&low).is_lt();
            let mut distance = denominator.clone();
            distance.subtract(&remainder);
            let upper = distance.compare(&high).is_lt();
            if lower || upper {
                let mut doubled = remainder.clone();
                doubled.multiply(2);
                if upper && (!lower || !doubled.compare(&denominator).is_lt()) {
                    let mut carry = true;
                    for digit in digits.iter_mut().rev() {
                        *digit += 1;
                        if *digit < radix {
                            carry = false;
                            break;
                        }
                        *digit = 0;
                    }
                    if carry {
                        let mut integer = Nat::from_u64(mantissa);
                        if exp >= 0 {
                            integer.shift(exp as usize)
                        } else {
                            let mut divisor = Nat::from_u64(1);
                            divisor.shift((-exp) as usize);
                            integer = integer.divide(&divisor).0;
                        }
                        integer.add_small(1);
                        text = integer.radix(radix);
                    }
                }
                break;
            }
        }
        while digits.last() == Some(&0) {
            digits.pop();
        }
        if !digits.is_empty() {
            text.push('.');
            text.extend(digits.into_iter().map(|digit| {
                char::from_digit(digit, radix).expect("A radix remainder is a valid digit")
            }));
        }
    }
    if value < 0.0 {
        text.insert(0, '-')
    }
    text
}

fn exact_sum(values: &[f64]) -> f64 {
    if values.iter().any(|value| value.is_nan())
        || values.contains(&f64::INFINITY) && values.contains(&f64::NEG_INFINITY)
    {
        return f64::NAN;
    }
    if values.contains(&f64::INFINITY) {
        return f64::INFINITY;
    }
    if values.contains(&f64::NEG_INFINITY) {
        return f64::NEG_INFINITY;
    }
    let mut positive = Nat::default();
    let mut negative = Nat::default();
    for value in values {
        let bits = value.to_bits();
        let exp = ((bits >> 52) & 0x7ff) as usize;
        let mantissa = (bits & ((1 << 52) - 1)) | if exp == 0 { 0 } else { 1 << 52 };
        let mut integer = Nat::from_u64(mantissa);
        integer.shift(exp.saturating_sub(1));
        if value.is_sign_negative() {
            negative.add(&integer)
        } else {
            positive.add(&integer)
        }
    }
    let negative_result = positive.compare(&negative).is_lt();
    let magnitude = if negative_result {
        negative.subtract(&positive);
        negative
    } else {
        positive.subtract(&negative);
        positive
    };
    if magnitude.bits() == 0 {
        return if values
            .iter()
            .all(|value| *value == 0.0 && value.is_sign_negative())
        {
            -0.0
        } else {
            0.0
        };
    }
    magnitude.float(-1074, negative_result)
}

fn half_round(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    let exponent = value.abs().log2().floor() as i32;
    if exponent > 15 {
        return value.signum() * f64::INFINITY;
    }
    let step = 2f64.powi((exponent - 10).max(-24));
    let units = (value.abs() / step).round_ties_even();
    let result = units * step;
    if result >= 65520.0 {
        value.signum() * f64::INFINITY
    } else {
        value.signum() * result
    }
}
