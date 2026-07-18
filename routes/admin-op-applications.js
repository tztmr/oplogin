const express = require('express');
const { requireSuperAdmin } = require('../lib/auth-middleware');
const {
  createOpApplication,
  listActiveOpApplicationOptions,
  listOpApplications,
  setDefaultOpApplication,
  setOpApplicationStatus,
  updateOpApplication,
} = require('../lib/op-applications');

function createAdminOpApplicationsRouter({ pool, requireAdminAuth }) {
  const router = express.Router();

  router.use(requireAdminAuth);

  router.get('/', async (req, res, next) => {
    try {
      if (req.adminUser.role !== 'super_admin') {
        const items = await listActiveOpApplicationOptions(pool);
        return res.status(200).json({
          items,
          total: items.length,
          page: 1,
          pageSize: items.length,
        });
      }
      return res.status(200).json(await listOpApplications(pool, req.query));
    } catch (error) {
      return next(error);
    }
  });

  router.use(requireSuperAdmin);

  router.post('/', async (req, res, next) => {
    try {
      const item = await createOpApplication(pool, req.body);
      return res.status(201).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const item = await updateOpApplication(pool, req.params.id, req.body);
      if (!item) {
        return res.status(404).json({ error: 'Application not found' });
      }
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/default', async (req, res, next) => {
    try {
      const item = await setDefaultOpApplication(pool, req.params.id);
      if (!item) {
        return res.status(404).json({ error: 'Application not found' });
      }
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/enable', async (req, res, next) => {
    try {
      const item = await setOpApplicationStatus(pool, req.params.id, 'active');
      if (!item) {
        return res.status(404).json({ error: 'Application not found' });
      }
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/disable', async (req, res, next) => {
    try {
      const item = await setOpApplicationStatus(pool, req.params.id, 'disabled');
      if (!item) {
        return res.status(404).json({ error: 'Application not found' });
      }
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createAdminOpApplicationsRouter };
