# WorkFlowy to Logseq

This repo contains a browser-side exporter for taking a subtree from WorkFlowy and downloading Markdown pages that are usable in Logseq.

It is intentionally lightweight: you run a single script in the browser console while WorkFlowy is open. There is no CLI or local app wrapper.

## What the current version does

- Reads the current WorkFlowy item and its subtree.
- Creates one Markdown file per direct child of the current item.
- Converts WorkFlowy HTML to Markdown with an embedded browser-side converter.
- Preserves hierarchy as nested Logseq-style bullet blocks.
- Renders completed items as `DONE ...`.
- Preserves WorkFlowy notes as child blocks.
- Downloads inline images as separate files when WorkFlowy exposes an image URL, and rewrites Markdown to point to those local files.
- Detects mirrors and keeps them as explicit readable fallback text.
- Detects WorkFlowy internal links and keeps them as annotated fallback text when a true Logseq block ref is not resolved.

## Current limitations

- Mirrors are not yet converted to true `{{embed ((block-id))}}` syntax.
- Internal WorkFlowy links are not yet converted to true `((block-ref))` syntax.
- The HTML to Markdown conversion is intentionally lightweight and may still need refinement for rare formatting cases.
- Export is browser-driven file download, so assets are downloaded as separate files rather than as a zip archive with folders.

## How to use it

1. Open WorkFlowy in your browser.
2. Navigate to the node you want to export.
3. Open the browser DevTools.
4. Open [`run-in-devtools-in-wf.js`](./run-in-devtools-in-wf.js) in this repo and copy its full contents.
5. Paste the script into the WorkFlowy DevTools console and run it.
6. The script will download one `.md` file per direct child of the current WorkFlowy item.

If the current item has no children, the script exports the current item itself as a single page.

## Output shape

- Each exported file is a Logseq page with a `title::` property at the top.
- Each WorkFlowy item becomes a bullet block.
- Notes are emitted as child blocks below their parent.
- Completed items become `DONE ...`.
- Mirrors are annotated as readable fallback text instead of silently disappearing.

## Why this exists

The goal is still to preserve more WorkFlowy structure than the built-in exporter, especially around mirrors and internal references, while staying easy to run from the browser.
