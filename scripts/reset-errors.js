// Script to reset all error emails back to pending
// (so the new retry logic can process them properly)
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const batchId = 'cmqgjx8uh000fr73rxz6516vo';
  const STATUS_COLUMNS = ['status1', 'status2', 'status3', 'status4', 'status5', 'status6'];

  console.log('=== Resetting error emails back to pending ===\n');

  // First, show the breakdown of error messages
  const messageCounts = {};
  let totalErrors = 0;

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
      totalErrors++;
    }
  }

  console.log(`Found ${totalErrors} error emails:`);
  const sorted = Object.entries(messageCounts).sort((a, b) => b[1] - a[1]);
  for (const [msg, count] of sorted) {
    console.log(`  ${count.toString().padStart(5)} | ${msg}`);
  }

  // Reset all errors back to pending
  let resetCount = 0;
  for (const col of STATUS_COLUMNS) {
    const result = await prisma.contact.updateMany({
      where: { batchId, [col]: 'error' },
      data: { [col]: 'pending' },
    });
    resetCount += result.count;
  }

  console.log(`\n✅ Reset ${resetCount} error emails back to pending.`);
  console.log('They will be retried automatically with the new rate-limit handling.');

  // Show final status breakdown
  console.log('\n=== Final Status Breakdown ===');
  const breakdown = {};
  for (const col of STATUS_COLUMNS) {
    for (const status of ['valid', 'invalid', 'catch-all', 'no-mx', 'unverifiable', 'error', 'pending', 'verifying']) {
      const count = await prisma.contact.count({ where: { batchId, [col]: status } });
      breakdown[status] = (breakdown[status] || 0) + count;
    }
    // Count skipped
    const skipped = await prisma.contact.count({ where: { batchId, [col]: { startsWith: 'skipped' } } });
    breakdown['skipped'] = (breakdown['skipped'] || 0) + skipped;
  }
  for (const [k, v] of Object.entries(breakdown)) {
    console.log(`  ${k}: ${v.toLocaleString()}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
