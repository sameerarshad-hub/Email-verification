import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET - List all batches
export async function GET() {
  try {
    const batches = await db.batch.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { contacts: true } },
      },
    });
    return NextResponse.json({ batches });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE - Delete a batch
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Batch ID is required' }, { status: 400 });
    }

    await db.contact.deleteMany({ where: { batchId: id } });
    await db.batch.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
