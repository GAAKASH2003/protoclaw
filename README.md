# 🐾 ProtoClaw

ProtoClaw is an autonomous agent orchestration framework designed for extreme resilience, clean isolation, and cross-boundary communication. It eliminates fragile IPC pipes, shared memory locks, and heavy third-party framework bloat by relying purely on **Node.js 22 native features** (`node:sqlite`, native `fetch`, and native `WebSocket`).

---

## 🧭 Architectural Philosophy

Traditional agent frameworks run monolithic processes where chat adapters, state, and LLM execution share the same memory space. If a tool or sandbox crashes, the entire bot crashes with it.

ProtoClaw decouples the **Host** (which handles channels, databases, and network ingress) from the **Runner Sandbox** (which executes AI queries and tool code) using **Two-DB SQLite Mailbox IPC**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             HOST PROCESS (Node.js 22+)                      │
│                                                                             │
│   ┌───────────────────────────────┐               ┌─────────────────────┐   │
│   │  Multi-Channel Adapters       │ ── Ingest ──► │  Inbound Router     │   │
│   │  (CLI, Telegram, WA, Discord) │               │  (protoclaw.db)     │   │
│   └───────────────┬───────────────┘               └──────────┬──────────┘   │
│                   ▲                                          │              │
│            Dispatches replies                                │ Writes       │
│                   │                                          │ (seq: 2, 4…) │
│   ┌───────────────┴───────────────┐                          ▼              │
│   │      Delivery Engine          │                   ┌──────────────┐      │
│   │  (Tracks delivered receipts)  │                   │  inbound.db  │      │
│   └───────────────▲───────────────┘                   │ (Host-owned) │      │
│                   │                                   └──────┬───────┘      │
└───────────────────┼──────────────────────────────────────────┼──────────────┘
                    │ Reads outbound.db                        │ Read-Only
                    │ (journal_mode=DELETE)                    │ Mount
┌───────────────────┼──────────────────────────────────────────┼──────────────┐
│                   │ Writes (seq: 1, 3, 5…)                   ▼              │
│           ┌───────┴──────┐                            ┌──────────────┐      │
│           │ outbound.db  │ ◄─────── AI Replies ────── │ Agent Runner │      │
│           │(Runner-owned)│       (Gemini/OpenRouter)  │ (Poll Loop)  │      │
│           └──────────────┘                            │ (.heartbeat) │      │
│                                                       └──────────────┘      │
│                   SANDBOX RUNTIME (Host-Mode or Container)                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ The 5 Golden Invariants

1. **Zero IPC Pipes, Zero Shared Memory:**
   The Host and the Runner communicate exclusively through two SQLite databases (`inbound.db` and `outbound.db`) plus a `.heartbeat` file.
2. **The Single-Writer Rule:**
   * **Host owns and writes `inbound.db`** (the Runner opens it strictly read-only).
   * **Runner owns and writes `outbound.db`** (the Host opens it strictly read-only).
   * Database lock contention is mathematically impossible because neither process ever shares a write lock.
3. **Cross-Mount Filesystem Reliability (`DELETE` journal & `mmap_size = 0`):**
   * Both databases strictly enforce `PRAGMA journal_mode = DELETE`. Shared memory (`-shm`) used in WAL mode does not synchronize across VirtioFS / Docker VM boundaries, causing readers to miss updates or freeze on stale memory snapshots.
4. **Sequence Number Parity Rule:**
   * Host assigns **EVEN** sequence numbers (`seq: 2, 4, 6, 8...`) to `messages_in`.
   * Runner assigns **ODD** sequence numbers (`seq: 1, 3, 5, 7...`) to `messages_out`.
   * Every message role (User vs Assistant) can be instantly identified by sequence parity alone.
5. **Zero Third-Party Channel Dependencies:**
   * AI providers and channel adapters (Telegram, WhatsApp, Discord) are built using standard web specifications native to Node 22 (`fetch`, `WebSocket`, `http`).

---

## 🌟 Core Features & Functionality

### 1. Dual-DB Mailbox IPC Engine (`src/mailbox/`)
* **`session-db.ts`**: Atomically creates and accesses session mailboxes. Automatically calculates parity sequences (`nextEvenSeq` and `nextOddSeq`).
* **`processing_ack`**: Real-time state machine in `outbound.db` tracking message lifecycles (`processing` ➔ `completed` / `failed`).
* **Single-Delivery Guarantee**: Host records platform delivery IDs in `inbound.db.delivered` before acknowledging messages.

