const express = require('express');
const path = require('path');

function createAdminPagesRouter(publicDir) {
  const router = express.Router();

  router.get('/admin/login', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin', 'login.html'));
  });

  router.get('/admin', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin', 'index.html'));
  });

  router.get('/admin/users', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin', 'users.html'));
  });

  return router;
}

module.exports = { createAdminPagesRouter };
