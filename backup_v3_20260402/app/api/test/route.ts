import { NextResponse } from 'next/server';

export async function GET() {
  return new NextResponse('Test API Route', {
    headers: { 'Content-Type': 'text/plain' },
  });
}
