# integrations/audio

Owns what the **operator** hears while a call is ringing, and the voicemail
recordings that get dropped into a prospect's mailbox.

## What this module does

Waiting through ringing for 7 hours a day is the worst part of cold calling.
This module replaces that with music.

- **Music mode (default, ON)** — Spotify plays from the operator's own library
  while a call rings. On answer, Spotify pauses within 300ms and the call audio
  unmutes. On hangup, Spotify resumes from the exact position it paused at.
- **Ringback mode (OFF)** — a synthesized US ringback tone (440 Hz + 480 Hz,
  2s on / 4s off) generated locally with the Web Audio API.
- **Voicemail recordings** — upload mp3/wav files, mark one default; the dialer
  drops the selected one into a prospect's voicemail with one keystroke.

### Why the ringback is synthesized rather than passed through

Carriers send wildly inconsistent early media — some send a real ringback tone,
some send silence, some send a recorded network message. Generating the tone
locally means the operator hears the identical thing on every single call, and
it can be muted instantly on answer without waiting for the carrier.

### Music can never reach the prospect

This is worth being explicit about, because it is the first thing anyone asks.

Spotify plays through the **local audio output device** — the MacBook's
speakers or headphones. The WebRTC uplink to Telnyx carries **only the
microphone input stream**. They are separate audio paths that are never mixed:
there is no code path in this app that routes playback audio into the outbound
media stream, and the browser's WebRTC stack has no mechanism to pick up
another tab's playback.

The one physical caveat: if the operator runs Spotify through **loudspeakers**
rather than headphones, an open microphone can pick the music up acoustically,
exactly as it would pick up a radio playing in the room. **Use headphones.**
That is a room-acoustics issue, not an app-routing one.

## Env vars this folder owns

| Key | What it is |
| --- | --- |
| `SPOTIFY_CLIENT_ID` | Identifies this app to Spotify |
| `SPOTIFY_CLIENT_SECRET` | Stored for reference; PKCE does not require it |

Non-secret preferences (which playlist, ringback volume, default voicemail) live
in the `Setting` table, not in env.

---

## Setup — click by click

### Spotify (only needed for music mode)

**You need Spotify Premium.** The Web Playback SDK will not play audio on a
free account — this is a Spotify restriction, not something the app can work
around. The app surfaces this in Settings rather than failing quietly.

1. Go to <https://developer.spotify.com/dashboard> and log in with your normal
   Spotify account.
2. Click **Create app**.
3. Fill in:
   - **App name**: `ActualizeCRM`
   - **App description**: anything
   - **Redirect URI**: `http://127.0.0.1:3000/api/spotify/callback`

     Spotify rejects `http://localhost` but allows the loopback IP
     `127.0.0.1`. Use the IP. It must match **exactly** — no trailing
     slash. A mismatch produces
     `redirect_uri: Not matching configuration` on an otherwise blank
     page, which is the single most common setup failure.

     > Do **not** use the cloudflared tunnel here. Quick tunnels get a
     > new hostname on every restart, so the dashboard entry goes stale
     > the moment the tunnel bounces. The loopback address is registered
     > once and then forgotten. The tunnel is only for Telnyx webhooks,
     > which re-register automatically via `npm run tunnel`.

4. Click **Save**.
5. Open the app → **Settings**. Copy the **Client ID** into `.env.local` as
   `SPOTIFY_CLIENT_ID=`.
6. Restart `npm run dev` so it picks up the new value.
7. In the CRM: **Settings → Audio → Connect Spotify**. Approve the permission
   prompt. Then pick a playlist from the dropdown.

Any playlist works, and so do podcast shows — it plays whatever is in the
selected item, in order.

### Voicemail recordings

1. Record your drop message. Voice Memos on the Mac is fine. Keep it under
   about 25 seconds — long voicemails get deleted unheard.
2. Export as `.mp3` or `.wav`.
3. **Settings → Audio → Voicemail recordings → Upload**.
4. Mark one as **Default**. That is the one the `V` hotkey drops.

Files are stored in `data/audio/`, which is gitignored — they are your data,
not part of the repo.

---

## Testing end to end

**1. Ringback tone (no Spotify needed)**
Settings → Audio → toggle **Play music instead of ringing** OFF. Start a dial
session. You should hear a steady two-tone ring, 2 seconds on, 4 seconds off.
Adjust the volume slider and confirm it responds live.

**2. Spotify connects**
Settings → Audio → Connect Spotify. After approving, your playlists appear in
the picker. If you get "INVALID_CLIENT: Invalid redirect URI", the redirect in
the Spotify dashboard does not exactly match
the value of `SPOTIFY_REDIRECT_URI`.

**3. Music pauses on answer** ← the one that matters
1. Music mode ON, playlist selected, **headphones on**.
2. Dial your own cell.
3. Music should start as soon as it begins ringing, and you should hear **no
   ringing at all**.
4. Answer on your cell. Music should stop essentially immediately (within about
   300ms) and you should hear the live call.
5. Talk, confirm both directions.
6. Hang up. Music should resume **from where it stopped**, not from the start
   of the track.

**4. The prospect hears no music**
While on the call from your cell, listen. You should hear only your voice.
If you hear music, you have speakers on rather than headphones — see above.

**5. Fallback behaves**
Disconnect Spotify in Settings while music mode is still ON. Start a call. You
should hear **silence**, not a sudden ringing tone, and Settings should show a
persistent warning banner. Never surprise an operator with unexpected ringing
in their ears.

**6. Voicemail drop**
Dial your own cell and let it go to voicemail. Press `V`. Hang up. Check your
voicemail — your recording should be there, and the dialer should have advanced
to the next lead on its own.
