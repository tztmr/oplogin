const crypto = require('node:crypto');

const PHONE_DURATION_DAYS = [30, 60, 90, 120, 150];

function createPhoneImportError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function derivePhoneExpireAt(now = Date.now(), durationDays = 30) {
  return new Date(now + durationDays * 86400000).toISOString();
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
    throw createPhoneImportError('接码链接格式不正确');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw createPhoneImportError('接码链接仅支持 HTTP 或 HTTPS');
  }
  return normalizedValue;
}

function parsePhoneInventoryImportText(
  rowsText,
  { durationDays = 30, now = Date.now() } = {},
) {
  const normalizedDays = Number(durationDays);
  if (
    !['number', 'string'].includes(typeof durationDays) ||
    !PHONE_DURATION_DAYS.includes(normalizedDays)
  ) {
    throw createPhoneImportError('手机有效期请选择 30、60、90、120 或 150 天');
  }

  const lines = String(rowsText || '')
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line);
  if (!lines.length) {
    throw createPhoneImportError('请先输入要导入的手机号');
  }

  return lines.map(({ line, lineNumber }) => {
    const parts = line.split('----').map((part) => part.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw createPhoneImportError(
        `第 ${lineNumber} 行格式不正确: 请使用手机号----接码链接`,
      );
    }

    const [phoneNumber, phoneSmsUrl] = parts;
    if (!/^\+?[0-9 ]+$/.test(phoneNumber)) {
      throw createPhoneImportError(`第 ${lineNumber} 行手机号格式不正确`);
    }

    let normalizedSmsUrl;
    try {
      normalizedSmsUrl = normalizePhoneSmsUrl(phoneSmsUrl);
    } catch (error) {
      throw createPhoneImportError(`第 ${lineNumber} 行${error.message}`);
    }

    return {
      phoneNumber,
      phoneSmsUrl: normalizedSmsUrl,
      phoneExpireAt: derivePhoneExpireAt(now, normalizedDays),
      phoneModel: '12mini',
    };
  });
}

function toPhoneInventoryDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    phoneNumber: row.phone_number,
    phoneSmsUrl: row.phone_sms_url,
    phoneExpireAt: row.phone_expire_at,
    phoneModel: row.phone_model,
    status: row.status,
    reservedRecordId: row.reserved_record_id,
    reservedBatchSlotId: row.reserved_batch_slot_id,
    reservedAt: row.reserved_at,
    afterSaleAt: row.after_sale_at,
    boundAt: row.bound_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listPhoneInventory(pool, filters = {}, adminUser) {
  if (!adminUser?.id) throw createPhoneImportError('手机号库存必须关联运营账号');
  const page = Number(filters.page ?? 1);
  const pageSize = Number(filters.pageSize ?? 20);
  const status = filters.status || '';
  const search = filters.search || '';
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000
      || ![20, 50, 100].includes(pageSize)
      || !['', 'unbound', 'bound', 'after_sale'].includes(status)
      || typeof search !== 'string' || search.length > 100) {
    throw createPhoneImportError('手机号查询参数不正确');
  }
  const values = [adminUser.id];
  const conditions = ['owner_id = $1'];
  if (status === 'unbound') conditions.push("status in ('available', 'reserved')");
  else if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }
  if (search.trim()) {
    values.push(`%${search.trim()}%`);
    conditions.push(`phone_number ilike $${values.length}`);
  }
  const where = conditions.join(' and ');
  const count = await pool.query(`select count(*)::int as total from phone_inventory where ${where}`, values);
  const total = count.rows[0].total;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
  const result = await pool.query(
    `select * from phone_inventory where ${where}
     order by updated_at desc, id desc limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, pageSize, (currentPage - 1) * pageSize],
  );
  return { items: result.rows.map(toPhoneInventoryDto), total, page: currentPage, pageSize };
}

async function importPhoneInventoryText(pool, rowsText, adminUser, options = {}) {
  if (!adminUser || !adminUser.id) {
    throw createPhoneImportError('手机号库存必须关联运营账号');
  }

  const rows = parsePhoneInventoryImportText(rowsText, options);
  const client = await pool.connect();
  let importedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const items = [];

  try {
    await client.query('begin');
    const owner = await client.query(
      'select id from admin_users where id = $1 for update',
      [adminUser.id],
    );
    if (!owner.rows.length) {
      throw createPhoneImportError('手机号库存必须关联运营账号');
    }

    for (const row of rows) {
      const existing = await client.query(
        `select * from phone_inventory
         where owner_id = $1 and phone_number = $2
         for update`,
        [adminUser.id, row.phoneNumber],
      );

      let storedRow;
      if (!existing.rows.length) {
        const inserted = await client.query(
          `insert into phone_inventory (
             id, owner_id, phone_number, phone_sms_url,
             phone_expire_at, phone_model, status
           ) values ($1, $2, $3, $4, $5, $6, 'available')
           returning *`,
          [
            crypto.randomUUID(),
            adminUser.id,
            row.phoneNumber,
            row.phoneSmsUrl,
            row.phoneExpireAt,
            row.phoneModel,
          ],
        );
        storedRow = inserted.rows[0];
        importedCount += 1;
      } else if (['available', 'reserved'].includes(existing.rows[0].status)) {
        const updated = await client.query(
          `update phone_inventory
           set phone_sms_url = $3, phone_expire_at = $4, updated_at = now()
           where owner_id = $1 and phone_number = $2
           returning *`,
          [adminUser.id, row.phoneNumber, row.phoneSmsUrl, row.phoneExpireAt],
        );
        storedRow = updated.rows[0];
        updatedCount += 1;
      } else {
        storedRow = existing.rows[0];
        skippedCount += 1;
      }
      items.push(toPhoneInventoryDto(storedRow));
    }

    await client.query('commit');
    return { importedCount, updatedCount, skippedCount, items };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  PHONE_DURATION_DAYS,
  derivePhoneExpireAt,
  importPhoneInventoryText,
  listPhoneInventory,
  normalizePhoneSmsUrl,
  parsePhoneInventoryImportText,
  toPhoneInventoryDto,
};
