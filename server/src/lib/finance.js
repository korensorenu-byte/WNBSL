// Pure financial logic. No database or HTTP here, so it is easy to test.
// All money values are integer toea (1 kina = 100 toea).

export const TOEA_PER_KINA = 100;

export function assertToea(value, name = 'amount') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive whole number of toea`);
  }
  return value;
}

/** Split a total into n integer parts that add up exactly to the total. */
export function splitEvenly(total, n) {
  const base = Math.floor(total / n);
  const parts = Array(n).fill(base);
  parts[n - 1] += total - base * n;
  return parts;
}

/**
 * Build a repayment schedule.
 * method 'reducing': equal monthly instalments on the declining balance.
 * method 'flat': principal and interest spread evenly over the term.
 * Returns rows: { period, principal, interest, payment, balanceAfter }.
 */
export function loanSchedule({ principal, annualRatePct, termMonths, method = 'reducing' }) {
  assertToea(principal, 'principal');
  if (!Number.isInteger(termMonths) || termMonths <= 0) throw new RangeError('termMonths must be a positive integer');
  if (!(annualRatePct >= 0)) throw new RangeError('annualRatePct must be zero or more');

  const r = annualRatePct / 100 / 12;
  const rows = [];

  if (method === 'flat') {
    const totalInterest = Math.round(principal * (annualRatePct / 100) * (termMonths / 12));
    const principalParts = splitEvenly(principal, termMonths);
    const interestParts = splitEvenly(totalInterest, termMonths);
    let balance = principal;
    for (let i = 0; i < termMonths; i++) {
      balance -= principalParts[i];
      rows.push({
        period: i + 1,
        principal: principalParts[i],
        interest: interestParts[i],
        payment: principalParts[i] + interestParts[i],
        balanceAfter: balance,
      });
    }
    return rows;
  }

  if (method !== 'reducing') throw new RangeError(`unknown method: ${method}`);

  const instalment =
    r === 0
      ? Math.ceil(principal / termMonths)
      : Math.round((principal * r) / (1 - Math.pow(1 + r, -termMonths)));

  let balance = principal;
  for (let i = 1; i <= termMonths; i++) {
    const interest = Math.round(balance * r);
    let princ = instalment - interest;
    // Final instalment clears any rounding residue.
    if (i === termMonths || princ > balance) princ = balance;
    balance -= princ;
    rows.push({ period: i, principal: princ, interest, payment: princ + interest, balanceAfter: balance });
  }
  return rows;
}

/** Monthly simple interest on a savings balance, in toea (rounded). */
export function monthlySavingsInterest(balanceToea, annualRatePct) {
  return Math.round(balanceToea * (annualRatePct / 100) / 12);
}

/**
 * Apply a repayment to unpaid installments, oldest first, interest before principal.
 * installments: [{ id, period, principal_due, interest_due, principal_paid, interest_paid }]
 * Returns { updates: [{ id, principal_paid, interest_paid }], applied, excess }.
 */
export function allocateRepayment(installments, amountToea) {
  assertToea(amountToea, 'repayment amount');
  let remaining = amountToea;
  const updates = [];
  const ordered = [...installments].sort((a, b) => a.period - b.period);

  for (const inst of ordered) {
    if (remaining === 0) break;
    const interestOwed = inst.interest_due - inst.interest_paid;
    const principalOwed = inst.principal_due - inst.principal_paid;
    if (interestOwed + principalOwed === 0) continue;

    const payInterest = Math.min(interestOwed, remaining);
    remaining -= payInterest;
    const payPrincipal = Math.min(principalOwed, remaining);
    remaining -= payPrincipal;

    updates.push({
      id: inst.id,
      interest_paid: inst.interest_paid + payInterest,
      principal_paid: inst.principal_paid + payPrincipal,
    });
  }
  return { updates, applied: amountToea - remaining, excess: remaining };
}

/** Total outstanding (principal + interest) across installments, in toea. */
export function outstandingBalance(installments) {
  return installments.reduce(
    (sum, i) => sum + (i.principal_due - i.principal_paid) + (i.interest_due - i.interest_paid),
    0,
  );
}

/** Installments past due and not fully paid. `today` is a 'YYYY-MM-DD' string. */
export function arrearsOf(installments, today) {
  return installments.filter(
    (i) =>
      i.due_date < today &&
      i.principal_paid + i.interest_paid < i.principal_due + i.interest_due,
  );
}

/** Maximum loan a member can borrow given total savings + shares. */
export function maxLoanAmount({ savingsAndSharesToea, multiple, cap }) {
  const byMultiple = Math.floor(savingsAndSharesToea * multiple);
  return cap ? Math.min(byMultiple, cap) : byMultiple;
}

export function formatKina(toea) {
  const sign = toea < 0 ? '-' : '';
  const abs = Math.abs(toea);
  const kina = Math.floor(abs / TOEA_PER_KINA);
  const t = String(abs % TOEA_PER_KINA).padStart(2, '0');
  return `${sign}K${kina.toLocaleString('en-US')}.${t}`;
}
