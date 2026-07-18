const crypto = require('node:crypto');

const { deriveOpExpireAt } = require('./managed-records');
const { parseOpToken } = require('./op-url');

const MAX_CODE_ATTEMPTS = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createHttpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function normalizeUuid(value, message) {
  const normalized = String(value || '').trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw createHttpError(400, message);
  }
  return normalized;
}

function normalizeRecordId(id) {
  return normalizeUuid(id, '短 OP ID 格式不正确');
}

function generateShortOpCode(randomIntImpl = crypto.randomInt) {
  return String(randomIntImpl(0, 100_000_000)).padStart(8, '0');
}

function maskOpValue(opValue) {
  return String(opValue || '')
    .split('|')
    .map((part) => (part.length <= 3 ? '****' : `${part.slice(0, 3)}****`))
    .join('|');
}

function toShortOpDto(row, { includeOpValue = false } = {}) {
  const item = {
    id: row.id,
    code: row.code,
    shortLink: `/op/${row.code}`,
    maskedOpValue: maskOpValue(row.op_value),
    applicationId: row.application_id,
    appName: row.app_name,
    appId: row.app_id,
    opExpireAt: row.op_expire_at,
    status: row.status,
    owner: row.owner_login || null,
    remark: row.remark,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeOpValue) {
    item.opValue = row.op_value;
  }
  return item;
}

function normalizeOpInput(payload = {}, fallback = {}) {
  const opValue = String(
    payload.opValue === undefined ? fallback.opValue || '' : payload.opValue,
  ).trim();
  const applicationId = normalizeUuid(
    payload.applicationId === undefined
      ? fallback.applicationId || ''
      : payload.applicationId,
    '应用 ID 格式不正确',
  );
  const remark = String(
    payload.remark === undefined ? fallback.remark || '' : payload.remark,
  ).trim();

  if (!opValue || !applicationId) {
    throw createHttpError(400, 'OP 数据和应用不能为空');
  }
  try {
    parseOpToken(opValue);
  } catch (error) {
    throw createHttpError(400, error.message);
  }

  return {
    opValue,
    applicationId,
    remark,
    opExpireAt: deriveOpExpireAt(opValue, { strict: true }),
  };
}

async function lockActiveApplication(client, applicationId) {
  const result = await client.query(
    `
      select *
      from op_applications
      where id = $1 and status = 'active'
      for key share
    `,
    [applicationId],
  );
  if (!result.rows[0]) {
    throw createHttpError(400, '所选应用不存在或已停用');
  }
  return result.rows[0];
}

function combineShortOpRow(row, application, adminUser) {
  return {
    ...row,
    app_name: application.name,
    app_id: application.app_id,
    owner_login: adminUser.login,
  };
}

async function createShortOpRecord(pool, payload, adminUser, options = {}) {
  const input = normalizeOpInput(payload);
  const randomIntImpl = options.randomIntImpl || crypto.randomInt;
  const client = await pool.connect();
  let completed = false;

  try {
    await client.query('begin');
    const application = await lockActiveApplication(client, input.applicationId);

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const code = generateShortOpCode(randomIntImpl);
      const result = await client.query(
        `
          insert into short_op_records (
            id, owner_id, code, op_value, application_id,
            op_expire_at, status, remark
          )
          values ($1, $2, $3, $4, $5, $6, 'active', $7)
          on conflict (code) do nothing
          returning *
        `,
        [
          crypto.randomUUID(),
          adminUser.id,
          code,
          input.opValue,
          input.applicationId,
          input.opExpireAt,
          input.remark,
        ],
      );
      if (result.rows[0]) {
        await client.query('commit');
        completed = true;
        return toShortOpDto(
          combineShortOpRow(result.rows[0], application, adminUser),
          { includeOpValue: true },
        );
      }
    }

    throw createHttpError(
      409,
      '短码生成冲突，请重试',
      'SHORT_OP_CODE_EXHAUSTED',
    );
  } catch (error) {
    if (!completed) {
      await client.query('rollback');
    }
    if (error.code === '23505') {
      throw createHttpError(409, '该 OP 与应用已存在', 'SHORT_OP_DUPLICATE');
    }
    throw error;
  } finally {
    client.release();
  }
}

function buildOwnershipCondition(adminUser, values, alias = 's') {
  if (adminUser && adminUser.role !== 'super_admin') {
    values.push(adminUser.id);
    return `${alias}.owner_id = $${values.length}`;
  }
  return '';
}

