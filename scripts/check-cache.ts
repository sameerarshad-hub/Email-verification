import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
async function main() {
  const noMx = await db.domainCache.count({ where: { status: 'no-mx' } });
  const catchAll = await db.domainCache.count({ where: { status: 'catch-all' } });
  const slowMx = await db.domainCache.count({ where: { status: 'slow-mx' } });
  console.log(`DomainCache: no-mx=${noMx}, catch-all=${catchAll}, slow-mx=${slowMx}`);
  
  const b = await db.batch.findFirst({ orderBy: { createdAt: 'desc' } });
  if (b) {
    const contacts = await db.contact.findMany({ where: { batchId: b.id }, select: { domain: true } });
    const uniqueDomains = new Set(contacts.map(c => c.domain.toLowerCase()));
    console.log(`Total unique domains in batch: ${uniqueDomains.size}`);
    
    // How many domains are NOT yet in cache?
    const cached = await db.domainCache.findMany();
    const cachedDomains = new Set(cached.map(c => c.domain));
    const uncached = [...uniqueDomains].filter(d => !cachedDomains.has(d));
    console.log(`Uncached domains (still need checking): ${uncached.length}`);
  }
  
  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
