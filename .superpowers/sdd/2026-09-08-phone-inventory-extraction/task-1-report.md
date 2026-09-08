# Task 1 report: phone inventory schema and migration

## Changes

- Added `phone_inventory` with owner-scoped phone uniqueness, allowed model/status checks, nullable record/slot history references, FIFO lookup index, full owner/record history index, and a partial unique active-reservation index.
- Added `schema_migrations` and the atomic one-time marker `phone_inventory_v1`.
- Added `phone_inventory_legacy_archive`, which snapshots every owned legacy phone row before any projection is cleared. It has no business-record foreign key so archived history survives later record deletion.
- Added a transactional legacy migration using fresh UUIDs. It deterministically prefers the oldest bound row for duplicate owner/number groups, leaves all bound projections and ownerless rows unchanged, preserves duplicate rows in the archive, and clears only owned unbound phone number/URL/expiry projections after inventory preservation.
- Added schema and true pre-marker migration coverage, including duplicate bound rows, bound-over-unbound precedence, ownerless preservation, fresh IDs, rerun idempotence, constraints, owner isolation, and terminal history survival.

## TDD evidence

- RED: `node --test test/schema-and-crypto.test.js` — 6 passed, 2 failed because `phone_inventory` did not exist.
- GREEN: `node --test test/schema-and-crypto.test.js` — 8 passed, 0 failed.
- Final verification: `node --test test/schema-and-crypto.test.js` — 8 passed, 0 failed; duration 252.929 ms.
- Diff check: `git diff --check` for the owned schema, migration, and test files produced no errors.

## Commit

- `cf1bc33 feat: add isolated phone inventory schema`

## Concerns / integration notes

- pg-mem incorrectly uses the reserved-only partial index for some later bound-history lookups. The production schema includes `idx_phone_inventory_owner_record`; correctness of these lookups and PostgreSQL `ON DELETE SET NULL` behavior should be confirmed by the parent task's real PostgreSQL integration run.
- For duplicate legacy bound records, one deterministic canonical record is referenced by `phone_inventory.reserved_record_id`. Every additional bound record remains permanently discoverable via `phone_inventory_legacy_archive.source_record_id` with `phone_status = '已绑定`; irreversible-bound checks should consult this archive fallback.
