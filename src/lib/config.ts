// Public configuration. The project URL and publishable key are designed to
// be public: every table is locked by row level security, and nothing here
// grants more than signing in does. No secret key is used anywhere in this app.
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://sbocwxnswgjnhmfvbmaq.supabase.co";

export const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_XyvEXx-PZY0vGcz9KRvQTg_xxVG9gfl";

// The OAuth issuer AI apps sign in through.
export const AUTH_ISSUER = `${SUPABASE_URL}/auth/v1`;

// Dates are shown in the family's own time zone.
export const FAMILY_TIME_ZONE = "Australia/Sydney";

// Path of the connector Grok and other AI apps add.
export const CONNECTOR_PATH = "/mcp";
