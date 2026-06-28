const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const {
  getKpis,
  getConfig,
  updateConfig,
  listCapReachedCycles,
  listUserCycleProgress,
} = require('../services/adminService');
const { getIncomeOverview, getMonthlyUserIncome } = require('../services/systemIncomeService');
const { getWithdrawableIncome, getAllUsersWithdrawableIncome } = require('../services/incomeService');
const { syncFromDataJson, unsyncBatch, fixLedgerMonthKeys } = require('../services/syncService');
const { logAudit } = require('../services/auditService');
const SyncBatch = require('../models/SyncBatch');

const updateConfigSchema = Joi.object({
  roiSlabs: Joi.array().items(
    Joi.object({
      name: Joi.string().required(),
      min: Joi.number().required(),
      max: Joi.number().allow(null),
      monthlyPercent: Joi.number().positive().required(),
    })
  ),
  overridePercentages: Joi.array().items(
    Joi.object({ level: Joi.number().min(1).max(20).required(), percent: Joi.number().min(0).required() })
  ),
  withdrawalWindow: Joi.object({
    dayOfMonth: Joi.number().min(1).max(28).required(),
    isOpen: Joi.boolean().required(),
  }),
  emergencyPause: Joi.boolean(),
}).min(1);

const kpis = asyncHandler(async (req, res) => {
  const data = await getKpis();
  res.json({ ok: true, data });
});

const config = asyncHandler(async (req, res) => {
  const data = await getConfig();
  res.json({ ok: true, data });
});

const update = asyncHandler(async (req, res) => {
  const payload = await updateConfigSchema.validateAsync(req.body);
  const data = await updateConfig(payload);
  res.json({ ok: true, data });
});

const syncDataJsonSchema = Joi.object({
  password: Joi.string().required(),
  data: Joi.object({
    rows: Joi.array().items(Joi.object()).required(),
  }).optional(),
});

