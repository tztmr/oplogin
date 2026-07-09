function isManagedRecordUidUniqueViolation(error) {
  if (!error) {
    return false;
  }

  const constraintName = String(error.constraint || error.index || '').trim();
  const message = String(error.message || '').trim();

  return (
    error.code === '23505'
    && (
      constraintName === 'idx_records_uid_value_unique_non_empty'
      || message.includes('idx_records_uid_value_unique_non_empty')
    )
  );
}

module.exports = { isManagedRecordUidUniqueViolation };
