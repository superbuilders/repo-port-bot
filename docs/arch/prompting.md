# Prompt Editing

How prompts are structured in this repo, and what might improve next.

## Current architecture

Prompts live in a dedicated provider-agnostic package: `@repo-port-bot/prompts`.

### Layout

```text
packages/prompts/
  src/
    templates/
      decision-system.md     # classifier system prompt
      decision-user.md       # classifier user prompt
      execution-system.md    # execution system prompt
      execution-user.md      # execution user prompt
    render.ts                # template loader + {{slot}} renderer
    sections.ts              # dynamic section renderers (files, retries, mappings, etc.)
    builders.ts              # public builder functions
    index.ts                 # package exports
```

### Three layers

1. **Product prompt intent** -- the `.md` template files. Static instruction text with `{{slot}}` placeholders. Editable as plain markdown.

2. **Prompt assembly** -- `sections.ts` and `builders.ts`. TypeScript renders dynamic sections (changed files, retry feedback, path mappings, naming conventions, plugin instructions) and fills template slots.

3. **Provider adaptation** -- `@repo-port-bot/agent-claude` imports the shared builders and passes rendered text into Claude SDK query options. The provider adds Claude-specific concerns (structured output schema, tool configuration, budget limits) but does not own the prompt wording.

### How editing works today

- To change what the bot says to the LLM, edit a `.md` template file.
- To change what dynamic context is included, edit `sections.ts`.
- To change how sections are composed, edit `builders.ts`.
- Provider-specific changes (tool surface, output format) stay in `agent-claude`.

### Structured output instructions

The execution system prompt (`execution-system.md`) includes instructions for the structured summary the model produces at the end of each attempt. The model is told to:

- End with a `summary` field (one-sentence overview of the port) and a `files` array (per-file descriptions).
- Include all touched files — including non-obvious edits like imports, exports, tests, and config changes.
- Capture uncertainty directly in the summary text when applicable.

The JSON schema enforcing this shape is provider-level concern (`EXECUTE_PORT_OUTPUT_FORMAT` in `agent-claude`), but the prompt wording that tells the model _what makes a good summary_ lives here in the shared templates.

### Testing

The prompts package has its own test suite:

- `render.test.ts` -- template rendering: slot replacement, empty slot removal, newline collapsing, template loading
- `sections.test.ts` -- every dynamic section renderer with edge cases
- `builders.test.ts` -- the four public builder functions with scenario coverage

## What could improve next

### Prompt versioning / snapshots

Snapshot tests for the full rendered output of each prompt scenario would make prompt revisions easier to review in PRs. Today the tests assert "contains this string" which is good for contracts but doesn't show the full picture of what the LLM actually sees.

### Richer template syntax

The current `{{slot}}` renderer is intentionally simple. If prompt complexity grows (conditional blocks, loops, includes), a lightweight template engine could replace it without changing the template file locations.

### Shared fragments

The decision-system and execution-system templates share a large common base (role definition, rules, source context slots). If they diverge further, extracting shared fragments (e.g. `_base-system.md`) could reduce duplication. For now, duplication is accepted to keep each template self-contained and easy to read.

### Provider-specific overlays

If a future provider needs meaningfully different prompt framing (not just different SDK wiring), the architecture supports adding provider-specific template overrides. The shared templates would remain the default; providers could extend or replace individual templates as needed.

## Open questions

- How much prompt customization should `pluginConfig.prompt` be allowed to do relative to the built-in templates?
- Should decision and execution templates share common fragments, or is self-contained duplication preferable for readability?
