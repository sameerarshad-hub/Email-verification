import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
async function main() {
  const b = await db.batch.findFirst({ orderBy: { createdAt: 'desc' } });
  if (!b) { console.log('No batch'); return; }
  console.log(`Batch: ${b.name}`);
  console.log(`  status: ${b.status}`);
  console.log(`  currentColumn: ${b.currentColumn}`);
  console.log(`  verified: ${b.verifiedEmails} / ${b.totalEmails}`);
  console.log(`  skipped: ${b.skippedEmails}`);
  
  const STATUS_COLS = ['status1','status2','status3','status4','status5','status6'];
  console.log('\nPer-column pending counts:');
  for (let i = 0; i < 6; i++) {
    const pending = await db.contact.count({ where: { batchId: b.id, [STATUS_COLS[i]]: 'pending' } as any });
    const verifying = await db.contact.count({ where: { batchId: b.id, [STATUS_COLS[i]]: 'verifying' } as any });
    console.log(`  col${i+1}: pending=${pending}, verifying=${verifying}`);
  }
  
  const state = await db.verificationState.findUnique({ where: { id: 'main' } });
  console.log(`\nEngine state: isRunning=${state?.isRunning}, batch=${state?.currentBatchId}, col=${state?.currentColumn}`);
  
  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
