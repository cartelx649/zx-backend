describe('Deposit smart contract integration', () => {
  const originalEnv = process.env;

  afterEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  test('blockchain service throws when ABI file path is invalid', async () => {
    process.env = {
      ...originalEnv,
      BSC_RPC_URL: 'https://bsc-dataseed.binance.org',
      USDT_CONTRACT_ADDRESS: '0x55d398326f99059ff775485246999027b3197955',
      DEPOSIT_CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111',
      DEPOSIT_CONTRACT_ABI_PATH: 'src/contracts/does-not-exist.json',
      CHAIN_CONFIRMATIONS: '8',
    };

    const { verifyUsdtDeposit } = require('../src/services/blockchainService');
    await expect(
      verifyUsdtDeposit({
        txHash: '0xabc',
        expectedFrom: '0x2222222222222222222222222222222222222222',
        expectedTo: '0x1111111111111111111111111111111111111111',
        expectedAmount: 100,
      })
    ).rejects.toMatchObject({ code: 'ABI_FILE_NOT_FOUND' });
  });

  test('deposit service verifies transfer to deposit contract address', async () => {
    process.env = {
      ...originalEnv,
      DEPOSIT_CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111',
    };

    jest.doMock('../src/models/User', () => ({
      findById: jest.fn().mockResolvedValue({
        _id: 'user1',
        walletAddress: '0x2222222222222222222222222222222222222222',
        sponsorWalletAddress: null,
      }),
    }));
    jest.doMock('../src/models/Cycle', () => ({
      findOne: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue(null) }),
    }));
    jest.doMock('../src/models/Deposit', () => ({ create: jest.fn() }));
    jest.doMock('../src/services/configService', () => ({
      getConfig: jest.fn().mockResolvedValue({
        emergencyPause: false,
        roiSlabs: [{ name: 'starter', min: 100, max: null, monthlyPercent: 10 }],
      }),
    }));
    const verifyUsdtDeposit = jest.fn().mockResolvedValue({ confirmations: 8 });
    jest.doMock('../src/services/blockchainService', () => ({ verifyUsdtDeposit }));
    jest.doMock('../src/services/cycleService', () => ({
      createCycleForDeposit: jest.fn(),
      withMongoTransaction: jest.fn(),
    }));
    jest.doMock('../src/services/incomeService', () => ({
      creditDirectCommission: jest.fn(),
    }));

    const cycleService = require('../src/services/cycleService');
    cycleService.withMongoTransaction.mockImplementation(async (work) => work({}));
    cycleService.createCycleForDeposit.mockResolvedValue({ cycle: { _id: 'cycle1' }, isTopup: false });

    const Deposit = require('../src/models/Deposit');
    Deposit.create.mockResolvedValue([{ _id: 'dep1' }]);

    const { verifyAndRecordDeposit } = require('../src/services/depositService');
    await verifyAndRecordDeposit({ userId: 'user1', txHash: '0xabc', amount: 100 });

    expect(verifyUsdtDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedTo: '0x1111111111111111111111111111111111111111',
      })
    );
  });
});
