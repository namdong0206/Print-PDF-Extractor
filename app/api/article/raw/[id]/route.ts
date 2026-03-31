import { NextResponse } from 'next/server';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return new NextResponse(`Raw text for article: ${id}`, {
    headers: { 'Content-Type': 'text/plain' },
  });
}
