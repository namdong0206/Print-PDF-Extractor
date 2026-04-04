import { NextResponse } from 'next/server';

export async function GET(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  
  // Simulate fetching task status from Firestore
  console.log(`Fetching status for task: ${taskId}`);

  return NextResponse.json({ taskId, status: 'pending', result: null });
}
