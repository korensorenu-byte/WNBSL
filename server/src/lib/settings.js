// Society rules, configurable by the admin in the Settings screen.
// Values are stored in the settings table; these are the starting defaults.
// Confirm every value against the Society's by-laws before going live.
export const DEFAULT_SETTINGS = {
  society_name: 'West New Britain Savings and Loans Society',
  currency: 'PGK',
  savings_interest_rate_pct: 4.0,      // annual, credited monthly
  loan_interest_rate_pct: 12.0,        // annual, default for new applications
  loan_method: 'reducing',             // 'reducing' or 'flat'
  loan_max_multiple: 3,                // max loan = savings + shares x multiple
  loan_max_amount_toea: 5_000_000,     // K50,000.00 cap (0 = no cap)
  loan_max_term_months: 36,
  min_savings_balance_toea: 0,         // minimum balance a withdrawal must leave
  require_guarantor: false,
  guarantor_min_savings_toea: 0,
};

export const SETTING_TYPES = Object.fromEntries(
  Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k, typeof v]),
);
