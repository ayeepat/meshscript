# Signing the runtime config

The extension accepts only a P-256-signed envelope at
`https://smeshai.xyz/extension-config.json`. Bare JSON and legacy cached
objects are deliberately rejected.

**Publish at the apex host, not `www.`.** The site 301-redirects every
`www.smeshai.xyz` request to the apex, and `fetchFresh()` in
`src/lib/remote-config.js` uses `redirect: 'error'` on purpose — a `www.` URL
can therefore never resolve, whatever is published behind it. The URL in
`src/lib/config.js` and the `host_permissions` entry in `manifest.json` must
keep naming that same apex origin; `tests/runtime-config-host-regression.mjs`
fails the build if they drift apart.

1. Edit a private, bare JSON file. `configVersion` must increase monotonically.
   Include signed integer millisecond timestamps `issuedAt` and `expiresAt`;
   validity may be at most seven days, so publish a newly signed config at
   least weekly. Reusing a version with different content is rejected.
2. Sign it without exposing the key:

   ```sh
   node scripts/sign-runtime-config.mjs config.private.json extension-config.json
   ```

3. Publish only `extension-config.json`. Never publish or commit
   `.secrets/runtime-config-signing-key.pem`; it is ignored by Git and must be
   backed up in the deployment secret store.

The signer refuses non-P-256 keys, keys that do not match the public key pinned
in `src/lib/config.js`, and any output path that aliases the input or private
key. It self-verifies the signature before atomically replacing the named
output file.

The only accepted `homeworkAnchorSelector` values are the exact strings in
`APPROVED_HOMEWORK_SELECTORS` in `src/lib/remote-config.js`. Supporting a new
Mesh DOM shape requires reviewing and shipping that selector in the extension
before remote config can select it.

Notice links are limited to `smeshai.xyz`, `www.smeshai.xyz`, and the Chrome
Web Store. Adding a destination requires an extension release and review; a
signed config cannot introduce an arbitrary link.
