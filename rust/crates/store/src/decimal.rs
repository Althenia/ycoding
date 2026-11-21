use crate::{Error, analytics::ROW_BYTES, session::codec::Field};
use std::cmp::Ordering;

const BASE: u64 = 1_000_000_000;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Decimal {
    negative: bool,
    scale: i32,
    coefficient: Vec<u32>,
}

impl Decimal {
    pub(crate) const COEFFICIENT_WORDS: usize = (ROW_BYTES - 10).div_ceil(9);

    pub(crate) fn check_coefficient_size(coefficient: &[u32]) -> Result<(), Error> {
        let digits = coefficient.len().saturating_sub(1).saturating_mul(9)
            + coefficient
                .last()
                .map_or(0, |value| value.checked_ilog10().unwrap_or(0) as usize + 1);
        if digits.saturating_add(10) > ROW_BYTES {
            return Err(Error::Rejected("native decimal exceeds row budget"));
        }
        Ok(())
    }

    pub fn from_f64(value: f64) -> Result<Self, Error> {
        if !value.is_finite() {
            return Err(Error::Rejected("non-finite native decimal input"));
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
            return Ok(Self::default());
        }
        let zeros = significand.trailing_zeros();
        significand >>= zeros;
        power += zeros as i32;
        let mut result = Self::from_u64(significand);
        result.negative = bits >> 63 != 0;
        if power < 0 {
            result.scale = -power;
            for _ in 0..-power {
                result.multiply_small(5)?;
            }
        } else {
            for _ in 0..power {
                result.multiply_small(2)?;
            }
        }
        result.normalize()?;
        Ok(result)
    }

    pub fn from_i64(value: i64) -> Self {
        let mut result = Self::from_u64(value.unsigned_abs());
        result.negative = value < 0;
        result.normalize().expect("bounded integer decimal scale");
        result
    }

    fn from_u64(mut value: u64) -> Self {
        let mut coefficient = Vec::new();
        while value != 0 {
            coefficient.push((value % BASE) as u32);
            value /= BASE;
        }
        Self {
            coefficient,
            ..Self::default()
        }
    }

    pub fn is_zero(&self) -> bool {
        self.coefficient.is_empty()
    }
    pub fn is_negative(&self) -> bool {
        self.negative
    }

    pub fn checked_add(&self, other: &Self) -> Result<Self, Error> {
        if self.is_zero() {
            return Ok(other.clone());
        }
        if other.is_zero() {
            return Ok(self.clone());
        }
        let scale = self.scale.max(other.scale);
        let mut left = self.aligned(scale)?;
        let right = other.aligned(scale)?;
        if self.negative == other.negative {
            let mut carry = 0;
            left.resize(left.len().max(right.len()), 0);
            for (index, target) in left.iter_mut().enumerate() {
                let value =
                    u64::from(*target) + u64::from(right.get(index).copied().unwrap_or(0)) + carry;
                *target = (value % BASE) as u32;
                carry = value / BASE;
            }
            if carry != 0 {
                left.push(carry as u32);
            }
            let mut result = Self {
                negative: self.negative,
                scale,
                coefficient: left,
            };
            result.normalize()?;
            result.check_size()?;
            return Ok(result);
        }
        let ordering = self.magnitude_cmp(other);
        if ordering == Ordering::Equal {
            return Ok(Self::default());
        }
        let (mut greater, lesser, negative) = if ordering == Ordering::Greater {
            (left, right, self.negative)
        } else {
            (right, left, other.negative)
        };
        let mut borrow = 0_i64;
        for (index, target) in greater.iter_mut().enumerate() {
            let value =
                i64::from(*target) - i64::from(lesser.get(index).copied().unwrap_or(0)) - borrow;
            borrow = i64::from(value < 0);
            *target = if value < 0 {
                value + BASE as i64
            } else {
                value
            } as u32;
        }
        if borrow != 0 {
            return Err(Error::Rejected("native decimal subtraction overflow"));
        }
        let mut result = Self {
            negative,
            scale,
            coefficient: greater,
        };
        result.normalize()?;
        result.check_size()?;
        Ok(result)
    }

    pub fn checked_sub(&self, other: &Self) -> Result<Self, Error> {
        let mut other = other.clone();
        if !other.is_zero() {
            other.negative = !other.negative;
        }
        self.checked_add(&other)
    }