function parsePagination(filters = {}) {
  const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
  const requested = String(filters.pageSize || '20').toLowerCase();
  if (requested === 'all') {
    return { page: 1, pageSize: 'all', limit: null, offset: 0 };
  }
  const pageSize = [20, 50, 100].includes(Number(requested)) ? Number(requested) : 20;
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

function parseExpiryRange(filters = {}) {
  const rawFrom = String(filters.opExpireFrom || '').trim();
  const rawTo = String(filters.opExpireTo || '').trim();
  const hasExplicitTimezone = (value) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  const fromTime = rawFrom ? Date.parse(rawFrom) : null;
  const toTime = rawTo ? Date.parse(rawTo) : null;
  if (
    (rawFrom && (!hasExplicitTimezone(rawFrom) || !Number.isFinite(fromTime)))
    || (rawTo && (!hasExplicitTimezone(rawTo) || !Number.isFinite(toTime)))
  ) {
    throw createHttpError(400, '短 OP 到期时间格式不正确');
  }
  if (fromTime !== null && toTime !== null && fromTime > toTime) {
    throw createHttpError(400, '短 OP 到期时间范围不正确');
  }
  return {
    opExpireFrom: fromTime === null ? '' : new Date(fromTime).toISOString(),
    opExpireTo: toTime === null ? '' : new Date(toTime).toISOString(),
  };
}

function buildListWhere(filters, adminUser) {
  const conditions = [];
  const values = [];
  const status = String(filters.status || '').trim();
  if (['active', 'disabled', 'deleted'].includes(status)) {
    values.push(status);
    conditions.push(`s.status = $${values.length}`);
  } else {
    conditions.push(`s.status <> 'deleted'`);
  }

  const applicationId = String(filters.applicationId || '').trim();
  if (applicationId) {
    values.push(applicationId);
    conditions.push(`s.application_id = $${values.length}`);
  }

  const search = String(filters.search || '').trim();
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(
      s.code ilike $${values.length}
      or s.op_value ilike $${values.length}
      or s.remark ilike $${values.length}
      or a.name ilike $${values.length}
      or a.app_id ilike $${values.length}
    )`);
  }

  const { opExpireFrom, opExpireTo } = parseExpiryRange(filters);
  if (opExpireFrom) {
    values.push(opExpireFrom);
    conditions.push(`s.op_expire_at >= $${values.length}::timestamptz`);
  }
  if (opExpireTo) {
    values.push(opExpireTo);
    conditions.push(`s.op_expire_at <= $${values.length}::timestamptz`);
  }

  const ownerCondition = buildOwnershipCondition(adminUser, values);
  if (ownerCondition) conditions.push(ownerCondition);
  return { whereClause: `where ${conditions.join(' and ')}`, values };
}

async function listShortOpRecords(pool, filters = {}, adminUser) {
  const { page, pageSize, limit, offset } = parsePagination(filters);
  const { whereClause, values } = buildListWhere(filters, adminUser);
  const joins = `
    from short_op_records s
    join op_applications a on a.id = s.application_id
    join admin_users u on u.id = s.owner_id
  `;
  const countResult = await pool.query(
    `select count(*)::int as total ${joins} ${whereClause}`,
    values,
  );

  const listValues = [...values];
  let paginationSql = '';
  if (limit !== null) {
    listValues.push(limit, offset);
    paginationSql = `limit $${listValues.length - 1} offset $${listValues.length}`;
  }
  const result = await pool.query(
    `
      select s.*, a.name as app_name, a.app_id, u.login as owner_login
      ${joins}
      ${whereClause}
      order by s.updated_at desc, s.id asc
      ${paginationSql}
    `,
    listValues,
  );

  return {
    items: result.rows.map((row) => toShortOpDto(row)),
    total: countResult.rows[0].total,
    page,
    pageSize,
  };
}

async function queryShortOpById(client, id, adminUser, { includeDeleted = false } = {}) {
  const values = [id];
  const conditions = [`s.id = $1`];
  if (!includeDeleted) conditions.push(`s.status <> 'deleted'`);
  const ownerCondition = buildOwnershipCondition(adminUser, values);
  if (ownerCondition) conditions.push(ownerCondition);
  const result = await client.query(
    `
      select s.*, a.name as app_name, a.app_id, u.login as owner_login
      from short_op_records s
      join op_applications a on a.id = s.application_id
      join admin_users u on u.id = s.owner_id
      where ${conditions.join(' and ')}
      limit 1
    `,
    values,
  );
  return result.rows[0] || null;
}

async function getShortOpRecordById(pool, id, adminUser) {
  const recordId = normalizeRecordId(id);
  const row = await queryShortOpById(pool, recordId, adminUser);
  return row ? toShortOpDto(row, { includeOpValue: true }) : null;
}

async function updateShortOpRecord(pool, id, payload, adminUser) {
  const recordId = normalizeRecordId(id);
  const client = await pool.connect();
  let completed = false;
  try {
    await client.query('begin');
    const existing = await queryShortOpById(client, recordId, adminUser);
    if (!existing) {
      await client.query('rollback');
      completed = true;
      return null;
    }
    const input = normalizeOpInput(payload, {
      opValue: existing.op_value,
      applicationId: existing.application_id,
      remark: existing.remark,
    });
    const application = await lockActiveApplication(client, input.applicationId);
    const values = [
      recordId, input.opValue, input.applicationId, input.opExpireAt, input.remark,
    ];
    let ownerSql = '';
    if (adminUser.role !== 'super_admin') {
      values.push(adminUser.id);
      ownerSql = `and owner_id = $${values.length}`;
    }
    const result = await client.query(
      `
        update short_op_records
        set op_value = $2, application_id = $3, op_expire_at = $4,
            remark = $5, updated_at = now()
        where id = $1 and status <> 'deleted' ${ownerSql}
        returning *
      `,
      values,
    );
    await client.query('commit');
    completed = true;
    return result.rows[0]
      ? toShortOpDto(combineShortOpRow(result.rows[0], application, {
        login: existing.owner_login,
      }), { includeOpValue: true })
      : null;
  } catch (error) {
    if (!completed) await client.query('rollback');
    if (error.code === '23505') {
      throw createHttpError(409, '该 OP 与应用已存在', 'SHORT_OP_DUPLICATE');
    }
    throw error;
  } finally {
    client.release();
  }
}

async function setShortOpRecordStatus(pool, id, status, adminUser) {
  if (!['active', 'disabled'].includes(status)) {
    throw createHttpError(400, '短 OP 状态无效');
  }
  const recordId = normalizeRecordId(id);
  const values = [recordId, status];
  let ownerSql = '';
  if (adminUser.role !== 'super_admin') {
    values.push(adminUser.id);
    ownerSql = `and owner_id = $${values.length}`;
  }
  const result = await pool.query(
    `
      update short_op_records
      set status = $2, updated_at = now()
      where id = $1 and status <> 'deleted' ${ownerSql}
      returning id
    `,
    values,
  );
  if (!result.rows[0]) return null;
  return getShortOpRecordById(pool, recordId, adminUser);
}

async function deleteShortOpRecord(pool, id, adminUser) {
  const recordId = normalizeRecordId(id);
  const values = [recordId];
  let ownerSql = '';
  if (adminUser.role !== 'super_admin') {
    values.push(adminUser.id);
    ownerSql = `and owner_id = $${values.length}`;
  }
  const result = await pool.query(
    `
      update short_op_records
      set status = 'deleted', deleted_at = now(), updated_at = now()
      where id = $1 and status <> 'deleted' ${ownerSql}
      returning id
    `,
    values,
  );
  if (!result.rows[0]) return null;
  const row = await queryShortOpById(
    pool,
    recordId,
    adminUser,
    { includeDeleted: true },
  );
  return row ? toShortOpDto(row, { includeOpValue: true }) : null;
}

async function findImportApplication(pool, appId) {
  if (appId) {
    const result = await pool.query(
      `select * from op_applications where app_id = $1 and status = 'active' limit 1`,
      [appId],
    );
    return result.rows[0] || null;
  }
  const result = await pool.query(
    `
      select * from op_applications
      where is_default = true and status = 'active'
      limit 1
    `,
  );
  return result.rows[0] || null;
}

function splitImportLine(line) {
  const separatorIndex = line.lastIndexOf('----');
  if (separatorIndex < 0) {
    return { opValue: line.trim(), appId: '' };
  }
  return {
    opValue: line.slice(0, separatorIndex).trim(),
    appId: line.slice(separatorIndex + 4).trim(),
  };
}

async function importShortOpText(pool, rowsText, adminUser, options = {}) {
  const lines = String(rowsText || '').split(/\r?\n/);
  const items = [];
  const errors = [];
  const seen = new Set();
  const createRecord = options.createShortOpRecordImpl || createShortOpRecord;
  let duplicateCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const parsed = splitImportLine(line);
      if (!parsed.opValue || (line.includes('----') && !parsed.appId)) {
        throw createHttpError(400, '每行只能填写 OP 或 OP----AppID');
      }
      const application = await findImportApplication(pool, parsed.appId);
      if (!application) {
        throw createHttpError(400, parsed.appId ? '指定 AppID 不存在或已停用' : '默认应用不存在或已停用');
      }
      const duplicateKey = `${parsed.opValue}\u0000${application.id}`;
      if (seen.has(duplicateKey)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(duplicateKey);
      try {
        items.push(await createRecord(pool, {
          opValue: parsed.opValue,
          applicationId: application.id,
        }, adminUser, options));
      } catch (error) {
        if (error.code === 'SHORT_OP_DUPLICATE') {
          duplicateCount += 1;
          continue;
        }
        throw error;
      }
    } catch (error) {
      errors.push({ lineNumber: index + 1, message: error.message });
    }
  }

  return {
    importedCount: items.length,
    duplicateCount,
    failedCount: errors.length,
    items,
    errors,
  };
}

async function resolveActiveShortOpByCode(pool, code) {
  const normalizedCode = String(code || '').trim();
  if (!/^\d{8}$/.test(normalizedCode)) return null;
  const result = await pool.query(
    `
      select s.*, a.name as app_name, a.app_id, u.login as owner_login
      from short_op_records s
      join op_applications a on a.id = s.application_id
      join admin_users u on u.id = s.owner_id
      where s.code = $1
        and s.status = 'active'
        and s.op_expire_at > now()
        and a.status = 'active'
      limit 1
    `,
    [normalizedCode],
  );
  return result.rows[0]
    ? toShortOpDto(result.rows[0], { includeOpValue: true })
    : null;
}

module.exports = {
  createShortOpRecord,
  deleteShortOpRecord,
  generateShortOpCode,
  getShortOpRecordById,
  importShortOpText,
  listShortOpRecords,
  resolveActiveShortOpByCode,
  setShortOpRecordStatus,
  updateShortOpRecord,
};
