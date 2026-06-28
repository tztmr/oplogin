const express = require('express');
const axios = require('axios');
const { buildWakeUrl } = require('../lib/op-url');

function createSubmitRouter({ buildWakeUrlImpl = buildWakeUrl } = {}) {
  const router = express.Router();

  router.post('/submit', async (req, res, next) => {
    const { url, game } = req.body;

    if (!url || !game) {
      return res
        .status(400)
        .json({ error: 'Missing required parameters: url or game' });
    }

    try {
      const wakeUrl = buildWakeUrlImpl(url, game);

      return res.status(200).json({
        status: 'success',
        url: wakeUrl,
        source: 'local',
      });
    } catch (localError) {
      try {
        const response = await axios.post(
          'https://www.opdengluqi.com/api.php',
          { url, game },
          {
            headers: {
              'Content-Type': 'application/json',
              Referer: 'https://www.opdengluqi.com/',
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          },
        );

        return res.status(200).json({
          ...response.data,
          source: 'remote',
        });
      } catch (remoteError) {
        remoteError.statusCode = 500;
        remoteError.message =
          'Failed to encode data locally or fetch from target API';
        remoteError.detail = localError.message;
        return next(remoteError);
      }
    }
  });

  return router;
}

module.exports = { createSubmitRouter };