    pub fn checked_mul(&self, other: &Self) -> Result<Self, Error> {
        if self.is_zero() || other.is_zero() {
            return Ok(Self::default());
        }
        let length = self
            .coefficient
            .len()
            .checked_add(other.coefficient.len())
            .filter(|length| *length <= Self::COEFFICIENT_WORDS + 1)
            .ok_or(Error::Rejected("native decimal exceeds row budget"))?;
        let mut coefficient = vec![0_u32; length];
        for (i, left) in self.coefficient.iter().enumerate() {
            let mut carry = 0;
            for (j, right) in other.coefficient.iter().enumerate() {
                let value =
                    u64::from(coefficient[i + j]) + u64::from(*left) * u64::from(*right) + carry;
                coefficient[i + j] = (value % BASE) as u32;
                carry = value / BASE;
            }
            coefficient[i + other.coefficient.len()] = carry as u32;
        }
        let mut result = Self {
            negative: self.negative != other.negative,
            scale: self
                .scale
                .checked_add(other.scale)
                .ok_or(Error::Rejected("native decimal scale overflow"))?,
            coefficient,
        };
        result.normalize()?;
        result.check_size()?;
        Ok(result)
    }

    pub fn scale10(&self, denominator_power: i32) -> Result<Self, Error> {
        let mut result = self.clone();
        if !result.is_zero() {
            result.scale = result
                .scale
                .checked_add(denominator_power)
                .ok_or(Error::Rejected("native decimal scale overflow"))?;
        }
        Ok(result)
    }

    pub fn to_f64(&self) -> Result<f64, Error> {
        if self.scale <= 0
            && let Some(value) = self
                .coefficient
                .iter()
                .rev()
                .try_fold(0_u64, |value, &word| {
                    value.checked_mul(BASE)?.checked_add(u64::from(word))
                })
                .and_then(|value| value.checked_mul(10_u64.checked_pow(self.scale.unsigned_abs())?))
        {
            let rounded = value as f64;
            return Ok(if self.negative { -rounded } else { rounded });
        }
        self.ratio_f64(&Self::from_i64(1))
    }

