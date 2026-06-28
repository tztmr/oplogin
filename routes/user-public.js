const express = require('express');
const { findAdminByIdentifier } = require('../lib/admin-users');
const { decryptGooglePassword } = require('../lib/google-password-crypto');

function createUserPublicRouter({ pool, config }) {
  const router = express.Router();

  router.get('/:username/record', async (req, res, next) => {
    try {
      const username = req.params.username;
      const user = await findAdminByIdentifier(pool, username);

      if (!user || user.status !== 'active') {
        return res.status(404).json({ error: 'User not found or disabled' });
      }

      // 获取当前用户下，有谷歌号且未被提取过的记录（uid_value 为空）
      const result = await pool.query(
        `select * from managed_records 
         where owner_id = $1 
           and google_account != ''
           and (uid_value = '' or uid_value is null)
         order by created_at asc
         limit 1`,
        [user.id]
      );

      if (result.rows.length === 0) {
        return res.status(200).json({ record: null });
      }

      const row = result.rows[0];
      return res.status(200).json({
        record: {
          id: row.id,
          googleAccount: row.google_account,
          googlePassword: decryptGooglePassword(row.google_password_encrypted, config.googlePasswordEncryptionKey),
          opValue: row.op_value
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:username/record/:id/uid', async (req, res, next) => {
    try {
      const { username, id } = req.params;
      const { uid } = req.body;

      if (!uid || !uid.trim()) {
        return res.status(400).json({ error: 'UID 不能为空' });
      }

      const user = await findAdminByIdentifier(pool, username);
      if (!user || user.status !== 'active') {
        return res.status(404).json({ error: 'User not found or disabled' });
      }

      const result = await pool.query(
        `update managed_records 
         set uid_value = $1, uid_created_at = now(), updated_at = now()
         where id = $2 
           and owner_id = $3 
           and (uid_value = '' or uid_value is null)
         returning id`,
        [uid.trim(), id, user.id]
      );

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