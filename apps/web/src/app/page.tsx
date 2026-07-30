import { redirect } from 'next/navigation';

export default function Home() {
  // The dialer is the only screen the operator starts their day on.
  redirect('/dialer');
}
