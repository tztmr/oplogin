const crypto = require('node:crypto');
const {
  encryptGooglePassword,
  decryptGooglePassword,
  buildGooglePasswordSearchHash,
} = require('./google-password-crypto');

const PHONE_STATUS_VALUES = ['未绑定', '已绑定'];
const PHONE_MODEL_VALUES = ['11', '12mini', '14', 'x'];
const PHONE_DURATION_DAYS = [30, 60, 90, 120, 150];
const PHONE_DEFAULT_DURATION_DAYS = 30;

function normalizePhoneDurationDays(value) {
  if (value === undefined) {
    return PHONE_DEFAULT_DURATION_DAYS;
  }

  const error = new Error('手机号有效期仅支持 30、60、90、120 或 150 天');
  error.statusCode = 400;
  if (value === null || Array.isArray(value) || typeof value === 'object') {
    throw error;
  }

  const days = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(days) || !PHONE_DURATION_DAYS.includes(days)) {
    throw error;
  }
  return days;
}

function derivePhoneExpireAt(now = Date.now(), durationDays = PHONE_DEFAULT_DURATION_DAYS) {
  return new Date(now + durationDays * 24 * 60 * 60 * 1000).toISOString();
}

function normalizePhoneSmsUrl(value) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return '';
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedValue);
  } catch {
    const error = new Error('接码链接格式不正确');
    error.statusCode = 400;
    throw error;
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    const error = new Error('接码链接仅支持 HTTP 或 HTTPS');
    error.statusCode = 400;
    throw error;
  }
  return normalizedValue;
}

function buildDerivedOpLink(opValue) {
  const normalizedOpValue = String(opValue || '').trim();
  return normalizedOpValue
    ? `/oplogin/${encodeURIComponent(normalizedOpValue)}`
    : '';
}

