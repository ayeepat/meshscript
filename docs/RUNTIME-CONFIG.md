# Runtime feature switches

The owner changes eight independent switches in `smeshaidashboard`. The VPS
stores the versioned configuration and publishes only the switch values at:

`https://ai.smeshapi.site/public/runtime-config`

The response is a P-256-signed envelope. The extension pins the matching public
key, rejects unsigned, malformed, expired or rolled-back payloads, and refreshes
an accepted value every five minutes while online. The private key is supplied
to the VPS only as `RUNTIME_CONFIG_PRIVATE_KEY_B64`; never commit or expose it
to the dashboard.

The VPS enforces `ai_text`, `ai_images` and `ai_documents` immediately for new
jobs. The extension enforces all eight switches at its message boundary:
AI text, AI images, AI documents, journal attachments, autofill, other-site
solving, telemetry and GDZ.

Operational check after a change:

1. Save once in the dashboard and confirm the revision increased.
2. Open `/public/runtime-config`, decode only for inspection, and verify that
   the signature is still accepted by the extension regression tests.
3. For an AI switch, send a synthetic request with no user content and confirm
   the VPS rejects it before the paid upstream.
4. Record the revision, operator and reason in the change log.

The older manual signer remains useful only for local cryptographic testing; it
is not the production publication path.
