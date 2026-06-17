import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

async function main() {
  const batch = await db.batch.findFirst({ orderBy: { createdAt: 'desc' } });
  if (!batch) { console.log('No batches'); return; }
  console.log(`Batch: ${batch.name}`);
  console.log(`  totalContacts: ${batch.totalContacts}, totalEmails: ${batch.totalEmails}`);
  console.log(`  verifiedEmails: ${batch.verifiedEmails}, skippedEmails: ${batch.skippedEmails}`);
  console.log(`  status: ${batch.status}, currentColumn: ${batch.currentColumn}`);

  const STATUS_COLS = ['status1','status2','status3','status4','status5','status6'];
  const statusValues = ['valid','invalid','catch-all','no-mx','unverifiable','error','pending','verifying','skipped-catch-all','skipped-no-mx'];

  console.log('\n=== Status breakdown ===');
  for (const sv of statusValues) {
    let total = 0;
    for (const col of STATUS_COLS) {
      if (sv === 'skipped') {
        const c = await db.contact.count({ where: { batchId: batch.id, [col]: { startsWith: 'skipped' } } } as any);
        total += c;
      } else {
        const c = await db.contact.count({ where: { batchId: batch.id, [col]: sv } } as any);
        total += c;
      }
    }
    if (total > 0) console.log(`  ${sv.padEnd(20)} = ${total}`);
  }

  // Sample messages per status
  console.log('\n=== Sample messages for each non-empty status ===');
  const MSG_COLS = ['message1','message2','message3','message4','message5','message6'];
  for (const sv of ['valid','invalid','catch-all','no-mx','unverifiable','error']) {
    let sampleMsg = '';
    for (let i = 0; i < 6 && !sampleMsg; i++) {
      const row = await db.contact.findFirst({
        where: { batchId: batch.id, [STATUS_COLS[i]]: sv } as any,
        select: { [MSG_COLS[i]]: true } as any,
      });
      if (row) sampleMsg = (row as any)[MSG_COLS[i]] || '';
    }
    console.log(`  ${sv.padEnd(20)} | sample: ${sampleMsg}`);
  }

  // Check distinct messages for "error"
  console.log('\n=== Distinct error messages ===');
  const errorMap = new Map<string, number>();
  for (let i = 0; i < 6; i++) {
    const errors = await db.contact.findMany({
      where: { batchId: batch.id, [STATUS_COLS[i]]: 'error' } as any,
      select: { [MSG_COLS[i]]: true } as any,
    });
    for (const e of errors) {
      const msg = (e as any)[MSG_COLS[i]] || '(no message)';
      errorMap.set(msg, (errorMap.get(msg) || 0) + 1);
    }
  }
  const sorted = [...errorMap.entries()].sort((a,b) => b[1] - a[1]);
  console.log(`Total distinct error messages: ${sorted.length}`);
  for (const [msg, count] of sorted.slice(0, 30)) {
    console.log(`  [${count}] ${msg}`);
  }

  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
