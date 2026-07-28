const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const axios = require('axios');

const { createSubmitRouter } = require('../routes/api-submit');

test('createSubmitRouter sends the remote fallback request with a timeout', async () => {
  const originalPost = axios.post;
  let observedConfig = null;

  axios.post = async (url, body, config) => {
    observedConfig = config;
    const error = new Error('timed out');
    error.code = 'ECONNABORTED';
    throw error;
  };

  const app = express();
  app.use(express.json());
  app.use('/api', createSubmitRouter({
    buildWakeUrlImpl() {
      throw new Error('local encode failed');
    },
  }));
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }
    return res.status(error.statusCode || 500).json({ error: error.message });
  });

  try {
    const response = await request(app)
      .post('/api/submit')
      .send({ url: 'bad-op-token', game: '1105602870' });

    assert.equal(response.status, 500);
    assert.match(response.body.error, /超时|Failed to encode data locally or fetch from target API/);
    assert.equal(observedConfig.timeout, 8000);
  } finally {
    axios.post = originalPost;
  }
});
