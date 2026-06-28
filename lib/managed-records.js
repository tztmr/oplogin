const crypto = require('node:crypto');
const {
  encryptGooglePassword,
  decryptGooglePassword,
  buildGooglePasswordSearchHash,
} = require('./google-password-crypto');

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
    opValue: String(payload.opValue || '').trim(),
    opLink: '',
    opExpireAt: null,
    remark: String(payload.remark || '').trim(),
  };

  input.opLink =
    String(payload.opLink || '').trim() || buildDerivedOpLink(input.opValue);
  input.opExpireAt = payload.opExpireAt || deriveOpExpireAt(input.opValue);

  if (!input.googleAccount && !input.opValue) {
    const error = new Error('必须提供谷歌号或 OP 数据');
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
    ownerId: row.owner_id,
    googleAccount: row.google_account,
    googlePassword: passwordState.googlePassword,
    googlePasswordDecryptionFailed: passwordState.googlePasswordDecryptionFailed,
    googleAssist: row.google_assist,
    googleExpireAt: row.google_expire_at,
    uidValue: row.uid_value,
    uidCreatedAt: row.uid_created_at,
    opValue: row.op_value,
    opLink: row.op_link,
    opExpireAt: row.op_expire_at,
    remark: row.remark,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
        op_value,
        op_link,
        op_expire_at,
        remark
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      input.opValue,
      input.opLink,
      input.opExpireAt,
      input.remark,
    ],
  );

  return toRecordDto(result.rows[0], config);
}

function buildManagedRecordWhere(filters, config, adminUser) {
  const clauses = [];
  const values = [];

  if (adminUser && adminUser.role !== 'super_admin') {
    values.push(adminUser.id);
    clauses.push(`owner_id = $${values.length}`);
  }

  if (filters.googleAccount) {
    values.push(`%${filters.googleAccount}%`);
    clauses.push(`google_account ilike $${values.length}`);
  }
  if (filters.googlePassword) {
    values.push(
      buildGooglePasswordSearchHash(
        filters.googlePassword,
        config.googlePasswordEncryptionKey,
      ),
    );
    clauses.push(`google_password_search_hash = $${values.length}`);
  }
  if (filters.googleAssist) {
    values.push(`%${filters.googleAssist}%`);
    clauses.push(`google_assist ilike $${values.length}`);
  }
  if (filters.uidValue) {
    values.push(`%${filters.uidValue}%`);
    clauses.push(`uid_value ilike $${values.length}`);
  }
  if (filters.opValue) {
    values.push(`%${filters.opValue}%`);
    clauses.push(`op_value ilike $${values.length}`);
  }
  if (filters.opLink) {
    values.push(`%${filters.opLink}%`);
    clauses.push(`op_link ilike $${values.length}`);
  }
  if (filters.remark) {
    values.push(`%${filters.remark}%`);
    clauses.push(`remark ilike $${values.length}`);
  }
  if (filters.uidCreatedFrom) {
    values.push(filters.uidCreatedFrom);
    clauses.push(`uid_created_at >= $${values.length}`);
  }
  if (filters.uidCreatedTo) {
    values.push(filters.uidCreatedTo);
    clauses.push(`uid_created_at <= $${values.length}`);
  }
  if (filters.googleExpireFrom) {
    values.push(filters.googleExpireFrom);
    clauses.push(`google_expire_at >= $${values.length}`);
  }
  if (filters.googleExpireTo) {
    values.push(filters.googleExpireTo);
    clauses.push(`google_expire_at <= $${values.length}`);
  }
  if (filters.opExpireFrom) {
    values.push(filters.opExpireFrom);
    clauses.push(`op_expire_at >= $${values.length}`);
  }
  if (filters.opExpireTo) {
    values.push(filters.opExpireTo);
    clauses.push(`op_expire_at <= $${values.length}`);
  }

  return {
    clauses,
    values,
    whereClause: clauses.length ? `where ${clauses.join(' and ')}` : '',
  };
}

function normalizeCsvValue(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
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
    'OP',
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
      item.opValue,
      item.opLink,
      item.opExpireAt,
      item.remark,
    ]),
  );

  return `\uFEFF${[toCsvRow(header), ...rows].join('\n')}`;
}

async function listManagedRecords(pool, config, filters, adminUser) {
  const { values, whereClause } = buildManagedRecordWhere(filters, config, adminUser);

  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize || 20)));

  const totalResult = await pool.query(
    `select count(*)::int as total from managed_records ${whereClause}`,
    values,
  );

  const itemValues = [...values, pageSize, (page - 1) * pageSize];
  const itemsResult = await pool.query(
    `
      select *
      from managed_records
      ${whereClause}
      order by updated_at desc
      limit $${itemValues.length - 1}
      offset $${itemValues.length}
    `,
    itemValues,
  );

  return {
    items: itemsResult.rows.map((row) => toRecordDto(row, config)),
    page,
    pageSize,
    total: totalResult.rows[0].total,
  };
}

async function exportManagedRecordsCsv(pool, config, filters, adminUser) {
  const { values, whereClause } = buildManagedRecordWhere(filters, config, adminUser);
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
    input.opValue,
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
        op_value = $8,
        op_link = $9,
        op_expire_at = $10,
        remark = $11,
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
  const normalizedIds = Array.from(
    new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean)),
  );
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

function parseManagedRecordImportText(rowsText) {
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

    if (parts.length === 3) {
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
      throwError(lineNumber, '格式无法识别，请使用: 谷歌号----密码----辅助，或 OP数据，或四段综合格式');
    }
  });

  function throwError(lineNumber, msg) {
    const error = new Error(`第 ${lineNumber} 行格式不正确: ${msg}`);
    error.statusCode = 400;
    throw error;
  }
}

async function importManagedRecordText(pool, config, rowsText, adminUser) {
  const records = parseManagedRecordImportText(rowsText);
  const client = await pool.connect();

  let ownerCheck = '';
  if (adminUser && adminUser.role !== 'super_admin') {
    ownerCheck = ` and (owner_id = '${adminUser.id}' or owner_id is null)`;
  }

  try {
    await client.query('begin');

    const items = [];
    for (const record of records) {
      if (record.type === 'google') {
        const match = await client.query(`
          select * from managed_records 
          where (google_account = '' or google_account is null) 
            and op_value != '' 
            ${ownerCheck}
          order by created_at asc 
          for update skip locked
          limit 1
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
            and google_account != '' 
            ${ownerCheck}
          order by created_at asc 
          for update skip locked
          limit 1
        `);
        if (match.rows.length > 0) {
          const existing = toRecordDto(match.rows[0], config);
          items.push(await updateManagedRecord(client, config, existing.id, {
            ...existing,
            opValue: record.data.opValue,
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
  buildManagedRecordsCsv,
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
