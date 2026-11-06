# Agent rules

- This is a local PDF++ fork for textbook notes in Obsidian. Read the
  `Local textbook workflow` section of `README.md` before changing that workflow.
  Extend the existing plugin and native PDF viewer; preserve upstream features.
- Keep notes as ordinary vault Markdown. Preserve note prose, return links,
  manual chapter assignments, and stable chapter IDs when updating annotations
  or indexes. Reject stale writes instead of overwriting newer edits.
- Use physical PDF pages for navigation and matching. Treat `printed_page` as
  a display label. Show students chapter names and clear Chinese labels; keep
  technical IDs and coordinates out of normal UI.
- Store API keys in Obsidian SecretStorage, never plugin settings or logs.
  Use local fixtures and mocked Responses endpoints by default; call live AI
  services only when the user authorizes sending the selected content.
- Edit source files, not generated `main.js`. Keep changes focused and reuse
  existing Obsidian and PDF++ APIs.
- For code changes, run `npm run build`, ESLint on changed TypeScript files,
  and affected tests with `node --test`. For viewer or interaction changes,
  also verify the workflow in Obsidian and report any untested behavior.
- Use the isolated `pdf-plus-path-validation` vault for local deployment and
  manual tests. Deploy to other vaults only when requested.
