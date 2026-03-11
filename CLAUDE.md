# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Immich is a self-hosted photo and video management platform. It's a monorepo with these main components:

| Component | Directory | Stack |
|-----------|-----------|-------|
| **Server** | `server/` | NestJS 11, TypeScript, Kysely ORM, PostgreSQL |
| **Web** | `web/` | SvelteKit, Svelte 5, Vite 7, Tailwind CSS 4 |
| **Mobile** | `mobile/` | Flutter/Dart, Riverpod |
| **Machine Learning** | `machine-learning/` | Python, FastAPI, ONNX Runtime |
| **CLI** | `cli/` | TypeScript, Commander.js |
| **TypeScript SDK** | `open-api/typescript-sdk/` | Auto-generated from OpenAPI spec |

## Common Commands

**Package manager**: pnpm (v10.30+). Node 24.13.1. All JS/TS workspaces managed via `pnpm-workspace.yaml`.

### Development Environment

```bash
make dev                  # Start full dev environment with Docker Compose (hot-reload)
make dev-update           # Rebuild and start dev containers
make dev-down             # Stop dev environment
```

### Building

```bash
make build-server         # Build server (NestJS)
make build-web            # Build web (depends on SDK)
make build-cli            # Build CLI (depends on SDK)
make build-sdk            # Build TypeScript SDK
make build-all            # Build all packages
```

Note: `build-web` and `build-cli` depend on `build-sdk` — the SDK must be built first.

### Testing

```bash
# Server unit tests
pnpm --filter immich run test                # Run all server tests (watch mode)
pnpm --filter immich run test -- --run       # Run once (CI mode)
# Run a single server test file:
pnpm --filter immich run test -- --run src/services/album.service.spec.ts

# Web tests
pnpm --filter immich-web run test            # Web unit tests
pnpm --filter immich-web run test -- --run

# CLI tests
pnpm --filter @immich/cli run test

# E2E tests (requires Docker)
make e2e                                     # Start E2E environment
make test-e2e                                # Run E2E tests

# Medium integration tests (requires Docker)
make test-medium

# All tests
make test-all

# Machine learning tests
cd machine-learning && pytest
```

### Linting & Formatting

```bash
make lint-all             # Fix lint issues across all packages
make format-all           # Format all code with Prettier
make check-all            # Type-check all packages (tsc, svelte-check)
make hygiene-all          # All of the above plus SQL sync

# Per-package
pnpm --filter immich run lint:fix            # Server lint
pnpm --filter immich-web run lint:fix        # Web lint
pnpm --filter immich run check              # Server type-check
pnpm --filter immich-web run check:svelte   # Svelte check
pnpm --filter immich-web run check:typescript  # Web TS check
```

Prettier config: 120 char line width, single quotes, semicolons.

### Code Generation

```bash
make open-api             # Regenerate OpenAPI spec + all SDKs
make open-api-typescript  # Regenerate TypeScript SDK only
make open-api-dart        # Regenerate Dart SDK only
make sql                  # Regenerate SQL query reference files (server/src/queries/)
```

After changing server controllers/DTOs, run `make open-api` to update the spec and SDKs. After changing repository queries decorated with `@GenerateSql()`, run `make sql`.

### Database Migrations

```bash
# Default DB: postgres://postgres:postgres@localhost:5432/immich
pnpm --filter immich run migrations:generate  # Generate migration from schema changes
pnpm --filter immich run migrations:run       # Apply pending migrations
pnpm --filter immich run migrations:revert    # Rollback last migration
pnpm --filter immich run schema:reset         # Drop and recreate schema
```

## Architecture

### Server (NestJS)

Three-tier architecture per domain:

```
Controller → Service → Repository → Kysely/PostgreSQL
```

- **Controllers** (`server/src/controllers/`): HTTP handlers with `@Authenticated()` guard and `@Endpoint()` decorator for OpenAPI docs.
- **Services** (`server/src/services/`): Business logic. All extend `BaseService` which injects every repository. Use `this.requireAccess()` for permission checks.
- **Repositories** (`server/src/repositories/`): Data access via Kysely. Methods decorated with `@GenerateSql()` auto-generate SQL reference files.
- **DTOs** (`server/src/dtos/`): Request/response validation with class-validator.
- **Schema** (`server/src/schema/`): Table definitions, migrations, enums, and trigger functions.
- **Queries** (`server/src/queries/`): Auto-generated SQL files — do not edit manually.

Key infrastructure:
- **Job Queue**: BullMQ with Redis. Queue definitions in `server/src/jobs/`. Worker modes: api, microservices, maintenance.
- **Events**: `@OnEvent()` decorator pattern with `eventRepository.emit()`.
- **Auth**: JWT + API keys + OpenID Connect/OAuth.
- **Observability**: OpenTelemetry instrumentation with Prometheus metrics.

### Server Testing Conventions

Tests use Vitest. Pattern: `*.spec.ts` co-located with source files in `src/`.

```typescript
// Services use newTestService() which mocks all repositories
const { sut, mocks } = newTestService(AlbumService);
// Then set up mocks and call sut methods
mocks.album.getById.mockResolvedValue(albumStub.empty);
```

Test utilities: `server/test/utils.ts` (mock factories), `server/test/fixtures/` (stubs), `server/test/factories/` (builders).

### Web (SvelteKit)

- SvelteKit with static adapter, file-based routing
- `@immich/sdk` (workspace dependency) for API calls
- `@immich/ui` for shared UI components
- Svelte 5 runes syntax
- Tailwind CSS 4 for styling
- svelte-i18n for internationalization
- Socket.io for real-time updates
- Tests use `@testing-library/svelte` with Vitest

### Mobile (Flutter)

- Riverpod for state management
- Drift for local database
- Code generation via `build_runner`
- Custom lint rules in `immich_lint`

### Machine Learning (Python)

- FastAPI service on port 3003
- ONNX Runtime with multiple backend support (CPU, CUDA, OpenVINO, etc.)
- Models from Hugging Face Hub (CLIP for search, InsightFace for faces)
- Python 3.11+, linted with ruff, type-checked with mypy
- Package manager: uv

### OpenAPI Workflow

Server NestJS decorators → `immich-openapi-specs.json` → TypeScript SDK (oazapfts) + Dart SDK (OpenAPI Generator). The web and CLI consume `@immich/sdk`; mobile uses the Dart SDK.

## Monorepo Package Names

When using `pnpm --filter`:
- `immich` = server
- `immich-web` = web
- `@immich/cli` = cli
- `@immich/sdk` = open-api/typescript-sdk
- `immich-e2e` = e2e
