const { Client } = require('pg');
const { decodeHtmlEntities } = require('../services/reading-subtitles');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('请先设置 DATABASE_URL');
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const found = await client.query(
      "SELECT id, title, content FROM articles WHERE content LIKE '%&#x%' OR content LIKE '%&#%'"
    );
    console.log('articles with entities', found.rows.length);
    for (const row of found.rows) {
      const next = decodeHtmlEntities(row.content);
      if (next === row.content) {
        console.log('skip', row.id, row.title);
        continue;
      }
      await client.query('UPDATE articles SET content = $1 WHERE id = $2', [next, row.id]);
      const left = (next.match(/&#x[0-9a-f]+;/gi) || []).length;
      console.log('repaired', row.id, row.title, 'remaining', left);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