### 2. Central Relational Entity Model (`src/db/`)
* Backed by `data/protoclaw.db`.
* **Users & Roles (`users.ts`)**: Granular authorization (`owner`, `admin`, `user`).
* **Agent Groups (`agent-groups.ts`)**: Named agent personas with independent storage folders and AI providers.
* **Messaging Groups & Wirings (`wirings.ts`)**: Dynamic routing matching channel IDs to agent groups using pattern regex (e.g. `.` for all) or `@mention` triggers.
* **Session Manager (`session-manager.ts`)**: Mutex-locked session creation preventing race conditions during concurrent message spikes.

### 3. Multi-Turn Conversation Memory (`src/runner/history.ts`)
* **Chronological Stitching**: Interleaves past questions from `inbound.db` with replies from `outbound.db` via `in_reply_to` links and sequence parity.
* **Active Prompt Isolation**: Automatically excludes the current turn from history to prevent duplicate prompt injection.
* **Sliding Window Pruning**: Enforces configurable `maxTurns` (default 20 turns) while ensuring dialogue history always starts cleanly with a user message.

### 4. Sandboxed Workspace & Autonomous Tool Loop (`src/tools/`, `src/runner/tool-loop.ts`, `src/mailbox/destinations.ts`)
* **Jailed Workspace Environment**: Each agent group operates within `groups/<agent_group_id>/workspace/` with standing instructions from `AGENT.md`.
* **Path Traversal Security**: Strict path sanitization (`resolveSafePath`) blocks directory escape attempts (`../`) with `WorkspaceSecurityError`.
* **Standard Workspace Tools**: Includes `read_file`, `write_file`, `list_directory`, and `bash` (strictly jailed to `workspaceDir`).
* **Cross-Channel & Inter-Agent Messaging**: The `send_message` tool dynamically resolves destinations from `inbound.db.destinations`, allowing agents to broadcast to Telegram, WhatsApp, Discord, or peer agents mid-turn.
* **Autonomous Reasoning & Acting Loop**: Supports multi-turn tool execution (up to configurable `maxSteps`), self-correcting on runtime or security errors before committing the final human reply to `outbound.db`.

### 5. Zero-Dependency Channel Adapters (`src/channels/`)

| Channel | Protocol | Key Features |
|---|---|---|
| **CLI** | `readline` | Interactive terminal REPL, colored formatting via `kleur` |
| **Telegram** | HTTP Long-Polling | Zero-tunnel bot polling via Telegram Bot API, Markdown formatting |
| **WhatsApp** | HTTP Webhooks + Graph API | Meta Cloud API v21.0, automatic webhook handshake verification |
| **Discord** | WebSocket Gateway + REST | Native Node 22 `WebSocket` Gateway connection (Intents: 37377), 2000-char smart chunking, `@mention` detection |

### 6. Hardened Docker Sandbox Isolation (`src/container-runtime.ts`, `src/container-runner.ts`, `container/`)
* **Strict Sandbox Isolation**: When `CONTAINER_RUNNER=true`, untrusted agent code and tools execute inside a dedicated Linux container (`protoclaw-runner`).
* **Mount Boundary Composition**: Mounts `./data/sessions/<group>/<id>` to `/workspace/session` (read-only `inbound.db`, read-write `outbound.db`) and `./groups/<group>/workspace` to `/workspace/project`.
* **Zero Network Exposure**: The host and container communicate exclusively through mounted SQLite files; no open TCP ports or bridges.
* **Cold Start & Warm Reuse**: Containers spin up instantly when new inbound messages arrive and remain warm until an idle timeout shuts them down gracefully (`SIGTERM`).
* **Zombie Orphan Sweeping**: `reapOrphans()` automatically cleans up stale container instances on host startup.

---

## 📁 Project Structure

