const {
  calculateProratedMonthlyRoi,
  previousCalendarMonthPeriod,
} = require('../src/services/roiJobService');

const ROI_SLABS = [
  { name: 's1', min: 1, max: 500, monthlyPercent: 5 },
  { name: 's2', min: 501, max: 2000, monthlyPercent: 6 },
];

function deposit(amount, iso) {
  return { amount, status: 'verified', createdAt: new Date(iso) };
}

describe('previousCalendarMonthPeriod', () => {
  test('returns the previous calendar month window', () => {
    const period = previousCalendarMonthPeriod(new Date('2026-07-05T00:00:00Z'));
    expect(period.monthKey).toBe('2026-06');
    expect(period.daysInMonth).toBe(30);
    expect(period.start.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('calculateProratedMonthlyRoi', () => {
  test('credits only the active days when a cycle starts mid-month', () => {
    const period = previousCalendarMonthPeriod(new Date('2026-07-05T00:00:00Z'));
    const amount = calculateProratedMonthlyRoi({
      cycle: { packageAmount: 1000 },
      deposits: [deposit(1000, '2026-06-18T10:00:00Z')],
      roiSlabs: ROI_SLABS,
      period,
    });

    expect(amount).toBeCloseTo(26, 8); // 1000 * 6% * (13 / 30)
  });

  test('prorates a mid-month top-up using the package active during each segment', () => {
    const period = previousCalendarMonthPeriod(new Date('2026-07-05T00:00:00Z'));
    const amount = calculateProratedMonthlyRoi({
      cycle: { packageAmount: 200 },
      deposits: [
        deposit(100, '2026-05-20T10:00:00Z'),
        deposit(100, '2026-06-16T10:00:00Z'),
      ],
      roiSlabs: ROI_SLABS,
      period,
    });

    expect(amount).toBeCloseTo(7.5, 8); // 15 days on 100 + 15 days on 200 at 5%
  });

  test('returns full monthly ROI when the package was active before the period started', () => {
    const period = previousCalendarMonthPeriod(new Date('2026-07-05T00:00:00Z'));
    const amount = calculateProratedMonthlyRoi({
      cycle: { packageAmount: 200 },
      deposits: [deposit(200, '2026-05-20T10:00:00Z')],
      roiSlabs: ROI_SLABS,
      period,
    });

    expect(amount).toBeCloseTo(10, 8);
  });
});
