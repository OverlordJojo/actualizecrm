import { NextResponse } from 'next/server';
import { loadBoard } from '@/lib/board';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const pipelineId =
    new URL(request.url).searchParams.get('pipelineId') ?? undefined;

  const board = await loadBoard(pipelineId);
  if (!board) {
    return NextResponse.json(
      { error: 'No pipelines yet. Run `npm run db:seed`.' },
      { status: 404 },
    );
  }

  return NextResponse.json(board);
}
