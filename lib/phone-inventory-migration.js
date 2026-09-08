const { randomUUID } = require('node:crypto');

const PHONE_INVENTORY_MIGRATION = 'phone_inventory_v1';
const PHONE_MODELS = new Set(['11', '12mini', '14', 'x']);

async function migrateLegacyPhones(pool) {
  const client = await pool.connect();

  try {
    await client.query('begin');
    const marker = await client.query(
      `insert into schema_migrations (name)
       values ($1)
       on conflict (name) do nothing
       returning name`,
      [PHONE_INVENTORY_MIGRATION],
    );
    if (marker.rowCount === 0) {
      await client.query('commit');
      return;
    }

    const legacy = await client.query(`
      select
        id,
        owner_id,
        phone_number,
        phone_sms_url,
        phone_expire_at,
        phone_model,
        phone_connected,
        phone_status,
        created_at,
        updated_at
      from managed_records
      where owner_id is not null and phone_number <> ''
      order by owner_id, phone_number, created_at, id
      for update
    `);

    const groups = new Map();
    for (const row of legacy.rows) {
      const key = `${row.owner_id}\u0000${row.phone_number}`;
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    }

    for (const rows of groups.values()) {
      const canonical = rows.find((row) => row.phone_status === '已绑定') || rows[0];
      const inventoryStatus = canonical.phone_status === '已绑定'
        ? 'bound'
        : 'available';
      const phoneModel = PHONE_MODELS.has(canonical.phone_model)
        ? canonical.phone_model
        : '12mini';

      for (const row of rows) {
        const reasons = ['legacy_phone_migration'];
        if (rows.length > 1) reasons.push('duplicate_owner_phone');
        if (!PHONE_MODELS.has(row.phone_model)) reasons.push('invalid_phone_model');
        await client.query(
          `insert into phone_inventory_legacy_archive (
             id, migration_name, source_record_id, owner_id, phone_number,
             phone_sms_url, phone_expire_at, phone_model, phone_connected,
             phone_status, source_created_at, source_updated_at, archive_reason
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
           )
           on conflict (migration_name, source_record_id) do nothing`,
          [
            randomUUID(),
            PHONE_INVENTORY_MIGRATION,
            row.id,
            row.owner_id,
            row.phone_number,
            row.phone_sms_url,
            row.phone_expire_at,
            row.phone_model,
            row.phone_connected,
            row.phone_status,
            row.created_at,
            row.updated_at,
            reasons.join(','),
          ],
        );
      }

      await client.query(
        `insert into phone_inventory (
           id, owner_id, phone_number, phone_sms_url, phone_expire_at,
           phone_model, status, reserved_record_id, bound_at, created_at,
           updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (owner_id, phone_number) do nothing`,
        [
          randomUUID(),
          canonical.owner_id,
          canonical.phone_number,
          canonical.phone_sms_url,
          canonical.phone_expire_at,
          phoneModel,
          inventoryStatus,
          inventoryStatus === 'bound' ? canonical.id : null,
          inventoryStatus === 'bound' ? canonical.updated_at : null,
          canonical.created_at,
          canonical.updated_at,
        ],
      );

      const unboundRows = rows.filter((row) => row.phone_status !== '已绑定');
      for (const row of unboundRows) {
        await client.query(
          `update managed_records
           set phone_number = '',
               phone_sms_url = '',
               phone_expire_at = null,
               updated_at = now()
           where id = $1`,
          [row.id],
        );
      }
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { migrateLegacyPhones, PHONE_INVENTORY_MIGRATION };
