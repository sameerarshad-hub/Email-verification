import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET - List all API keys
export async function GET() {
  try {
    const keys = await db.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
    });
    // Mask keys for security - show first 8 and last 4 chars
    const masked = keys.map(k => ({
      ...k,
      key: k.key.length > 12 ? k.key.substring(0, 8) + '****' + k.key.substring(k.key.length - 4) : '****',
      fullKeyLength: k.key.length,
    }));
    return NextResponse.json({ keys: masked });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST - Add a new API key
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { key, label, speedMs, dailyLimit } = body;

    if (!key) {
      return NextResponse.json({ error: 'API key is required' }, { status: 400 });
    }

    const apiKey = await db.apiKey.create({
      data: {
        key: key.trim(),
        label: label?.trim() || null,
        speedMs: speedMs || 900,
        dailyLimit: dailyLimit || 86000,
        usedToday: 0,
        lastResetDate: new Date().toISOString().split('T')[0],
        active: true,
      },
    });

    return NextResponse.json({ success: true, apiKey });
  } catch (err: any) {
    if (err.code === 'P2002') {
      return NextResponse.json({ error: 'This API key already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// PUT - Update an API key
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, label, speedMs, dailyLimit, active } = body;

    if (!id) {
      return NextResponse.json({ error: 'API key ID is required' }, { status: 400 });
    }

    const updateData: any = {};
    if (label !== undefined) updateData.label = label;
    if (speedMs !== undefined) updateData.speedMs = speedMs;
    if (dailyLimit !== undefined) updateData.dailyLimit = dailyLimit;
    if (active !== undefined) updateData.active = active;

    const apiKey = await db.apiKey.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({ success: true, apiKey });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE - Remove an API key
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'API key ID is required' }, { status: 400 });
    }

    await db.apiKey.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
