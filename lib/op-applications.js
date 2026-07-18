const crypto = require('node:crypto');

function toOpApplicationDto(row) {
  return {
    id: row.id,
    name: row.name,
    appId: row.app_id,
    isDefault: row.is_default,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizePayload(payload = {}) {
  const name = String(payload.name || '').trim();
  const appId = String(payload.appId || '').trim();

  if (!name || !appId) {
    throw createHttpError(400, '应用名称和 AppID 不能为空');
  }

  return { name, appId };
}

function parsePagination(filters = {}) {
  if (String(filters.pageSize || '').trim().toLowerCase() === 'all') {
    return { page: 1, pageSize: 'all' };
  }
  const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(filters.pageSize, 10) || 20));
  return { page, pageSize };
}

async function getOpApplicationById(pool, id) {
  const result = await pool.query(
    `select * from op_applications where id = $1 limit 1`,
    [id],
  );
  return result.rows[0] ? toOpApplicationDto(result.rows[0]) : null;
}

async function listActiveOpApplicationOptions(pool) {
  const result = await pool.query(`
    select *
    from op_applications
    where status = 'active'
    order by is_default desc, name asc, app_id asc
  `);
  return result.rows.map(toOpApplicationDto);
}

async function listOpApplications(pool, filters = {}) {
  const { page, pageSize } = parsePagination(filters);
  const search = String(filters.search || '').trim();
  const status = String(filters.status || '').trim();
  const conditions = [];
  const values = [];

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(name ilike $${values.length} or app_id ilike $${values.length})`);
  }
  if (status === 'active' || status === 'disabled') {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }

  const whereClause = conditions.length ? `where ${conditions.join(' and ')}` : '';
  const countResult = await pool.query(
    `select count(*)::int as total from op_applications ${whereClause}`,
    values,
  );
  let paginationSql = '';
  if (pageSize !== 'all') {
    values.push(pageSize, (page - 1) * pageSize);
    paginationSql = `limit $${values.length - 1} offset $${values.length}`;
  }
  const result = await pool.query(
    `
      select *
      from op_applications
      ${whereClause}
      order by is_default desc, created_at desc, id asc
      ${paginationSql}
    `,
    values,
  );

  return {
    items: result.rows.map(toOpApplicationDto),
    total: countResult.rows[0].total,
    page,
    pageSize,
  };
}

async function createOpApplication(pool, payload) {
  const { name, appId } = normalizePayload(payload);
  const duplicate = await pool.query(
    `select id from op_applications where app_id = $1 limit 1`,
    [appId],
  );
  if (duplicate.rows[0]) {
    throw createHttpError(409, 'AppID 已存在');
  }

  try {
    const result = await pool.query(
      `
        insert into op_applications (id, name, app_id, is_default, status)
        values ($1, $2, $3, false, 'active')
        returning *
      `,
      [crypto.randomUUID(), name, appId],
    );
    return toOpApplicationDto(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      throw createHttpError(409, 'AppID 已存在');
    }
    throw error;
  }
}

async function updateOpApplication(pool, id, payload) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // PostgreSQL FK inserts take a KEY SHARE lock on this row, which conflicts
    // with this UPDATE lock and prevents a reference appearing mid-change.
    const existingResult = await client.query(
      `select * from op_applications where id = $1 for update`,
      [id],
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      await client.query('rollback');
      return null;
    }

    const { name, appId } = normalizePayload(payload);
    if (appId !== existing.app_id) {
      const referenceResult = await client.query(
        `select 1 from short_op_records where application_id = $1 limit 1`,
        [id],
      );
      if (referenceResult.rows[0]) {
        throw createHttpError(409, '已使用的 AppID 不能修改');
      }

      const duplicateResult = await client.query(
        `select id from op_applications where app_id = $1 and id <> $2 limit 1`,
        [appId, id],
      );
      if (duplicateResult.rows[0]) {
        throw createHttpError(409, 'AppID 已存在');
      }
    }

    const result = await client.query(
      `
        update op_applications
        set name = $2, app_id = $3, updated_at = now()
        where id = $1
        returning *
      `,
      [id, name, appId],
    );
    await client.query('commit');
    return toOpApplicationDto(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    if (error.code === '23505') {
      throw createHttpError(409, 'AppID 已存在');
    }
    throw error;
  } finally {
    client.release();
  }
}

async function setDefaultOpApplication(pool, id) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const targetResult = await client.query(
      `select * from op_applications where id = $1 for update`,
      [id],
    );
    const target = targetResult.rows[0];
    if (!target) {
      await client.query('rollback');
      return null;
    }
    if (target.status !== 'active') {
      throw createHttpError(400, '只能设置启用中的应用为默认应用');
    }

    await client.query(
      `
        select id
        from op_applications
        where is_default = true and id <> $1
        for update
      `,
      [id],
    );
    await client.query(
      `
        update op_applications
        set is_default = false, updated_at = now()
        where is_default = true and id <> $1
      `,
      [id],
    );
    const result = await client.query(
      `
        update op_applications
        set is_default = true, updated_at = now()
        where id = $1
        returning *
      `,
      [id],
    );
    await client.query('commit');
    return toOpApplicationDto(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function setOpApplicationStatus(pool, id, status) {
  if (!['active', 'disabled'].includes(status)) {
    throw createHttpError(400, '应用状态无效');
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const existingResult = await client.query(
      `select * from op_applications where id = $1 for update`,
      [id],
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      await client.query('rollback');
      return null;
    }
    if (status === 'disabled' && existing.is_default) {
      throw createHttpError(400, '当前默认应用不能停用，请先设置其他默认应用');
    }

    const result = await client.query(
      `
        update op_applications
        set status = $2, updated_at = now()
        where id = $1
        returning *
      `,
      [id, status],
    );
    await client.query('commit');
    return toOpApplicationDto(result.rows[0]);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  createOpApplication,
  getOpApplicationById,
  listActiveOpApplicationOptions,
  listOpApplications,
  setDefaultOpApplication,
  setOpApplicationStatus,
  updateOpApplication,
};
