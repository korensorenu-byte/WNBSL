// Rules about age and student (minor) accounts. Kept pure so they are easy to test.

export const COMING_OF_AGE = 18;

/** Whole years between a 'YYYY-MM-DD' birth date and a 'YYYY-MM-DD' date. */
export function ageOn(dob, onDate) {
  const [by, bm, bd] = String(dob).split('-').map(Number);
  const [y, m, d] = String(onDate).split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

/**
 * A student account is held for a child (and only the guardian's rights are limited)
 * until the child turns 18. From that date the child owns it outright.
 */
export function isHeldForMinor(account, childDob, onDate) {
  if (!account.guardian_member_id || !childDob) return false;
  return ageOn(childDob, onDate) < COMING_OF_AGE;
}

/** The date the child reaches 18, as 'YYYY-MM-DD'. */
export function comingOfAgeDate(dob) {
  const [y, m, d] = String(dob).split('-').map(Number);
  return `${y + COMING_OF_AGE}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
