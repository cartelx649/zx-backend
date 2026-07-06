const { calculateProjection } = require('../src/services/roiCalculatorService');

const FIXTURE_CONFIG = {
  roiSlabs: [
    { name: 's1', min: 1, max: 500, monthlyPercent: 5 },
    { name: 's2', min: 501, max: 2000, monthlyPercent: 6 },
    { name: 's4', min: 5001, max: null, monthlyPercent: 8 },
  ],
  overridePercentages: [
    { level: 1, percent: 10 },
    { level: 2, percent: 5 },
    { level: 3, percent: 3 },
  ],
};

describe('calculateProjection', () => {
  test('projects ROI, direct and level income for a $2 deposit', () => {
    const result = calculateProjection(2, FIXTURE_CONFIG);

    expect(result.input.slab.name).toBe('s1');
    // ROI: 2 * 5% = 0.10/month, target 2x = 4, cap 3x = 6
    expect(result.roi.monthlyRoi).toBe(0.1);
    expect(result.roi.roiTarget).toBe(4);
    expect(result.roi.incomeCap).toBe(6);
    expect(result.roi.monthsToCompleteRoi).toBe(40);

    // Direct: one-time 5% of deposit = 0.10
    expect(result.direct.commissionAmount).toBe(0.1);

    // Level: override % applied to monthly ROI (0.10)
    expect(result.level.breakdown).toHaveLength(3);
    expect(result.level.breakdown[0]).toMatchObject({ level: 1, percent: 10, monthlyAmount: 0.01 });
    expect(result.level.note).toContain('3x total cap');
  });

  test('selects the correct slab for higher amounts', () => {
    const result = calculateProjection(1000, FIXTURE_CONFIG);
    expect(result.input.slab.name).toBe('s2');
    expect(result.roi.monthlyRoi).toBe(60); // 1000 * 6%
  });

  test('throws when amount matches no slab', () => {
    expect(() => calculateProjection(0.5, FIXTURE_CONFIG)).toThrow('Amount does not match any ROI slab');
  });
});
