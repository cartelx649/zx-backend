const {
  parseMonthParam,
  monthKeyVariants,
  simulatePerUserForMonth,
  computeClaimable,
} = require('../src/services/systemIncomeService');

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

describe('parseMonthParam', () => {
  test('normalizes padded, non-padded and named months to YYYY-MM', () => {
    expect(parseMonthParam('2026-05').monthKey).toBe('2026-05');
    expect(parseMonthParam('2026-5').monthKey).toBe('2026-05');
    expect(parseMonthParam('May 2026').monthKey).toBe('2026-05');
    expect(parseMonthParam('may 2026').monthKey).toBe('2026-05');
    expect(parseMonthParam('December 2026').monthKey).toBe('2026-12');
    expect(parseMonthParam('2026-5')).toMatchObject({ year: 2026, monthIndex: 4 });
  });

  test('throws on invalid input', () => {
    expect(() => parseMonthParam('')).toThrow('Month is required');
    expect(() => parseMonthParam('2026-13')).toThrow('Invalid month');
    expect(() => parseMonthParam('Smarch 2026')).toThrow('Invalid month name');
    expect(() => parseMonthParam('garbage')).toThrow('Unparseable month');
  });
});

describe('monthKeyVariants', () => {
  test('returns padded + non-padded for single-digit months', () => {
    expect(monthKeyVariants('2026-05')).toEqual(['2026-05', '2026-5']);
  });

  test('returns only the padded form for two-digit months', () => {
    expect(monthKeyVariants('2026-11')).toEqual(['2026-11']);
  });
});

describe('simulatePerUserForMonth', () => {
  test('captures per-user ROI and override for the target month', () => {
    const sponsor = makeUser('s1', '0xsponsor');
    const downline = makeUser('d1', '0xdown', '0xsponsor');
    const cycles = [makeCycle('s1', 100), makeCycle('d1', 100)];
    const { perUser } = simulatePerUserForMonth(1, cycles, [sponsor, downline], FIXTURE_CONFIG);

    expect(perUser.get('d1').roi).toBeCloseTo(5, 6);
    expect(perUser.get('s1').roi).toBeCloseTo(5, 6);
    // sponsor level-1 override = downline monthlyRoi (5) * 10%
    expect(perUser.get('s1').override).toBeCloseTo(0.5, 6);
    expect(perUser.get('s1').overrideByLevel.get(1)).toBeCloseTo(0.5, 6);
  });

  test('returns empty map for non-positive target offset', () => {
    const { perUser } = simulatePerUserForMonth(0, [makeCycle('u1', 100)], [makeUser('u1', '0xa')], FIXTURE_CONFIG);
    expect(perUser.size).toBe(0);
  });

  test('yields zero for a cycle already saturated before the target month', () => {
    // package 100 -> monthlyRoi 5, roiTarget 200 -> saturates at month 40.
    const { perUser } = simulatePerUserForMonth(50, [makeCycle('u1', 100)], [makeUser('u1', '0xa')], FIXTURE_CONFIG);
    expect(perUser.get('u1')).toBeUndefined(); // no ROI credited in month 50
  });
});

describe('computeClaimable', () => {
  test('allocates claimed proportionally across income types', () => {
    const r = computeClaimable({ earnedRoi: 200, earnedDirect: 10, earnedOverride: 15, claimed: 90 });
    // total earned 225; claimed share per type = 90 * (type/225)
    expect(r.claimableRoi).toBeCloseTo(200 - 90 * (200 / 225), 2);
    expect(r.claimableDirect).toBeCloseTo(10 - 90 * (10 / 225), 2);
    expect(r.claimableLevel).toBeCloseTo(15 - 90 * (15 / 225), 2);
    expect(r.totalClaimable).toBeCloseTo(135, 2);
    expect(r.earnedAllTime).toEqual({ roi: 200, direct: 10, level: 15 });
    expect(r.claimed).toBe(90);
  });

  test('returns all zeros when nothing earned (no divide-by-zero)', () => {
    const r = computeClaimable({});
    expect(r).toMatchObject({
      claimableRoi: 0,
      claimableDirect: 0,
      claimableLevel: 0,
      totalClaimable: 0,
      claimed: 0,
    });
  });

  test('clamps claimable at zero when claimed exceeds earned', () => {
    const r = computeClaimable({ earnedRoi: 50, claimed: 80 });
    expect(r.totalClaimable).toBe(0);
    expect(r.claimableRoi).toBe(0);
  });
});
