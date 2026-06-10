# Icons

Place `icon16.png`, `icon48.png`, and `icon128.png` here.

These are referenced by `manifest.json`. Any square PNGs of the right sizes
work. The extension will fail to load in Chrome if these files are missing,
so add them before loading the unpacked extension (or remove the `icons` and
`action.default_icon` keys from the manifest while testing).
