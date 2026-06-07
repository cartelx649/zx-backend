describe('createCycleForDeposit — same-cycle re-top-up', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('tops up the active cycle: grows package + caps, preserves earned progress', async () => {
    // Active $400 cycle (slab s1) with some ROI already earned.
    const activeCycle = {
      _id: 'cycle1',
      userId: 'user1',
      packageAmount: 400,
      roiTarget: 800,
      incomeCap: 1200,
      earnedRoi: 150,
      earnedDirect: 0,
      earnedOverride: 0,
      totalEarned: 150,
      isActive: true,
      save: jest.fn().mockResolvedValue(undefined),
    };

    jest.doMock('../src/models/Cycle', () => ({
      findOne: jest.fn().mockResolvedValue(activeCycle),
      create: jest.fn(),
    }));
    jest.doMock('../src/models/User', () => ({
      findByIdAndUpdate: jest.fn(),
    }));

    const Cycle = require('../src/models/Cycle');
    const { createCycleForDeposit } = require('../src/services/cycleService');

    const user = { _id: 'user1', currentCycleNumber: 1, totalDeposited: 400, save: jest.fn() };
    const result = await createCycleForDeposit(user, 200 /* top-up */, /* session */ null);

    // Returns the same active cycle, flagged as a top-up — no new cycle created.
    expect(result.isTopup).toBe(true);
    expect(result.cycle).toBe(activeCycle);
    expect(Cycle.create).not.toHaveBeenCalled();

    // Package grows cumulatively; caps recompute on the new total (2x / 3x).
    expect(activeCycle.packageAmount).toBe(600);
    expect(activeCycle.roiTarget).toBe(1200);
    expect(activeCycle.incomeCap).toBe(1800);

    // Already-earned progress is untouched — only ceilings rise.
    expect(activeCycle.earnedRoi).toBe(150);
    expect(activeCycle.totalEarned).toBe(150);

    // User lifetime deposit total grows; cycle number unchanged (same cycle).
    expect(user.totalDeposited).toBe(600);
    expect(user.currentCycleNumber).toBe(1);

    expect(activeCycle.save).toHaveBeenCalled();
    expect(user.save).toHaveBeenCalled();
  });

  test('creates a fresh cycle when no active cycle exists', async () => {
    const created = [{ _id: 'cycle2', packageAmount: 300 }];
    jest.doMock('../src/models/Cycle', () => ({
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(created),
    }));
    jest.doMock('../src/models/User', () => ({ findByIdAndUpdate: jest.fn() }));

    const Cycle = require('../src/models/Cycle');
    const { createCycleForDeposit } = require('../src/services/cycleService');

    const user = { _id: 'user1', currentCycleNumber: 0, totalDeposited: 0, save: jest.fn() };
    const result = await createCycleForDeposit(user, 300, null);

    expect(result.isTopup).toBe(false);
    expect(result.cycle).toBe(created[0]);
    expect(Cycle.create).toHaveBeenCalled();
    expect(user.currentCycleNumber).toBe(1);
    expect(user.isActive).toBe(true);
    expect(user.totalDeposited).toBe(300);
  });
});
