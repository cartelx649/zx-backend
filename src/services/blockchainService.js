const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

let providerInstance = null;
let depositContractAbiCache = null;

function getProvider() {
  if (!providerInstance) {
    providerInstance = new ethers.JsonRpcProvider(env.bscRpcUrl);
  }
  return providerInstance;
}

function getReadContract() {
  if (!env.usdtContractAddress) {
    throw new ApiError(500, 'USDT contract address is not configured', 'CHAIN_CONFIG_MISSING');
  }
  return new ethers.Contract(env.usdtContractAddress, ERC20_ABI, getProvider());
}

function getDepositContractAbi() {
  if (depositContractAbiCache) return depositContractAbiCache;
  const abiPath = path.resolve(process.cwd(), env.depositContractAbiPath);
  if (!fs.existsSync(abiPath)) {
    throw new ApiError(500, 'Deposit contract ABI file not found', 'ABI_FILE_NOT_FOUND', { abiPath });
  }
  const raw = fs.readFileSync(abiPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(500, 'Invalid deposit contract ABI JSON', 'ABI_JSON_INVALID');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ApiError(500, 'Deposit contract ABI is empty', 'ABI_EMPTY');
  }
  depositContractAbiCache = parsed;
  return depositContractAbiCache;
}

function assertDepositContractConfigured() {
  if (!env.depositContractAddress) {
    throw new ApiError(500, 'Deposit contract address is not configured', 'DEPOSIT_CONTRACT_NOT_CONFIGURED');
  }
  // Explicitly load ABI as part of contract-deposit validation requirements.
  getDepositContractAbi();
}

async function verifyUsdtDeposit({ txHash, expectedFrom, expectedTo, expectedAmount }) {
  assertDepositContractConfigured();
  const provider = getProvider();
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.confirmations < env.chainConfirmations) {
    throw new ApiError(400, 'Transaction not sufficiently confirmed', 'CHAIN_CONFIRMATION_PENDING');
  }
  const usdtReadContract = getReadContract();
  const events = await usdtReadContract.queryFilter(
    usdtReadContract.filters.Transfer(expectedFrom, expectedTo),
    receipt.blockNumber,
    receipt.blockNumber
  );
  const expected = BigInt(Math.round(expectedAmount * 1_000_000));
  const match = events.some((eventLog) => eventLog.transactionHash === txHash && eventLog.args.value >= expected);
  if (!match) {
    throw new ApiError(400, 'USDT transfer verification failed', 'CHAIN_VERIFICATION_FAILED');
  }
  return { confirmations: receipt.confirmations };
}

async function transferPayout({ to, amount }) {
  const provider = getProvider();
  const wallet = new ethers.Wallet(env.payoutPrivateKey, provider);
  const contract = new ethers.Contract(env.usdtContractAddress, ERC20_ABI, wallet);
  const amountUnits = BigInt(Math.round(amount * 1_000_000));
  const tx = await contract.transfer(to, amountUnits);
  const receipt = await tx.wait(env.chainConfirmations);
  return { txHash: receipt.hash };
}

module.exports = { verifyUsdtDeposit, transferPayout };
