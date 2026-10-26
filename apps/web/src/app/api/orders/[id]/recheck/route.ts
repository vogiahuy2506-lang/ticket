import { NextResponse } from 'next/server';
import { API_BASE } from '@/lib/api';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const res = await fetch(`${API_BASE}/api/orders/${id}/recheck`, {
    method: 'POST',
    cache: 'no-store',
  });
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
