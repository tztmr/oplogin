const crypto = require('node:crypto');
const {
  decryptGooglePassword,
  buildGooglePasswordSearchHash,
} = require('./google-password-crypto');

const SLOT_COUNT = 6;

function createPublicError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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
      opValue: row.op_value,
      distributionOrder: Number(row.distribution_order),
      total: Number(row.total_records),
      remark: row.remark || '',
    },
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

  for (const row of result.rows) {
    if (!row.record_id) {
      row.total_records = 0;
      row.distribution_order = 0;
      continue;
    }

    const totalResult = await client.query(
      `
        select count(*) as total_records
        from managed_records
        where owner_id = $1
      `,
      [row.record_owner_id],
    );
    const distributionResult = await client.query(
      `
        select count(*) as distribution_order
        from managed_records
        where owner_id = $1
          and (
            created_at < $2
            or (created_at = $2 and id <= $3)
          )
      `,
      [row.record_owner_id, row.record_created_at, row.record_id],
    );
    row.total_records = totalResult.rows[0].total_records;
    row.distribution_order = distributionResult.rows[0].distribution_order;
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
  const batchId = crypto.randomUUID();
  const emptyPasswordSearchHash = buildGooglePasswordSearchHash(
    '',
    config.googlePasswordEncryptionKey,
  );
  const selectedRecords = await client.query(
    `
      select m.id
      from managed_records m
      where m.owner_id = $1
        and m.google_account != ''
        and m.op_value != ''
        and m.google_password_search_hash != $4
        and (m.uid_value = '' or m.uid_value is null)
        and not (m.id = any($2::uuid[]))
      order by m.created_at asc, m.id asc
      limit $3
    `,
    [ownerId, excludeRecordIds, SLOT_COUNT, emptyPasswordSearchHash],
  );

  await client.query(
    `
      insert into public_user_batches (id, owner_id, status)
      values ($1, $2, 'open')
    `,
    [batchId, ownerId],
  );

  for (let slotNumber = 1; slotNumber <= SLOT_COUNT; slotNumber += 1) {
    const selectedRow = selectedRecords.rows[slotNumber - 1] || null;
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

async function getCurrentBatch(pool, config, user) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const openBatchId = await findOpenBatchId(client, user.id);
    const batch = openBatchId
      ? await loadBatch(client, config, openBatchId)
      : await createBatch(client, config, user.id);
    await client.query('commit');
    return batch;
  } catch (error) {
    await client.query('rollback');
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

    const releasableResult = await client.query(
      `
        select record_id
        from public_user_batch_slots
        where batch_id = $1 and status = 'available' and record_id is not null
        order by slot_number asc
      `,
      [openBatchId],
    );
    const excludeRecordIds = releasableResult.rows.map((row) => row.record_id);

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

    const batch = await createBatch(client, config, user.id, { excludeRecordIds });
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
  submitBatchSlotUid,
  advanceBatch,
};
