/**
 * Telling a carrier's robot greeting from a person's own recording.
 *
 * The operator wants to hear voicemails, because whether it is the owner's voice
 * or a front desk decides whether the lead is worth calling back — that is
 * judgement, and it is theirs. What they do not want is the network's default
 * greeting, which carries no information about the business at all.
 *
 * This needs no model. Carrier greetings are a small, fixed set of scripts, and
 * they give themselves away structurally rather than by wording:
 *
 *   - They speak in the **third person** about the person being called: "the
 *     person you are trying to reach", "the wireless customer", "the Google
 *     subscriber". A human recording their own greeting says "I" and "me".
 *   - They **read the number back as digits**, which nobody does about their
 *     own phone.
 *
 * Both greetings say "leave a message after the tone", so that phrase decides
 * nothing and is deliberately not used.
 *
 * When it cannot tell, it says so and the call is played. Hearing one robot is
 * a second wasted; hanging up on a real greeting loses the judgement the
 * operator is there to make.
 */

export type GreetingKind = 'carrier' | 'human' | 'unknown';

/// Third-person phrasing about the callee. No one says these about themselves.
const CARRIER_PHRASES = [
  'the person you are trying to reach',
  'the person you have called',
  'the number you have dialed',
  'the number you have dialled',
  'the subscriber you have dialed',
  'the wireless customer',
  'the google subscriber',
  'the cellular customer',
  'is not available',
  'is unavailable',
  'has a voice mailbox',
  'has not been set up',
  'please record your message',
  'at the tone, please record',
  'is not accepting calls',
  'has been forwarded to an automated',
  'automated voice messaging system',
  'voice messaging system',
  'to page this person',
  'when you have finished recording',
];

/// First-person phrasing. A person recording their own greeting, or a business
/// recording one for itself.
const HUMAN_MARKERS = [
  // "Hey, it's Sarah" — the commonest personal greeting there is, and one no
  // network recording has ever opened with.
  "it's ",
  'this is ',
  "you've reached",
  'you have reached',
  "i'm not",
  'i am not',
  "i'm away",
  "i'm currently",
  'i can not get',
  "i can't get",
  'my phone',
  'get back to you',
  'call you back',
  'leave your name',
  'sorry i missed',
  'thanks for calling',
  'thank you for calling',
  'our office',
  'our business hours',
  'we are currently',
  "we're currently",
  'we will get back',
];

/// Digits spelled out one at a time — a carrier reading the number back.
const SPOKEN_DIGITS =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine)\b(\s+\b(zero|one|two|three|four|five|six|seven|eight|nine)\b){4,}/;

/**
 * Phrases only a network says. These decide on their own, because they can
 * co-occur with first-person wording — "you have reached the voice messaging
 * system for seven zero two…" opens like a person and is not one.
 */
const DECISIVE_CARRIER = [
  // Taken verbatim from transcripts this dialer actually produced. Real speech
  // recognition writes contractions, drops words and mishears — patterns built
  // from how a carrier script reads on paper miss it.
  'the person you called',
  'the person you dialed',
  'the person you dialled',
  "hasn't been set up",
  "has not been set up",
  'voice mailbox',
  'voicemail box',
  'is not set up',
  'mailbox is full',
  'not accepting messages',
  // Menus. An IVR is not a mailbox and there is nobody to leave a message for;
  // hearing one tells the operator only that they have not reached a person.
  'press one',
  'press 1',
  'press two',
  'press 2',
  'press pound',
  'press star',
  'for english',
  'para espanol',
  'para español',
  'main menu',
  'menu options',
  'listen carefully as our options',
  'your call is very important',
  'your call is important to us',
  'all of our representatives',
  'the next available representative',
  'to speak to a representative',
  'to speak with someone',
  'dial the extension',
  "if you know your party's extension",
  'voice messaging system',
  'automated voice messaging',
  'the person you are trying to reach',
  'the person you have called',
  'the wireless customer',
  'the google subscriber',
  'the cellular customer',
  'has a voice mailbox',
  'has not been set up',
];

