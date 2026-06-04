const path = require('path');
const fs = require('fs');
const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { getKpis, getConfig, updateConfig } = require('../services/adminService');
const { syncFromDataJson, unsyncBatch } = require('../services/syncService');
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

module.exports = {
  kpis,
  config,
  update,
  syncDataJson,
  syncRoiReport,
  unsyncRoiReport,
  listSyncBatches,
};
