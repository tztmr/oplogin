const express = require('express');
const { findAdminByIdentifier } = require('../lib/admin-users');
const { decryptGooglePassword } = require('../lib/google-password-crypto');
const {
  getCurrentBatch,
  submitBatchSlotUid,
  advanceBatch,
} = require('../lib/public-user-batches');

function createUserPublicRouter({ pool, config }) {
  const router = express.Router();

  function chooseRecordIndex(records, currentRecordId, direction, jumpSlot) {
    if (!records.length) {
      return -1;
    }

    if (Number.isInteger(jumpSlot) && jumpSlot >= 1 && jumpSlot <= records.length) {
      return jumpSlot - 1;
    }

    const currentIndex = records.findIndex((row) => row.id === currentRecordId);
    if (currentIndex === -1) {
      return 0;
    }
    if (direction === 'next') {
      return Math.min(currentIndex + 1, records.length - 1);
    }
    if (direction === 'prev') {
      return Math.max(currentIndex - 1, 0);
    }
    return currentIndex;
  }

  async function findActiveUser(username) {
    const user = await findAdminByIdentifier(pool, username);
    if (!user || user.status !== 'active') {
      throw Object.assign(new Error('User not found or disabled'), { statusCode: 404 });
    }
    return user;
  }

  router.get('/:username/batch', async (req, res, next) => {
    try {
      const user = await findActiveUser(req.params.username);
      const batch = await getCurrentBatch(pool, config, user);
      return res.status(200).json({ batch });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:username/batch/slots/:slot/uid', async (req, res, next) => {
    try {
      const user = await findActiveUser(req.params.username);
      const slotNumber = Number.parseInt(String(req.params.slot || '').trim(), 10);
      if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 6) {
        return res.status(400).json({ error: '槽位必须在 1 到 6 之间' });
      }

      const batch = await submitBatchSlotUid(pool, config, user, slotNumber, req.body || {});
      return res.status(200).json({ status: 'success', batch });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:username/batch/advance', async (req, res, next) => {
    try {
      const user = await findActiveUser(req.params.username);
      const batch = await advanceBatch(pool, config, user);
      return res.status(200).json({ status: 'success', batch });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:username/record', async (req, res, next) => {
    try {
      const username = req.params.username;
      const currentRecordId = String(req.query.currentRecordId || '').trim();
      const direction = String(req.query.direction || '').trim().toLowerCase();
      const jumpSlotValue = Number.parseInt(String(req.query.jumpSlot || '').trim(), 10);
      const jumpSlot = Number.isNaN(jumpSlotValue) ? null : jumpSlotValue;
      const user = await findActiveUser(username);

      // 获取当前用户下，有谷歌号且未被提取过的记录（uid_value 为空）
      const countResult = await pool.query(
        `select count(*) from managed_records where owner_id = $1`,
        [user.id]
      );
      const totalRecords = parseInt(countResult.rows[0].count, 10);

      const result = await pool.query(
        `select * from managed_records 
         where owner_id = $1 
           and google_account != ''
           and (uid_value = '' or uid_value is null)
         order by created_at asc, id asc`,
        [user.id],
      );

      if (result.rows.length === 0) {
        return res.status(200).json({ record: null });
      }

      const recordIndex = chooseRecordIndex(
        result.rows,
        currentRecordId,
        direction,
        jumpSlot,
      );
      const row = result.rows[recordIndex];

      // 计算该记录在所有记录中的绝对索引
      const absoluteIndexResult = await pool.query(
        `select count(*) from managed_records 
         where owner_id = $1 
           and (
             created_at < (select created_at from managed_records where id = $2)
             or (
               created_at = (select created_at from managed_records where id = $2)
               and id <= $2
             )
           )`,
        [user.id, row.id]
      );
      const absoluteIndex = parseInt(absoluteIndexResult.rows[0].count, 10);

      return res.status(200).json({
        record: {
          id: row.id,
          distributionOrder: absoluteIndex,
          index: absoluteIndex,
          total: totalRecords,
          availableCount: result.rows.length,
          googleAccount: row.google_account,
          googlePassword: decryptGooglePassword(
            row.google_password_encrypted,
            config.googlePasswordEncryptionKey,
          ),
          opValue: row.op_value,
          hasPrevious: recordIndex > 0,
          hasNext: recordIndex < result.rows.length - 1,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:username/record/:id/uid', async (req, res, next) => {
    try {
      const { username, id } = req.params;
      const { uid, remark } = req.body;

      if (!uid || !uid.trim()) {
        return res.status(400).json({ error: 'UID 不能为空' });
      }

      const user = await findActiveUser(username);

      let query = `update managed_records 
         set uid_value = $1, uid_created_at = now(), updated_at = now()`;
      const queryParams = [uid.trim(), id, user.id];

      if (remark && remark.trim()) {
        query += `, remark = $4`;
        queryParams.push(remark.trim());
      }

      query += ` where id = $2 and owner_id = $3 and (uid_value = '' or uid_value is null) returning id`;

      const result = await pool.query(query, queryParams);

      if (result.rows.length === 0) {
        return res.status(400).json({ error: '记录不存在或已被其他用户提取' });
      }

      return res.status(200).json({ status: 'success' });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createUserPublicRouter };
