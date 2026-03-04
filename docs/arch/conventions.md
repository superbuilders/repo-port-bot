# Engine Conventions

Codebase-wide patterns and policies that apply across all engine modules.

## Boundary decoding

Runtime validation for untrusted inputs lives in dedicated decoder modules, not in core protocol type files.

- Protocol/domain types remain in `packages/engine/src/types.ts`
- Boundary decoders live alongside adapters (for example
  `packages/engine/src/config/port-bot-json.decoder.ts`)
- Engine stages consume decoded values only (`unknown` is handled at the edge)

This keeps type definitions clean while making parsing and validation explicit. We use [decoders](https://decoders.cc) for runtime validation at boundaries.
