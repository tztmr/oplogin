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

const PHONE_INVENTORY_BATCH_LIMIT = 500;
const PHONE_INVENTORY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE_INVENTORY_BATCH_STATUSES = ['unbound', 'bound', 'after_sale'];

function normalizePhoneInventoryIds(ids, emptyMessage) {
  const source = Array.isArray(ids) ? ids : String(ids || '').split(',');
  const normalized = Array.from(
    new Set(
      source
        .map((id) => String(id || '').trim())
        .filter((id) => PHONE_INVENTORY_ID_PATTERN.test(id)),
    ),
  );
  if (!normalized.length) {
    throw createPhoneImportError(emptyMessage);
  }
  if (normalized.length > PHONE_INVENTORY_BATCH_LIMIT) {
    throw createPhoneImportError(`一次最多选择 ${PHONE_INVENTORY_BATCH_LIMIT} 个手机号`);
  }
  return normalized;
}

function phoneInventoryIdPlaceholders(ids, startIndex = 1) {
  return ids.map((_, index) => `$${startIndex + index}`).join(', ');
}

async function withPhoneInventoryOwner(pool, adminUser, work) {
  if (!adminUser?.id) throw createPhoneImportError('手机号库存必须关联运营账号');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const owner = await client.query(
      'select id from admin_users where id = $1 for update',
      [adminUser.id],
    );
    if (!owner.rows.length) {
      throw createPhoneImportError('手机号库存必须关联运营账号');
    }
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function unbindProjectedRecord(client, phone, adminUser) {
  if (phone.status !== 'bound') return;
  const values = [adminUser.id, phone.phone_number];
  let where = "owner_id = $1 and phone_number = $2 and phone_status = '已绑定'";
  if (phone.reserved_record_id) {
    values.push(phone.reserved_record_id);
    where += ` and id = $${values.length}`;
  }
  await client.query(
    `update managed_records
     set phone_number = '',
         phone_sms_url = '',
         phone_expire_at = null,
         phone_status = '未绑定',
         phone_model = '12mini',
         updated_at = now()
     where ${where}`,
    values,
  );
}

async function projectBoundPhone(client, phone, adminUser) {
  if (!phone.reserved_record_id) return;
  await client.query(
    `update managed_records
     set phone_number = $1,
         phone_sms_url = $2,
         phone_expire_at = $3,
         phone_model = $4,
         phone_status = '已绑定',
         updated_at = now()
     where id = $5
       and owner_id = $6
       and phone_status != '已绑定'
       and (uid_value = '' or uid_value is null)`,
    [
      phone.phone_number,
      phone.phone_sms_url,
      phone.phone_expire_at,
      phone.phone_model,
      phone.reserved_record_id,
      adminUser.id,
    ],
  );
}

async function lockOwnedPhoneInventory(client, ids, adminUser) {
  const values = [adminUser.id, ...ids];
  const result = await client.query(
    `select * from phone_inventory
     where owner_id = $1 and id in (${phoneInventoryIdPlaceholders(ids, 2)})
     for update`,
    values,
  );
  return result.rows;
}

async function deletePhoneInventory(pool, ids, adminUser) {
  const normalizedIds = normalizePhoneInventoryIds(ids, '请选择要删除的手机号');
  return withPhoneInventoryOwner(pool, adminUser, async (client) => {
    const phones = await lockOwnedPhoneInventory(client, normalizedIds, adminUser);
    for (const phone of phones) {
      await unbindProjectedRecord(client, phone, adminUser);
    }
    const ownedIds = phones.map((phone) => phone.id);
    if (!ownedIds.length) return 0;
    const deleted = await client.query(
      `delete from phone_inventory
       where owner_id = $1 and id in (${phoneInventoryIdPlaceholders(ownedIds, 2)})
       returning id`,
      [adminUser.id, ...ownedIds],
    );
    return deleted.rowCount;
  });
}

function nextPhoneInventoryStatus(phone, targetStatus) {
  if (targetStatus === 'unbound') {
    const alreadyUnbound = phone.status === 'available'
      && !phone.reserved_record_id
      && !phone.reserved_batch_slot_id
      && !phone.reserved_at
      && !phone.after_sale_at
      && !phone.bound_at;
    if (alreadyUnbound) return null;
    return {
      status: 'available',
      reservedRecordId: null,
      reservedBatchSlotId: null,
      reservedAt: null,
      afterSaleAt: null,
      boundAt: null,
      unbind: phone.status === 'bound',
      project: false,
    };
  }
  if (targetStatus === 'bound') {
    if (phone.status === 'bound') return null;
    return {
      status: 'bound',
      reservedRecordId: phone.reserved_record_id,
      reservedBatchSlotId: phone.reserved_batch_slot_id,
      reservedAt: phone.reserved_at,
      afterSaleAt: phone.after_sale_at,
      boundAt: 'now',
      unbind: false,
      project: true,
    };
  }
  if (phone.status === 'after_sale') return null;
  return {
    status: 'after_sale',
    reservedRecordId: phone.reserved_record_id,
    reservedBatchSlotId: phone.reserved_batch_slot_id,
    reservedAt: phone.reserved_at,
    afterSaleAt: 'now',
    boundAt: phone.bound_at,
    unbind: phone.status === 'bound',
    project: false,
  };
}

async function updatePhoneInventoryStatus(pool, ids, status, adminUser) {
  const targetStatus = String(status || '').trim();
  if (!PHONE_INVENTORY_BATCH_STATUSES.includes(targetStatus)) {
    throw createPhoneImportError('手机号状态不正确');
  }
  const normalizedIds = normalizePhoneInventoryIds(ids, '请选择要更改状态的手机号');
  return withPhoneInventoryOwner(pool, adminUser, async (client) => {
    const phones = await lockOwnedPhoneInventory(client, normalizedIds, adminUser);
    let updatedCount = 0;
    for (const phone of phones) {
      const next = nextPhoneInventoryStatus(phone, targetStatus);
      if (!next) continue;
      if (next.unbind) {
        await unbindProjectedRecord(client, phone, adminUser);
      }
      await client.query(
        `update phone_inventory
         set status = $3,
             reserved_record_id = $4,
             reserved_batch_slot_id = $5,
             reserved_at = $6,
             after_sale_at = $7,
             bound_at = $8,
             updated_at = now()
         where owner_id = $1 and id = $2`,
        [
          adminUser.id,
          phone.id,
          next.status,
          next.reservedRecordId,
          next.reservedBatchSlotId,
          next.reservedAt,
          next.afterSaleAt === 'now' ? new Date() : next.afterSaleAt,
          next.boundAt === 'now' ? new Date() : next.boundAt,
        ],
      );
      if (next.project) {
        await projectBoundPhone(client, { ...phone, status: 'bound' }, adminUser);
      }
      updatedCount += 1;
    }
    return updatedCount;
  });
}

module.exports = {
  PHONE_DURATION_DAYS,
  PHONE_INVENTORY_BATCH_LIMIT,
  deletePhoneInventory,
  derivePhoneExpireAt,
  importPhoneInventoryText,
  listPhoneInventory,
  normalizePhoneSmsUrl,
  parsePhoneInventoryImportText,
  toPhoneInventoryDto,
  updatePhoneInventoryStatus,
};