/**
 * Openings that give a recording away before it finishes its first sentence.
 *
 * Matched as prefixes against a partial transcript, because that is the whole
 * point: a greeting is recognisable from its first few words and there is no
 * reason to sit through the rest. "The person you're trying to reach" is
 * decided four words in.
 */
const CARRIER_OPENINGS = [
  'the person you',
  'leave a message because',
  'the party you',
  'the number you',
  'the subscriber you',
  'the wireless customer',
  'the cellular customer',
  'the google subscriber',
  'your call has been forwarded',
  'you have reached the voice',
  'welcome to the',
  'thank you for calling. your call',
  'please leave your message for',
  'at the tone',
  'record your message',
  'press one',
  'press 1',
  'for english',
  'para espanol',
  'para español',
];

export function classifyGreeting(transcript: string): GreetingKind {
  const text = transcript.toLowerCase().replace(/\s+/g, ' ').trim();

  // Decided as early as possible. Eight characters is enough for "the person",
  // and holding out for a full sentence means holding the operator on the line
  // through the whole recording.
  if (CARRIER_OPENINGS.some((o) => text.startsWith(o) || text.includes(o))) {
    return 'carrier';
  }

  if (text.length < 8) return 'unknown';

  // Reading the number back, one digit at a time. Nobody does this about their
  // own phone, so it settles the question by itself.
  if (SPOKEN_DIGITS.test(text)) return 'carrier';
  if (DECISIVE_CARRIER.some((p) => text.includes(p))) return 'carrier';

  const humanHits = HUMAN_MARKERS.filter((m) => text.includes(m)).length;
  const carrierHits = CARRIER_PHRASES.filter((p) => text.includes(p)).length;

  // A greeting naming the business is worth hearing even if it also uses a
  // stock phrase — plenty of real greetings say "is not available" about a
  // colleague. First-person wins ties.
  if (humanHits > 0 && humanHits >= carrierHits) return 'human';
  if (carrierHits > 0) return 'carrier';
  return 'unknown';
}

/**
 * How long to listen before deciding.
 *
 * Long enough for a greeting to identify itself, short enough that a robot is a
 * brief annoyance rather than a wait. A carrier greeting names itself in its
 * first sentence.
 */
export const GREETING_DECISION_MS = 4000;

/**
 * Pulls a person's name out of a voicemail greeting.
 *
 * A name is the strongest signal there is. A carrier recording never says one,
 * so hearing one settles both questions at once: this is a real mailbox, and
 * there is a person behind it worth calling back.
 *
 * Deliberately conservative. A wrong name written onto a lead is worse than no
 * name — the operator will greet somebody by the wrong name on the callback,
 * which is a worse first impression than not knowing it. So it only accepts a
 * name in a position where nothing else fits, and rejects anything that looks
 * like a company, a role, or a stray word.
 */

