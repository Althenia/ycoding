use ycoding_store::Decimal;

#[test]
fn exact_binary64_inputs_round_trip_signed_extremes_and_fractional_values() {
    for value in [
        f64::MIN,
        -1.0,
        -0.25,
        -f64::from_bits(1),
        0.0,
        f64::from_bits(1),
        0.1,
        0.2,
        0.25,
        1.0,
        1_100_000_000.0,
        f64::from_bits((u64::MAX as f64).to_bits() - 1),
        u64::MAX as f64,
        f64::MAX,
    ] {
        let number = Decimal::from_f64(value).unwrap();
        assert_eq!(number.to_f64().unwrap().to_bits(), value.to_bits());
        assert_eq!(
            Decimal::from_bytes(&number.to_bytes().unwrap()).unwrap(),
            number
        );
    }
    for value in [f64::NEG_INFINITY, f64::INFINITY, f64::NAN] {
        assert!(Decimal::from_f64(value).is_err());
    }
    let sum = Decimal::from_f64(0.1)
        .unwrap()
        .checked_add(&Decimal::from_f64(0.2).unwrap())
        .unwrap();
    assert_eq!(sum.to_f64().unwrap().to_bits(), 0x3fd3333333333334);
    for value in [9_007_199_254_740_993_i64, -9_007_199_254_740_995] {
        assert_eq!(
            Decimal::from_i64(value).to_f64().unwrap().to_bits(),
            (value as f64).to_bits()
        );
    }
}

#[test]
fn native_decimal_cancellation_retains_minimum_subnormal_and_signed_remainders() {
    let maximum = Decimal::from_f64(f64::MAX).unwrap();
    let minimum = Decimal::from_f64(f64::from_bits(1)).unwrap();
    let sum = maximum.checked_add(&minimum).unwrap();
    assert_eq!(sum.to_f64().unwrap().to_bits(), f64::MAX.to_bits());
    assert_eq!(sum.checked_sub(&maximum).unwrap(), minimum);
    let refund = Decimal::from_f64(-0.5).unwrap();
    assert_eq!(
        refund
            .checked_add(&Decimal::from_f64(0.25).unwrap())
            .unwrap()
            .to_f64()
            .unwrap(),
        -0.25
    );
    assert!(maximum.checked_add(&maximum).unwrap().to_f64().is_err());
}

#[test]
fn native_decimal_append_delete_replace_and_merge_are_order_independent() {
    let large = Decimal::from_f64(9_007_199_254_740_992.0).unwrap();
    let one = Decimal::from_i64(1);
    let left = large.checked_add(&one).unwrap().checked_add(&one).unwrap();
    let right = one.checked_add(&one).unwrap().checked_add(&large).unwrap();
    assert_eq!(left, right);
    assert_eq!(left.to_f64().unwrap(), 9_007_199_254_740_994.0);
    assert_eq!(
        large
            .checked_add(&one)
            .unwrap()
            .checked_sub(&large)
            .unwrap(),
        one
    );
    assert_eq!(
        left.checked_sub(&large)
            .unwrap()
            .checked_add(&Decimal::default())
            .unwrap(),
        Decimal::from_i64(2)
    );
}

#[test]
fn native_decimal_storage_order_and_numeric_order_agree() {
    let values = [
        f64::MIN,
        -100.0,
        -1.2,
        -1.0,
        -0.1,
        -f64::from_bits(1),
        0.0,
        f64::from_bits(1),
        0.1,
        1.0,
        1.2,
        100.0,
        f64::MAX,
    ]
    .map(|value| Decimal::from_f64(value).unwrap());
    for pair in values.windows(2) {
        assert!(pair[0] < pair[1]);
        assert!(pair[0].to_bytes().unwrap() < pair[1].to_bytes().unwrap());
    }
    for bytes in [&[][..], &[3][..], &[1, 0][..], &[2, 0][..]] {
        assert!(Decimal::from_bytes(bytes).is_err());
    }
}

#[test]
fn native_decimal_products_and_final_ratios_round_only_at_public_output() {
    let minimum = Decimal::from_f64(f64::from_bits(1)).unwrap();
    let half = Decimal::from_f64(0.5).unwrap();
    assert_eq!(
        minimum
            .checked_mul(&half)
            .unwrap()
            .to_f64()
            .unwrap()
            .to_bits(),
        0
    );
    assert_eq!(
        minimum
            .checked_mul(&half)
            .unwrap()
            .checked_add(&minimum)
            .unwrap()
            .to_f64()
            .unwrap()
            .to_bits(),
        2
    );
    let one = Decimal::from_i64(1);
    let three = Decimal::from_i64(3);
    assert_eq!(
        one.ratio_f64(&three).unwrap().to_bits(),
        (1.0_f64 / 3.0).to_bits()
    );
    assert_eq!(one.scale10(6).unwrap().to_f64().unwrap(), 0.000001);
    assert!(one.ratio_f64(&Decimal::default()).is_err());
}

#[test]
fn native_decimal_codec_accepts_the_full_coefficient_byte_budget_and_rejects_oversize() {
    let mut bytes = vec![2];
    bytes.extend((65_526_u64 ^ (1_u64 << 63)).to_be_bytes());
    bytes.extend(std::iter::repeat_n(2_u8, 65_526));
    bytes.push(0);
    let value = Decimal::from_bytes(&bytes).unwrap();
    assert_eq!(value.to_bytes().unwrap(), bytes);
    assert_eq!(value.checked_add(&Decimal::default()).unwrap(), value);
    bytes.insert(bytes.len() - 1, 2);
    assert!(Decimal::from_bytes(&bytes).is_err());
}
