import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

async function main() {
  // Find which batches have errors
  const batches = await db.batch.findMany({ select: { id: true, name: true, status: true, totalEmails: true, verifiedEmails: true } });
  console.log('=== Batches ===');
  for (const b of batches) {
    console.log(`  ${b.id} | ${b.name} | status=${b.status} | total=${b.totalEmails} | verified=${b.verifiedEmails}`);
  }

  // For each batch, count error statuses across all 6 columns
  console.log('\n=== Error counts per batch ===');
  const STATUS_COLS = ['status1','status2','status3','status4','status5','status6'];
  const MSG_COLS = ['message1','message2','message3','message4','message5','message6'];
  for (const b of batches) {
    let total = 0;
    for (const col of STATUS_COLS) {
      const c = await db.contact.count({ where: { batchId: b.id, [col]: 'error' } } as any);
      total += c;
    }
    console.log(`  ${b.name}: ${total} errors`);
  }

  // For the most-recent batch, get distinct error messages
  console.log('\n=== Distinct error messages (top 20) ===');
  const latestBatch = batches[batches.length - 1];
  if (latestBatch) {
    console.log(`Inspecting batch: ${latestBatch.name} (${latestBatch.id})`);
    const errorMap = new Map<string, number>();
    for (let i = 0; i < 6; i++) {
      const statusCol = STATUS_COLS[i];
      const msgCol = MSG_COLS[i];
      const errors = await db.contact.findMany({
        where: { batchId: latestBatch.id, [statusCol]: 'error' } as any,
        select: { [msgCol]: true } as any,
      });
      for (const e of errors) {
        const msg = (e as any)[msgCol] || '(no message)';
        errorMap.set(msg, (errorMap.get(msg) || 0) + 1);
      }
    }
    const sorted = [...errorMap.entries()].sort((a,b) => b[1] - a[1]);
    for (const [msg, count] of sorted.slice(0, 20)) {
      console.log(`  [${count}] ${msg}`);
    }
  }

  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
