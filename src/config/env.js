const dotenv = require('dotenv');

dotenv.config();

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  mongodbUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET || 'dev_secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1d',
  adminWallet: (process.env.ADMIN_WALLET || '').toLowerCase(),
  bscRpcUrl: process.env.BSC_RPC_URL,
  usdtContractAddress: (process.env.USDT_CONTRACT_ADDRESS || '').toLowerCase(),
  depositContractAddress: (process.env.DEPOSIT_CONTRACT_ADDRESS || '').toLowerCase(),
  depositContractAbiPath: process.env.DEPOSIT_CONTRACT_ABI_PATH || 'src/contracts/DepositContract.abi.json',
  treasuryWallet: (process.env.TREASURY_WALLET || '').toLowerCase(),
  payoutWallet: (process.env.PAYOUT_WALLET || '').toLowerCase(),
  payoutPrivateKey: process.env.PAYOUT_PRIVATE_KEY,
  chainConfirmations: Number(process.env.CHAIN_CONFIRMATIONS || 8),
};

module.exports = env;
