const QUEUE_FIELDS = [
  { key: 'requireGoogleAccount', column: 'queue_require_google_account', defaultValue: true },
  { key: 'requireGooglePassword', column: 'queue_require_google_password', defaultValue: true },
  { key: 'requireOp', column: 'queue_require_op', defaultValue: false },
  { key: 'requireEmptyUid', column: 'queue_require_empty_uid', defaultValue: true },
];

function serializeQueueSettings(row) {
  return Object.fromEntries(QUEUE_FIELDS.map(({ key, column, defaultValue }) => [
    key, row[column] ?? defaultValue,
  ]));
}

// SQL aliases and column names come from internal constants, never user input.
function queueRequirementSql(passwordHashParam, recordAlias = 'm', ownerAlias = 'u') {
  const conditions = [
    `${recordAlias}.google_account != ''`,
    `${recordAlias}.google_password_search_hash != ${passwordHashParam}`,
    `${recordAlias}.op_value != ''`,
    `(${recordAlias}.uid_value = '' or ${recordAlias}.uid_value is null)`,
  ];
  return QUEUE_FIELDS.map(({ column, defaultValue }, index) =>
    `(coalesce(${ownerAlias}.${column}, ${defaultValue}) = false or ${conditions[index]})`,
  );
}

function eligibleRecordSql(passwordHashParam, recordAlias = 'm', ownerAlias = 'u') {
  return queueRequirementSql(passwordHashParam, recordAlias, ownerAlias).join(' and ');
}

async function saveOwnQueueSettings(pool, ownerId, payload) {
  const fields = QUEUE_FIELDS.filter(({ key }) => Object.prototype.hasOwnProperty.call(payload || {}, key));
  if (!fields.length || fields.some(({ key }) => typeof payload[key] !== 'boolean')) {
    throw Object.assign(new Error('队列条件必须为勾选或未勾选'), { statusCode: 400 });
  }
  const assignments = fields.map(({ column }, index) => `${column} = $${index + 2}`);
  const result = await pool.query(
    `update admin_users set ${assignments.join(', ')}, updated_at = now()
     where id = $1 returning *`,
    [ownerId, ...fields.map(({ key }) => payload[key])],
  );
  return serializeQueueSettings(result.rows[0]);
}

module.exports = { eligibleRecordSql, queueRequirementSql, serializeQueueSettings, saveOwnQueueSettings };
