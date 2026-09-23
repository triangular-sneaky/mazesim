# MIDI throttling & guards

How outgoing MIDI to the physical maze is rate-limited. This is the "non-negotiable" part:
no matter what a movement asks for, the transport paces what actually reaches the wire.

All of this lives in one file: **`src/ui/mazeMidiController.js`** (the `MazeMidiController`
class). Nothing else sends MIDI out.

---

## 1. Vocabulary (what the words actually mean)

| Term | Definition |
|---|---|
| **Message** | One MIDI event = 3 bytes. Two kinds we send: **note-on** `[0x90, note, velocity]` and **note-off** `[0x80, note, 0]`. |
| **Note** | A panel's address (a MIDI note number). One note = one physical panel. |
| **Velocity** | The note-on's third byte, `1–127`. On this maze it sets the panel's **brightness** (`1` = off, `127` = max). |
| **Step** | One increment of a panel's position along its bounce cycle. It is produced by **one note-on**, which we always send as a **(note-off, note-on) pair** → **2 messages per step**. |
| **Unit** | A group of messages that must be sent **contiguously** — never split apart by other messages. In normal ("sequential") mode a unit = **all the messages for one note**. So a "move this panel 3 steps" is one unit of `3 × 2 = 6` messages. |
| **Token** | Permission to send **one message**. The rate limiter hands these out. |
| **Control tick** | One pass of the control loop (`engine.tick` + controller `tick`s + the belief→sim mirror), driven by the background-clock heartbeat at ~16 ms (~60/s). This is what "per tick / per frame" means here — it is **not** a render frame (rendering runs on a separate `requestAnimationFrame` loop). |

Firmware model this rests on: a note-on advances the panel one step *and* sets its light to
`velocity`; a note-off turns the light off without moving. So **light only ever changes as part
of a step** — that's why moves carry brightness, and why the unit of sending is "a note's steps."

---

## 2. The three knobs

Set in **`config/layout.yaml` → `midi:`** (current values shown), also editable live in the
MIDI-out UI section. They are read once at startup and passed into `MazeMidiController`.

| Knob | Current | Meaning |
|---|---|---|
| **`rateHz`** | `100` | **Sustained ceiling**: the long-run average number of *messages per second* allowed. |
| **`burst`** | `32` | **Burst budget**: how many messages may go out quickly, back-to-back, before the sustained ceiling starts holding things back. |
| **`delayMs`** | `6` | **Wire spacing**: the gap, in milliseconds, between two consecutive messages of a unit as they're placed on the wire. |

Plus one hard filter:

| | |
|---|---|
| **`deadNotes`** | A set of notes (panels) marked dead in the HUD. Any message to a dead note is dropped before it's ever queued. |

---

## 3. The mechanism: one queue, one token bucket

Every send path — `sendSteps()` (the movement drive), `move()` (the manual investigation
sweep), `sendOff()` (lights off) — turns its request into **units** and appends them to a single
shared FIFO queue (`_enqueue`). A single pump (`_pump`) drains that queue **one unit at a time**,
gated by a **token bucket**.

### The token bucket, plainly

Picture a bucket that holds at most **`burst`** tokens (32). It **refills continuously at
`rateHz` tokens per second** (100/s = one token every 10 ms), never overflowing past `burst`.
Sending a unit **spends one token per message** in it.

Each time the pump looks at the next unit:

1. **Refill** the bucket for however long it's been since last time
   (`tokens = min(burst, tokens + elapsed_seconds × rateHz)`).
2. **Can we afford it?** The unit costs `cost = number of messages in it`.
   - If the bucket has fewer tokens than we need → **wait**. It reschedules itself for exactly
     `ceil((needed − tokens) / rateHz × 1000)` ms — long enough to refill the shortfall — then
     re-checks. *This wait is the throttle.*
   - If there are enough → **send it**: place the unit's messages on the wire, timestamped
     `delayMs` apart, subtract `cost` tokens, and schedule the next pump.

(A unit larger than the whole bucket can still go once the bucket is full — we never wait for
*more* than a full bucket, since that would deadlock.)

