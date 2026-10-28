import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';
import { actingUserId } from '@/lib/session-cookie';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // `?gateway=1` asks the payment gateway too (querydr); without it the
  // API only reads the persisted status.
  const askGateway = new URL(req.url).searchParams.get('gateway') === '1';
  // The API checks that the caller owns the order, so the acting user has
  // to travel with the request.
  const userId = await actingUserId();

  const res = await fetch(
    `${API_BASE}/api/orders/${id}/recheck${askGateway ? '?gateway=1' : ''}`,
    {
      method: 'POST',
      headers: userId ? { 'x-tce-user-id': userId } : {},
      cache: 'no-store',
    },
  );
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
