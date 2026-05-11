const AuditLog = require('../models/AuditLog');

async function logAudit({ actorUserId = null, action, entity, entityId, meta = {} }) {
  return AuditLog.create({ actorUserId, action, entity, entityId, meta });
}

module.exports = { logAudit };
