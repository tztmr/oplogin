const { findAdminById, serializeAdminUser } = require('./admin-users');

function createRequireAdminAuth(pool) {
  return async function requireAdminAuth(req, res, next) {
    try {
      const adminUserId = req.session && req.session.adminUserId;

      if (!adminUserId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const user = await findAdminById(pool, adminUserId);
      if (!user || user.status !== 'active') {
        return req.session.destroy(() => {
          res.status(401).json({ error: 'Unauthorized' });
        });
      }

      req.adminUser = serializeAdminUser(user);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requireSuperAdmin(req, res, next) {
  if (!req.adminUser || req.adminUser.role !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  return next();
}

module.exports = {
  createRequireAdminAuth,
  requireSuperAdmin,
};
