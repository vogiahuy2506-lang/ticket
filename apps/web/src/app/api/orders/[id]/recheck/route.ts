import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // `?gateway=1` asks the payment gateway too (querydr); without it the
  // API only reads the persisted status.
  const askGateway = new URL(req.url).searchParams.get('gateway') === '1';
  const res = await fetch(
    `${API_BASE}/api/orders/${id}/recheck${askGateway ? '?gateway=1' : ''}`,
    {
      method: 'POST',
      cache: 'no-store',
    },
  );
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
