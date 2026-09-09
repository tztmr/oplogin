const crypto = require('node:crypto');
const {
  decryptGooglePassword,
  buildGooglePasswordSearchHash,
} = require('./google-password-crypto');
const { isManagedRecordUidUniqueViolation } = require('./uid-value');

const SLOT_COUNT = 6;
const PHONE_MODEL_VALUES = ['11', '12mini', '14', 'x'];

function createPublicError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function eligibleRecordSql(passwordHashParam, alias = '') {
  const column = alias ? `${alias}.` : '';
  return `
    ${column}google_account != ''
    and ${column}op_value != ''
    and ${column}google_password_search_hash != ${passwordHashParam}
    and (${column}uid_value = '' or ${column}uid_value is null)
  `;
}

function slotHasRecord(slot) {
  return Boolean(slot && slot.record);
}

function toSlotDto(row, config) {
  if (!row.record_id) {
    return {
      slot: Number(row.slot_number),
      status: row.slot_status,
      record: null,
    };
  }

  return {
    slot: Number(row.slot_number),
    status: row.slot_status,
    record: {
      id: row.record_id,
      googleAccount: row.google_account,
      googlePassword: decryptGooglePassword(
        row.google_password_encrypted,
        config.googlePasswordEncryptionKey,
      ),
      phoneNumber: row.phone_number || '',
      phoneInventoryId: row.phone_inventory_id || null,
      phoneSmsUrl: row.phone_sms_url || '',
      phoneExpireAt: row.phone_expire_at,
      phoneStatus: row.phone_number ? (row.phone_status || '未绑定') : '',
      phoneModel: row.phone_model || '12mini',
      phoneBindingLocked: Boolean(row.phone_binding_locked),
      lastPhoneAttempt: row.last_phone_attempt || null,
      opValue: row.op_value,
      distributionOrder: Number(row.distribution_order),
      total: Number(row.total_records),
      remark: row.remark || '',
    },
  };
}

async function loadDistributionScope(client, ownerId) {
  const result = await client.query(
    `
      select id
      from managed_records
      where owner_id = $1
      order by created_at asc, id asc
    `,
    [ownerId],
  );
  return {
    totalRecords: result.rows.length,
    distributionOrderById: new Map(
      result.rows.map((row, index) => [row.id, index + 1]),
    ),
  };
}

async function loadBatch(client, config, batchId) {
  const result = await client.query(
    `
      select
        b.id as batch_id,
        b.owner_id,
        b.status as batch_status,
        b.created_at as batch_created_at,
        s.slot_number,
        s.status as slot_status,
        s.record_id,
        s.completed_at,
        m.google_account,
        m.google_password_encrypted,
        m.phone_number,
        m.phone_sms_url,
        m.phone_expire_at,
        m.phone_status,
        m.phone_model,
        m.op_value,
        m.remark,
        m.owner_id as record_owner_id,
        m.created_at as record_created_at
      from public_user_batches b
      join public_user_batch_slots s on s.batch_id = b.id
      left join managed_records m on m.id = s.record_id
      where b.id = $1
      order by s.slot_number asc
    `,
    [batchId],
  );

  if (!result.rows.length) {
    throw createPublicError('当前批次不存在', 404);
  }

  const distributionScopeCache = new Map();
  for (const row of result.rows) {
    if (row.record_owner_id !== row.owner_id) row.record_id = null;
    if (!row.record_id) {
      row.total_records = 0;
      row.distribution_order = 0;
      continue;
    }

    const history = await loadPhoneHistory(client, row.owner_id, row.record_id);
    const currentPhone = !history.bound && row.phone_status !== '已绑定' ? history.reserved : null;
    row.phone_binding_locked = Boolean(history.bound || row.phone_status === '已绑定');
    if (history.bound && !history.bound.source_record_id) row.phone_inventory_id = history.bound.id;
    if (currentPhone) {
      row.phone_inventory_id = currentPhone.source_record_id ? null : currentPhone.id;
      row.phone_number = currentPhone.phone_number;
      row.phone_sms_url = currentPhone.phone_sms_url;
      row.phone_expire_at = currentPhone.phone_expire_at;
      row.phone_model = currentPhone.phone_model;
      row.phone_status = '未绑定';
    } else if (row.phone_status !== '已绑定') {
      row.phone_number = '';
      row.phone_sms_url = '';
      row.phone_expire_at = null;
      row.phone_status = '';
    }
    if (history.lastAttempt) {
      row.last_phone_attempt = {
        phoneInventoryId: history.lastAttempt.id,
        phoneNumber: history.lastAttempt.phone_number,
        phoneStatus: '老号售后',
        afterSaleAt: history.lastAttempt.after_sale_at,
      };
    }

    if (!distributionScopeCache.has(row.record_owner_id)) {
      distributionScopeCache.set(
        row.record_owner_id,
        await loadDistributionScope(client, row.record_owner_id),
      );
    }

    const distributionScope = distributionScopeCache.get(row.record_owner_id);
    row.total_records = distributionScope.totalRecords;
    row.distribution_order = distributionScope.distributionOrderById.get(row.record_id) || 0;
  }

  return {
    id: result.rows[0].batch_id,
    ownerId: result.rows[0].owner_id,
    status: result.rows[0].batch_status,
    createdAt: result.rows[0].batch_created_at,
    slots: result.rows.map((row) => toSlotDto(row, config)),
  };
}

