# Family Hub

The private record of Phil, Ferique and Gigi, reached through each person's
Grok (or Claude) and a small web app. Stage 1 is live in this code: sign-in,
personal files of preferences, the connector AI apps use, the off switches and
the activity log.

## How it fits together

```
Phil's Grok ─┐
Ferique's Grok ─┼─► /mcp connector ──► Supabase (FamilyHub project)
Gigi's Grok ─┘        │                  every query runs as the signed-in person,
The app (browser) ────┘                  so the database's rules decide access
```

- **Sign-in.** Supabase Auth is the OAuth server. An AI app adds `https://<app>/mcp`
  as a custom connector, is sent to `/oauth/consent`, the person signs in and
  approves, and the AI app gets a token tied to that one person.
- **The connector** (`src/app/mcp/route.ts`) accepts only tokens issued to an AI
  app (they carry a `client_id`), and runs every tool call with that token. It
  holds no master key.
- **The database** (`supabase/migrations/`) enforces who sees and writes what,
  stamps every entry with the door it came through, logs every write, and blocks
  any AI that has been switched off.

## Tools an AI app gets

| Tool | What it does |
| --- | --- |
| `who_am_i` | Which family member this connection is, and what they can do |
| `read_personal_file` | A person's file, as shared with the caller |
| `remember_preference` | Save a confirmed preference (only when told to) |
| `suggest_preference` | Save something noticed, pending the owner's confirmation |
| `confirm_preference` | Confirm a suggestion |
| `retire_preference` | Mark as no longer true; nothing is deleted |
| `update_about` | Replace the About note at the top of a file |

## Rules the database enforces

- Only the three member addresses can ever hold an account.
- You write in your own file; a parent can also write in Gigi's. Gigi's file has no private entries.
- Visibility per entry: family, parents (owner and both parents), private (owner only).
- Suggestions are visible only to the owner (and parents, for Gigi) until confirmed.
- Nothing is deleted. Entries are retired.
- Each AI app is switched on or off per person; a parent can switch off Gigi's, and Gigi cannot switch it back on.
- A parent can turn off all AI access for Gigi at once.
- AI apps cannot connect other AI apps or flip switches; that happens only in the app.

## One-time setup (Supabase dashboard, FamilyHub project)

1. **Authentication → URL Configuration:** Site URL = the app's production address.
2. **Authentication → OAuth Server:** enable it; Authorization Path = `/oauth/consent`;
   allow dynamic client registration (AI apps register themselves).
3. **Authentication → Users → Add user:** create Phil, Ferique and Gigi with a
   password each and "auto confirm". Any other address is refused.

## Connecting Grok

grok.com/connectors → New Connector → Custom → paste `https://<app>/mcp` →
sign in as yourself → Connect. Then ask: "Who am I in Family Hub?"

## Development

```bash
npm install
npm test            # connector and permission tests (no database needed)
npm run typecheck
npm run lint
npm run build
```

The Supabase URL and publishable key in `src/lib/config.ts` are public by
design; override with `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. No secret key is used anywhere.