```text
protoclaw/
├── container/                            # Linux container sandbox packaging
│   └── Dockerfile                        # node:22-alpine hardened runner image
├── data/                                 # Runtime data (git-ignored)
│   ├── protoclaw.db                      # Central SQLite relational database
│   └── sessions/                         # Session mailbox directories
│       └── <agent_group_id>/
│           └── <session_id>/
│               ├── inbound.db            # Host-written mailbox (seq: 2, 4, 6...)
│               ├── outbound.db           # Runner-written mailbox (seq: 1, 3, 5...)
│               └── .heartbeat            # Runner liveness timestamp
├── scripts/                              # Standalone bot runners & CLI REPLs
│   ├── chat.ts                           # Interactive terminal chat
│   ├── telegram.ts                       # Telegram bot runner
│   ├── whatsapp.ts                       # WhatsApp Cloud API bot runner
│   └── discord.ts                        # Discord Gateway bot runner
├── src/
│   ├── channels/                         # Multi-channel adapter implementations
│   │   ├── cli.ts                        # Terminal adapter
│   │   ├── telegram.ts                   # Telegram Bot API adapter
│   │   ├── whatsapp.ts                   # Meta WhatsApp Cloud API adapter
│   │   ├── discord.ts                    # Discord REST + WebSocket adapter
│   │   └── registry.ts                   # Channel adapter lookup registry
│   ├── container-runner.ts               # Container lifecycle manager (wake, stop, reap)
│   ├── container-runtime.ts              # Docker CLI wrapper & path normalizer
│   ├── db/                               # Central database schema & CRUD
│   │   ├── connection.ts                 # Database factory & migrations
│   │   ├── users.ts                      # User management & roles
│   │   ├── agent-groups.ts               # Agent group definitions
│   │   ├── messaging-groups.ts           # Channel platform entities
│   │   └── wirings.ts                    # Routing rules & patterns
│   ├── mailbox/                          # Dual-DB session mailboxes
│   │   ├── schema.ts                     # Inbound & Outbound DDL schemas
│   │   ├── session-db.ts                 # Dual-DB opener & write helpers
│   │   └── parity.ts                     # Sequence parity allocator
│   ├── runner/                           # Agent execution loop & memory
│   │   ├── poll-loop.ts                  # Polling engine & task dispatcher
│   │   ├── history.ts                    # Dual-DB multi-turn dialogue reconstructor
│   │   ├── heartbeat.ts                  # Liveness checking
│   │   └── providers/                    # AI LLM providers (Gemini, OpenRouter, Mock)
│   ├── delivery.ts                       # Host outbound delivery loop
│   ├── router.ts                         # Inbound platform event router
│   └── session-manager.ts                # Session resolution & directory provisioning
└── tests/                                # Comprehensive test suite (Vitest)
```

---

## 🚀 Quickstart Guide

### 1. Prerequisites
* **Node.js**: `v22.0.0` or higher
* **pnpm**: `v9.0.0` or higher

### 2. Installation
Clone the repository and install dependencies:

```bash
cd protoclaw
pnpm install
```

### 3. Environment Configuration
Create a `.env` file in the `protoclaw` directory:

```env
# AI Providers (At least one required)
GEMINI_API_KEY="your_google_ai_studio_api_key"
GEMINI_MODEL="gemini-2.5-flash"
# Optional OpenRouter fallback:
# OPENROUTER_API_KEY="your_openrouter_api_key"

# Telegram Bot (Optional)
TELEGRAM_BOT_TOKEN="your_telegram_bot_token"
TELEGRAM_BOT_USERNAME="@your_bot_username"

# WhatsApp Cloud API (Optional)
WHATSAPP_TOKEN="your_meta_system_user_token"
WHATSAPP_PHONE_NUMBER_ID="your_meta_phone_number_id"
WHATSAPP_VERIFY_TOKEN="your_custom_secret"
WHATSAPP_WEBHOOK_PORT=3000

# Discord Bot (Optional)
DISCORD_BOT_TOKEN="your_discord_bot_token"
DISCORD_CLIENT_ID="your_discord_application_id"
```

---

## 🎮 Running ProtoClaw

### Interactive Terminal Chat
Start the command line chat REPL:

```bash
pnpm run chat
```

Or run a single query and exit:
```bash
pnpm run chat "Explain the Single-Writer Rule in ProtoClaw."
```

### Discord Bot Runner
Starts the real-time Discord Gateway connection:

```bash
pnpm run discord
```
* Mention `@ProtoClaw <prompt>` in any channel where the bot has access, or send it a direct message!

### Telegram Bot Runner
Starts the Telegram long-polling service:

```bash
pnpm run telegram
```

### WhatsApp Cloud API Runner
Starts the built-in HTTP webhook server and delivery loop:

```bash
pnpm run whatsapp
```

---

## 🧪 Testing & Verification

ProtoClaw includes an extensive test suite verifying database schemas, sequence parity, router concurrency locks, delivery idempotency, channel adapters, and history reconstruction:

```bash
# Run full Vitest suite (119 passing tests across 15 test suites)
pnpm test

# Run TypeScript typecheck
pnpm typecheck
```

---
