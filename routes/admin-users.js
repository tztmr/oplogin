const express = require('express');
const {
  createAdminUser,
  listAdminUsers,
  resetAdminPassword,
  updateAdminUser,
} = require('../lib/admin-users');
const { requireSuperAdmin } = require('../lib/auth-middleware');

function createAdminUsersRouter({ pool, requireAdminAuth }) {
  const router = express.Router();

  router.use(requireAdminAuth, requireSuperAdmin);

  router.get('/', async (req, res, next) => {
    try {
      const users = await listAdminUsers(pool);
      return res.status(200).json({ users });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const user = await createAdminUser(pool, req.body);
      return res.status(201).json({ user });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const user = await updateAdminUser(pool, req.params.id, req.body);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.status(200).json({ user });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/:id/password', async (req, res, next) => {
    try {
      await resetAdminPassword(pool, req.params.id, req.body.password);
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createAdminUsersRouter };
