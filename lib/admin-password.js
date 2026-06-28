const bcrypt = require('bcryptjs');

function hashAdminPassword(password) {
  return bcrypt.hash(String(password || ''), 12);
}

function verifyAdminPassword(password, passwordHash) {
  return bcrypt.compare(String(password || ''), passwordHash);
}

module.exports = { hashAdminPassword, verifyAdminPassword };
