const FIXTURE_CONFIG = {
  emergencyPause: false,
  roiSlabs: [
    { name: 's1', min: 1, max: 500, monthlyPercent: 5 },
    { name: 's2', min: 501, max: 2000, monthlyPercent: 6 },
    { name: 's3', min: 2001, max: 5000, monthlyPercent: 7 },
    { name: 's4', min: 5001, max: null, monthlyPercent: 8 },
  ],
  overridePercentages: [],
};

function makeMocks({ userDocs = [], cycleDocs = [] } = {}) {
  const userFindOneAndUpdate = jest.fn().mockImplementation(async (filter) => ({
    _id: `u-${filter.walletAddress}`,
    walletAddress: filter.walletAddress,
  }));
  const userFindOne = jest.fn().mockImplementation((filter) => ({
    select: jest
      .fn()
      .mockResolvedValue(
        userDocs.find((u) => u.walletAddress === filter.walletAddress) || null
      ),
  }));
  const userUpdateOne = jest.fn().mockResolvedValue({ acknowledged: true });
  const userFind = jest.fn().mockImplementation(() => ({
    select: jest.fn().mockResolvedValue(userDocs),
  }));

  const cycleFindOneAndUpdate = jest.fn().mockImplementation(async (filter, update) => ({
    _id: `c-${filter.userId}`,
    userId: filter.userId,
    ...update.$set,
  }));
  const cycleFind = jest.fn().mockImplementation(() => ({
    select: jest.fn().mockResolvedValue(cycleDocs),
  }));

  const depositFindOneAndUpdate = jest
    .fn()
    .mockImplementation(async (filter) => ({ _id: `d-${filter.txHash}`, txHash: filter.txHash }));

  const ledgerFindOneAndUpdate = jest
    .fn()
    .mockImplementation(async (filter) => ({ _id: `l-${filter.type}-${filter.beneficiaryUserId}` }));

  jest.doMock('../src/models/User', () => ({
    findOneAndUpdate: userFindOneAndUpdate,
    findOne: userFindOne,
    updateOne: userUpdateOne,
    find: userFind,
  }));
  jest.doMock('../src/models/Cycle', () => ({
    findOneAndUpdate: cycleFindOneAndUpdate,
    find: cycleFind,
  }));
  jest.doMock('../src/models/Deposit', () => ({ findOneAndUpdate: depositFindOneAndUpdate }));
  jest.doMock('../src/models/IncomeLedger', () => ({ findOneAndUpdate: ledgerFindOneAndUpdate }));
  jest.doMock('../src/services/configService', () => ({
    getConfig: jest.fn().mockResolvedValue(FIXTURE_CONFIG),
  }));
  // resolveRoiSlab pulled in transitively; reimplement to avoid loading depositService's heavy deps.
  jest.doMock('../src/services/depositService', () => ({
    resolveRoiSlab: (amount, slabs) =>
      slabs.find((s) => amount >= s.min && (s.max === null || amount <= s.max)),
  }));

  return {
    userFindOneAndUpdate,
    userUpdateOne,
    cycleFindOneAndUpdate,
    depositFindOneAndUpdate,
    ledgerFindOneAndUpdate,
  };
}