const syncDataJson = asyncHandler(async (req, res) => {
  const payload = await syncDataJsonSchema.validateAsync(req.body);
  if (payload.password !== env.backendLoginPassword) {
    throw new ApiError(401, 'Invalid password', 'INVALID_SYNC_PASSWORD');
  }
  let data = payload.data;
  if (!data) {
    const filePath = path.join(__dirname, '..', '..', 'data.json');
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  const stats = await syncFromDataJson(data);
  res.json({ ok: true, data: stats });
});

function assertSyncPassword(password) {
  if (password !== env.backendLoginPassword) {
    throw new ApiError(401, 'Invalid password', 'INVALID_SYNC_PASSWORD');
  }
}

function makeBatchId() {
  return `roi-report-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

const syncRoiReportSchema = Joi.object({
  password: Joi.string().required(),
  data: Joi.object({
    rows: Joi.array().items(Joi.object()).required(),
  }).optional(),
});

const syncRoiReport = asyncHandler(async (req, res) => {
  const payload = await syncRoiReportSchema.validateAsync(req.body);
  assertSyncPassword(payload.password);

  let data = payload.data;
  let source = 'request-body';
  if (!data) {
    const filePath = path.join(__dirname, '..', '..', 'data', 'roi_report.json');
    if (!fs.existsSync(filePath)) {
      throw new ApiError(
        400,
        'No data provided and data/roi_report.json not found. Run export-roi-report-json first.',
        'SYNC_SOURCE_MISSING'
      );
    }
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    source = 'data/roi_report.json';
  }

  const batchId = makeBatchId();
  const stats = await syncFromDataJson(data, { batchId, source });
  await logAudit({ action: 'roi_sync', entity: 'SyncBatch', entityId: batchId, meta: stats });
  res.json({ ok: true, data: { batchId, stats } });
});

const unsyncRoiReportSchema = Joi.object({
  password: Joi.string().required(),
  batchId: Joi.string().required(),
});

const unsyncRoiReport = asyncHandler(async (req, res) => {
  const payload = await unsyncRoiReportSchema.validateAsync(req.body);
  assertSyncPassword(payload.password);

  const result = await unsyncBatch(payload.batchId);
  await logAudit({
    action: 'roi_unsync',
    entity: 'SyncBatch',
    entityId: payload.batchId,
    meta: result.deleted,
  });
  res.json({ ok: true, data: result });
});

const incomeOverviewSchema = Joi.object({
  password: Joi.string().required(),
  months: Joi.number().integer().min(0).max(120).default(12),
});

const incomeOverview = asyncHandler(async (req, res) => {
  const { password, months } = await incomeOverviewSchema.validateAsync(req.query);
  if (password !== env.virtualDepositPassword) {
    throw new ApiError(401, 'Invalid password', 'INVALID_PASSWORD');
  }
  const data = await getIncomeOverview({ months });
  res.json({ ok: true, data });
});

const monthlyUserIncomeSchema = Joi.object({
  password: Joi.string().required(),
  month: Joi.string().required(),
});

const monthlyUserIncome = asyncHandler(async (req, res) => {
  const { password, month } = await monthlyUserIncomeSchema.validateAsync(req.query);
  if (password !== env.virtualDepositPassword) {
    throw new ApiError(401, 'Invalid password', 'INVALID_PASSWORD');
  }
  const data = await getMonthlyUserIncome({ month });
  res.json({ ok: true, data });
});

const adminWithdrawableIncomeSchema = Joi.object({
  password: Joi.string().required(),
  month: Joi.string().required(),
});

const adminWithdrawableIncome = asyncHandler(async (req, res) => {
  const { password, month } = await adminWithdrawableIncomeSchema.validateAsync(req.query);
  if (password !== env.virtualDepositPassword) {
    throw new ApiError(401, 'Invalid password', 'INVALID_PASSWORD');
  }
  const { userId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new ApiError(400, 'Invalid userId', 'INVALID_USER_ID');
  }
  const data = await getWithdrawableIncome(userId, month);
  res.json({ ok: true, data });
});

const adminAllUsersWithdrawableIncome = asyncHandler(async (req, res) => {
  const { password, month } = await monthlyUserIncomeSchema.validateAsync(req.query);
  if (password !== env.virtualDepositPassword) {
    throw new ApiError(401, 'Invalid password', 'INVALID_PASSWORD');
  }
  const data = await getAllUsersWithdrawableIncome(month);
  res.json({ ok: true, data });
});

const capReachedCyclesSchema = Joi.object({
  password: Joi.string().required(),
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0),
});

const capReachedCycles = asyncHandler(async (req, res) => {
  const { password, limit, offset } = await capReachedCyclesSchema.validateAsync(req.query);
  if (password !== env.virtualDepositPassword) {
    throw new ApiError(401, 'Invalid password', 'INVALID_PASSWORD');
  }
  const data = await listCapReachedCycles({ limit, offset });
  res.json({ ok: true, data });
});

const cycleProgressSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(500).default(200),
  offset: Joi.number().integer().min(0).default(0),
  status: Joi.string()
    .valid('all', 'attention', 'active', 'inactive', 'roi_reached', 'cap_reached')
    .default('all'),
});

const cycleProgress = asyncHandler(async (req, res) => {
  const { limit, offset, status } = await cycleProgressSchema.validateAsync(req.query);
  const data = await listUserCycleProgress({ limit, offset, status });
  res.json({ ok: true, data });
});

const listSyncBatchesSchema = Joi.object({
  password: Joi.string().required(),
});

const listSyncBatches = asyncHandler(async (req, res) => {
  const source = Object.keys(req.body || {}).length ? req.body : req.query;
  const payload = await listSyncBatchesSchema.validateAsync(source);
  assertSyncPassword(payload.password);

  const batches = await SyncBatch.find()
    .sort({ createdAt: -1 })
    .select({ batchId: 1, source: 1, status: 1, stats: 1, revertedAt: 1, createdAt: 1 })
    .lean();
  res.json({ ok: true, data: batches });
});

const fixLedgerMonthKeysSchema = Joi.object({
  password: Joi.string().required(),
  dry: Joi.boolean().default(false),
});

const fixLedgerMonthKeysHandler = asyncHandler(async (req, res) => {
  const payload = await fixLedgerMonthKeysSchema.validateAsync(req.body);
  assertSyncPassword(payload.password);

  const result = await fixLedgerMonthKeys({ dry: payload.dry });
  if (!payload.dry) {
    await logAudit({
      action: 'ledger_monthkey_fix',
      entity: 'IncomeLedger',
      entityId: `ledger-monthkey-fix-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      meta: { scanned: result.scanned, updated: result.updated, merged: result.merged, skipped: result.skipped },
    });
  }
  res.json({ ok: true, data: result });
});

module.exports = {
  kpis,
  config,
  update,
  syncDataJson,
  syncRoiReport,
  unsyncRoiReport,
  listSyncBatches,
  incomeOverview,
  monthlyUserIncome,
  adminWithdrawableIncome,
  adminAllUsersWithdrawableIncome,
  capReachedCycles,
  cycleProgress,
  fixLedgerMonthKeysHandler,
};
