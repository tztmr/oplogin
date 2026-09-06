const crypto = require('node:crypto');
const {
  decryptGooglePassword,
  buildGooglePasswordSearchHash,
} = require('./google-password-crypto');
const { isManagedRecordUidUniqueViolation } = require('./uid-value');

const SLOT_COUNT = 6;
const PHONE_MODEL_VALUES = ['11', '12mini', '14', 'x'];
const PHONE_STATUS_VALUES = ['未绑定', '已绑定'];

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
    and ${column}phone_number != ''
  `;
}

function slotHasVisiblePhone(slot) {
  return Boolean(slot && slot.record && String(slot.record.phoneNumber || '').trim());
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
      phoneSmsUrl: row.phone_sms_url || '',
      phoneExpireAt: row.phone_expire_at,
      phoneStatus: row.phone_status || '未绑定',
      phoneModel: row.phone_model || '12mini',
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
    if (!row.record_id) {
      row.total_records = 0;
      row.distribution_order = 0;
      continue;
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
  return batch.slots.some((slot) => slot.status === 'available' && slotHasVisiblePhone(slot));
}

function hasVacantSlots(batch) {
  return batch.slots.some(
    (slot) => slot.status === 'empty' || (slot.status === 'available' && !slotHasVisiblePhone(slot)),
  );
}

function getVisibleAvailableRecordIds(batch) {
  return batch.slots
    .filter((slot) => slot.status === 'available' && slotHasVisiblePhone(slot))
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
    (slot) => slot.status === 'empty' || (slot.status === 'available' && !slotHasVisiblePhone(slot)),
  );
  if (!vacantSlots.length) {
    return batch;
  }

  const keptRecordIds = batch.slots
    .filter((slot) => slot.record && (slot.status === 'done' || slotHasVisiblePhone(slot)))
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

async function submitBatchSlotUid(pool, config, user, slotNumber, payload) {
  const normalizedUid = String(payload.uid || '').trim();
  const normalizedRemark = String(payload.remark || '').trim();
  if (!normalizedUid) {
    throw createPublicError('UID 不能为空', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const openBatchId = await findOpenBatchId(client, user.id);
    if (!openBatchId) {
      throw createPublicError('当前没有可处理批次', 400);
    }

    const slotResult = await client.query(
      `
        select
          s.id,
          s.record_id,
          s.status,
          m.owner_id
        from public_user_batch_slots s
        join public_user_batches b on b.id = s.batch_id
        left join managed_records m on m.id = s.record_id
        where b.id = $1 and s.slot_number = $2
      `,
      [openBatchId, slotNumber],
    );
    const slot = slotResult.rows[0];

    if (!slot || !slot.record_id) {
      throw createPublicError('当前槽位没有可提交的数据', 400);
    }
    if (slot.status !== 'available') {
      throw createPublicError('当前槽位已经处理完成', 400);
    }
    if (slot.owner_id !== user.id) {
      throw createPublicError('当前槽位不属于该用户', 403);
    }

    const duplicateUidResult = await client.query(
      `
        select 1
        from managed_records
        where uid_value = $1
          and id != $2
        limit 1
      `,
      [normalizedUid, slot.record_id],
    );

    if (duplicateUidResult.rows.length > 0) {
      throw createPublicError('UID 已存在，请勿重复提交', 400);
    }

    const updateRecordResult = await client.query(
      `
        update managed_records
        set
          uid_value = $1,
          uid_created_at = now(),
          remark = case
            when $2 != '' then $2
            else remark
          end,
          updated_at = now()
        where id = $3
          and owner_id = $4
          and (uid_value = '' or uid_value is null)
        returning id
      `,
      [normalizedUid, normalizedRemark, slot.record_id, user.id],
    );

    if (!updateRecordResult.rows.length) {
      throw createPublicError('记录不存在或已被其他用户提取', 400);
    }

    await client.query(
      `
        update public_user_batch_slots
        set status = 'done', completed_at = now(), updated_at = now()
        where id = $1
      `,
      [slot.id],
    );

    const batch = await loadBatch(client, config, openBatchId);
    await client.query('commit');
    return batch;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function markBatchSlotPhoneBound(
  pool,
  config,
  user,
  slotNumber,
  targetStatus = '已绑定',
) {
  const normalizedTargetStatus = String(targetStatus || '已绑定').trim();
  if (!PHONE_STATUS_VALUES.includes(normalizedTargetStatus)) {
    throw createPublicError('手机号状态不正确', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const openBatchId = await findOpenBatchId(client, user.id);
    if (!openBatchId) {
      throw createPublicError('当前没有可处理批次', 400);
    }

    const slotResult = await client.query(
      `
        select
          s.id,
          s.record_id,
          s.status,
          m.owner_id,
          m.phone_number
        from public_user_batch_slots s
        join public_user_batches b on b.id = s.batch_id
        left join managed_records m on m.id = s.record_id
        where b.id = $1 and s.slot_number = $2
      `,
      [openBatchId, slotNumber],
    );
    const slot = slotResult.rows[0];

    if (!slot || !slot.record_id) {
      throw createPublicError('当前槽位没有可提交的数据', 400);
    }
    if (slot.owner_id !== user.id) {
      throw createPublicError('当前槽位不属于该用户', 403);
    }
    if (!String(slot.phone_number || '').trim()) {
      throw createPublicError('当前记录没有手机号，无法修改状态', 400);
    }

    await client.query(
      `
        update managed_records
        set phone_status = $3, updated_at = now()
        where id = $1
          and owner_id = $2
      `,
      [slot.record_id, user.id, normalizedTargetStatus],
    );

    const batch = await loadBatch(client, config, openBatchId);
    await client.query('commit');
    return batch;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function updateBatchSlotPhoneModel(pool, config, user, slotNumber, phoneModel) {
  const normalizedModel = String(phoneModel || '').trim();
  if (!PHONE_MODEL_VALUES.includes(normalizedModel)) {
    throw createPublicError('机型不正确，请选择 11、12mini、14 或 x', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const openBatchId = await findOpenBatchId(client, user.id);
    if (!openBatchId) {
      throw createPublicError('当前没有可处理批次', 400);
    }

    const slotResult = await client.query(
      `
        select
          s.id,
          s.record_id,
          s.status,
          m.owner_id
        from public_user_batch_slots s
        join public_user_batches b on b.id = s.batch_id
        left join managed_records m on m.id = s.record_id
        where b.id = $1 and s.slot_number = $2
      `,
      [openBatchId, slotNumber],
    );
    const slot = slotResult.rows[0];

    if (!slot || !slot.record_id) {
      throw createPublicError('当前槽位没有可提交的数据', 400);
    }
    if (slot.owner_id !== user.id) {
      throw createPublicError('当前槽位不属于该用户', 403);
    }

    await client.query(
      `
        update managed_records
        set phone_model = $1, updated_at = now()
        where id = $2
          and owner_id = $3
      `,
      [normalizedModel, slot.record_id, user.id],
    );

    const batch = await loadBatch(client, config, openBatchId);
    await client.query('commit');
    return batch;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function advanceBatch(pool, config, user) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const openBatchId = await findOpenBatchId(client, user.id);

    if (!openBatchId) {
      const batch = await createBatch(client, config, user.id);
      await client.query('commit');
      return batch;
    }

    const currentBatch = await loadBatch(client, config, openBatchId);
    const priorityRecordIds = getVisibleAvailableRecordIds(currentBatch);

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
  submitBatchSlotUid,
  updateBatchSlotPhoneModel,
  advanceBatch,
};
