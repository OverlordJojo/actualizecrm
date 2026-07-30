import { NextResponse } from 'next/server';
import { searchNumbers, regionOf, TelnyxError } from '@/integrations/telnyx/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;

  try {
    const results = await searchNumbers({
      countryCode: p.get('country') ?? 'US',
      areaCode: p.get('areaCode') ?? undefined,
      state: p.get('state') ?? undefined,
      city: p.get('city') ?? undefined,
      limit: 20,
    });

    return NextResponse.json(
      results.map((n) => {
        const { locality, region } = regionOf(n);
        return {
          phoneNumber: n.phone_number,
          locality,
          region,
          monthlyCost: Number(n.cost_information?.monthly_cost ?? 0),
          upfrontCost: Number(n.cost_information?.upfront_cost ?? 0),
          currency: n.cost_information?.currency ?? 'USD',
        };
      }),
    );
  } catch (err) {
    if (err instanceof TelnyxError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: 'Number search failed.' },
      { status: 500 },
    );
  }
}
