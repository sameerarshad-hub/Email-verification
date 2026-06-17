// Quick check: start server, start verification, wait 30s, check results
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkDb() {
  const batchId = 'cmqgjx8uh000fr73rxz6516vo';
  const STATUS_COLUMNS = ['status1', 'status2', 'status3', 'status4', 'status5', 'status6'];

  console.log('=== Current Database State ===\n');

  // Status breakdown
  const breakdown = {};
  for (const col of STATUS_COLUMNS) {
    for (const status of ['valid', 'invalid', 'catch-all', 'no-mx', 'unverifiable', 'error', 'pending', 'verifying']) {
      const count = await prisma.contact.count({ where: { batchId, [col]: status } });
      breakdown[status] = (breakdown[status] || 0) + count;
    }
    const skipped = await prisma.contact.count({ where: { batchId, [col]: { startsWith: 'skipped' } } });
    breakdown['skipped'] = (breakdown['skipped'] || 0) + skipped;
  }

  console.log('Status Breakdown:');
  for (const [k, v] of Object.entries(breakdown)) {
    console.log(`  ${k}: ${v.toLocaleString()}`);
  }

  // Check error messages if any
  if (breakdown.error > 0) {
    console.log('\nError Messages:');
    const messageCounts = {};
    for (const col of STATUS_COLUMNS) {
      const msgCol = col.replace('status', 'message');
      const errors = await prisma.contact.findMany({
        where: { batchId, [col]: 'error' },
        select: { [msgCol]: true },
      });
      for (const e of errors) {
        const msg = e[msgCol] || '(no message)';
        const normalized = msg.length > 60 ? msg.substring(0, 60) : msg;
        messageCounts[normalized] = (messageCounts[normalized] || 0) + 1;
      }
    }
    const sorted = Object.entries(messageCounts).sort((a, b) => b[1] - a[1]);
    for (const [msg, count] of sorted) {
      console.log(`  ${count.toString().padStart(5)} | ${msg}`);
    }
  }

  // Check pending messages (should show "Retrying after rate limit" if 429s were put back)
  console.log('\nPending Messages (sample):');
  for (const col of STATUS_COLUMNS) {
    const msgCol = col.replace('status', 'message');
    const samples = await prisma.contact.findMany({
      where: { batchId, [col]: 'pending', [msgCol]: { contains: 'Retrying after rate limit' } },
      select: { [msgCol]: true },
      take: 3,
    });
    if (samples.length > 0) {
      console.log(`  Column ${col}: ${samples.length}+ emails with "Retrying after rate limit" message`);
      for (const s of samples.slice(0, 2)) {
        console.log(`    -> ${s[msgCol]}`);
      }
      break;
    }
  }
}

checkDb()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