/// Openings where whatever follows is the speaker's own name.
const NAME_PATTERNS: RegExp[] = [
  /\byou(?:'ve| have) reached (?:the (?:desk|office) of )?([a-z]+(?: [a-z]+)?)\b/i,
  /\bthis is ([a-z]+(?: [a-z]+)?)\b/i,
  /\b(?:hi|hey|hello),? (?:it'?s|this is) ([a-z]+(?: [a-z]+)?)\b/i,
  /\b([a-z]+(?: [a-z]+)?) speaking\b/i,
  /\byou(?:'ve| have) reached ([a-z]+(?: [a-z]+)?)'s (?:phone|voicemail|mobile|cell)\b/i,
];

/// Words that are never a person's first name in this position. Mostly the
/// beginnings of company names and roles, which is what the patterns above
/// otherwise catch.
const NOT_A_NAME = new Set([
  'the', 'a', 'an', 'our', 'my', 'your', 'their', 'his', 'her',
  'voicemail', 'voice', 'mail', 'mailbox', 'office', 'desk', 'phone', 'mobile',
  'cell', 'number', 'line', 'company', 'business', 'team', 'department',
  'sales', 'support', 'service', 'services', 'reception', 'front', 'main',
  'customer', 'client', 'accounts', 'billing', 'dispatch', 'scheduling',
  'not', 'no', 'sorry', 'thanks', 'thank', 'please', 'leave', 'after', 'at',
  'we', 'us', 'me', 'i', 'you', 'it', 'and', 'but', 'so', 'is', 'are',
  'currently', 'unavailable', 'available', 'away', 'out', 'here', 'there',
  // Prepositions and conjunctions. The two-word capture greedily takes these —
  // "you've reached Josh at Modern Landscape" yields "Josh at" — so a second
  // word from this set is dropped and the first is kept.
  'at', 'from', 'with', 'of', 'on', 'in', 'for', 'to', 'by', 'and', 'or',
]);

/// Suffixes that mark the match as a company rather than a person.
const COMPANY_WORDS = new Set([
  'inc', 'llc', 'ltd', 'corp', 'co', 'company', 'group', 'services', 'service',
  'solutions', 'systems', 'landscape', 'landscaping', 'paving', 'construction',
  'plumbing', 'roofing', 'electric', 'hvac', 'realty', 'properties', 'law',
  'dental', 'medical', 'clinic', 'salon', 'studio', 'associates', 'partners',
]);

export interface GreetingName {
  firstName: string;
  lastName: string | null;
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

export function extractGreetingName(transcript: string): GreetingName | null {
  const text = transcript.replace(/\s+/g, ' ').trim();
  if (text.length < 8) return null;

  for (const pattern of NAME_PATTERNS) {
    const m = pattern.exec(text);
    if (!m?.[1]) continue;

    const words = m[1].trim().split(' ').filter(Boolean);
    if (words.length === 0 || words.length > 2) continue;

    let lower = words.map((w) => w.toLowerCase().replace(/[^a-z']/g, ''));

    // A second word that is a preposition belongs to what follows the name, not
    // to the name. Keep the first rather than discarding a good match.
    if (lower.length === 2 && NOT_A_NAME.has(lower[1])) lower = [lower[0]];

    if (lower.some((w) => w.length < 2 || NOT_A_NAME.has(w))) continue;
    if (lower.some((w) => COMPANY_WORDS.has(w))) continue;

    return {
      firstName: titleCase(lower[0]),
      lastName: lower[1] ? titleCase(lower[1]) : null,
    };
  }

  return null;
}


/**
 * The signal that needs neither words nor tone: **recordings do not stop.**
 *
 * A person who picks up says a short thing and waits — "Hello?", "Bob
 * speaking", four or five words and then silence, because they are expecting an
 * answer. A recording delivers its whole script without yielding, because it is
 * not expecting anything.
 *
 * That difference is behavioural, so it survives everything that defeats the
 * other two detectors. It does not care what language the greeting is in,
 * whether the voice is synthetic or a person who recorded themselves years ago,
 * whether the transcript is garbled, or whether the carrier uses wording nobody
 * has added to a list. A convincing human-sounding recording still monologues.
 *
 * It is the same insight AMD uses acoustically, applied to the timeline instead
 * — and because it is measured from transcript arrival rather than audio, it
 * catches the cases where AMD's acoustic judgement went the wrong way.
 *
 * Deliberately generous. Someone answering with a long "Hello, this is Josh
 * over at Modern Landscape, how can I help you?" is a real person taking six
 * seconds, so the threshold sits well past anything a person says in one
 * breath while still landing far inside a carrier greeting.
 */
export const MONOLOGUE_SECONDS = 7;
export const MONOLOGUE_WORDS = 22;

export interface SpeechShape {
  /// Seconds the far end has been speaking since they answered.
  speakingSeconds: number;
  /// Words they have produced in that time.
  words: number;
  /// True once the operator has said anything — after which this test is moot,
  /// because a conversation is underway.
  operatorSpoke: boolean;
}

export function isMonologue(shape: SpeechShape): boolean {
  if (shape.operatorSpoke) return false;
  return (
    shape.speakingSeconds >= MONOLOGUE_SECONDS || shape.words >= MONOLOGUE_WORDS
  );
}
