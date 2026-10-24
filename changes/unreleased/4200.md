<!-- changes-log: packages/coding-agent/src/core/changes.md -->
## 2026-10-24 - Keep restored delivery reservations across queue clears (senpi#4198 follow-up)

### What changed

- `external-admission.ts`: keep restored reservations while their live custody or persisted carrier owns the delivery; release reservations whose custody ends without persistence.
- `lifecycle-session-binding.ts`: restore custody-backed reservations and reduce delivery history once before the constructor's restoration loop.

### Why

- Clearing an agent queue before recovery enqueues its restored carrier must not let a gateway retry enqueue a duplicate.

### Why an extension could not handle it

- The admission ledger and durable custody replay are engine-owned session state.

### Expected merge conflict zones

- `external-admission.ts`: restored reservations and queued admission cleanup.
- `lifecycle-session-binding.ts`: constructor custody restoration.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed

- Prevent duplicate cross-session deliveries when a queue is cleared before restored delivery recovery; allow redelivery when custody is released without persistence.