async function findOpenBatchId(client, ownerId) {
  const result = await client.query(
    `
      select id
      from public_user_batches
      where owner_id = $1 and status = 'open'
      order by created_at desc, id desc
      limit 1
    `,
    [ownerId],
  );

  return result.rows[0] ? result.rows[0].id : null;
}

async function createBatch(client, config, ownerId, options = {}) {
  const excludeRecordIds = Array.isArray(options.excludeRecordIds)
    ? options.excludeRecordIds.filter(Boolean)
    : [];
  const priorityRecordIds = Array.isArray(options.priorityRecordIds)
    ? options.priorityRecordIds.filter(Boolean)
    : [];
  const batchId = crypto.randomUUID();
  const emptyPasswordSearchHash = buildGooglePasswordSearchHash(
    '',
    config.googlePasswordEncryptionKey,
  );
  const priorityRecords = priorityRecordIds.length
    ? await client.query(
      `
        select m.id
        from managed_records m
        where m.owner_id = $1
          and m.id = any($2::uuid[])
          and ${eligibleRecordSql('$3', 'm')}
        limit $4
      `,
      [ownerId, priorityRecordIds, emptyPasswordSearchHash, SLOT_COUNT],
    )
    : { rows: [] };
  if (priorityRecords.rows.length > 1) {
    const priorityOrder = new Map(
      priorityRecordIds.map((recordId, index) => [recordId, index]),
    );
    priorityRecords.rows.sort(
      (left, right) => (priorityOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (priorityOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  const remainingSlotCount = Math.max(SLOT_COUNT - priorityRecords.rows.length, 0);
  const selectedRecords = remainingSlotCount
    ? await client.query(
    `
      select m.id
      from managed_records m
      where m.owner_id = $1
        and ${eligibleRecordSql('$4', 'm')}
        and not (m.id = any($2::uuid[]))
      order by m.created_at asc, m.id asc
      limit $3
    `,
    [
      ownerId,
      [...new Set([...excludeRecordIds, ...priorityRecords.rows.map((row) => row.id)])],
      remainingSlotCount,
      emptyPasswordSearchHash,
    ],
  )
    : { rows: [] };
  const batchRecordRows = [...priorityRecords.rows, ...selectedRecords.rows];

  await client.query(
    `
      insert into public_user_batches (id, owner_id, status)
      values ($1, $2, 'open')
    `,
    [batchId, ownerId],
  );

  for (let slotNumber = 1; slotNumber <= SLOT_COUNT; slotNumber += 1) {
    const selectedRow = batchRecordRows[slotNumber - 1] || null;
    await client.query(
      `
        insert into public_user_batch_slots (
          id,
          batch_id,
          slot_number,
          record_id,
          status
        )
        values ($1, $2, $3, $4, $5)
      `,
      [
        crypto.randomUUID(),
        batchId,
        slotNumber,
        selectedRow ? selectedRow.id : null,
        selectedRow ? 'available' : 'empty',
      ],
    );
  }

  return loadBatch(client, config, batchId);
}

function hasProcessableSlots(batch) {
  return batch.slots.some((slot) => slot.status === 'available' && slotHasRecord(slot));
}

function hasVacantSlots(batch) {
  return batch.slots.some(
    (slot) => slot.status === 'empty' || (slot.status === 'available' && !slotHasRecord(slot)),
  );
}

function getAvailableRecordIds(batch) {
  return batch.slots
    .filter((slot) => slot.status === 'available' && slotHasRecord(slot))
    .map((slot) => slot.record.id);
}

async function hasEligibleRecords(client, config, ownerId, excludeRecordIds = []) {
  const emptyPasswordSearchHash = buildGooglePasswordSearchHash(
    '',
    config.googlePasswordEncryptionKey,
  );
  const result = await client.query(
    `
      select 1
      from managed_records
      where owner_id = $1
        and ${eligibleRecordSql('$2')}
        and not (id = any($3::uuid[]))
      limit 1
    `,
    [ownerId, emptyPasswordSearchHash, excludeRecordIds],
  );
  return result.rows.length > 0;
}

async function fillVacantSlots(client, config, batch) {
  const vacantSlots = batch.slots.filter(
    (slot) => slot.status === 'empty' || (slot.status === 'available' && !slotHasRecord(slot)),
  );
  if (!vacantSlots.length) {
    return batch;
  }

  const keptRecordIds = batch.slots
    .filter((slot) => slot.record)
    .map((slot) => slot.record.id);
  const emptyPasswordSearchHash = buildGooglePasswordSearchHash(
    '',
    config.googlePasswordEncryptionKey,
  );
  const replacements = await client.query(
    `
      select m.id
      from managed_records m
      where m.owner_id = $1
        and ${eligibleRecordSql('$2', 'm')}
        and not (m.id = any($3::uuid[]))
      order by m.created_at asc, m.id asc
      limit $4
    `,
    [batch.ownerId, emptyPasswordSearchHash, keptRecordIds, vacantSlots.length],
  );

  for (let index = 0; index < vacantSlots.length; index += 1) {
    const slot = vacantSlots[index];
    const replacement = replacements.rows[index] || null;
    await client.query(
      `
        update public_user_batch_slots
        set
          record_id = $1,
          status = $2,
          updated_at = now()
        where batch_id = $3 and slot_number = $4
      `,
      [
        replacement ? replacement.id : null,
        replacement ? 'available' : 'empty',
        batch.id,
        slot.slot,
      ],
    );
  }

  return loadBatch(client, config, batch.id);
}

async function getCurrentBatch(pool, config, user) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await lockOwner(client, user.id);
    const openBatchId = await findOpenBatchId(client, user.id);
    let batch = openBatchId
      ? await loadBatch(client, config, openBatchId)
      : await createBatch(client, config, user.id);

    if (openBatchId && !hasProcessableSlots(batch) && await hasEligibleRecords(client, config, user.id)) {
      await client.query(
        `
          update public_user_batches
          set status = 'released', released_at = now(), updated_at = now()
          where id = $1
        `,
        [openBatchId],
      );
      batch = await createBatch(client, config, user.id);
    } else if (openBatchId && hasVacantSlots(batch)) {
      batch = await fillVacantSlots(client, config, batch);
    }

    await client.query('commit');
    return batch;
  } catch (error) {
    await client.query('rollback');
    if (isManagedRecordUidUniqueViolation(error)) {
      throw createPublicError('UID 已存在，请勿重复提交', 400);
    }
    throw error;
  } finally {
    client.release();
  }
}

// Every public write acquires this owner lock before record and inventory locks.
async function lockOwner(client, ownerId) {
  await client.query('select id from admin_users where id = $1 for update', [ownerId]);
}

async function withOwnerTransaction(pool, user, work) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await lockOwner(client, user.id);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    if (isManagedRecordUidUniqueViolation(error)) {
      throw createPublicError('UID 已存在，请勿重复提交', 400);
    }
    throw error;
  } finally {
    client.release();
  }
}

