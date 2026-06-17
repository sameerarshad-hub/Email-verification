import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

async function main() {
  // Mark the known stuck emails as unverifiable so the engine doesn't loop on them
  const stuckEmails = [
    'tino.millar@moveai.tech',
    'taimoor.shah@techsurge.co.uk',
    'rachid.talidi@ibism.co.uk',
    'alessandro.carmelita@quantabusiness.com',
  ];
  const STATUS_COLS = ['status1','status2','status3','status4','status5','status6'];
  const MSG_COLS = ['message1','message2','message3','message4','message5','message6'];
  const EMAIL_COLS = ['email1','email2','email3','email4','email5','email6'];

  let totalMarked = 0;
  for (const email of stuckEmails) {
    for (let i = 0; i < 6; i++) {
      const r = await db.contact.updateMany({
        where: { [EMAIL_COLS[i]]: email, [STATUS_COLS[i]]: { in: ['pending', 'verifying'] } } as any,
        data: { [STATUS_COLS[i]]: 'unverifiable', [MSG_COLS[i]]: 'Pre-marked: domain times out with MailTester' },
      });
      totalMarked += r.count;
    }
    console.log(`Marked ${email}`);
  }
  console.log(`Total: ${totalMarked} records marked unverifiable`);
  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
