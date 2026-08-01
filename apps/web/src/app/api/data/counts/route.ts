import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const [contacts, calls, activities, bookings, messages, emails] = await Promise.all([
    db.contact.count(),
    db.call.count(),
    db.activity.count(),
    db.booking.count(),
    db.message.count(),
    db.emailMessage.count(),
  ]);
  return NextResponse.json({ contacts, calls, activities, bookings, messages, emails });
}