    pub fn ratio_f64(&self, denominator: &Self) -> Result<f64, Error> {
        if denominator.is_zero() {
            return Err(Error::Rejected("native decimal division by zero"));
        }
        if self.is_zero() {
            return Ok(0.0);
        }
        let negative = self.negative != denominator.negative;
        let scale = self.scale.max(denominator.scale);
        let mut numerator = Binary::from_decimal_words(&self.aligned(scale)?);
        let mut denominator = Binary::from_decimal_words(&denominator.aligned(scale)?);
        let mut exponent = numerator.bits() - denominator.bits();
        let ordering = if exponent >= 0 {
            numerator.cmp(&denominator.shift(exponent as u32)?)
        } else {
            numerator.shift((-exponent) as u32)?.cmp(&denominator)
        };
        if ordering == Ordering::Less {
            exponent -= 1;
        }
        if exponent > 1023 {
            return Err(Error::Rejected("native decimal public number overflow"));
        }
        if exponent < -1075 {
            return Ok(f64::from_bits(u64::from(negative) << 63));
        }
        let shift = if exponent < -1022 {
            1074
        } else {
            52 - exponent
        };
        if shift >= 0 {
            numerator = numerator.shift(shift as u32)?;
        } else {
            denominator = denominator.shift((-shift) as u32)?;
        }
        let width = numerator.bits() - denominator.bits();
        if width > 53 {
            return Err(Error::Rejected("native decimal quotient overflow"));
        }
        let mut significand = 0_u64;
        for bit in (0..=width).rev() {
            let divisor = denominator.shift(bit as u32)?;
            if numerator.cmp(&divisor) != Ordering::Less {
                numerator.subtract(&divisor)?;
                significand |= 1_u64 << bit;
            }
        }
        let rounding = numerator.shift(1)?.cmp(&denominator);
        if rounding == Ordering::Greater || (rounding == Ordering::Equal && significand & 1 != 0) {
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
                return Err(Error::Rejected("native decimal public number overflow"));
            }
            ((exponent + 1023) as u64) << 52
                | significand
                    .checked_sub(1_u64 << 52)
                    .ok_or(Error::Rejected("native decimal significand underflow"))?
        };
        let result = f64::from_bits(magnitude | (u64::from(negative) << 63));
        if !result.is_finite() {
            return Err(Error::Rejected("native decimal public number overflow"));
        }
        Ok(result)
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let mut bytes = Vec::new();
        self.encode(&mut bytes)?;
        Ok(bytes)
    }

    pub fn from_bytes(mut bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > ROW_BYTES {
            return Err(Error::Incompatible("native decimal exceeds row budget"));
        }
        let value = Self::decode(&mut bytes)?;
        if !bytes.is_empty() {
            return Err(Error::Incompatible("native decimal trailing bytes"));
        }
        Ok(value)
    }

    fn aligned(&self, scale: i32) -> Result<Vec<u32>, Error> {
        let shift = u32::try_from(i64::from(scale) - i64::from(self.scale))
            .map_err(|_| Error::Rejected("native decimal scale overflow"))?;
        let zeros = (shift / 9) as usize;
        if self.coefficient.len().saturating_add(zeros) > Self::COEFFICIENT_WORDS {
            return Err(Error::Rejected("native decimal exceeds row budget"));
        }
        let mut value = Self {
            coefficient: vec![0; zeros],
            ..Self::default()
        };
        value.coefficient.extend(&self.coefficient);
        value.multiply_small(10_u32.pow(shift % 9))?;
        Ok(value.coefficient)
    }

    fn multiply_small(&mut self, factor: u32) -> Result<(), Error> {
        let mut carry = 0_u64;
        for part in &mut self.coefficient {
            let value = u64::from(*part) * u64::from(factor) + carry;
            *part = (value % BASE) as u32;
            carry = value / BASE;
        }
        if carry != 0 {
            self.coefficient.push(carry as u32);
        }
        self.check_size()
    }

    fn normalize(&mut self) -> Result<(), Error> {
        while self.coefficient.last() == Some(&0) {
            self.coefficient.pop();
        }
        if self.is_zero() {
            self.scale = 0;
            self.negative = false;
            return Ok(());
        }
        while self.coefficient[0].is_multiple_of(10) {
            let mut carry = 0_u64;
            for part in self.coefficient.iter_mut().rev() {
                let value = carry * BASE + u64::from(*part);
                *part = (value / 10) as u32;
                carry = value % 10;
            }
            while self.coefficient.last() == Some(&0) {
                self.coefficient.pop();
            }
            self.scale = self
                .scale
                .checked_sub(1)
                .ok_or(Error::Rejected("native decimal scale overflow"))?;
        }
        Ok(())
    }

    fn check_size(&self) -> Result<(), Error> {
        Self::check_coefficient_size(&self.coefficient)
    }

    fn digits(&self) -> Vec<u8> {
        let mut digits = Vec::with_capacity(self.coefficient.len() * 9);
        for (index, part) in self.coefficient.iter().rev().enumerate() {
            let mut divisor = 100_000_000;
            for _ in 0..9 {
                let digit = ((part / divisor) % 10) as u8;
                if index != 0 || digit != 0 || !digits.is_empty() {
                    digits.push(digit);
                }
                divisor /= 10;
            }
        }
        digits
    }

    fn magnitude_cmp(&self, other: &Self) -> Ordering {
        if self.is_zero() || other.is_zero() {
            return self.coefficient.len().cmp(&other.coefficient.len());
        }
        let left = self.digits();
        let right = other.digits();
        let exponent = (left.len() as i64 - i64::from(self.scale))
            .cmp(&(right.len() as i64 - i64::from(other.scale)));
        if exponent != Ordering::Equal {
            return exponent;
        }
        for index in 0..left.len().max(right.len()) {
            let ordering = left
                .get(index)
                .copied()
                .unwrap_or(0)
                .cmp(&right.get(index).copied().unwrap_or(0));
            if ordering != Ordering::Equal {
                return ordering;
            }
        }
        Ordering::Equal
    }
}

struct Binary(Vec<u32>);

impl Binary {
    fn from_decimal_words(words: &[u32]) -> Self {
        let mut result = Vec::<u32>::new();
        for word in words.iter().rev() {
            let mut carry = u64::from(*word);
            for target in &mut result {
                let value = u64::from(*target) * BASE + carry;
                *target = value as u32;
                carry = value >> 32;
            }
            if carry != 0 {
                result.push(carry as u32);
            }
        }
        Self(result)
    }

    fn bits(&self) -> i32 {
        self.0.last().map_or(0, |last| {
            ((self.0.len() - 1) * 32) as i32 + (32 - last.leading_zeros()) as i32
        })
    }

    fn cmp(&self, other: &Self) -> Ordering {
        self.0
            .len()
            .cmp(&other.0.len())
            .then_with(|| self.0.iter().rev().cmp(other.0.iter().rev()))
    }

