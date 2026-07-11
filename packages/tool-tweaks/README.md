# Tool Tweaks

Adjusts Pi's active tools:

- Disables the built-in `read` and `write` tools by default while leaving all other active tools unchanged.
- Provides `view_image`, a small wrapper around the image support from Pi's built-in `read` tool.

The disabled tools can still be enabled later through Pi's tool settings. Use `bash` with `cat` or `sed` to read text files, `view_image` to inspect images, and `edit` to create or modify files without full-file writes.
