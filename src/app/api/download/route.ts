import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { generateCSV } from '@/lib/csv-utils';

const HEADERS = [
  'First Name', 'Last Name', 'Job Title', 'Company', 'Website/Domain',
  'Head Count', 'Industry', 'Location',
  'Email 1 (firstname.lastname)', 'Status 1',
  'Email 2 (firstname)', 'Status 2',
  'Email 3 (lastname)', 'Status 3',
  'Email 4 (firstname.l)', 'Status 4',
  'Email 5 (f.lastname)', 'Status 5',
  'Email 6 (firstnamelastname)', 'Status 6',
];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const { batchId } = await params;

    const batch = await db.batch.findUnique({
      where: { id: batchId },
    });

    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }

    const contacts = await db.contact.findMany({
      where: { batchId },
      orderBy: { id: 'asc' },
    });

    const rows = contacts.map(c => [
      c.firstName, c.lastName, c.jobTitle || '', c.company || '',
      c.domain, c.headCount || '', c.industry || '', c.location || '',
      c.email1 || '', c.status1 || '',
      c.email2 || '', c.status2 || '',
      c.email3 || '', c.status3 || '',
      c.email4 || '', c.status4 || '',
      c.email5 || '', c.status5 || '',
      c.email6 || '', c.status6 || '',
    ]);

    const csv = generateCSV(HEADERS, rows);

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${batch.name.replace('.csv', '')}_verified.csv"`,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
