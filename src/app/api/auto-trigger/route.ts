import { NextResponse } from 'next/server';
import { getVerificationEngine } from '@/lib/verification-engine';
import { db } from '@/lib/db';

/**
 * Health-check / keep-alive endpoint.
 * If verification should be running but the engine crashed, this auto-resumes it.
 * Called by the frontend periodically to ensure continuous operation.
 */
export async function GET() {
  try {
    const engine = getVerificationEngine();
    const status = engine.getStatus();

    // If already running, just return status
    if (status.isRunning) {
      return NextResponse.json({
        healthy: true,
        isRunning: true,
        activeKeys: status.activeKeys,
      });
    }

    // Check if there are active API keys
    const keys = await db.apiKey.findMany({ where: { active: true } });
    if (keys.length === 0) {
      return NextResponse.json({
        healthy: true,
        isRunning: false,
        reason: 'No active API keys',
      });
    }

    // Check if there are batches with pending emails
    const batches = await db.batch.findMany({
      where: { status: { in: ['uploaded', 'paused', 'verifying'] } },
      orderBy: { createdAt: 'asc' },
    });

    for (const batch of batches) {
      // Check if batch actually has pending emails
      const STATUS_COLS = ['status1', 'status2', 'status3', 'status4', 'status5', 'status6'];
      let hasPending = false;
      for (const col of STATUS_COLS) {
        const count = await db.contact.count({
          where: { batchId: batch.id, [col]: 'pending' } as any,
        });
        if (count > 0) { hasPending = true; break; }
      }

      if (hasPending) {
        const result = await engine.start(batch.id);
        if (result.success) {
          return NextResponse.json({
            healthy: true,
            resumed: true,
            isRunning: true,
            batchId: batch.id,
            reason: `Auto-resumed batch: ${batch.name}`,
          });
        }
      }
    }

    return NextResponse.json({
      healthy: true,
      isRunning: false,
      reason: 'No batches with pending emails',
    });
  } catch (err: any) {
    return NextResponse.json({ healthy: false, error: err.message }, { status: 500 });
  }
}
