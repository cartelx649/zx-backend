const { simulateForwardIncome } = require('../src/services/systemIncomeService');

const FIXTURE_CONFIG = {
  roiSlabs: [
    { name: 's1', min: 1, max: 500, monthlyPercent: 5 },
    { name: 's2', min: 501, max: 2000, monthlyPercent: 6 },
  ],
  overridePercentages: [
    { level: 1, percent: 10 },
    { level: 2, percent: 5 },
  ],
};

const BASE = new Date(Date.UTC(2026, 5, 1)); // 2026-06

function makeUser(id, wallet, sponsorWallet = null) {
  return { _id: id, walletAddress: wallet, sponsorWalletAddress: sponsorWallet };
}

function makeCycle(userId, packageAmount, overrides = {}) {
  return {
    userId,
    packageAmount,
    roiTarget: packageAmount * 2,
    incomeCap: packageAmount * 3,
    earnedRoi: 0,
    earnedDirect: 0,
    earnedOverride: 0,
    totalEarned: 0,
    ...overrides,
  };
}

describe('simulateForwardIncome', () => {
  test('honors the ROI cap (2x) and stops the cycle once saturated', () => {
    const result = simulateForwardIncome(60, [makeCycle('u1', 100)], [makeUser('u1', '0xa')], FIXTURE_CONFIG, BASE);
    const totalRoi = result.months.reduce((s, m) => s + m.roi, 0);
    expect(totalRoi).toBeCloseTo(200, 6);
    expect(result.grandTotals.roi).toBeCloseTo(200, 6);
    expect(result.grandTotals.override).toBe(0);
    expect(result.months.every((m) => m.direct === 0)).toBe(true);
    expect(result.months[0].monthKey).toBe('2026-07');
  });

  test('propagates override income up the sponsor chain with level percentages', () => {
    const sponsor = makeUser('s1', '0xsponsor');
    const downline = makeUser('d1', '0xdown', '0xsponsor');
    const cycles = [makeCycle('s1', 100), makeCycle('d1', 100)];
    const result = simulateForwardIncome(1, cycles, [sponsor, downline], FIXTURE_CONFIG, BASE);
    const month = result.months[0];
    expect(month.override).toBeCloseTo(0.5, 6);
    expect(month.overrideByLevel).toEqual([{ level: 1, amount: 0.5 }]);
    expect(month.roi).toBeCloseTo(10, 6);
  });

  test('skips override when the sponsor has no active cycle', () => {
    const sponsor = makeUser('s1', '0xsponsor');
    const downline = makeUser('d1', '0xdown', '0xsponsor');
    const result = simulateForwardIncome(1, [makeCycle('d1', 100)], [sponsor, downline], FIXTURE_CONFIG, BASE);
    expect(result.months[0].override).toBe(0);
    expect(result.months[0].roi).toBeCloseTo(5, 6);
  });

  test('returns empty months and zero totals when months <= 0', () => {
    const result = simulateForwardIncome(0, [makeCycle('u1', 100)], [makeUser('u1', '0xa')], FIXTURE_CONFIG, BASE);
    expect(result.months).toEqual([]);
    expect(result.grandTotals).toEqual({ roi: 0, direct: 0, override: 0, total: 0 });
  });

  test('records cycles with no matching slab and contributes zero ROI', () => {
    const result = simulateForwardIncome(12, [makeCycle('u1', 0.5)], [makeUser('u1', '0xa')], FIXTURE_CONFIG, BASE);
    expect(result.warnings.slabNotFound).toContain('u1');
    expect(result.grandTotals.roi).toBe(0);
  });

  test('terminates and stays finite when the sponsor chain forms a cycle', () => {
    const a = makeUser('a', '0xa', '0xb');
    const b = makeUser('b', '0xb', '0xa');
    const result = simulateForwardIncome(3, [makeCycle('a', 100), makeCycle('b', 100)], [a, b], FIXTURE_CONFIG, BASE);
    expect(Number.isFinite(result.grandTotals.override)).toBe(true);
    expect(result.grandTotals.override).toBeGreaterThan(0);
  });

  test('returns all-zero months when there are no active cycles', () => {
    const result = simulateForwardIncome(12, [], [], FIXTURE_CONFIG, BASE);
    expect(result.months).toHaveLength(12);
    expect(result.months.every((m) => m.roi === 0 && m.override === 0)).toBe(true);
    expect(result.grandTotals.total).toBe(0);
  });
});
