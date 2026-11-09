# Contributing

Use a branch and open a pull request describing the behavior change and its validation. Run `npm ci`, `npm run build`, `npm run check`, `npm test` and `npm run check:release` first. The default sample configuration and fictional fixtures must stay runnable without secrets.

Keep guild-specific configuration out of shared code. Edit `branding/templates/` for generated frontend structure; run the branding build and commit both templates and generated output. Do not edit the production identity to make a test pass. Changes to ownership, guild membership, OAuth state, CSRF, origin validation or bot authority require meaningful positive and negative tests.

Never contribute production database files, backups, cookies, provider responses containing private account data or real-member screenshots. Use the read-only demo server and fictional identities for UI evidence. Do not add a development login bypass to the production Worker.

The MIT licence covers contributions to this project. Third-party assets and code must have compatible redistribution permission and attribution. Do not copy Blizzard artwork or someone else's guild branding into the default theme.
