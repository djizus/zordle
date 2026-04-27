// Wordle-specific helpers: word packing and feedback computation.

// Trit values for the per-position pattern.
pub const GREY: u8 = 0;
pub const YELLOW: u8 = 1;
pub const GREEN: u8 = 2;

use crate::constants::{ALPHABET_SIZE, WORD_LENGTH};

// 2^5 powers used for letter packing (5 bits per letter).
const SHIFT_1: u32 = 32;
const SHIFT_2: u32 = 1024;
const SHIFT_3: u32 = 32768;
const SHIFT_4: u32 = 1048576;
const LETTER_MASK: u32 = 32; // We use modulo, so just the divisor.

pub mod Errors {
    pub const BAD_LENGTH: felt252 = 'Wordle: word must be 5 letters';
    pub const BAD_LETTER: felt252 = 'Wordle: letter out of range';
}

#[inline]
pub fn pack_word(l0: u8, l1: u8, l2: u8, l3: u8, l4: u8) -> u32 {
    let p0: u32 = l0.into();
    let p1: u32 = Into::<u8, u32>::into(l1) * SHIFT_1;
    let p2: u32 = Into::<u8, u32>::into(l2) * SHIFT_2;
    let p3: u32 = Into::<u8, u32>::into(l3) * SHIFT_3;
    let p4: u32 = Into::<u8, u32>::into(l4) * SHIFT_4;
    p0 + p1 + p2 + p3 + p4
}

// Convenience for the loader script: pack a Span<u8> of length 5.
pub fn pack_letters(letters: Span<u8>) -> u32 {
    assert(letters.len() == WORD_LENGTH.into(), Errors::BAD_LENGTH);
    let l0 = *letters.at(0);
    let l1 = *letters.at(1);
    let l2 = *letters.at(2);
    let l3 = *letters.at(3);
    let l4 = *letters.at(4);
    assert(
        l0 < ALPHABET_SIZE
            && l1 < ALPHABET_SIZE
            && l2 < ALPHABET_SIZE
            && l3 < ALPHABET_SIZE
            && l4 < ALPHABET_SIZE,
        Errors::BAD_LETTER,
    );
    pack_word(l0, l1, l2, l3, l4)
}

#[inline]
pub fn letter_at(word: u32, position: u8) -> u8 {
    let shift: u32 = if position == 0 {
        1
    } else if position == 1 {
        SHIFT_1
    } else if position == 2 {
        SHIFT_2
    } else if position == 3 {
        SHIFT_3
    } else {
        SHIFT_4
    };
    ((word / shift) % LETTER_MASK).try_into().unwrap()
}

// Compute Wordle feedback as a base-3 encoded integer in 0..242.
//   Trit at position i: 0 = grey, 1 = yellow, 2 = green.
//   pattern = p0 + p1*3 + p2*9 + p3*27 + p4*81
//
// Two-pass to handle duplicate letters correctly:
//   Pass 1 marks greens (and consumes those target slots).
//   Pass 2 marks yellows by walking guess positions left-to-right and
//   consuming the first unused target slot with the matching letter.
pub fn compute_pattern(guess: u32, target: u32) -> u8 {
    let g0: u8 = (guess % LETTER_MASK).try_into().unwrap();
    let g1: u8 = ((guess / SHIFT_1) % LETTER_MASK).try_into().unwrap();
    let g2: u8 = ((guess / SHIFT_2) % LETTER_MASK).try_into().unwrap();
    let g3: u8 = ((guess / SHIFT_3) % LETTER_MASK).try_into().unwrap();
    let g4: u8 = ((guess / SHIFT_4) % LETTER_MASK).try_into().unwrap();
    let t0: u8 = (target % LETTER_MASK).try_into().unwrap();
    let t1: u8 = ((target / SHIFT_1) % LETTER_MASK).try_into().unwrap();
    let t2: u8 = ((target / SHIFT_2) % LETTER_MASK).try_into().unwrap();
    let t3: u8 = ((target / SHIFT_3) % LETTER_MASK).try_into().unwrap();
    let t4: u8 = ((target / SHIFT_4) % LETTER_MASK).try_into().unwrap();

    let mut p0: u8 = GREY;
    let mut p1: u8 = GREY;
    let mut p2: u8 = GREY;
    let mut p3: u8 = GREY;
    let mut p4: u8 = GREY;
    let mut used: u8 = 0;

    // Pass 1: greens consume their own target slot.
    if g0 == t0 {
        p0 = GREEN;
        used = used | 1;
    }
    if g1 == t1 {
        p1 = GREEN;
        used = used | 2;
    }
    if g2 == t2 {
        p2 = GREEN;
        used = used | 4;
    }
    if g3 == t3 {
        p3 = GREEN;
        used = used | 8;
    }
    if g4 == t4 {
        p4 = GREEN;
        used = used | 16;
    }

    // Pass 2: yellows, consuming the leftmost unused matching target slot.
    if p0 == GREY {
        let (matched, new_used) = find_yellow(g0, t0, t1, t2, t3, t4, used);
        if matched {
            p0 = YELLOW;
            used = new_used;
        }
    }
    if p1 == GREY {
        let (matched, new_used) = find_yellow(g1, t0, t1, t2, t3, t4, used);
        if matched {
            p1 = YELLOW;
            used = new_used;
        }
    }
    if p2 == GREY {
        let (matched, new_used) = find_yellow(g2, t0, t1, t2, t3, t4, used);
        if matched {
            p2 = YELLOW;
            used = new_used;
        }
    }
    if p3 == GREY {
        let (matched, new_used) = find_yellow(g3, t0, t1, t2, t3, t4, used);
        if matched {
            p3 = YELLOW;
            used = new_used;
        }
    }
    if p4 == GREY {
        let (matched, new_used) = find_yellow(g4, t0, t1, t2, t3, t4, used);
        if matched {
            p4 = YELLOW;
            used = new_used;
        }
    }

    p0 + p1 * 3 + p2 * 9 + p3 * 27 + p4 * 81
}