function validateIdentity(payload, requirePhone = false) {
  const keys = requirePhone ? ['batchId', 'recordId', 'phoneInventoryId'] : ['batchId', 'recordId'];
  for (const key of keys) {
    if (typeof payload[key] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload[key])) {
      throw createPublicError('缺少或无效的批次、记录或手机号标识，请刷新后重试', 400);
    }
  }
}

async function loadWritableSlot(client, user, slotNumber, payload) {
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > SLOT_COUNT) {
    throw createPublicError('槽位必须在 1 到 6 之间', 400);
  }
  const batchId = await findOpenBatchId(client, user.id);
  if (payload.batchId !== undefined && payload.batchId !== batchId) {
    throw createPublicError('批次已变更，请刷新后重试', 409);
  }
  if (!batchId) throw createPublicError('当前没有可处理批次', 400);
  const result = await client.query(
    'select id, record_id, status from public_user_batch_slots where batch_id=$1 and slot_number=$2',
    [batchId, slotNumber],
  );
  const slot = result.rows[0];
  if (payload.recordId !== undefined && payload.recordId !== slot?.record_id) {
    throw createPublicError('槽位记录已变更，请刷新后重试', 409);
  }
  if (!slot?.record_id) throw createPublicError('当前槽位没有可提交的数据', 400);
  if (slot.status !== 'available') throw createPublicError('当前槽位已经处理完成', 409);
  const records = await client.query('select * from managed_records where id=$1 for update', [slot.record_id]);
  const record = records.rows[0];
  if (!record) throw createPublicError('记录不存在，请刷新后重试', 409);
  if (record.owner_id !== user.id) throw createPublicError('当前槽位不属于该用户', 403);
  if (String(record.uid_value || '').trim()) throw createPublicError('记录已经处理完成', 409);
  return { ...slot, batchId, record };
}

