# OpenClaw Maximum Optimization Blueprint

## 0. Goal
This document defines the best-practice architecture for OpenClaw on Node.js + Feishu, with three hard goals:

1. Chat must never be blocked by task execution.
2. Multi-task concurrency must be stable and controllable.
3. Users must always know what each task is doing in real time.

This is the implementation contract for your robot. It should execute this doc directly.

---

## 1. Final Architecture (Use This, Not More Agents)

Use 4 core runtime components, not many LLM sub-agents:

1. `Chat Gateway`
2. `Orchestrator`
3. `Worker Pool`
4. `Notifier`

Supporting infrastructure:

1. `Redis` (queue, stream/pubsub, locks, short-term state)
2. `Postgres` (durable task store, events, audit trail)
3. `BullMQ` (job queue + retries + priorities)

### 1.1 Component Responsibilities

`Chat Gateway`:
- Receives Feishu events.
- Replies fast ACK in 100-300ms.
- Parses intent (`create_task`, `status_query`, `cancel_task`, `provide_input`).
- Never executes long-running business logic.

`Orchestrator`:
- Single writer of task state machine.
- Creates tasks and dispatches jobs to queues.
- Applies scheduling policy (priority, quotas, fairness).
- Handles transitions including `waiting_user_input`.

`Worker Pool`:
- Executes business task steps.
- Emits progress/heartbeat events only.
- Must not directly call Feishu messaging API.

`Notifier`:
- Single outbound messaging channel to Feishu.
- Consumes task events, throttles updates, edits message cards.
- Handles dedupe, retry, and fallback messaging.

### 1.2 Hard Constraints (Must Enforce)

1. Only `Orchestrator` can mutate task status.
2. Only `Notifier` can send/edit Feishu messages.
3. `Worker` only emits events; no direct user conversation.
4. Status queries are read-path only from store, no extra sub-agent spin-up.
5. Chat and Worker run in separate processes (prefer separate pods/containers).

---

## 2. Replace Current Agent Model With Lean Model

Current idea has extra layers (`trigger agent`, `query sub-agent`, `dialog sub-agent`) that increase latency and race risk.

Replace with:

1. Keep `real-time chat` as `Chat Gateway`.
2. Keep `task scheduler` as `Orchestrator`.
3. Replace `query agent` with `Status Reader + Notifier` (non-LLM).
4. Use a small LLM dialog step only when task state is `waiting_user_input`.
5. Remove `trigger agent` entirely.

Why:

1. Status check is a pure data read.
2. Extra agent hop adds delay and coordination complexity.
3. More agents means higher chance of duplicate and out-of-order replies.

---

## 3. Task State Machine (Authoritative)

Use these states only:

1. `queued`
2. `running`
3. `waiting_user_input`
4. `retrying`
5. `succeeded`
6. `failed`
7. `canceled`
8. `stuck`

Allowed transitions:

1. `queued -> running`
2. `running -> waiting_user_input`
3. `waiting_user_input -> running`
4. `running -> retrying -> running`
5. `running -> succeeded|failed|canceled|stuck`
6. `retrying -> failed|stuck`

State transition rule:

1. Validate transition in `Orchestrator`.
2. Persist transition in DB transaction.
3. Publish event to `task_events` stream.

---

## 4. Data Model (Required)

## 4.1 Postgres Tables

`tasks`:
- `task_id` (pk, uuid)
- `user_id`
- `chat_id`
- `conversation_id`
- `task_type`
- `priority` (int)
- `status`
- `progress_percent` (0-100)
- `current_step`
- `input_payload` (jsonb)
- `result_payload` (jsonb)
- `error_code`
- `error_message`
- `heartbeat_at`
- `created_at`
- `updated_at`
- `version` (optimistic lock)

`task_events`:
- `event_id` (pk, uuid)
- `task_id`
- `event_type`
- `event_payload` (jsonb)
- `created_at`

`message_bindings`:
- `task_id`
- `feishu_chat_id`
- `feishu_message_id`
- `card_version`
- `updated_at`

## 4.2 Redis Keys

1. `queue:task:<task_type>`
2. `lock:task:<task_id>`
3. `limiter:user:<user_id>`
4. `limiter:chat:<chat_id>`
5. `hb:task:<task_id>`
6. `dedupe:feishu_event:<event_id>`

---

## 5. Concurrency and Scheduling Policy

Apply 3 levels of limits:

1. Global concurrency: `MAX_GLOBAL = 50` (tune by CPU/IO).
2. Per user: `MAX_PER_USER = 3`.
3. Per chat/session: `MAX_PER_CHAT = 2`.

Queue strategy:

1. Use BullMQ queues by task type.
2. Use priority (`P1` incident > `P2` normal > `P3` background).
3. Enable delayed retry with exponential backoff.
4. Route permanent failures to DLQ.

Fairness:

1. Round-robin pull by tenant or user shard.
2. Reject or defer when quota exceeded with clear message.

---

## 6. Non-Blocking Conversation Contract

For any incoming user message:

1. `Chat Gateway` responds immediate ACK.
2. If intent is status query, read `tasks` directly and reply instantly.
3. If intent is create task, create task + enqueue then reply `task_id`.
4. If task is running, chat remains fully responsive because execution is async.

