require('dotenv').config();
const { Client } = require('pg');

console.log('=== ENV CHECK ===');
console.log('DATABASE_URL set?', !!process.env.DATABASE_URL);
console.log('DATABASE_URL length:', process.env.DATABASE_URL ? process.env.DATABASE_URL.length : 0);
if (process.env.DATABASE_URL) {
  const masked = process.env.DATABASE_URL.replace(/:([^:@]+)@/, ':****@');
  console.log('DATABASE_URL (masked):', masked);
}

const url = process.env.DATABASE_URL.replace(/\?sslmode=require$/, '');
const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  console.log('\n=== CONNECTING ===');
  try {
    await client.connect();
    console.log('✅ Connected');
    const res = await client.query('SELECT NOW() as now, version() as version');
    console.log('   Server time:', res.rows[0].now);
    console.log('   Postgres:', res.rows[0].version.split(',')[0]);
    await client.end();
  } catch (err) {
    console.error('\n❌ Connection failed');
    console.error('   Name:', err.name);
    console.error('   Message:', err.message);
    console.error('   Code:', err.code);
    console.error('   Full error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
    process.exit(1);
  }
})();