async function loadPhoneHistory(client, ownerId, recordId) {
  const phones = await client.query(
    "select * from phone_inventory where owner_id=$1 and reserved_record_id=$2 order by created_at desc,id desc",
    [ownerId, recordId],
  );
  const archive = await client.query(
    "select * from phone_inventory_legacy_archive where owner_id=$1 and source_record_id=$2 and phone_status='已绑定' limit 1",
    [ownerId, recordId],
  );
  return {
    bound: phones.rows.find((phone) => phone.status === 'bound') || archive.rows[0] || null,
    reserved: phones.rows.find((phone) => phone.status === 'reserved') || null,
    lastAttempt: phones.rows.filter((phone) => phone.status === 'after_sale')
      .sort((a, b) => new Date(b.after_sale_at) - new Date(a.after_sale_at))[0] || null,
  };
}

async function requireUnboundRecord(client, user, slot) {
  const history = await loadPhoneHistory(client, user.id, slot.record_id);
  if (history.bound || slot.record.phone_status === '已绑定') {
    throw createPublicError('手机号已绑定，用户中心不可修改或更换', 409);
  }
  return history;
}

async function requireReservedPhone(client, user, slot, payload) {
  await requireUnboundRecord(client, user, slot);
  const result = await client.query(
    "select * from phone_inventory where id=$1 and owner_id=$2 and reserved_record_id=$3 and status='reserved' for update",
    [payload.phoneInventoryId, user.id, slot.record_id],
  );
  if (!result.rows.length) throw createPublicError('手机号已变更，请刷新后重试', 409);
  return result.rows[0];
}