### What each knob does, concretely

- **`burst`** controls the size of the initial spurt: with a full bucket you can fire ~`burst`
  messages before the bucket empties and the ceiling kicks in.
- **`rateHz`** controls the steady state after that: units come out no faster than the bucket
  refills, so the long-run average never exceeds `rateHz` messages/second.
- **`delayMs`** only affects *within-unit* spacing (and thus how long a unit occupies the wire);
  it does not change the overall ceiling.

### Worked example (100 / 32 / 6)

A movement enqueues **40 one-step moves** = 40 units × 2 messages = **80 messages**.

- Bucket starts full (32 tokens). The first several units fire quickly — each costs 2 tokens,
  spaced `unitDur = cost × delayMs = 12 ms` apart, while the bucket refills ~1.2 tokens per 12 ms.
- After the ~32-message burst is spent, the bucket is near empty, so each further 2-message unit
  must wait for 2 tokens to refill ≈ **20 ms** → a steady **~50 units/sec = 100 messages/sec**.

Net: a short quick burst (bounded by `burst`), then a steady stream capped at `rateHz`.

---

## 4. Why it holds across *everything*

The bucket's state (its token level and last-refill time) **lives on the controller and persists
between calls**. That matters because the inverted drive fires **many small, independent sends**,
from two sources with very different cadence:

- **Timeline movements** (wave, ripple, chase, geo, maze, blocks): each panel move is a discrete
  scheduled action, so its `sendSteps` fires *at that action's time* — not on any clock tick.
- **Continuous controllers** (Lullaby Float): their `tick()` runs on the control tick and can call
  `engine.move()` for each panel *every* tick. But `engine.move` snaps to the nearest z and is a
  no-op when neither the snapped height nor the light changed — so real sends come in **bursts as
  panels cross z-boundaries**, not blindly once per tick.

Either way each is its own little `sendSteps`, and they all append to the *same* queue and draw
from the *same* bucket — so even 86 panels sending independently can't each grab a fresh full
bucket and blow past the ceiling; they collectively obey one `rateHz`/`burst`. (Regression test:
*"the token bucket holds ACROSS separate sends."*)

Guards apply in layers, but the transport is the one that's authoritative:

- **Belief layer** (`MazeEngine`): skips dead panels and never emits a zero-step move, so every
  request is a well-formed unit.
- **Transport layer** (this queue): the only thing that touches the wire — rate, burst, spacing,
  and the dead-note ban are all enforced here, for every caller.
- **Wire layer**: messages are handed to the browser with explicit timestamps, which the
  browser's MIDI clock honors precisely — even when the tab is backgrounded. The pump reschedules
  through the background clock, so throttling keeps running in a hidden tab.

---

## 5. Note atomicity & send order

A unit is never interleaved with another unit, so a note's `(note-off, note-on)` pairs always
arrive together — a panel never lands half-driven. Two orderings are available:

- **sequential** (default): one whole note, then the next.
- **interleave**: round-robin across notes; the entire round-robin stream is treated as one unit.

---

## 6. Stopping (flush) and panic

- **`flush()`** (called on movement Stop, on switching movements, and by panic) drops every
  queued unit and stops the pump. Messages already handed to the browser's clock still fire — you
  can't unsend those — but nothing further queued reaches the wire.
- **`panic()`** first flushes, then sends a note-off to every note `0–127` to kill all light. Note
  that panic's own offs are sent directly (spaced by `delayMs`), not metered through the bucket —
  it's an emergency all-off.

---

## 7. Where to look in the code

| Concern | Location (`src/ui/mazeMidiController.js`) |
|---|---|
| Knob defaults / config wiring | constructor; values come from `config/layout.yaml` `midi:` via `src/main.js` |
| Build units + dead-note filter | `sendSteps()`, `sendOff()`, `move()` |
| Queue append | `_enqueue()` |
| Token bucket + pacing + timestamps | `_pump()` |
| Drop the queue | `flush()` / `_cancel()` |
| All-off | `panic()` |
| Background-safe scheduling | timers injected from `src/ui/backgroundClock.js` |
