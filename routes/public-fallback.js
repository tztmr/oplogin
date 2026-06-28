const express = require('express');

function createPublicFallbackRouter(indexFilePath) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.redirect('/admin');
  });

  router.get(/^\/oplogin(?:\/.*)?$/, (req, res) => {
    res.sendFile(indexFilePath);
  });

  return router;
}

module.exports = { createPublicFallbackRouter };
