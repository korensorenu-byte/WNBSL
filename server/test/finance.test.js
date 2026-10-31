import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loanSchedule,
  splitEvenly,
  allocateRepayment,
  outstandingBalance,
  arrearsOf,
  monthlySavingsInterest,
  maxLoanAmount,
  formatKina,
} from '../src/lib/finance.js';

test('splitEvenly sums exactly to the total', () => {
  const parts = splitEvenly(100, 3);
  assert.deepEqual(parts, [33, 33, 34]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 100);
});

test('reducing-balance schedule clears the loan to zero', () => {
  const rows = loanSchedule({ principal: 1_000_000, annualRatePct: 12, termMonths: 12 });
  assert.equal(rows.length, 12);
  assert.equal(rows.at(-1).balanceAfter, 0);
  const totalPrincipal = rows.reduce((s, r) => s + r.principal, 0);
  assert.equal(totalPrincipal, 1_000_000);
});

test('reducing-balance first-month interest equals principal x monthly rate', () => {
  const rows = loanSchedule({ principal: 1_200_000, annualRatePct: 12, termMonths: 6 });
  assert.equal(rows[0].interest, 12_000); // K12,000.00 = 1% of K1,200,000
});

test('zero-rate loan has no interest', () => {
  const rows = loanSchedule({ principal: 600_000, annualRatePct: 0, termMonths: 6 });
  assert.equal(rows.reduce((s, r) => s + r.interest, 0), 0);
  assert.equal(rows.at(-1).balanceAfter, 0);
});

test('flat-rate schedule totals the expected interest and clears principal', () => {
  const rows = loanSchedule({ principal: 1_200_000, annualRatePct: 10, termMonths: 12, method: 'flat' });
  const interest = rows.reduce((s, r) => s + r.interest, 0);
  assert.equal(interest, 120_000); // 10% of K1,200,000 for one year
  assert.equal(rows.at(-1).balanceAfter, 0);
});

test('repayment pays interest before principal, oldest instalment first', () => {
  const inst = [
    { id: 'a', period: 1, principal_due: 900, interest_due: 100, principal_paid: 0, interest_paid: 0 },
    { id: 'b', period: 2, principal_due: 900, interest_due: 80, principal_paid: 0, interest_paid: 0 },
  ];
  const { updates, applied, excess } = allocateRepayment(inst, 150);
  assert.equal(applied, 150);
  assert.equal(excess, 0);
  assert.deepEqual(updates[0], { id: 'a', interest_paid: 100, principal_paid: 50 });
});

test('overpayment is reported as excess and not applied', () => {
  const inst = [{ id: 'a', period: 1, principal_due: 500, interest_due: 0, principal_paid: 0, interest_paid: 0 }];
  const { applied, excess } = allocateRepayment(inst, 800);
  assert.equal(applied, 500);
  assert.equal(excess, 300);
});

test('outstanding balance and arrears are detected', () => {
  const inst = [
    { id: 'a', period: 1, due_date: '2026-01-31', principal_due: 500, interest_due: 50, principal_paid: 500, interest_paid: 50 },
    { id: 'b', period: 2, due_date: '2026-02-28', principal_due: 500, interest_due: 40, principal_paid: 0, interest_paid: 0 },
    { id: 'c', period: 3, due_date: '2099-03-31', principal_due: 500, interest_due: 30, principal_paid: 0, interest_paid: 0 },
  ];
  assert.equal(outstandingBalance(inst), 1070);
  assert.deepEqual(arrearsOf(inst, '2026-10-31').map((i) => i.id), ['b']);
});

test('monthly savings interest is rounded toea', () => {
  // K10,000.00 at 4% p.a. = K33.33 per month
  assert.equal(monthlySavingsInterest(1_000_000, 4), 3333);
});

test('maximum loan respects multiple and cap', () => {
  assert.equal(maxLoanAmount({ savingsAndSharesToea: 1_000_000, multiple: 3, cap: 2_000_000 }), 2_000_000);
  assert.equal(maxLoanAmount({ savingsAndSharesToea: 500_000, multiple: 3, cap: 0 }), 1_500_000);
});

test('formatKina formats toea as kina', () => {
  assert.equal(formatKina(123_456), 'K1,234.56');
  assert.equal(formatKina(5), 'K0.05');
});