Response SLA targets:

1. ACK: `< 300ms`
2. Status query: `< 800ms` from DB/Redis read
3. Progress push cadence: state change immediate + heartbeat summary each 10-15s

---

## 7. Feishu Messaging Strategy

Use one card per task and keep updating same message.

Rules:

1. Store `feishu_message_id` in `message_bindings`.
2. `Notifier` updates the same card on each important transition.
3. Use throttling: if no state change, merge updates to every 10-15s.
4. On state change (`running -> waiting_user_input`, `running -> failed`, etc.), push immediately.
5. If card edit fails repeatedly, fallback to new message and rebind `message_id`.

Card content minimum:

1. `task_id`, `status`, `progress`, `current_step`
2. `last_heartbeat`, `last_event_time`
3. Action buttons: `refresh`, `cancel`, `details`

---

## 8. Reliability and Idempotency

Exactly-once is not realistic in distributed systems. Implement at-least-once + idempotency.

Required controls:

1. Deduplicate Feishu inbound by `event_id`.
2. Deduplicate worker step commits by `task_id + step_id + version`.
3. Use distributed lock for terminal state writes.
4. Heartbeat watchdog:
   - If no heartbeat > `30s`, mark `stuck`.
   - Auto retry if policy allows.
5. Retry policy:
   - `max_attempts = 3`
   - backoff: `2s, 10s, 30s`
6. DLQ for manual inspection + replay.

---

## 9. Observability (Must Have Before Production)

Metrics:

1. Queue depth by task type.
2. End-to-end latency (`queued -> terminal`).
3. Chat ACK latency.
4. Status query latency.
5. Failure rate and retry rate.
6. Stuck task count.
7. Feishu send/edit error rate.

Logs:

1. Structured JSON logs with `task_id`, `conversation_id`, `event_id`, `trace_id`.
2. Log every state transition and external API error.

Alerts:

1. Queue backlog > threshold for 5 min.
2. ACK p95 > 1s.
3. Stuck tasks above threshold.
4. Feishu notifier failures continuously > 3 min.

---

## 10. Security and Governance

1. Verify Feishu request signature and timestamp.
2. Encrypt secrets (`APP_ID`, `APP_SECRET`) in secret manager.
3. Strict RBAC for admin actions (`cancel/retry/replay`).
4. Audit log all manual interventions.
5. Redact sensitive fields in logs/events.

---

## 11. Reference Interfaces (TypeScript Contract)

```ts
type TaskStatus =
  | "queued"
  | "running"
  | "waiting_user_input"
  | "retrying"
  | "succeeded"
  | "failed"
  | "canceled"
  | "stuck";

interface TaskCommand {
  taskId: string;
  userId: string;
  chatId: string;
  type: string;
  priority: number;
  payload: Record<string, unknown>;
}

interface TaskEvent {
  eventId: string;
  taskId: string;
  type: "progress" | "heartbeat" | "state_changed" | "need_input" | "result" | "error";
  at: string;
  payload: Record<string, unknown>;
}
```

---

## 12. Build Plan (Robot Must Execute In Order)

### Phase 1: Decouple Chat and Execution

1. Add `Chat Gateway` with immediate ACK.
2. Add `Orchestrator` with task creation and state machine.
3. Add BullMQ queue + one worker.
4. Store tasks/events in Postgres.
5. Add `Notifier` and card update path.

Exit criteria:

1. User can keep chatting while task runs.
2. Task has visible progress updates.
3. Status query works anytime.

### Phase 2: Concurrency and Stability

1. Add per-user and per-chat concurrency limiter.
2. Add retry/backoff/DLQ.
3. Add heartbeat + stuck detector.
4. Add idempotency for inbound and step commits.

Exit criteria:

1. 50 concurrent tasks stable.
2. No duplicate task execution under retry.
3. Stuck tasks detected within 30s.

### Phase 3: Production Hardening

1. Add full metrics/logging/alerts.
2. Add admin APIs (`cancel`, `retry`, `replay`, `force-fail`).
3. Add load test and chaos test.
4. Add runbooks and on-call SOP.

Exit criteria:

1. p95 ACK < 1s under load.
2. p95 status query < 1s.
3. Error budget and alerting validated.

---

## 13. Acceptance Test Checklist

1. Create 30 tasks from 10 users concurrently.
2. Continuously ask status in chat while workers are busy.
3. Verify no blocking and no message disorder.
4. Simulate worker crash and verify retry + status continuity.
5. Simulate Feishu edit failure and verify notifier fallback.
6. Simulate missing heartbeat and verify `stuck` transition.
7. Verify cancel command reaches running task in < 2s.

---

## 14. Direct Instruction Block For Your Robot

Use this exact instruction:

1. Implement architecture exactly as sections 1-13.
2. Do not add trigger/query/dialog LLM agents unless state is `waiting_user_input`.
3. Keep one message output channel (`Notifier`) for Feishu.
4. Enforce single writer (`Orchestrator`) for task status.
5. Deliver code in small PRs by phase with tests and load benchmarks.
6. Stop each phase only after exit criteria pass.

Done condition:

1. Chat stays responsive during any task load.
2. User always sees live task state.
3. System supports controlled multi-task concurrency with recovery.

