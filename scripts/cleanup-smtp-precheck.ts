import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

async function main() {
  const STATUS_COLS = ['status1','status2','status3','status4','status5','status6'];
  const MSG_COLS = ['message1','message2','message3','message4','message5','message6'];
  
  // 1. Reset contacts marked by SMTP pre-check back to pending
  let resetCount = 0;
  for (let i = 0; i < 6; i++) {
    // Reset contacts with "SMTP server unreachable (pre-check)" message
    const r1 = await db.contact.updateMany({
      where: { [MSG_COLS[i]]: 'SMTP server unreachable (pre-check)' } as any,
      data: { [STATUS_COLS[i]]: 'pending', [MSG_COLS[i]]: null },
    });
    resetCount += r1.count;
  }
  console.log(`Reset ${resetCount} contacts from SMTP pre-check back to pending`);
  
  // 2. Count current slow-mx domains in cache
  const slowMxCount = await db.domainCache.count({ where: { status: 'slow-mx' } });
  console.log(`Current slow-mx domains in cache: ${slowMxCount}`);
  
  // 3. Delete ALL slow-mx entries from DomainCache — the engine will re-detect
  // them reliably through actual API timeouts (port 25 is blocked on our server,
  // so the SMTP pre-check approach doesn't work)
  const deleted = await db.domainCache.deleteMany({ where: { status: 'slow-mx' } });
  console.log(`Deleted ${deleted.count} slow-mx entries from DomainCache`);
  
  // 4. Also reset contacts marked as skipped-slow-mx by the engine (during verification)
  // back to pending, since we deleted the cache entries
  let engineReset = 0;
  for (let i = 0; i < 6; i++) {
    const r = await db.contact.updateMany({
      where: { [STATUS_COLS[i]]: 'skipped-slow-mx' } as any,
      data: { [STATUS_COLS[i]]: 'pending', [MSG_COLS[i]]: null },
    });
    engineReset += r.count;
  }
  console.log(`Reset ${engineReset} engine-marked skipped-slow-mx contacts back to pending`);
  
  // 5. Show current state
  const batch = await db.batch.findFirst({ orderBy: { createdAt: 'desc' } });
  if (batch) {
    console.log(`\nBatch: ${batch.name}`);
    console.log(`  status: ${batch.status}`);
    console.log(`  verified: ${batch.verifiedEmails} / ${batch.totalEmails}`);
    console.log(`  skipped: ${batch.skippedEmails}`);
    
    const noMx = await db.domainCache.count({ where: { status: 'no-mx' } });
    const catchAll = await db.domainCache.count({ where: { status: 'catch-all' } });
    console.log(`\nDomainCache: no-mx=${noMx}, catch-all=${catchAll}, slow-mx=0 (cleared)`);
  }
  
  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