async function saveRecordUid(client, user, record, payload) {
  const uid = String(payload.uid || '').trim();
  const remark = String(payload.remark || '').trim();
  if (!uid) throw createPublicError('UID 不能为空', 400);
  if (record.phone_status !== '已绑定' || !String(record.phone_number || '').trim()) {
    throw createPublicError('请先确认手机号已绑定，再保存 UID', 400);
  }
  const duplicate = await client.query('select id from managed_records where uid_value=$1 and id!=$2 limit 1', [uid, record.id]);
  if (duplicate.rows.length) throw createPublicError('UID 已存在，请勿重复提交', 400);
  const result = await client.query(
    `update managed_records set uid_value=$1,uid_created_at=now(),
       remark=case when $2!='' then $2 else remark end,updated_at=now()
     where id=$3 and owner_id=$4 and (uid_value='' or uid_value is null)
       and phone_status='已绑定' and phone_number=$5 and phone_number!=''
     returning id`,
    [uid, remark, record.id, user.id, record.phone_number],
  );
  if (!result.rows.length) throw createPublicError('记录已变更或手机号未绑定，请刷新后重试', 409);
  await client.query(
    `update public_user_batch_slots set status='done',completed_at=now(),updated_at=now()
     where record_id=$1 and status='available'
       and batch_id in (select id from public_user_batches where owner_id=$2 and status='open')`,
    [record.id, user.id],
  );
}

async function submitBatchSlotUid(pool, config, user, slotNumber, payload = {}) {
  return withOwnerTransaction(pool, user, async (client) => {
    const slot = await loadWritableSlot(client, user, slotNumber, payload);
    await saveRecordUid(client, user, slot.record, payload);
    return loadBatch(client, config, slot.batchId);
  });
}

async function submitRecordUid(pool, user, recordId, payload = {}) {
  return withOwnerTransaction(pool, user, async (client) => {
    const result = await client.query('select * from managed_records where id=$1 and owner_id=$2 for update', [recordId, user.id]);
    const record = result.rows[0];
    if (!record || String(record.uid_value || '').trim()) throw createPublicError('记录不存在或已被其他用户提取', 400);
    if (payload.recordId !== undefined && payload.recordId !== recordId) throw createPublicError('记录已变更，请刷新后重试', 409);
    if (payload.batchId !== undefined && payload.batchId !== await findOpenBatchId(client, user.id)) throw createPublicError('批次已变更，请刷新后重试', 409);
    await saveRecordUid(client, user, record, payload);
    return { status: 'success' };
  });
}

async function extractBatchSlotPhone(pool, config, user, slotNumber, payload = {}) {
  validateIdentity(payload);
  return withOwnerTransaction(pool, user, async (client) => {
    const slot = await loadWritableSlot(client, user, slotNumber, payload);
    const history = await requireUnboundRecord(client, user, slot);
    if (!history.reserved) {
      const available = await client.query(
        `select * from phone_inventory where owner_id=$1 and status='available'
         and (phone_expire_at is null or phone_expire_at>now())
         order by created_at asc,id asc limit 1 for update`,
        [user.id],
      );
      if (!available.rows.length) throw createPublicError('手机号库存不足', 400);
      const result = await client.query(
        `update phone_inventory set status='reserved',reserved_record_id=$1,reserved_batch_slot_id=$2,
         reserved_at=now(),updated_at=now() where id=$3 and owner_id=$4 and status='available' returning id`,
        [slot.record_id, slot.id, available.rows[0].id, user.id],
      );
      if (!result.rows.length) throw createPublicError('手机号已变更，请刷新后重试', 409);
    }
    return loadBatch(client, config, slot.batchId);
  });
}

