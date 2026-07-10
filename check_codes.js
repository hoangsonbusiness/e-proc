import db from './dist/server/db/postgres.js';

async function run() {
  try {
    await db.initDatabase();
    
    // Find all access codes that are used more than once
    const duplicates = await db.query(`
      SELECT access_code, COUNT(*), string_agg(id::text || ' (batch:' || batch_id::text || ', status:' || status || ')', ', ') as details
      FROM students
      GROUP BY access_code
      HAVING COUNT(*) > 1
    `);
    
    console.log('=== DUPLICATE ACCESS CODES ===');
    console.log('Count of duplicates:', duplicates.rows.length);
    duplicates.rows.forEach(row => {
      console.log(`Code: ${row.access_code} | Count: ${row.count} | Details: ${row.details}`);
    });

  } catch (err) {
    console.error('Error:', err);
  } finally {
    const pool = db.getPool();
    if (pool && typeof pool.end === 'function') {
      await pool.end();
    }
    process.exit(0);
  }
}

run();
