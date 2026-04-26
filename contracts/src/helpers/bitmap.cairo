// Generic bitmap operations over any type that converts to/from u256.
// Lifted from athanor (grimoire branch) — used here for the per-game
// candidate bitmap (sharded across NUM_CHUNKS u256 chunks).

use crate::helpers::power::TwoPower;

pub trait BitmapTrait<T> {
    fn popcount(x: T) -> u8;
    fn get(x: T, index: u8) -> u8;
    fn set(x: T, index: u8) -> T;
    fn unset(x: T, index: u8) -> T;
}

pub impl Bitmap<
    T, +Into<u8, T>, +Into<T, u256>, +TryInto<T, u8>, +TryInto<u256, T>,
> of BitmapTrait<T> {
    #[inline]
    fn popcount(x: T) -> u8 {
        let mut x: u256 = x.into();
        let mut count: u8 = 0;
        while (x > 0) {
            count += PrivateTrait::_popcount((x % 0x100000000).try_into().unwrap());
            x /= 0x100000000;
        }
        count
    }

    #[inline]
    fn get(x: T, index: u8) -> u8 {
        let x: u256 = x.into();
        let offset: u256 = TwoPower::pow(index);
        (x / offset % 2).try_into().unwrap()
    }

    #[inline]
    fn set(x: T, index: u8) -> T {
        let x: u256 = x.into();
        let offset: u256 = TwoPower::pow(index);
        let bit = x / offset % 2;
        let offset: u256 = offset * (1 - bit);
        (x + offset).try_into().unwrap()
    }

    #[inline]
    fn unset(x: T, index: u8) -> T {
        let x: u256 = x.into();
        let offset: u256 = TwoPower::pow(index);
        let bit = x / offset % 2;
        let offset: u256 = offset * bit;
        (x - offset).try_into().unwrap()
    }
}

#[generate_trait]
impl Private of PrivateTrait {
    #[inline]
    fn _popcount(mut x: u32) -> u8 {
        x -= ((x / 2) & 0x55555555);
        x = (x & 0x33333333) + ((x / 4) & 0x33333333);
        x = (x + (x / 16)) & 0x0f0f0f0f;
        x += (x / 256);
        x += (x / 65536);
        return (x % 64).try_into().unwrap();
    }
}

// Find the position of the k-th set bit (0-indexed) in a u256.
// Used by the lazy boss to pick a uniform-random non-empty pattern bucket.
pub fn kth_set_bit_u256(x: u256, k: u32) -> u8 {
    let mut remaining: u32 = k;
    let mut bit_idx: u32 = 0;
    let mut bits: u256 = x;
    let mut found: bool = false;
    let mut result: u8 = 0;
    while bits > 0 && !found {
        if (bits % 2) == 1 {
            if remaining == 0 {
                result = bit_idx.try_into().unwrap();
                found = true;
            } else {
                remaining -= 1;
            }
        }
        if !found {
            bits = bits / 2;
            bit_idx += 1;
        }
    }
    assert(found, 'kth_set_bit: out of range');
    result
}

// Plain Array<u8> stream of patterns. We tried packing 32 patterns × 8 bits
// per u256 (and a TwoPower-based shift/mask round-trip) but the u256 mul/div
// in the hot loop was net-negative vs the cost of one felt per pattern.
pub fn append_pattern_to_stream(ref stream: Array<u8>, pattern: u8) {
    stream.append(pattern);
}

pub fn read_pattern_from_stream(stream: @Array<u8>, ordinal: u32) -> u8 {
    *stream.at(ordinal)
}

#[cfg(test)]
mod tests {
    use super::{
        Bitmap, append_pattern_to_stream, kth_set_bit_u256, read_pattern_from_stream,
    };

    #[test]
    fn test_bitmap_popcount_large() {
        let count: u8 = Bitmap::popcount(
            0x4003FBB391C53CCB8E99752EB665586B695BB2D026BEC9071FF30002_u256,
        );
        assert_eq!(count, 109);
    }

    #[test]
    fn test_bitmap_popcount_small() {
        let count = Bitmap::popcount(0b101_u256);
        assert_eq!(count, 2);
    }

    #[test]
    fn test_bitmap_get() {
        let bit = Bitmap::get(0b1001011_u256, 0);
        assert_eq!(bit, 1);
    }

    #[test]
    fn test_bitmap_set() {
        let bit: u256 = Bitmap::set(0b1001010_u256, 0);
        assert_eq!(bit, 0b1001011);
    }

    #[test]
    fn test_bitmap_unset() {
        let bit: u256 = Bitmap::unset(0b1001011_u256, 0);
        assert_eq!(bit, 0b1001010);
    }

    #[test]
    fn test_kth_set_bit_low_bits() {
        // 0b10110 has bits set at positions 1, 2, 4.
        assert_eq!(kth_set_bit_u256(0b10110_u256, 0), 1);
        assert_eq!(kth_set_bit_u256(0b10110_u256, 1), 2);
        assert_eq!(kth_set_bit_u256(0b10110_u256, 2), 4);
    }

    #[test]
    fn test_kth_set_bit_high_bit() {
        // Only bit 242 set: 2^242 = 4 * 16^60, so "4" followed by 60 zeros.
        let x: u256 = 0x4000000000000000000000000000000000000000000000000000000000000_u256;
        assert_eq!(kth_set_bit_u256(x, 0), 242);
    }

    #[test]
    fn test_pattern_stream_round_trip() {
        let mut stream: Array<u8> = array![];
        let mut i: u32 = 0;
        while i < 100 {
            let pattern: u8 = ((i * 17) % 243).try_into().unwrap();
            append_pattern_to_stream(ref stream, pattern);
            i += 1;
        }

        let mut j: u32 = 0;
        while j < 100 {
            let expected: u8 = ((j * 17) % 243).try_into().unwrap();
            assert_eq!(read_pattern_from_stream(@stream, j), expected);
            j += 1;
        }
    }
}
