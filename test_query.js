import db from './dist/server/db/postgres.js';

async function run() {
  try {
    await db.initDatabase();
    console.log('Database initialized');
    
    const result = await db.query('SELECT id, name, start_time, end_time FROM batches ORDER BY id DESC LIMIT 1');
    const batch = result.rows[0];
    
    if (!batch) {
      console.log('No batches found');
      process.exit(0);
    }
    
    console.log('=== RAW ROW DATA ===');
    console.log('id:', batch.id);
    console.log('name:', batch.name);
    console.log('start_time value:', batch.start_time);
    console.log('start_time type:', typeof batch.start_time);
    console.log('start_time isDate:', batch.start_time instanceof Date);
    
    console.log('=== JSON SERIALIZED ===');
    console.log(JSON.stringify(batch, null, 2));
    
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