describe('syncService.syncFromDataJson', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('rejects with INVALID_SYNC_PAYLOAD on missing rows', async () => {
    makeMocks();
    const { syncFromDataJson } = require('../src/services/syncService');
    await expect(syncFromDataJson({})).rejects.toMatchObject({ code: 'INVALID_SYNC_PAYLOAD' });
  });

  test('happy two-row case: upserts user, attaches sponsor, creates cycle/deposit/ledger', async () => {
    const downline = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const sponsor = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const userDocs = [
      { _id: 'u-sponsor', walletAddress: sponsor },
      { _id: 'u-downline', walletAddress: downline },
    ];
    const cycleDocs = [
      { _id: 'c-u-sponsor', userId: 'u-sponsor' },
      { _id: 'c-u-downline', userId: 'u-downline' },
    ];
    const mocks = makeMocks({ userDocs, cycleDocs });

    const { syncFromDataJson } = require('../src/services/syncService');
    const stats = await syncFromDataJson({
      rows: [
        {
          Address: sponsor.toUpperCase(),
          Referrer: null,
          'Deposited (USD)': 100,
          'ROI Accrued est. (USD)': 10,
          'Referral Rewards Claimed (USD)': 5,
        },
        {
          Address: downline.toUpperCase(),
          Referrer: sponsor.toUpperCase(),
          'Deposited (USD)': 1000,
          'ROI Accrued est. (USD)': 50,
          'Referral Rewards Claimed (USD)': 20,
        },
      ],
    });

    expect(stats.rowsProcessed).toBe(2);
    expect(stats.usersUpserted).toBe(2);
    expect(stats.cyclesUpserted).toBe(2);
    expect(stats.depositsUpserted).toBe(2);
    expect(stats.ledgerEntriesUpserted).toBe(4);
    expect(stats.overCapWarnings).toEqual([]);

    expect(mocks.userFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.userFindOneAndUpdate).toHaveBeenCalledWith(
      { walletAddress: sponsor },
      expect.any(Object),
      expect.objectContaining({ upsert: true })
    );

    expect(mocks.userUpdateOne).toHaveBeenCalledWith(
      { walletAddress: downline },
      { $set: { sponsorWalletAddress: sponsor } }
    );
    expect(mocks.userUpdateOne).toHaveBeenCalledTimes(1);

    const cycleCall = mocks.cycleFindOneAndUpdate.mock.calls.find(
      ([f]) => f.userId === 'u-downline'
    );
    expect(cycleCall[1].$set).toMatchObject({
      packageAmount: 1000,
      roiTarget: 2000,
      incomeCap: 3000,
      earnedRoi: 50,
      earnedDirect: 20,
      earnedOverride: 0,
      totalEarned: 70,
      isActive: true,
    });

    expect(mocks.depositFindOneAndUpdate).toHaveBeenCalledWith(
      { txHash: `synced-${downline}` },
      expect.objectContaining({ $set: expect.objectContaining({ roiSlabName: 's2', amount: 1000 }) }),
      expect.objectContaining({ upsert: true })
    );

    const ledgerTypes = mocks.ledgerFindOneAndUpdate.mock.calls.map(([f]) => f.type);
    expect(ledgerTypes).toEqual(expect.arrayContaining(['roi', 'direct']));
    expect(mocks.ledgerFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ monthKey: 'sync-historical' }),
      expect.any(Object),
      expect.objectContaining({ upsert: true })
    );
  });

  test.each([
    [100, 's1'],
    [1000, 's2'],
    [3000, 's3'],
    [6000, 's4'],
  ])('resolves slab for deposit %i to %s', async (amount, expectedSlab) => {
    const addr = '0xcccccccccccccccccccccccccccccccccccccccc';
    const userDocs = [{ _id: 'u1', walletAddress: addr }];
    const cycleDocs = [{ _id: 'c1', userId: 'u1' }];
    const mocks = makeMocks({ userDocs, cycleDocs });

    const { syncFromDataJson } = require('../src/services/syncService');
    await syncFromDataJson({
      rows: [
        {
          Address: addr,
          Referrer: null,
          'Deposited (USD)': amount,
          'ROI Accrued est. (USD)': 0,
          'Referral Rewards Claimed (USD)': 0,
        },
      ],
    });

    const depositCall = mocks.depositFindOneAndUpdate.mock.calls[0];
    expect(depositCall[1].$set.roiSlabName).toBe(expectedSlab);
  });

  test('leaves sponsorWalletAddress unset when referrer is not in our User collection', async () => {
    const addr = '0xdddddddddddddddddddddddddddddddddddddddd';
    const userDocs = [{ _id: 'u1', walletAddress: addr }]; // sponsor wallet NOT included
    const cycleDocs = [{ _id: 'c1', userId: 'u1' }];
    const mocks = makeMocks({ userDocs, cycleDocs });

    const { syncFromDataJson } = require('../src/services/syncService');
    await syncFromDataJson({
      rows: [
        {
          Address: addr,
          Referrer: '0x9999999999999999999999999999999999999999',
          'Deposited (USD)': 100,
          'ROI Accrued est. (USD)': 0,
          'Referral Rewards Claimed (USD)': 0,
        },
      ],
    });

    expect(mocks.userUpdateOne).not.toHaveBeenCalled();
  });

  test('is idempotent: two runs produce identical upsert call counts', async () => {
    const addr = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const userDocs = [{ _id: 'u1', walletAddress: addr }];
    const cycleDocs = [{ _id: 'c1', userId: 'u1' }];
    const mocks = makeMocks({ userDocs, cycleDocs });

    const { syncFromDataJson } = require('../src/services/syncService');
    const payload = {
      rows: [
        {
          Address: addr,
          Referrer: null,
          'Deposited (USD)': 100,
          'ROI Accrued est. (USD)': 10,
          'Referral Rewards Claimed (USD)': 5,
        },
      ],
    };
    const first = await syncFromDataJson(payload);
    const second = await syncFromDataJson(payload);
    expect(first).toEqual(second);
    expect(mocks.depositFindOneAndUpdate).toHaveBeenCalledTimes(2);
    // Both calls target the same txHash → unique key → upsert no-ops on the second pass.
    expect(mocks.depositFindOneAndUpdate.mock.calls[0][0]).toEqual(
      mocks.depositFindOneAndUpdate.mock.calls[1][0]
    );
  });

  test('records over-cap warning and closes cycle when direct+level exceeds 1× cap', async () => {
    const addr = '0xffffffffffffffffffffffffffffffffffffffff';
    const userDocs = [{ _id: 'u1', walletAddress: addr }];
    const cycleDocs = [{ _id: 'c1', userId: 'u1' }];
    const mocks = makeMocks({ userDocs, cycleDocs });

    const warnSpy = jest.fn();
    const { syncFromDataJson } = require('../src/services/syncService');
    const stats = await syncFromDataJson(
      {
        rows: [
          {
            Address: addr,
            Referrer: null,
            'Deposited (USD)': 204,
            'ROI Accrued est. (USD)': 71,
            'Referral Rewards Claimed (USD)': 313,
          },
        ],
      },
      { logger: { warn: warnSpy, log: () => {} } }
    );

    expect(stats.overCapWarnings).toContainEqual({
      address: addr,
      kind: 'directLevel',
      expected: 204,
      actual: 313,
    });
    expect(warnSpy).toHaveBeenCalled();

    const cycleSet = mocks.cycleFindOneAndUpdate.mock.calls[0][1].$set;
    expect(cycleSet.earnedDirect).toBe(313);
    expect(cycleSet.isActive).toBe(false);
    expect(cycleSet.closedAt).toBeInstanceOf(Date);
  });

  test('keeps cycle active when earnings are well under all caps', async () => {
    const addr = '0x1111111111111111111111111111111111111111';
    const userDocs = [{ _id: 'u1', walletAddress: addr }];
    const cycleDocs = [{ _id: 'c1', userId: 'u1' }];
    const mocks = makeMocks({ userDocs, cycleDocs });

    const { syncFromDataJson } = require('../src/services/syncService');
    await syncFromDataJson({
      rows: [
        {
          Address: addr,
          Referrer: null,
          'Deposited (USD)': 1000,
          'ROI Accrued est. (USD)': 10,
          'Referral Rewards Claimed (USD)': 5,
        },
      ],
    });

    const cycleSet = mocks.cycleFindOneAndUpdate.mock.calls[0][1].$set;
    expect(cycleSet.isActive).toBe(true);
    expect(cycleSet.closedAt).toBeNull();
  });

  test('skips rows with missing Address', async () => {
    makeMocks({ userDocs: [], cycleDocs: [] });
    const { syncFromDataJson } = require('../src/services/syncService');
    const stats = await syncFromDataJson({
      rows: [{ Address: null, 'Deposited (USD)': 100 }, { Address: undefined }],
    });
    expect(stats.rowsProcessed).toBe(0);
    expect(stats.usersUpserted).toBe(0);
  });
});
