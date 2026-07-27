const express = require('express');
const {
  createManagedRecord,
  listManagedRecords,
  getManagedRecordById,
  updateManagedRecord,
  clearManagedRecordGoogleFields,
  clearManagedRecordOpFields,
  clearManagedRecordGoogleFieldsBatch,
  clearManagedRecordOpFieldsBatch,
  deleteManagedRecord,
  deleteManagedRecords,
  exportManagedRecordsCsv,
  importManagedRecordText,
} = require('../lib/managed-records');
const { lookupOpNicknames } = require('../lib/op-nickname');

function createAdminRecordsRouter({
  pool,
  config,
  requireAdminAuth,
  lookupOpNicknamesImpl = lookupOpNicknames,
}) {
  const router = express.Router();

  router.use(requireAdminAuth);

  router.get('/', async (req, res, next) => {
    try {
      const result = await listManagedRecords(pool, config, req.query, req.adminUser);
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const item = await createManagedRecord(pool, config, req.body, req.adminUser);
      return res.status(201).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/import-text', async (req, res, next) => {
    try {
      const result = await importManagedRecordText(
        pool,
        config,
        req.body.rowsText,
        req.adminUser,
        lookupOpNicknamesImpl,
      );
      return res.status(201).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/export.csv', async (req, res, next) => {
    try {
      const csvContent = await exportManagedRecordsCsv(
        pool,
        config,
        req.query,
        req.adminUser,
        req.query.ids,
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="managed-records.csv"',
      );
      return res.status(200).send(csvContent);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/export.csv', async (req, res, next) => {
    try {
      const csvContent = await exportManagedRecordsCsv(
        pool,
        config,
        req.body.filters || {},
        req.adminUser,
        req.body.ids,
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="managed-records.csv"',
      );
      return res.status(200).send(csvContent);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/batch-delete', async (req, res, next) => {
    try {
      const deletedCount = await deleteManagedRecords(pool, req.body.ids, req.adminUser);
      return res.status(200).json({ deletedCount });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/batch-clear-google', async (req, res, next) => {
    try {
      const clearedCount = await clearManagedRecordGoogleFieldsBatch(
        pool,
        config,
        req.body.ids,
        req.adminUser,
      );
      return res.status(200).json({ clearedCount });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/batch-clear-op', async (req, res, next) => {
    try {
      const clearedCount = await clearManagedRecordOpFieldsBatch(
        pool,
        config,
        req.body.ids,
        req.adminUser,
      );
      return res.status(200).json({ clearedCount });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/', async (req, res, next) => {
    try {
      const deletedCount = await deleteManagedRecords(pool, req.body.ids, req.adminUser);
      return res.status(200).json({ deletedCount });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const item = await getManagedRecordById(pool, config, req.params.id, req.adminUser);
      if (!item) {
        return res.status(404).json({ error: 'Record not found' });
      }

      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const item = await updateManagedRecord(
        pool,
        config,
        req.params.id,
        req.body,
        req.adminUser
      );
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:id/google', async (req, res, next) => {
    try {
      const item = await clearManagedRecordGoogleFields(
        pool,
        config,
        req.params.id,
        req.adminUser,
      );
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:id/op', async (req, res, next) => {
    try {
      const item = await clearManagedRecordOpFields(
        pool,
        config,
        req.params.id,
        req.adminUser,
      );
      return res.status(200).json({ item });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      await deleteManagedRecord(pool, req.params.id, req.adminUser);
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createAdminRecordsRouter };
