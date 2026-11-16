//! Frozen Node/V8-compatible logarithm for positive lexical token counts.
//! Adapted from the fdlibm log implementation used by V8 12.4:
//! https://github.com/v8/v8/blob/12.4.254.21/src/base/ieee754.cc
//! Explicit mul_add preserves the frozen macOS Node build's expression-local
//! Clang fp-contract=on rounding, rather than relying on Rust/libc log or FMA.
//
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved.
// V8 adaptations copyright 2016 the V8 project authors, under the BSD-style
// license at https://github.com/v8/v8/blob/12.4.254.21/LICENSE .

pub(super) fn positive_integer_log(value: usize) -> f64 {
    if value == 0 { return f64::NEG_INFINITY; }
    let mut x = value as f64;
    let bits = x.to_bits();
    let mut high = (bits >> 32) as i32;
    let mut exponent = (high >> 20) - 1023;
    high &= 0x000f_ffff;
    let adjust = (high + 0x95f64) & 0x100000;
    x = f64::from_bits((bits & 0xffff_ffff) | ((high | (adjust ^ 0x3ff00000)) as u64) << 32);
    exponent += adjust >> 20;
    let fraction = x - 1.0;
    let ln2_high = f64::from_bits(0x3fe62e42fee00000);
    let ln2_low = f64::from_bits(0x3dea39ef35793c76);
    let k = exponent as f64;
    if (0x000f_ffff & (2 + high)) < 3 {
        if fraction == 0.0 { return if exponent == 0 { 0.0 } else { k.mul_add(ln2_high, k * ln2_low) }; }
        let correction = fraction * fraction * fraction.mul_add(-0.33333333333333333, 0.5);
        return if exponent == 0 { fraction - correction } else { k.mul_add(ln2_high, -((-k).mul_add(ln2_low, correction) - fraction)) };
    }
    let reduced = fraction / (2.0 + fraction);
    let square = reduced * reduced;
    let fourth = square * square;
    let coefficients = [
        f64::from_bits(0x3fe5555555555593), f64::from_bits(0x3fd999999997fa04),
        f64::from_bits(0x3fd2492494229359), f64::from_bits(0x3fcc71c51d8e78af),
        f64::from_bits(0x3fc7466496cb03de), f64::from_bits(0x3fc39a09d078c69f),
        f64::from_bits(0x3fc2f112df3e5244),
    ];
    let even = fourth * fourth.mul_add(fourth.mul_add(coefficients[5],coefficients[3]),coefficients[1]);
    let odd = square * fourth.mul_add(fourth.mul_add(fourth.mul_add(coefficients[6],coefficients[4]),coefficients[2]),coefficients[0]);
    let approximation = odd + even;
    if ((high - 0x6147a) | (0x6b851 - high)) > 0 {
        let half_square = 0.5 * fraction * fraction;
        if exponent == 0 { fraction - (-reduced).mul_add(half_square + approximation, half_square) }
        else { k.mul_add(ln2_high, -((half_square - reduced.mul_add(half_square + approximation, k * ln2_low)) - fraction)) }
    } else if exponent == 0 { (-reduced).mul_add(fraction - approximation, fraction) }
    else { k.mul_add(ln2_high, -(reduced.mul_add(fraction - approximation, -k * ln2_low) - fraction)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_math_log_three_bits() {
        assert_eq!(positive_integer_log(3).to_bits(), 0x3ff193ea7aad030a);
        assert_eq!(positive_integer_log(1).to_bits(), 0);
    }
}
