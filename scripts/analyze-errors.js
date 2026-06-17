// Script to analyze error patterns in the database
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const batchId = 'cmqgjx8uh000fr73rxz6516vo';

  console.log('=== Error Message Analysis ===\n');

  // Get error message distribution across all 6 status columns
  const messageCounts = {};
  let totalErrors = 0;

  for (let col = 1; col <= 6; col++) {
    const statusCol = `status${col}`;
    const msgCol = `message${col}`;

    const errors = await prisma.contact.findMany({
      where: { batchId, [statusCol]: 'error' },
      select: { [msgCol]: true },
    });

    for (const e of errors) {
      const msg = e[msgCol] || '(no message)';
      // Normalize the message (truncate long ones)
      const normalized = msg.length > 80 ? msg.substring(0, 80) + '...' : msg;
      messageCounts[normalized] = (messageCounts[normalized] || 0) + 1;
      totalErrors++;
    }
  }

  // Sort by count descending
  const sorted = Object.entries(messageCounts).sort((a, b) => b[1] - a[1]);

  console.log(`Total errors: ${totalErrors}\n`);
  console.log('Top error messages:');
  for (const [msg, count] of sorted.slice(0, 20)) {
    console.log(`  ${count.toString().padStart(6)} | ${msg}`);
  }

  // Also check the speed/rate limit settings
  console.log('\n=== API Key Settings ===');
  const keys = await prisma.apiKey.findMany();
  for (const k of keys) {
    console.log(`  Key ${k.label || k.key.substring(0, 8)}: speed=${k.speedMs}ms, limit=${k.dailyLimit}/day, used=${k.usedToday}`);
  }

  // Check verification timing
  console.log('\n=== Recent Verification Activity ===');
  const recent = await prisma.contact.findFirst({
    where: { batchId, status1: { in: ['valid', 'invalid', 'error'] } },
    orderBy: { id: 'desc' },
  });
  if (recent) {
    console.log(`  Last processed contact: ${recent.firstName} ${recent.lastName} (${recent.domain})`);
    console.log(`  Status: ${recent.status1}, Message: ${recent.message1}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
