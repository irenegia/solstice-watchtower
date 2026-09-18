# Solstice watchtower PoC: design

Approved by Irene 2026-09-17. Scope issue: https://github.com/filecoin-project/solstice/issues/69

## What it is

A reader runs every 10 minutes against calibnet and appends what it finds to a public record.
One page shows that record in three parts:

1. Queued writes: every write waiting in the f02 pending-write queue, with its decoded payload,
   its effective epoch and the time left.
2. What landed: events and messages of f02, the SWA and the SRA, in time order, grouped by quarter.
3. State: values that leave no event, read on every run.

Not in the PoC: the alert, any automatic judgment, the miner actor / f07 / f06 / f05 checks, mainnet,
anything off chain.

## The reader (`bin/reader.js`)

One run:

1. Reads the last epoch it finished from `status.json`.
2. For the new epochs it fetches
   - the f02 actor events (`Filecoin.GetActorEventsRaw`),
   - the SRA and SWA logs (`eth_getLogs`),
   - every message sent to the SRA, the SWA or one of their owner multisigs, with its result. A reverted
     message emits no event (FIP-0118 §2.4.9: "Reverted calls emit no event"), so messages are found by
     reading every block. The revert reason comes from replaying the call on the state of the epoch before.
3. At the chain head it does the reads: f02 state, the state behind `streams_root`, wallet balances, SRA views.
   For every `claim-payout` event it also reads the recipient's balance just before and just after.
4. Appends the new records to `records.jsonl` and moves the cursor.

Rules for the record:

- Append-only. A line is never rewritten, so the file history shows what was seen and when.
- Every decoded value keeps its raw data and its message id next to it, so the decoding can be checked
  against a block explorer.
- A read is recorded only when its value changed since the last run.
- What the decoder does not know is recorded as `unknown(...)` or `undecoded` with the raw data. Nothing is dropped.

Quarter numbers follow FIP-0118 §2.2: `Start(Q) = ACTIVATION_EPOCH + (Q-1) * EPOCHS_PER_QUARTER`,
quarter Q is `[Start(Q), Start(Q+1))`. Quarter 0 means before activation.

## Sources the decoders were written from

- Contracts: solstice `main` at `87fd57c` (2026-09-16). Each signature group in `lib/evm.js` names its file.
- f02 events and state: FIP-0118 §2.4.2 and §2.4.9 at the PR #1286 head `a1a0a8b`, checked against
  builtin-actors `master` at `eb9c308`, `actors/reward/src/emit.rs` (PR #1782 merged 2026-09-16).

When a contract or f02 changes, re-read these and update `lib/evm.js` / `lib/f02.js`.

## The page (`site/index.html`)

One static file, no framework, relative paths only, so the folder works when served from a Filecoin CID. It decodes nothing: it displays `data/<network>/records.jsonl` and `status.json`. Times are UTC
because the rehearsal plan uses UTC. The plan's "Q5 cycle" runs on the day after Q5 ends, so on chain it falls
in quarter 6: each quarter header shows both labels.

The queue is taken from the f02 state and rebuilt from the `write-*` events as a cross-check. If the two
differ, the page says so.

## Testing

- `npm test`: hand-written SAMPLE inputs through the real decoders. No chain data.
- `npm run sample`: a SAMPLE record for the page (`?data=sample`), kept apart from the real record.
- `config/plumbing-check.json`: the reader pointed at a busy existing calibnet contract, to test logs,
  messages and revert reasons on real data before the SRA and SWA exist. Its output (one run, 2026-09-17,
  epoch 4077698, 128 records, 11 reverted) is the page's third view, `?data=real-test`. One reverted record
  was checked by hand against Filfox on 2026-09-17: same epoch, status `SysErrContractReverted`.
  Correction 2026-09-18: the first version of the reader got the reason by replaying the call, and the replay
  left out the message's `value`, so it reported a wrong reason (`Error(Incorrect fee amount)`). The reader now
  takes the reason from the on-chain receipt (`Filecoin.StateSearchMsg`, field `Return`) and replays only the
  inner call of a multisig message. The 11 reverted records of this view were re-read from their receipts:
  custom error `0x9514f828`, which this decoder does not know because the contract is unrelated.
- Cannot be tested before the contracts are on calibnet: the real f02 event bytes from the node, the state
  behind `streams_root` on real data, the multisig message path. First job after deployment: check three
  records by hand against a block explorer.

## Known limits of the PoC

What can be observed on chain, for every action, is in [OBSERVABILITY.md](OBSERVABILITY.md). These two limits
are in this code, not in the chain:

1. The reader does not read messages sent to f02. It reads messages sent to the SRA, the SWA and their owner
   multisigs. `Claim` is sent to f02 directly, so a `Claim` that pays nothing (no `claim-payout` event) or
   that fails is not recorded. Fix: add f02 to the addresses whose messages are read.
2. The reader must not stop for long. It finds messages by reading every block, and the public calibnet
   endpoint keeps full blocks for only 17 hours to 2 days (measured 2026-09-17: a block 2,000 epochs old was
   served, one 6,000 epochs old was not). Messages from a longer gap are lost. This matters most for
   `SetAdmittedLists` and `SetPricingParams`, whose event is the only record of the values. How long the
   endpoint keeps events was not measured.

## Later steps (not built)

1. One manual publish of `site/` to Filecoin with the `publish` skill (mainnet only).
2. The scheduled job: GitHub Actions runs the reader and commits the record to this repo.
3. Hosting (decided 2026-09-17): the website is served from IPFS/Filecoin through Filecoin Pin, not from
   GitHub Pages. Open: how the page gets a record that changes every 10 minutes. Either the page on Filecoin
   reads the record from this repo (one fixed link, re-published only when the page changes), or the whole
   folder is re-uploaded on every change and a name (ENS or a domain) is re-pointed to the newest CID. A CI
   upload would use a session key (`SESSION_KEY` + `WALLET_ADDRESS`), which cannot move funds.
4. The alert: needs a named person and a channel.
