# Signing the runtime config

The extension accepts only a P-256-signed envelope at
`https://www.smeshai.xyz/extension-config.json`. Bare JSON and legacy cached
objects are deliberately rejected.

1. Edit a private, bare JSON file. `configVersion` must increase monotonically.
2. Sign it without exposing the key:

   ```sh
   node scripts/sign-runtime-config.mjs config.private.json extension-config.json
   ```

3. Publish only `extension-config.json`. Never publish or commit
   `.secrets/runtime-config-signing-key.pem`; it is ignored by Git and must be
   backed up in the deployment secret store.

The only accepted `homeworkAnchorSelector` values are the exact strings in
`APPROVED_HOMEWORK_SELECTORS` in `src/lib/remote-config.js`. Supporting a new
Mesh DOM shape requires reviewing and shipping that selector in the extension
before remote config can select it.
