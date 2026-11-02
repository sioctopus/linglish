const { pool } = require('./core');

const REQUEST_COLUMNS = [
  { name: 'video_updated_at', type: 'timestamp with time zone', sql: 'TIMESTAMPTZ' },
  { name: 'resource_revision', type: 'text', sql: 'TEXT' },
];
const MEDIA_INDEXES = [
  { column: 'local_video_path', name: 'idx_video_resources_local_video_path' },
  { column: 'thumbnail_path', name: 'idx_video_resources_thumbnail_path' },
];

function incompatible(field) {
  throw new Error(`VIDEO_PUBLICATION_SCHEMA_INCOMPATIBLE: ${field}`);
}

async function indexedMediaColumns(query) {
  const { rows } = await query(`SELECT DISTINCT a.attname AS column_name
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = 'video_resources'::regclass AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND am.amname = 'btree'
      AND a.attname IN ('local_video_path', 'thumbnail_path')`);
  return new Set(rows.map(row => row.column_name));
}

async function ensureVideoPublicationSchema(query = pool.query.bind(pool)) {
  // Base tables are created by the normal schema bootstrap. Check access before
  // inspecting metadata so missing tables or denied reads cannot appear ready.
  await query('SELECT id FROM video_share_requests LIMIT 0');
  await query('SELECT local_video_path, thumbnail_path FROM video_resources LIMIT 0');
  const { rows } = await query(`SELECT c.relname AS table_name, a.attname AS column_name,
      a.atttypid::regtype::text AS data_type
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE a.attrelid IN ('video_share_requests'::regclass, 'video_resources'::regclass)
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname IN ('video_updated_at', 'resource_revision', 'local_video_path', 'thumbnail_path')`);
  const types = new Map(rows.map(row => [`${row.table_name}.${row.column_name}`, row.data_type]));
  const missing = [];
  for (const column of REQUEST_COLUMNS) {
    const key = `video_share_requests.${column.name}`;
    if (!types.has(key)) missing.push(column);
    else if (types.get(key) !== column.type) incompatible(key);
  }
  for (const index of MEDIA_INDEXES) {
    const key = `video_resources.${index.column}`;
    if (!['text', 'character varying'].includes(types.get(key))) incompatible(key);
  }

  // Complete migrated schemas take only the read-only path. Runtime DDL is
  // limited to missing support, and any ownership/permission failure propagates.
  if (missing.length) {
    await query(`ALTER TABLE video_share_requests ${missing.map(column =>
      `ADD COLUMN IF NOT EXISTS ${column.name} ${column.sql}`).join(', ')}`);
  }
  await query('SELECT video_updated_at, resource_revision FROM video_share_requests LIMIT 0');
  const indexed = await indexedMediaColumns(query);
  const missingIndexes = MEDIA_INDEXES.filter(index => !indexed.has(index.column));
  for (const index of missingIndexes) {
    await query(`CREATE INDEX IF NOT EXISTS ${index.name} ON video_resources (${index.column})`);
  }
  if (missingIndexes.length) {
    const ensured = await indexedMediaColumns(query);
    for (const index of missingIndexes) {
      if (!ensured.has(index.column)) incompatible(`video_resources.${index.column} index`);
    }
  }
}

module.exports = { ensureVideoPublicationSchema };
