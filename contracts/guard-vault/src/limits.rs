//! Spending limits: pure functions, no host calls.
//!
//! The daily window is a fixed UTC day: block time in milliseconds divided by
//! 86 400 000. The running total resets at 00:00 UTC, so up to twice the daily
//! cap can be paid across midnight (see `THREAT_MODEL.md`).

use concordium_std::{Amount, Timestamp};

use crate::Error;

/// Milliseconds in one day.
pub const DAY_MILLIS: u64 = 86_400_000;

/// The UTC day number of `now` (days since the Unix epoch).
pub fn utc_day(now: Timestamp) -> u64 {
    now.timestamp_millis() / DAY_MILLIS
}

/// Caps are valid when `0 < per_tx_cap <= daily_cap`.
pub fn valid_caps(per_tx_cap: Amount, daily_cap: Amount) -> bool {
    per_tx_cap > Amount::zero() && per_tx_cap <= daily_cap
}

/// The running total for one UTC day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DailySpend {
    /// UTC day of the last successful payment.
    pub day: u64,
    /// Total paid during `day`.
    pub spent: Amount,
}

impl DailySpend {
    /// The amount that counts against the cap on `today`. A later day starts
    /// from zero; an earlier `today` (impossible on chain) never resets.
    pub fn effective(self, today: u64) -> Amount {
        if today > self.day {
            Amount::zero()
        } else {
            self.spent
        }
    }
}

/// Check one payment of `amount` on `today` against both caps and return the
/// new running total. Nothing is changed on error.
pub fn check_spend(
    amount: Amount,
    per_tx_cap: Amount,
    daily_cap: Amount,
    current: DailySpend,
    today: u64,
) -> Result<DailySpend, Error> {
    if amount == Amount::zero() {
        return Err(Error::ZeroAmount);
    }
    if amount > per_tx_cap {
        return Err(Error::ExceedsPerTxCap);
    }
    let spent = current
        .effective(today)
        .checked_add(amount)
        .ok_or(Error::Overflow)?;
    if spent > daily_cap {
        return Err(Error::ExceedsDailyCap);
    }
    Ok(DailySpend {
        day: today.max(current.day),
        spent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn ccd(n: u64) -> Amount {
        Amount::from_ccd(n)
    }

    const fn micro(n: u64) -> Amount {
        Amount::from_micro_ccd(n)
    }

    /// 2026-11-21T00:00:00Z is UTC day 20 778.
    const DAY: u64 = 20_778;

    fn start(spent: Amount) -> DailySpend {
        DailySpend { day: DAY, spent }
    }

    #[test]
    fn utc_day_boundaries() {
        let midnight = DAY * DAY_MILLIS;
        assert_eq!(
            utc_day(Timestamp::from_timestamp_millis(midnight - 1)),
            DAY - 1
        );
        assert_eq!(utc_day(Timestamp::from_timestamp_millis(midnight)), DAY);
        assert_eq!(
            utc_day(Timestamp::from_timestamp_millis(midnight + DAY_MILLIS - 1)),
            DAY
        );
        assert_eq!(
            utc_day(Timestamp::from_timestamp_millis(midnight + DAY_MILLIS)),
            DAY + 1
        );
    }

    #[test]
    fn caps_must_be_positive_and_ordered() {
        assert!(valid_caps(ccd(1), ccd(1)));
        assert!(valid_caps(ccd(1), ccd(10)));
        assert!(!valid_caps(Amount::zero(), ccd(10)));
        assert!(!valid_caps(ccd(11), ccd(10)));
    }

    #[test]
    fn zero_amount_is_rejected() {
        let r = check_spend(Amount::zero(), ccd(5), ccd(10), start(Amount::zero()), DAY);
        assert_eq!(r, Err(Error::ZeroAmount));
    }

    #[test]
    fn per_tx_cap_boundary() {
        let ok = check_spend(ccd(5), ccd(5), ccd(10), start(Amount::zero()), DAY);
        assert_eq!(ok, Ok(start(ccd(5))));
        let over = check_spend(
            micro(5_000_001),
            ccd(5),
            ccd(10),
            start(Amount::zero()),
            DAY,
        );
        assert_eq!(over, Err(Error::ExceedsPerTxCap));
    }

    #[test]
    fn daily_total_adds_up_then_stops() {
        let after_first = check_spend(ccd(4), ccd(5), ccd(10), start(Amount::zero()), DAY).unwrap();
        let after_second = check_spend(ccd(5), ccd(5), ccd(10), after_first, DAY).unwrap();
        assert_eq!(after_second, start(ccd(9)));
        let at_cap = check_spend(ccd(1), ccd(5), ccd(10), after_second, DAY).unwrap();
        assert_eq!(at_cap, start(ccd(10)));
        let over = check_spend(micro(1), ccd(5), ccd(10), at_cap, DAY);
        assert_eq!(over, Err(Error::ExceedsDailyCap));
    }

    #[test]
    fn total_resets_on_the_next_utc_day() {
        let next = check_spend(ccd(5), ccd(5), ccd(10), start(ccd(10)), DAY + 1);
        assert_eq!(
            next,
            Ok(DailySpend {
                day: DAY + 1,
                spent: ccd(5)
            })
        );
    }

    #[test]
    fn midnight_edge_allows_two_caps_in_a_short_time() {
        // Documented edge: a full cap at 23:59:59.999 and again at 00:00:00.000.
        let before = utc_day(Timestamp::from_timestamp_millis((DAY + 1) * DAY_MILLIS - 1));
        let after = utc_day(Timestamp::from_timestamp_millis((DAY + 1) * DAY_MILLIS));
        let first = check_spend(ccd(10), ccd(10), ccd(10), start(Amount::zero()), before).unwrap();
        assert_eq!(first, start(ccd(10)));
        let second = check_spend(ccd(10), ccd(10), ccd(10), first, after).unwrap();
        assert_eq!(
            second,
            DailySpend {
                day: DAY + 1,
                spent: ccd(10)
            }
        );
    }

    #[test]
    fn earlier_day_never_resets_the_total() {
        let r = check_spend(ccd(1), ccd(5), ccd(10), start(ccd(10)), DAY - 1);
        assert_eq!(r, Err(Error::ExceedsDailyCap));
        assert_eq!(start(ccd(10)).effective(DAY - 1), ccd(10));
    }

    #[test]
    fn overflow_is_an_error_not_a_wrap() {
        let max = micro(u64::MAX);
        let r = check_spend(micro(1), max, max, start(max), DAY);
        assert_eq!(r, Err(Error::Overflow));
    }
}