    fn shift(&self, bits: u32) -> Result<Self, Error> {
        if self.0.is_empty() {
            return Ok(Self(Vec::new()));
        }
        let zeros = (bits / 32) as usize;
        if self
            .0
            .len()
            .saturating_add(zeros)
            .saturating_add(1)
            .saturating_mul(4)
            > ROW_BYTES
        {
            return Err(Error::Rejected(
                "native decimal conversion exceeds row budget",
            ));
        }
        let mut result = vec![0; zeros];
        let mut carry = 0_u64;
        for word in &self.0 {
            let value = (u64::from(*word) << (bits % 32)) | carry;
            result.push(value as u32);
            carry = value >> 32;
        }
        if carry != 0 {
            result.push(carry as u32);
        }
        Ok(Self(result))
    }

    fn subtract(&mut self, other: &Self) -> Result<(), Error> {
        let mut borrow = false;
        for (index, word) in self.0.iter_mut().enumerate() {
            let (value, first) = word.overflowing_sub(other.0.get(index).copied().unwrap_or(0));
            let (value, second) = value.overflowing_sub(u32::from(borrow));
            *word = value;
            borrow = first || second;
        }
        if borrow {
            return Err(Error::Rejected(
                "native decimal binary subtraction overflow",
            ));
        }
        while self.0.last() == Some(&0) {
            self.0.pop();
        }
        Ok(())
    }
}

impl Ord for Decimal {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self.negative, other.negative) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => self.magnitude_cmp(other),
            (true, true) => self.magnitude_cmp(other).reverse(),
        }
    }
}

impl PartialOrd for Decimal {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Field for Decimal {
    fn encode(&self, bytes: &mut Vec<u8>) -> Result<(), Error> {
        self.check_size()?;
        if self.is_zero() {
            bytes.push(1);
            return Ok(());
        }
        let digits = self.digits();
        let exponent = digits.len() as i64 - i64::from(self.scale);
        let mask = if self.negative { 255 } else { 0 };
        bytes.push(if self.negative { 0 } else { 2 });
        bytes.extend(
            ((exponent as u64) ^ (1_u64 << 63))
                .to_be_bytes()
                .map(|byte| byte ^ mask),
        );
        bytes.extend(digits.into_iter().map(|digit| (digit + 1) ^ mask));
        bytes.push(mask);
        Ok(())
    }

    fn decode(input: &mut &[u8]) -> Result<Self, Error> {
        let Some((&sign, rest)) = input.split_first() else {
            return Err(Error::Incompatible("truncated native decimal"));
        };
        *input = rest;
        if sign == 1 {
            return Ok(Self::default());
        }
        if ![0, 2].contains(&sign) || input.len() < 9 {
            return Err(Error::Incompatible("invalid native decimal header"));
        }
        let negative = sign == 0;
        let mask = if negative { 255 } else { 0 };
        let exponent_bytes: [u8; 8] = input[..8]
            .try_into()
            .map_err(|_| Error::Incompatible("native decimal exponent"))?;
        let exponent =
            (u64::from_be_bytes(exponent_bytes.map(|byte| byte ^ mask)) ^ (1_u64 << 63)) as i64;
        *input = &input[8..];
        let end = input
            .iter()
            .position(|byte| *byte == mask)
            .filter(|length| *length > 0 && length.saturating_add(10) <= ROW_BYTES)
            .ok_or(Error::Incompatible("invalid native decimal coefficient"))?;
        let digits = &input[..end];
        let scale = i64::try_from(digits.len())
            .ok()
            .and_then(|length| length.checked_sub(exponent))
            .and_then(|scale| i32::try_from(scale).ok())
            .ok_or(Error::Incompatible("native decimal scale"))?;
        let mut value = Self::default();
        for (index, digit) in digits.iter().enumerate() {
            let digit = digit ^ mask;
            if !(1..=10).contains(&digit)
                || (digit == 1 && (index == 0 || index + 1 == digits.len()))
            {
                return Err(Error::Incompatible(
                    "noncanonical native decimal coefficient",
                ));
            }
            value.multiply_small(10)?;
            let mut carry = u64::from(digit - 1);
            for part in &mut value.coefficient {
                let sum = u64::from(*part) + carry;
                *part = (sum % BASE) as u32;
                carry = sum / BASE;
                if carry == 0 {
                    break;
                }
            }
            if carry != 0 {
                value.coefficient.push(carry as u32);
            }
        }
        value.negative = negative;
        value.scale = scale;
        *input = &input[end + 1..];
        Ok(value)
    }
}
