const express = require('express');

const {
  createShortOpRecord,
  deleteShortOpRecord,
  getShortOpRecordById,
  importShortOpText,
  listShortOpRecords,
  setShortOpRecordStatus,
  updateShortOpRecord,
} = require('../lib/short-op-records');

function createAdminShortOpsRouter({ pool, requireAdminAuth }) {
  const router = express.Router();
  router.use(requireAdminAuth);

  router.get('/', async (req, res, next) => {
    try {
      return res.status(200).json(
        await listShortOpRecords(pool, req.query, req.adminUser),
      );
    } catch (error) {
      return next(error);
    }
  });

  router.post('/import-text', async (req, res, next) => {
    try {
      const result = await importShortOpText(
        pool,
        req.body && req.body.rowsText,
        req.adminUser,
      );
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const item = await createShortOpRecord(pool, req.body, req.adminUser);
      return res.status(201).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const item = await getShortOpRecordById(pool, req.params.id, req.adminUser);
      if (!item) return res.status(404).json({ error: 'Short OP not found' });
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const item = await updateShortOpRecord(
        pool,
        req.params.id,
        req.body,
        req.adminUser,
      );
      if (!item) return res.status(404).json({ error: 'Short OP not found' });
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/enable', async (req, res, next) => {
    try {
      const item = await setShortOpRecordStatus(
        pool,
        req.params.id,
        'active',
        req.adminUser,
      );
      if (!item) return res.status(404).json({ error: 'Short OP not found' });
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/disable', async (req, res, next) => {
    try {
      const item = await setShortOpRecordStatus(
        pool,
        req.params.id,
        'disabled',
        req.adminUser,
      );
      if (!item) return res.status(404).json({ error: 'Short OP not found' });
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const item = await deleteShortOpRecord(pool, req.params.id, req.adminUser);
      if (!item) return res.status(404).json({ error: 'Short OP not found' });
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createAdminShortOpsRouter };
