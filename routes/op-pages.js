const express = require('express');
const path = require('path');

function createOpPagesRouter(publicDir = path.join(__dirname, '..', 'public')) {
  const router = express.Router();

  router.get(/^\/op(?:\/.*)?$/, (req, res) => {
    return res.sendFile(path.join(publicDir, 'op.html'));
  });

  return router;
}

module.exports = { createOpPagesRouter };
