# Live screen monitor: Supabase signaling + WebRTC P2P

This feature sends **no video through Vercel or Supabase**. The student browser reuses the existing recorder screen-share track and sends it directly to the admin browser with WebRTC. Supabase Realtime carries only SDP/ICE/hangup messages on a private channel. By default it is P2P-only, with public STUN discovery and no TURN account.

## Limits built into this implementation

- Only `admin` can open `/admin/batches/:id/live`; `mod` is rejected by the backend.
- A candidate publisher serves one viewer at a time; an admin page also opens one viewer at a time.
- A viewer token lasts 10 minutes, is scoped to one opaque candidate-attempt topic, and has no database/Supabase service-role privilege.
- Each view request and end outcome is stored in `live_monitor_audit`. The raw attempt JTI is hashed.
- If live configuration is unavailable, the exam continues. Without TURN, restrictive corporate/mobile networks may be impossible to view live; this never interrupts the exam.

## Vercel environment variables

Set these only in the Vercel server environment; do not prefix any of them with `VITE_` and do not commit them:

```text
LIVE_MONITORING_ENABLED=true
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_REALTIME_PRIVATE_KEY_BASE64=<base64 of the ES256 private JWK>
SUPABASE_REALTIME_JWT_KEY_ID=<the JWK kid>
```

The browser receives only an expiring Supabase Realtime token. It never receives the Supabase signing private key.

## One-time Supabase setup

1. Generate an ES256 private JWK with `supabase gen signing-key --algorithm ES256`; keep that output private. In Supabase Dashboard → Auth → JWT Signing Keys, create/import that JWK as a standby key, then rotate it to active. Put its `kid` in `SUPABASE_REALTIME_JWT_KEY_ID` and base64-encode the full private JWK JSON for `SUPABASE_REALTIME_PRIVATE_KEY_BASE64`. This lets Supabase validate server-minted Realtime JWTs without sharing a service-role key with the browser.
2. Run `migrations/20260828_live_monitoring.sql` in the same Supabase database used by the app. It creates the audit table and scoped `realtime.messages` broadcast policies. Do **not** add `ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY`: Supabase already enables it and blocks ALTER operations on its managed Realtime table.
3. Keep Realtime enabled. The client uses private broadcast channels only; it does not use presence or database change feeds.

## TURN is deliberately not configured

Open Relay's current 20 GB plan asks for card details for identity/abuse verification. It therefore does **not** satisfy the project's no-card requirement and its credentials are intentionally omitted. The code still supports optional TURN credentials later, but P2P is the deployed default. If a candidate network blocks P2P, the admin will see a connection failure rather than a fallback relay; the candidate's exam and recording continue normally.
