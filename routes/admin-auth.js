const express = require('express');
const {
  findAdminByIdentifier,
  serializeAdminUser,
} = require('../lib/admin-users');
const { verifyAdminPassword } = require('../lib/admin-password');

function createAdminAuthRouter({ pool, requireAdminAuth }) {
  const router = express.Router();

  router.post('/login', async (req, res, next) => {
    try {
      const { identifier, password } = req.body;
      const user = await findAdminByIdentifier(pool, identifier);

      if (!user || user.status !== 'active') {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const passwordMatches = await verifyAdminPassword(
        password,
        user.password_hash,
      );
      if (!passwordMatches) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      req.session.adminUserId = user.id;
      await pool.query(
        `update admin_users set last_login_at = now(), updated_at = now() where id = $1`,
        [user.id],
      );

      return res.status(200).json({ user: serializeAdminUser(user) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', requireAdminAuth, (req, res) => {
    res.status(200).json({ user: req.adminUser });
  });

  router.post('/logout', (req, res) => {
    if (!req.session) {
      return res.status(204).end();
    }

    return req.session.destroy(() => {
      res.status(204).end();
    });
  });

  return router;
}

module.exports = { createAdminAuthRouter };