function deriveOpExpireAt(opValue, { strict = false } = {}) {
  const normalizedOpValue = String(opValue || '').trim();
  if (!normalizedOpValue) {
    return null;
  }

  const parts = normalizedOpValue.split('|').map((item) => item.trim());
  const timestampValue = parts[4];

  if (!timestampValue) {
    if (strict) {
      const error = new Error('OP 数据号缺少到期时间戳');
      error.statusCode = 400;
      throw error;
    }
    return null;
  }

  const timestamp = Number(timestampValue);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    const error = new Error('OP 数据号时间戳格式不正确');
    error.statusCode = 400;
    throw error;
  }

  // 自动加 30 天
  return new Date(timestamp * 1000 + 30 * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeManagedRecordInput(payload) {
  const input = {
    googleAccount: String(payload.googleAccount || '').trim(),
    googlePassword: String(payload.googlePassword || '').trim(),
    googleAssist: String(payload.googleAssist || '').trim(),
    googleExpireAt: payload.googleExpireAt || null,
    uidValue: String(payload.uidValue || '').trim(),
    phoneNumber: String(payload.phoneNumber || '').trim(),
    phoneSmsUrl: normalizePhoneSmsUrl(payload.phoneSmsUrl),
    phoneExpireAt: payload.phoneExpireAt || null,
    phoneStatus: PHONE_STATUS_VALUES.includes(
      String(payload.phoneStatus || '').trim(),
    )
      ? String(payload.phoneStatus || '').trim()
      : '未绑定',
    phoneModel: PHONE_MODEL_VALUES.includes(
      String(payload.phoneModel || '').trim(),
    )
      ? String(payload.phoneModel || '').trim()
      : '12mini',
    opValue: String(payload.opValue || '').trim(),
    opNickname: Object.prototype.hasOwnProperty.call(payload, 'opNickname')
      ? String(payload.opNickname || '').trim()
      : null,
    opLink: '',
    opExpireAt: null,
    remark: String(payload.remark || '').trim(),
  };

  input.opLink =
    String(payload.opLink || '').trim() || buildDerivedOpLink(input.opValue);
  input.opExpireAt = payload.opExpireAt || deriveOpExpireAt(input.opValue);
  if (input.phoneNumber && !input.phoneExpireAt) {
    input.phoneExpireAt = derivePhoneExpireAt();
  }

  if (!input.googleAccount && !input.opValue && !input.phoneNumber) {
    const error = new Error('必须提供谷歌号、OP 数据或手机号');
    error.statusCode = 400;
    throw error;
  }

  return input;
}

function decodeGooglePasswordForDto(row, config) {
  try {
    return {
      googlePassword: decryptGooglePassword(
        row.google_password_encrypted,
        config.googlePasswordEncryptionKey,
      ),
      googlePasswordDecryptionFailed: false,
    };
  } catch (error) {
    return {
      googlePassword: '',
      googlePasswordDecryptionFailed: true,
    };
  }
}

function toRecordDto(row, config) {
  const passwordState = decodeGooglePasswordForDto(row, config);
  return {
    id: row.id,
    distributionOrder:
      row.distribution_order === undefined || row.distribution_order === null
        ? null
        : Number(row.distribution_order),
    ownerId: row.owner_id,
    googleAccount: row.google_account,
    googlePassword: passwordState.googlePassword,
    googlePasswordDecryptionFailed: passwordState.googlePasswordDecryptionFailed,
    googleAssist: row.google_assist,
    googleExpireAt: row.google_expire_at,
    uidValue: row.uid_value,
    uidCreatedAt: row.uid_created_at,
    phoneNumber: row.phone_number || '',
    phoneSmsUrl: row.phone_sms_url || '',
    phoneExpireAt: row.phone_expire_at,
    phoneStatus: row.phone_status || '未绑定',
    phoneModel: row.phone_model || '12mini',
    opValue: row.op_value,
    opNickname: row.op_nickname || '',
    opLink: row.op_link,
    opExpireAt: row.op_expire_at,
    remark: row.remark,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getPublicBatchEligibilityStats(pool, config, adminUser) {
  const values = [
    buildGooglePasswordSearchHash('', config.googlePasswordEncryptionKey),
  ];
  let ownerWhereClause = '';

  if (adminUser && adminUser.role !== 'super_admin') {
    values.push(adminUser.id);
    ownerWhereClause = `where owner_id = $2`;
  }

  const result = await pool.query(
    `
      select
        coalesce(sum(case when google_account = '' then 1 else 0 end), 0)::int as missing_google_account_count,
        coalesce(sum(case
          when google_account != '' and google_password_search_hash = $1 then 1
          else 0
        end), 0)::int as missing_google_password_count,
        coalesce(sum(case
          when google_account != ''
            and google_password_search_hash != $1
            and op_value = '' then 1
          else 0
        end), 0)::int as missing_op_count,
        coalesce(sum(case
          when google_account != ''
            and google_password_search_hash != $1
            and op_value != ''
            and uid_value != '' then 1
          else 0
        end), 0)::int as filled_uid_count,
        coalesce(sum(case
          when google_account != ''
            and google_password_search_hash != $1
            and op_value != ''
            and (uid_value = '' or uid_value is null)
            and phone_number = '' then 1
          else 0
        end), 0)::int as missing_phone_count,
        coalesce(sum(case
          when google_account != ''
            and google_password_search_hash != $1
            and op_value != ''
            and (uid_value = '' or uid_value is null)
            and phone_number != '' then 1
          else 0
        end), 0)::int as eligible_count
      from managed_records
      ${ownerWhereClause}
    `,
    values,
  );

  const row = result.rows[0];
  const missingGoogleAccountCount = row.missing_google_account_count;
  const missingGooglePasswordCount = row.missing_google_password_count;
  const missingOpCount = row.missing_op_count;
  const filledUidCount = row.filled_uid_count;
  const missingPhoneCount = row.missing_phone_count;
  const eligibleCount = row.eligible_count;

  return {
    eligibleCount,
    missingGoogleAccountCount,
    missingGooglePasswordCount,
    missingOpCount,
    filledUidCount,
    missingPhoneCount,
    blockedTotalCount:
      missingGoogleAccountCount +
      missingGooglePasswordCount +
      missingOpCount +
      filledUidCount +
      missingPhoneCount,
  };
}

async function createManagedRecord(pool, config, payload, adminUser) {
  const input = normalizeManagedRecordInput(payload);
  const result = await pool.query(
    `
      insert into managed_records (
        id,
        owner_id,
        google_account,
        google_password_encrypted,
        google_password_search_hash,
        google_assist,
        google_expire_at,
        uid_value,
        uid_created_at,
        phone_number,
        phone_sms_url,
        phone_expire_at,
        phone_status,
        phone_model,
        op_value,
        op_nickname,
        op_link,
        op_expire_at,
        remark
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      returning *
    `,
    [
      crypto.randomUUID(),
      adminUser ? adminUser.id : null,
      input.googleAccount,
      encryptGooglePassword(
        input.googlePassword,
        config.googlePasswordEncryptionKey,
      ),
      buildGooglePasswordSearchHash(
        input.googlePassword,
        config.googlePasswordEncryptionKey,
      ),
      input.googleAssist,
      input.googleExpireAt,
      input.uidValue,
      input.uidValue ? new Date().toISOString() : null,
      input.phoneNumber,
      input.phoneSmsUrl,
      input.phoneExpireAt,
      input.phoneStatus,
      input.phoneModel,
      input.opValue,
      input.opNickname || '',
      input.opLink,
      input.opExpireAt,
      input.remark,
    ],
  );

  return toRecordDto(result.rows[0], config);
}

function buildManagedRecordWhere(filters, config, adminUser, tableAlias = '') {
  const clauses = [];
  const values = [];
  const columnPrefix = tableAlias ? `${tableAlias}.` : '';

  if (adminUser && adminUser.role !== 'super_admin') {
    values.push(adminUser.id);
    clauses.push(`${columnPrefix}owner_id = $${values.length}`);
  }

  if (filters.googleAccount) {
    values.push(`%${filters.googleAccount}%`);
    clauses.push(`${columnPrefix}google_account ilike $${values.length}`);
  }
  if (filters.googlePassword) {
    values.push(
      buildGooglePasswordSearchHash(
        filters.googlePassword,
        config.googlePasswordEncryptionKey,
      ),
    );
    clauses.push(`${columnPrefix}google_password_search_hash = $${values.length}`);
  }
  if (filters.googleAssist) {
    values.push(`%${filters.googleAssist}%`);
    clauses.push(`${columnPrefix}google_assist ilike $${values.length}`);
  }
  if (filters.uidValue) {
    values.push(`%${filters.uidValue}%`);
    clauses.push(`${columnPrefix}uid_value ilike $${values.length}`);
  }
  if (filters.opValue) {
    values.push(`%${filters.opValue}%`);
    clauses.push(`${columnPrefix}op_value ilike $${values.length}`);
  }
  if (filters.opLink) {
    values.push(`%${filters.opLink}%`);
    clauses.push(`${columnPrefix}op_link ilike $${values.length}`);
  }
  if (filters.remark) {
    values.push(`%${filters.remark}%`);
    clauses.push(`${columnPrefix}remark ilike $${values.length}`);
  }
  if (filters.uidCreatedFrom) {
    values.push(filters.uidCreatedFrom);
    clauses.push(`${columnPrefix}uid_created_at >= $${values.length}`);
  }
  if (filters.uidCreatedTo) {
    values.push(filters.uidCreatedTo);
    clauses.push(`${columnPrefix}uid_created_at <= $${values.length}`);
  }
  if (filters.googleExpireFrom) {
    values.push(filters.googleExpireFrom);
    clauses.push(`${columnPrefix}google_expire_at >= $${values.length}`);
  }
  if (filters.googleExpireTo) {
    values.push(filters.googleExpireTo);
    clauses.push(`${columnPrefix}google_expire_at <= $${values.length}`);
  }
  if (filters.opExpireFrom) {
    values.push(filters.opExpireFrom);
    clauses.push(`${columnPrefix}op_expire_at >= $${values.length}`);
  }
  if (filters.opExpireTo) {
    values.push(filters.opExpireTo);
    clauses.push(`${columnPrefix}op_expire_at <= $${values.length}`);
  }

  return {
    clauses,
    values,
    whereClause: clauses.length ? `where ${clauses.join(' and ')}` : '',
  };
}

function normalizeRecordIds(ids) {
  const source = Array.isArray(ids) ? ids : String(ids || '').split(',');
  return Array.from(
    new Set(source.map((id) => String(id || '').trim()).filter(Boolean)),
  );
}

function toComparableManagedRecordPayload(payload) {
  const normalized = normalizeManagedRecordInput(payload || {});
  return {
    googleAccount: normalized.googleAccount,
    googlePassword: normalized.googlePassword,
    googleAssist: normalized.googleAssist,
    googleExpireAt: normalized.googleExpireAt || null,
    uidValue: normalized.uidValue,
    phoneNumber: normalized.phoneNumber,
    phoneSmsUrl: normalized.phoneSmsUrl,
    phoneExpireAt: normalized.phoneExpireAt || null,
    phoneStatus: normalized.phoneStatus,
    phoneModel: normalized.phoneModel,
    opValue: normalized.opValue,
    opNickname: normalized.opNickname || '',
    opLink: normalized.opLink,
    opExpireAt: normalized.opExpireAt || null,
    remark: normalized.remark,
  };
}

function mergeImportedRecordData(existing, incoming) {
  return {
    googleAccount: incoming.googleAccount || existing.googleAccount,
    googlePassword: incoming.googlePassword || existing.googlePassword,
    googleAssist: incoming.googleAssist || existing.googleAssist,
    googleExpireAt: incoming.googleExpireAt || existing.googleExpireAt || null,
    uidValue: existing.uidValue || incoming.uidValue || '',
    phoneNumber: incoming.phoneNumber || existing.phoneNumber || '',
    phoneSmsUrl: incoming.phoneSmsUrl || existing.phoneSmsUrl || '',
    phoneExpireAt: incoming.phoneExpireAt || existing.phoneExpireAt || null,
    phoneStatus: incoming.phoneStatus || existing.phoneStatus || '未绑定',
    phoneModel: incoming.phoneModel || existing.phoneModel || '12mini',
    opValue: incoming.opValue || existing.opValue,
    opNickname: incoming.opNickname || existing.opNickname || '',
    opLink: incoming.opLink || existing.opLink,
    opExpireAt: incoming.opExpireAt || existing.opExpireAt || null,
    remark: incoming.remark || existing.remark || '',
  };
}

function hasManagedRecordPayloadChanges(existing, nextPayload) {
  const currentPayload = toComparableManagedRecordPayload(existing);
  const mergedPayload = toComparableManagedRecordPayload(
    mergeImportedRecordData(existing, nextPayload),
  );
  return JSON.stringify(currentPayload) !== JSON.stringify(mergedPayload);
}

function normalizeCsvValue(value) {
  if (value instanceof Date) {
    return formatCsvDateTime(value);
  }

  return value;
}

function formatCsvDateTime(value) {
  if (!value) {
    return '';
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const partMap = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  const month = String(partMap.month || '').padStart(2, '0');
  const day = String(partMap.day || '').padStart(2, '0');
  const hour = String(partMap.hour || '').padStart(2, '0');
  const minute = String(partMap.minute || '').padStart(2, '0');
  const second = String(partMap.second || '').padStart(2, '0');

  return `${partMap.year}/${month}/${day} ${hour}:${minute}:${second}`;
}

function toCsvCell(value) {
  const normalized =
    value === null || value === undefined
      ? ''
      : String(normalizeCsvValue(value));
  return `"${normalized.replace(/"/g, '""')}"`;
}

function toCsvRow(values) {
  return values.map((value) => toCsvCell(value)).join(',');
}

function buildManagedRecordsCsv(items) {
  const header = [
    '谷歌号',
    '谷歌密码',
    '谷歌辅助',
    '谷歌到期时间',
    'UID',
    'UID创建时间',
    '手机号',
    '手机到期时间',
    '接码链接',
    '手机状态',
    '机型',
    'OP',
    'OP昵称',
    'OP链接',
    'OP到期时间',
    '备注',
  ];

  const rows = items.map((item) =>
    toCsvRow([
      item.googleAccount,
      item.googlePassword,
      item.googleAssist,
      item.googleExpireAt,
      item.uidValue,
      item.uidCreatedAt,
      item.phoneNumber,
      item.phoneExpireAt,
      item.phoneSmsUrl,
      item.phoneStatus,
      item.phoneModel,
      item.opValue,
      item.opNickname,
      item.opLink,
      item.opExpireAt,
      item.remark,
    ]),
  );

  return `\uFEFF${[toCsvRow(header), ...rows].join('\n')}`;
}

async function listManagedRecords(pool, config, filters, adminUser) {
  const { values, whereClause } = buildManagedRecordWhere(
    filters,
    config,
    adminUser,
  );
  const publicBatchEligibility = await getPublicBatchEligibilityStats(
    pool,
    config,
    adminUser,
  );

  const totalResult = await pool.query(
    `select count(*)::int as total from managed_records ${whereClause}`,
    values,
  );
  const total = totalResult.rows[0].total;
  const isAllPageSize = String(filters.pageSize || '').trim().toLowerCase() === 'all';
  const page = isAllPageSize ? 1 : Math.max(1, Number(filters.page || 1));
  const pageSize = isAllPageSize
    ? Math.max(total, 1)
    : Math.max(1, Math.min(100, Number(filters.pageSize || 20)));

  const offset = (page - 1) * pageSize;
  let itemsResult;

  if (isAllPageSize) {
    itemsResult = await pool.query(
      `
        select *
        from managed_records
        ${whereClause}
        order by updated_at desc, id desc
      `,
      values,
    );
  } else {
    itemsResult = await pool.query(
      `
        select *
        from managed_records
        ${whereClause}
        order by updated_at desc, id desc
        limit $${values.length + 1} offset $${values.length + 2}
      `,
      [...values, pageSize, offset],
    );
  }

  const distributionScopeValues = [];
  let distributionScopeWhereClause = '';
  if (adminUser && adminUser.role !== 'super_admin') {
    distributionScopeValues.push(adminUser.id);
    distributionScopeWhereClause = `where owner_id = $1`;
  }
  const distributionScopeResult = await pool.query(
    `
      select id
      from managed_records
      ${distributionScopeWhereClause}
      order by created_at asc, id asc
    `,
    distributionScopeValues,
  );
  const distributionOrderById = new Map(
    distributionScopeResult.rows.map((row, index) => [row.id, index + 1]),
  );

  return {
    items: itemsResult.rows.map((row) =>
      toRecordDto(
        {
          ...row,
          distribution_order: distributionOrderById.get(row.id) || null,
        },
        config,
      ),
    ),
    page,
    pageSize,
    publicBatchEligibility,
    total,
  };
}

async function exportManagedRecordsCsv(pool, config, filters, adminUser, ids = []) {
  const { clauses, values } = buildManagedRecordWhere(filters, config, adminUser);
  const normalizedIds = normalizeRecordIds(ids);
  if (normalizedIds.length > 0) {
    const idPlaceholders = normalizedIds.map(
      (_, index) => `$${values.length + index + 1}`,
    );
    values.push(...normalizedIds);
    clauses.push(`id in (${idPlaceholders.join(', ')})`);
  }
  const whereClause = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const result = await pool.query(
    `
      select *
      from managed_records
      ${whereClause}
      order by updated_at desc
    `,
    values,
  );

  const items = result.rows.map((row) => toRecordDto(row, config));
  return buildManagedRecordsCsv(items);
}

async function getManagedRecordById(pool, config, id, adminUser) {
  const values = [id];
  let ownerCheck = '';
  if (adminUser && adminUser.role !== 'super_admin') {
    values.push(adminUser.id);
    ownerCheck = ` and owner_id = $2`;
  }

  const result = await pool.query(
    `select * from managed_records where id = $1${ownerCheck} limit 1`,
    values,
  );

  return result.rows[0] ? toRecordDto(result.rows[0], config) : null;
}

async function updateManagedRecord(pool, config, id, payload, adminUser) {
  const input = normalizeManagedRecordInput(payload);
  
  const values = [
    id,
    input.googleAccount,
    encryptGooglePassword(
      input.googlePassword,
      config.googlePasswordEncryptionKey,
    ),
    buildGooglePasswordSearchHash(
      input.googlePassword,
      config.googlePasswordEncryptionKey,
    ),
    input.googleAssist,
    input.googleExpireAt,
    input.uidValue,
    input.phoneNumber,
    input.phoneSmsUrl,
    input.phoneExpireAt,
    input.phoneStatus,
    input.phoneModel,
    input.opValue,
    input.opNickname,
    input.opLink,
    input.opExpireAt,
    input.remark,
  ];

  let ownerCheck = '';
  if (adminUser && adminUser.role !== 'super_admin') {
    values.push(adminUser.id);
    ownerCheck = ` and (owner_id = $${values.length} or owner_id is null)`;
  }

  const result = await pool.query(
    `
      update managed_records
      set
        owner_id = coalesce(owner_id, ${adminUser ? `'${adminUser.id}'` : 'owner_id'}),
        google_account = $2,
        google_password_encrypted = $3,
        google_password_search_hash = $4,
        google_assist = $5,
        google_expire_at = $6,
        uid_value = $7,
        uid_created_at = case
          when $7 <> '' and uid_created_at is null then now()
          else uid_created_at
        end,
        phone_number = $8,
        phone_sms_url = $9,
        phone_expire_at = $10,
        phone_status = $11,
        phone_model = $12,
        op_value = $13,
        op_nickname = coalesce($14, op_nickname),
        op_link = $15,
        op_expire_at = $16,
        remark = $17,
        updated_at = now()
      where id = $1${ownerCheck}
      returning *
    `,
    values,
  );

  if (!result.rows[0]) {
    const error = new Error('Record not found or access denied');
    error.statusCode = 404;
    throw error;
  }

  return toRecordDto(result.rows[0], config);
}

function buildRecordOwnerUpdateFragments(adminUser, values) {
  let ownerAssignment = 'owner_id';
  let ownerCheck = '';

  if (adminUser) {
    values.push(adminUser.id);
    const ownerParam = `$${values.length}`;
    ownerAssignment = `coalesce(owner_id, ${ownerParam})`;
    if (adminUser.role !== 'super_admin') {
      ownerCheck = ` and (owner_id = ${ownerParam} or owner_id is null)`;
    }
  }

  return { ownerAssignment, ownerCheck };
}

async function clearManagedRecordGoogleFields(pool, config, id, adminUser) {
  const values = [
    id,
    encryptGooglePassword('', config.googlePasswordEncryptionKey),
    buildGooglePasswordSearchHash('', config.googlePasswordEncryptionKey),
  ];
  const { ownerAssignment, ownerCheck } = buildRecordOwnerUpdateFragments(
    adminUser,
    values,
  );

  const result = await pool.query(
    `
      update managed_records
      set
        owner_id = ${ownerAssignment},
        google_account = '',
        google_password_encrypted = $2,
        google_password_search_hash = $3,
        google_assist = '',
        google_expire_at = null,
        updated_at = now()
      where id = $1${ownerCheck}
      returning *
    `,
    values,
  );

  if (!result.rows[0]) {
    const error = new Error('Record not found or access denied');
    error.statusCode = 404;
    throw error;
  }

  return toRecordDto(result.rows[0], config);
}

async function clearManagedRecordOpFields(pool, config, id, adminUser) {
  const values = [id];
  const { ownerAssignment, ownerCheck } = buildRecordOwnerUpdateFragments(
    adminUser,
    values,
  );

  const result = await pool.query(
    `
      update managed_records
      set
        owner_id = ${ownerAssignment},
        op_value = '',
        op_nickname = '',
        op_link = '',
        op_expire_at = null,
        updated_at = now()
      where id = $1${ownerCheck}
      returning *
    `,
    values,
  );

  if (!result.rows[0]) {
    const error = new Error('Record not found or access denied');
    error.statusCode = 404;
    throw error;
  }

  return toRecordDto(result.rows[0], config);
}

async function clearManagedRecordGoogleFieldsBatch(pool, config, ids, adminUser) {
  const normalizedIds = normalizeRecordIds(ids);
  if (!normalizedIds.length) {
    const error = new Error('请选择要删除谷歌号的记录');
    error.statusCode = 400;
    throw error;
  }

  const values = [...normalizedIds];
  const idPlaceholders = normalizedIds.map((_, index) => `$${index + 1}`).join(', ');
  values.push(encryptGooglePassword('', config.googlePasswordEncryptionKey));
  values.push(buildGooglePasswordSearchHash('', config.googlePasswordEncryptionKey));
  const encryptedPasswordParam = `$${normalizedIds.length + 1}`;
  const passwordSearchHashParam = `$${normalizedIds.length + 2}`;
  const { ownerAssignment, ownerCheck } = buildRecordOwnerUpdateFragments(
    adminUser,
    values,
  );

  const result = await pool.query(
    `
      update managed_records
      set
        owner_id = ${ownerAssignment},
        google_account = '',
        google_password_encrypted = ${encryptedPasswordParam},
        google_password_search_hash = ${passwordSearchHashParam},
        google_assist = '',
        google_expire_at = null,
        updated_at = now()
      where id in (${idPlaceholders})${ownerCheck}
      returning id
    `,
    values,
  );

  return result.rowCount;
}

async function clearManagedRecordOpFieldsBatch(pool, config, ids, adminUser) {
  const normalizedIds = normalizeRecordIds(ids);
  if (!normalizedIds.length) {
    const error = new Error('请选择要删除 OP 的记录');
    error.statusCode = 400;
    throw error;
  }

  const values = [...normalizedIds];
  const idPlaceholders = normalizedIds.map((_, index) => `$${index + 1}`).join(', ');
  const { ownerAssignment, ownerCheck } = buildRecordOwnerUpdateFragments(
    adminUser,
    values,
  );

  const result = await pool.query(
    `
      update managed_records
      set
        owner_id = ${ownerAssignment},
        op_value = '',
        op_nickname = '',
        op_link = '',
        op_expire_at = null,
        updated_at = now()
      where id in (${idPlaceholders})${ownerCheck}
      returning id
    `,
    values,
  );

  return result.rowCount;
}

async function clearManagedRecordPhoneFieldsBatch(pool, ids, adminUser) {
  const normalizedIds = normalizeRecordIds(ids);
  if (!normalizedIds.length) {
    const error = new Error('请选择要删除手机号的记录');
    error.statusCode = 400;
    throw error;
  }

  const values = [...normalizedIds];
  const idPlaceholders = normalizedIds.map((_, index) => `$${index + 1}`).join(', ');
  const { ownerAssignment, ownerCheck } = buildRecordOwnerUpdateFragments(
    adminUser,
    values,
  );

  const result = await pool.query(
    `
      update managed_records
      set
        owner_id = ${ownerAssignment},
        phone_number = '',
        phone_sms_url = '',
        phone_expire_at = null,
        phone_status = '未绑定',
        phone_model = '12mini',
        updated_at = now()
      where id in (${idPlaceholders})${ownerCheck}
      returning id
    `,
    values,
  );

  return result.rowCount;
}

async function deleteManagedRecord(pool, id, adminUser) {
  const values = [id];
  let ownerCheck = '';
  if (adminUser && adminUser.role !== 'super_admin') {
    values.push(adminUser.id);
    ownerCheck = ` and owner_id = $2`;
  }
  await pool.query(`delete from managed_records where id = $1${ownerCheck}`, values);
}

async function deleteManagedRecords(pool, ids, adminUser) {
  const normalizedIds = normalizeRecordIds(ids);
  if (!normalizedIds.length) {
    const error = new Error('请选择要删除的记录');
    error.statusCode = 400;
    throw error;
  }

  const values = [...normalizedIds];
  const idPlaceholders = normalizedIds.map((_, index) => `$${index + 1}`).join(', ');
  let ownerCheck = '';

  if (adminUser && adminUser.role !== 'super_admin') {
    values.push(adminUser.id);
    ownerCheck = ` and owner_id = $${values.length}`;
  }

  const result = await pool.query(
    `delete from managed_records where id in (${idPlaceholders})${ownerCheck} returning id`,
    values,
  );
  return result.rowCount;
}

function parseManagedRecordImportText(rowsText, options = {}) {
  const phoneDurationDays = normalizePhoneDurationDays(options.phoneDurationDays);
  const lines = String(rowsText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    const error = new Error('请先输入要导入的数据');
    error.statusCode = 400;
    throw error;
  }

  return lines.map((line, index) => {
    const lineNumber = index + 1;
    const parts = line.split('----').map((item) => item.trim());

    if (parts.length === 2) {
      const [phoneNumber, phoneSmsUrl] = parts;
      if (!phoneNumber || !phoneSmsUrl) {
        throwError(lineNumber, '手机号导入格式缺少必填项');
      }
      return {
        type: 'phone',
        data: {
          googleAccount: '',
          googlePassword: '',
          googleAssist: '',
          googleExpireAt: null,
          uidValue: '',
          phoneNumber,
          phoneSmsUrl: normalizePhoneSmsUrl(phoneSmsUrl),
          phoneExpireAt: derivePhoneExpireAt(Date.now(), phoneDurationDays),
          phoneStatus: '未绑定',
          phoneModel: '12mini',
          opValue: '',
          opLink: '',
          opExpireAt: null,
          remark: '',
        },
      };
    } else if (parts.length === 3) {
      const [googleAccount, googlePassword, googleAssist] = parts;
      if (!googleAccount || !googlePassword || !googleAssist) {
        throwError(lineNumber, '谷歌导入格式缺少必填项');
      }
      return {
        type: 'google',
        data: {
          googleAccount,
          googlePassword,
          googleAssist,
          googleExpireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          uidValue: '',
          opValue: '',
          opLink: '',
          opExpireAt: null,
          remark: '',
        },
      };
    } else if (parts.length === 1 && line.includes('|')) {
      const opValue = line;
      return {
        type: 'op',
        data: {
          googleAccount: '',
          googlePassword: '',
          googleAssist: '',
          googleExpireAt: null,
          uidValue: '',
          opValue,
          opLink: buildDerivedOpLink(opValue),
          opExpireAt: deriveOpExpireAt(opValue, { strict: true }),
          remark: '',
        },
      };
    } else if (parts.length === 4) {
      const [googleAccount, googlePassword, googleAssist, opValue] = parts;
      if (!googleAccount || !googlePassword || !googleAssist || !opValue) {
        throwError(lineNumber, '综合导入格式缺少必填项');
      }
      return {
        type: 'combined',
        data: {
          googleAccount,
          googlePassword,
          googleAssist,
          googleExpireAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          uidValue: '',
          opValue,
          opLink: buildDerivedOpLink(opValue),
          opExpireAt: deriveOpExpireAt(opValue, { strict: true }),
          remark: '',
        },
      };
    } else {
      throwError(lineNumber, '格式无法识别，请使用: 手机号----接码链接，谷歌号----密码----辅助，OP数据，或四段综合格式');
    }
  });

  function throwError(lineNumber, msg) {
    const error = new Error(`第 ${lineNumber} 行格式不正确: ${msg}`);
    error.statusCode = 400;
    throw error;
  }
}

async function findImportDuplicateMatches(client, config, recordData, adminUser) {
  const values = [];
  const clauses = [];
  const uniqueClauses = [];

  if (adminUser && adminUser.role !== 'super_admin') {
    values.push(adminUser.id);
    clauses.push(`owner_id = $${values.length}`);
  }
  if (recordData.googleAccount) {
    values.push(recordData.googleAccount);
    uniqueClauses.push(`google_account = $${values.length}`);
  }
  if (recordData.opValue) {
    values.push(recordData.opValue);
    uniqueClauses.push(`op_value = $${values.length}`);
  }
  if (recordData.phoneNumber) {
    values.push(recordData.phoneNumber);
    uniqueClauses.push(`phone_number = $${values.length}`);
  }
  if (!uniqueClauses.length) {
    return [];
  }

  const whereClauses = [...clauses, `(${uniqueClauses.join(' or ')})`];
  const result = await client.query(
    `
      select *
      from managed_records
      where ${whereClauses.join(' and ')}
      order by created_at asc
      for update
    `,
    values,
  );

  return result.rows.map((row) => toRecordDto(row, config));
}

async function backfillManagedRecordOpNicknames(
  pool,
  ids,
  adminUser,
  lookupOpNicknamesImpl,
) {
  const normalizedIds = normalizeRecordIds(ids);
  if (!normalizedIds.length) {
    const error = new Error('请先勾选要补全 OP 昵称的记录');
    error.statusCode = 400;
    throw error;
  }

  const pendingValues = [...normalizedIds];
  const pendingIdPlaceholders = normalizedIds
    .map((_, index) => `$${index + 1}`)
    .join(', ');
  let pendingOwnerCheck = '';
  if (adminUser.role !== 'super_admin') {
    pendingValues.push(adminUser.id);
    pendingOwnerCheck = `and owner_id = $${pendingValues.length}`;
  }
  const pendingResult = await pool.query(
    `
      select id, op_value
      from managed_records
      where id in (${pendingIdPlaceholders})
        ${pendingOwnerCheck}
        and op_value <> ''
        and op_nickname = ''
      order by created_at asc
    `,
    pendingValues,
  );
  const pendingCount = pendingResult.rowCount;
  if (!pendingCount) {
    return { pendingCount: 0, updatedCount: 0, failedCount: 0 };
  }

  const recordIdsByOpValue = new Map();
  for (const row of pendingResult.rows) {
    const recordIds = recordIdsByOpValue.get(row.op_value) || [];
    recordIds.push(row.id);
    recordIdsByOpValue.set(row.op_value, recordIds);
  }

  let nicknameByOpValue = new Map();
  try {
    const lookupResult = await lookupOpNicknamesImpl(
      Array.from(recordIdsByOpValue.keys()),
    );
    if (lookupResult?.nicknameByOpValue instanceof Map) {
      nicknameByOpValue = lookupResult.nicknameByOpValue;
    }
  } catch {
    nicknameByOpValue = new Map();
  }

  let updatedCount = 0;
  for (const [opValue, recordIds] of recordIdsByOpValue) {
    const nickname = String(nicknameByOpValue.get(opValue) || '').trim();
    if (!nickname) {
      continue;
    }
    const updateValues = [nickname, opValue, ...recordIds];
    const idPlaceholders = recordIds
      .map((_, index) => `$${index + 3}`)
      .join(', ');
    let updateOwnerCheck = '';
    if (adminUser.role !== 'super_admin') {
      updateValues.push(adminUser.id);
      updateOwnerCheck = `and owner_id = $${updateValues.length}`;
    }
    const updateResult = await pool.query(
      `
        update managed_records
        set op_nickname = $1, updated_at = now()
        where op_value = $2
          and op_nickname = ''
          and id in (${idPlaceholders})
          ${updateOwnerCheck}
      `,
      updateValues,
    );
    updatedCount += updateResult.rowCount;
  }

  return {
    pendingCount,
    updatedCount,
    failedCount: pendingCount - updatedCount,
  };
}

async function importManagedRecordText(
  pool,
  config,
  rowsText,
  adminUser,
  lookupOpNicknamesImpl,
  phoneDurationDays,
) {
  const records = parseManagedRecordImportText(rowsText, { phoneDurationDays });
  let lookupResult = {
    nicknameByOpValue: new Map(),
    detectedCount: 0,
    failedCount: 0,
  };
  if (lookupOpNicknamesImpl) {
    try {
      lookupResult = await lookupOpNicknamesImpl(
        records.map((record) => record.data.opValue).filter(Boolean),
      );
    } catch {
      const uniqueOpValues = new Set(
        records.map((record) => record.data.opValue).filter(Boolean),
      );
      lookupResult = {
        nicknameByOpValue: new Map(),
        detectedCount: 0,
        failedCount: uniqueOpValues.size,
      };
    }
  }
  for (const record of records) {
    if (record.data.opValue) {
      record.data.opNickname =
        lookupResult.nicknameByOpValue.get(record.data.opValue) || '';
    }
  }
  const client = await pool.connect();

  let ownerCheck = '';
  if (adminUser && adminUser.role !== 'super_admin') {
    ownerCheck = ` and (owner_id = '${adminUser.id}' or owner_id is null)`;
  }

  try {
    await client.query('begin');

    const items = [];
    let skippedCount = 0;
    for (const record of records) {
      const duplicateMatches = await findImportDuplicateMatches(
        client,
        config,
        record.data,
        adminUser,
      );
      if (duplicateMatches.length > 0) {
        const existing = duplicateMatches[0];
        if (!hasManagedRecordPayloadChanges(existing, record.data)) {
          skippedCount += 1;
          continue;
        }

        items.push(
          await updateManagedRecord(
            client,
            config,
            existing.id,
            mergeImportedRecordData(existing, record.data),
            adminUser,
          ),
        );
        continue;
      }

      if (record.type === 'phone') {
        const match = await client.query(`
          select * from managed_records
          where (phone_number = '' or phone_number is null)
            and (google_account != '' or op_value != '')
            ${ownerCheck}
          order by created_at asc
          limit 1
          for update
        `);
        if (match.rows.length > 0) {
          const existing = toRecordDto(match.rows[0], config);
          items.push(await updateManagedRecord(client, config, existing.id, {
            ...existing,
            phoneNumber: record.data.phoneNumber,
            phoneSmsUrl: record.data.phoneSmsUrl,
            phoneExpireAt: record.data.phoneExpireAt,
            phoneStatus: record.data.phoneStatus,
            phoneModel: record.data.phoneModel,
          }, adminUser));
        } else {
          items.push(await createManagedRecord(client, config, record.data, adminUser));
        }
      } else if (record.type === 'google') {
        const match = await client.query(`
          select * from managed_records 
          where (google_account = '' or google_account is null) 
            and (op_value != '' or phone_number != '')
            ${ownerCheck}
          order by created_at asc 
          limit 1
          for update
        `);
        if (match.rows.length > 0) {
          const existing = toRecordDto(match.rows[0], config);
          items.push(await updateManagedRecord(client, config, existing.id, {
            ...existing,
            googleAccount: record.data.googleAccount,
            googlePassword: record.data.googlePassword,
            googleAssist: record.data.googleAssist,
            googleExpireAt: record.data.googleExpireAt,
          }, adminUser));
        } else {
          items.push(await createManagedRecord(client, config, record.data, adminUser));
        }
      } else if (record.type === 'op') {
        const match = await client.query(`
          select * from managed_records 
          where (op_value = '' or op_value is null) 
            and (google_account != '' or phone_number != '')
            ${ownerCheck}
          order by created_at asc 
          limit 1
          for update
        `);
        if (match.rows.length > 0) {
          const existing = toRecordDto(match.rows[0], config);
          items.push(await updateManagedRecord(client, config, existing.id, {
            ...existing,
            opValue: record.data.opValue,
            opNickname: record.data.opNickname,
            opLink: record.data.opLink,
            opExpireAt: record.data.opExpireAt,
          }, adminUser));
        } else {
          items.push(await createManagedRecord(client, config, record.data, adminUser));
        }
      } else {
        items.push(await createManagedRecord(client, config, record.data, adminUser));
      }
    }

    await client.query('commit');
    return {
      importedCount: items.length,
      skippedCount,
      nicknameDetectedCount: lookupResult.detectedCount,
      nicknameFailedCount: lookupResult.failedCount,
      items,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  backfillManagedRecordOpNicknames,
  buildManagedRecordsCsv,
  clearManagedRecordGoogleFields,
  clearManagedRecordGoogleFieldsBatch,
  clearManagedRecordOpFields,
  clearManagedRecordOpFieldsBatch,
  clearManagedRecordPhoneFieldsBatch,
  createManagedRecord,
  buildDerivedOpLink,
  deleteManagedRecord,
  deleteManagedRecords,
  deriveOpExpireAt,
  exportManagedRecordsCsv,
  getManagedRecordById,
  importManagedRecordText,
  listManagedRecords,
  parseManagedRecordImportText,
  updateManagedRecord,
};