fn find_yellow(letter: u8, t0: u8, t1: u8, t2: u8, t3: u8, t4: u8, used: u8) -> (bool, u8) {
    if (used & 1) == 0 && letter == t0 {
        return (true, used | 1);
    }
    if (used & 2) == 0 && letter == t1 {
        return (true, used | 2);
    }
    if (used & 4) == 0 && letter == t2 {
        return (true, used | 4);
    }
    if (used & 8) == 0 && letter == t3 {
        return (true, used | 8);
    }
    if (used & 16) == 0 && letter == t4 {
        return (true, used | 16);
    }
    (false, used)
}

#[cfg(test)]
mod tests {
    use super::{compute_pattern, letter_at, pack_word};

    // Letter codes (a=0..z=25).
    const A: u8 = 0;
    const B: u8 = 1;
    const C: u8 = 2;
    const D: u8 = 3;
    const E: u8 = 4;
    const G: u8 = 6;
    const H: u8 = 7;
    const I: u8 = 8;
    const L: u8 = 11;
    const M: u8 = 12;
    const N: u8 = 13;
    const O: u8 = 14;
    const P: u8 = 15;
    const R: u8 = 17;
    const S: u8 = 18;
    const T: u8 = 19;
    const Y: u8 = 24;

    #[test]
    fn test_pack_unpack_roundtrip() {
        let crane = pack_word(C, R, A, N, E);
        assert_eq!(letter_at(crane, 0), C);
        assert_eq!(letter_at(crane, 1), R);
        assert_eq!(letter_at(crane, 2), A);
        assert_eq!(letter_at(crane, 3), N);
        assert_eq!(letter_at(crane, 4), E);
    }

    #[test]
    fn test_pattern_all_green() {
        let crane = pack_word(C, R, A, N, E);
        // 2 + 2*3 + 2*9 + 2*27 + 2*81 = 242
        assert_eq!(compute_pattern(crane, crane), 242);
    }

    #[test]
    fn test_pattern_all_grey() {
        let ghost = pack_word(G, H, O, S, T);
        let crane = pack_word(C, R, A, N, E);
        assert_eq!(compute_pattern(ghost, crane), 0);
    }

    #[test]
    fn test_pattern_two_greens() {
        // SLATE vs CRANE: positions 2 (A) and 4 (E) green, rest grey.
        let slate = pack_word(S, L, A, T, E);
        let crane = pack_word(C, R, A, N, E);
        // 0 + 0 + 2*9 + 0 + 2*81 = 180
        assert_eq!(compute_pattern(slate, crane), 180);
    }

    #[test]
    fn test_pattern_duplicate_in_guess() {
        // SPEED vs ABIDE: only one E in target; first E gets yellow,
        // second E gets grey. Final D matches D in target → yellow.
        let speed = pack_word(S, P, E, E, D);
        let abide = pack_word(A, B, I, D, E);
        // Pattern: [grey, grey, yellow, grey, yellow]
        // = 0 + 0 + 1*9 + 0 + 1*81 = 90
        assert_eq!(compute_pattern(speed, abide), 90);
    }

    #[test]
    fn test_pattern_duplicate_in_target() {
        // LLAMA vs ALLOY: target has two Ls and one A.
        // Pos 1 L is green; pos 0 L finds the other L (yellow); pos 2 A
        // finds the lone A (yellow); pos 3 M and pos 4 A are grey.
        let llama = pack_word(L, L, A, M, A);
        let alloy = pack_word(A, L, L, O, Y);
        // Pattern: [yellow, green, yellow, grey, grey]
        // = 1 + 2*3 + 1*9 + 0 + 0 = 16
        assert_eq!(compute_pattern(llama, alloy), 16);
    }
}
