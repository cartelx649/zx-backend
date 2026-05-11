const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const { getKpis, getConfig, updateConfig } = require('../services/adminService');

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

module.exports = { kpis, config, update };