async function setBatchSlotPhoneStatus(pool, config, user, slotNumber, targetStatus, payload = {}) {
  validateIdentity(payload, true);
  const status = String(targetStatus || '').trim();
  if (!['已绑定', '老号售后'].includes(status)) throw createPublicError('手机号状态不正确', 400);
  return withOwnerTransaction(pool, user, async (client) => {
    const slot = await loadWritableSlot(client, user, slotNumber, payload);
    const phone = await requireReservedPhone(client, user, slot, payload);
    const bound = status === '已绑定';
    const result = await client.query(
      `update phone_inventory set status=$1,${bound ? 'bound_at' : 'after_sale_at'}=now(),updated_at=now()
       where id=$2 and owner_id=$3 and reserved_record_id=$4 and status='reserved' returning id`,
      [bound ? 'bound' : 'after_sale', phone.id, user.id, slot.record_id],
    );
    if (!result.rows.length) throw createPublicError('手机号已变更，请刷新后重试', 409);
    if (bound) {
      const updated = await client.query(
        `update managed_records set phone_number=$1,phone_sms_url=$2,phone_expire_at=$3,
         phone_model=$4,phone_status='已绑定',updated_at=now()
         where id=$5 and owner_id=$6 and phone_status!='已绑定' and (uid_value='' or uid_value is null) returning id`,
        [phone.phone_number, phone.phone_sms_url, phone.phone_expire_at, phone.phone_model, slot.record_id, user.id],
      );
      if (!updated.rows.length) throw createPublicError('记录已变更，请刷新后重试', 409);
    }
    return loadBatch(client, config, slot.batchId);
  });
}

async function markBatchSlotPhoneBound(pool, config, user, slotNumber, targetStatus = '已绑定', payload = {}) {
  return setBatchSlotPhoneStatus(pool, config, user, slotNumber, targetStatus, payload);
}

async function updateBatchSlotPhoneModel(pool, config, user, slotNumber, phoneModel, payload = {}) {
  validateIdentity(payload, true);
  const normalizedModel = String(phoneModel || '').trim();
  if (!PHONE_MODEL_VALUES.includes(normalizedModel)) throw createPublicError('机型不正确，请选择 11、12mini、14 或 x', 400);
  return withOwnerTransaction(pool, user, async (client) => {
    const slot = await loadWritableSlot(client, user, slotNumber, payload);
    const phone = await requireReservedPhone(client, user, slot, payload);
    const result = await client.query(
      `update phone_inventory set phone_model=$1,updated_at=now()
       where id=$2 and owner_id=$3 and reserved_record_id=$4 and status='reserved' returning id`,
      [normalizedModel, phone.id, user.id, slot.record_id],
    );
    if (!result.rows.length) throw createPublicError('手机号已变更，请刷新后重试', 409);
    return loadBatch(client, config, slot.batchId);
  });
}

async function advanceBatch(pool, config, user) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await lockOwner(client, user.id);
    const openBatchId = await findOpenBatchId(client, user.id);

    if (!openBatchId) {
      const batch = await createBatch(client, config, user.id);
      await client.query('commit');
      return batch;
    }

    const currentBatch = await loadBatch(client, config, openBatchId);
    const priorityRecordIds = getAvailableRecordIds(currentBatch);

    await client.query(
      `
        update public_user_batch_slots
        set status = 'released', updated_at = now()
        where batch_id = $1 and status = 'available'
      `,
      [openBatchId],
    );
    await client.query(
      `
        update public_user_batches
        set status = 'released', released_at = now(), updated_at = now()
        where id = $1
      `,
      [openBatchId],
    );

    const batch = await createBatch(client, config, user.id, { priorityRecordIds });
    await client.query('commit');
    return batch;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  SLOT_COUNT,
  getCurrentBatch,
  markBatchSlotPhoneBound,
  extractBatchSlotPhone,
  setBatchSlotPhoneStatus,
  submitRecordUid,
  submitBatchSlotUid,
  updateBatchSlotPhoneModel,
  advanceBatch,
};
