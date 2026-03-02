# Workspace CLI Examples (Non-Interactive)

All examples assume you are at the `hbot` repo root.

## Create a package

```bash
bun workspace create @hbot/feature-flags
```

## Remove a package without confirmation

```bash
bun workspace remove feature-flags --yes
```

## List all workspace packages

```bash
bun workspace list
```

## Clean build artifacts

```bash
bun workspace clean
```

## Clean everything including node_modules

```bash
bun workspace clean --all
```

## Typical automation sequence

```bash
bun workspace create @hbot/new-lib
bun run build
bun run check
```
