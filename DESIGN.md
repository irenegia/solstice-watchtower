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
     reading every block. The revert reason comes from the on-chain receipt; only the inner call of a multisig
     message is replayed. Messages sent to f02 itself are read too, from the activation epoch on.
3. At the chain head it does the reads: f02 state, the state behind `streams_root`, wallet balances, SRA views.
   For every `claim-payout` event it also reads the recipient's balance just before and just after.
4. For every queued write it has seen (from a `write-queued` event or from the queue in the f02 state), once the
   effective epoch E has passed it reads the f02 state at tipset E+1 (and E+2) and records a `queued write outcome`:
   `applied`, `dropped or replaced`, or `still queued`. f02 writes no visible event at that moment, so this read is
   the only evidence (added 2026-09-19, after rvagg's rule: poll the state at every effective epoch). Tested on
   hand-written samples only; the first real test is butterfly gamma on 2026-09-21.
5. Appends the new records to `records.jsonl` and moves the cursor.

Rules for the record:

- Append-only. A line is never rewritten, so the file history shows what was seen and when.
- Every decoded value keeps its raw data and its message id next to it, so the decoding can be checked
  against a block explorer.
- A read is recorded only when its value changed since the last run.
- What the decoder does not know is recorded as `unknown(...)` or `undecoded` with the raw data. Nothing is dropped.

Quarter numbers follow FIP-0118 §2.2: `Start(Q) = ACTIVATION_EPOCH + (Q-1) * EPOCHS_PER_QUARTER`,
quarter Q is `[Start(Q), Start(Q+1))`. Quarter 0 means before activation.

## Sources the decoders were written from

- Contracts: solstice `main` at `87fd57c` (2026-09-16), re-checked at `0fa8cca` (2026-09-17, the deployed
  version: the SRA is unchanged, the SWA gained two gate-check errors). Each signature group in `lib/evm.js`
  names its file.
- f02 events and state: FIP-0118 §2.4.2 and §2.4.9 at the PR #1286 head `a1a0a8b`, checked against
  builtin-actors `master` at `eb9c308`, `actors/reward/src/emit.rs` (PR #1782 merged 2026-09-16).

When a contract or f02 changes, re-read these and update `lib/evm.js` / `site/lib/f02.js`. The f02 decoder
lives inside `site/` because the page uses the same file for its live read.

## The page (`site/index.html`)

One static file, no framework, relative paths only, so the folder works when served from a Filecoin CID.
It displays `data/<network>/records.jsonl` and `status.json`, and reads f02 live (below). Times are UTC
because the rehearsal plan uses UTC. The plan's "Q5 cycle" runs on the day after Q5 ends, so on chain it falls
in quarter 6: each quarter header shows both labels.

The queue is taken from the f02 state and rebuilt from the `write-*` events as a cross-check. If the two
differ, the page says so.

### Live read of f02 (decided 2026-09-18, in from the first live version so the rehearsal tests it)

Parts 1 (queued writes) and 3 (state) do not wait for the scheduled job. When the page opens, the visitor's
browser asks the public endpoint for the f02 state (`Filecoin.StateReadState`, then `Filecoin.ChainReadObj`
for the block behind `streams_root`) and decodes it with the same layout as `lib/f02.js`. The endpoint allows
calls from a web page (`access-control-allow-origin: *`, checked 2026-09-18 on the calibnet endpoint).

- Why: the record can be 15 to 20 minutes old. On calibnet the hold is 6 hours, on butterfly 20 minutes; a
  queued write must show at once, with the right time left.
- The page shows both: the live queue, and the queue from the record with its age. If they disagree by more
  than the record's age explains, the page says so. Two sources that should agree are a check on each other.
- If the endpoint does not answer, the page says so and shows the recorded values only. It never shows stale
  values as live.
- Part 2 (what landed: history, failed messages, proposal contents) always comes from the record: a browser
  can only ask the chain about now.
- Cost: the page loads one small CBOR library, and each visitor sends a few requests to the public endpoint.

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
- First real records, 2026-09-18: the reader was run on the deployed calibnet SRA and SWA from their
  deployment blocks (SRA 4078418, SWA 4078422). It decoded `Upgraded`, `OwnerAdded` (twice), `Initialized` and,
  for the SRA, `OrchestratorAdmitted` with the identity and wallet of `deployments.json`. The SRA deployment
  message was checked by hand on Filfox: height 4078418, status OK, method `CreateExternal`.
- First real f02 data, 2026-09-18: the reader was run once over butterflynet "alpha" (lotus-infra issue #1654;
  genesis 2026-09-17 20:04 UTC, FIP-0118 active from epoch 90, rvagg's test run; overwritten by a reset the same
  evening), with the ok of BigLep (lotus-infra PR #1655). 318 records, kept in `site/data/butterfly-alpha/` as
  the only copy, shown as the page's view `?data=butterfly-alpha`. What it proved on real data: the decoding of
  the state behind `streams_root` (three streams, share maps, accrued amounts); messages sent to f02 itself
  (7 `Claim`, 3 `SetShares`, 1 `ReplaceAddress`); the two-multisig pattern (`Submitted`, `Approved`, `Rejected`);
  a real f02 rejection (`quarterlyGateCheck` failed with `StepWeightRecordsFailed(16)` at epoch 2563, passed
  at 2616 after a stream was removed). Three hand checks inside the record agreed: the service stream's weight
  (35%, t_start 2400) against the gate check of quarter 10 (steps 5); `SharesSubmitted` for quarter 10 (1
  recipient, 250,000 USD) against the share map (1 row) and against `VolumePosted`; `aggregatedFilecoinPayVolume(10)`
  read as 250,000 USD. Not proved there: f02 events (the actor events API was off on that node; it is on from
  the next reset), and nothing could be compared with a block explorer (butterflynet has none).
- Still not testable on calibnet before its activation: the real f02 event bytes from the node, the state
  behind `streams_root` on real data, the multisig message path. First job after deployment: check three
  records by hand against a block explorer.

## Known limits of the PoC

What can be observed on chain, for every action, is in [OBSERVABILITY.md](OBSERVABILITY.md). These two limits
are in this code, not in the chain:

1. Fixed 2026-09-18: the reader now also reads messages sent to f02 itself (`Claim`, or a stream method called
   directly), from the activation epoch on. They are native Filecoin messages, so they are read with
   `Filecoin.ChainGetMessagesInTipset`, two more requests per epoch. Not yet tested on real data: calibnet's
   f02 gets these methods at activation (2026-09-23).
2. The reader must not stop for long. It finds messages by reading every block, and the public calibnet
   endpoint keeps full blocks for only 17 hours to 2 days (measured 2026-09-17: a block 2,000 epochs old was
   served, one 6,000 epochs old was not). Messages from a longer gap are lost. This matters most for
   `SetAdmittedLists` and `SetPricingParams`, whose event is the only record of the values. How long the
   endpoint keeps events was not measured; one `eth_getLogs` query may span at most 2,880 epochs there
   ("block range exceeds maximum of 2880", seen 2026-09-18).

## Later steps (not built)

1. One manual publish of `site/` to Filecoin with the `publish` skill (mainnet only).
2. The scheduled job: GitHub Actions runs the reader every 10 minutes and commits the record to this repo
   (`.github/workflows/read.yml`; it holds no key and no secret, and starts running once it is on GitHub).
   Three rules for when it fails (decided 2026-09-18); a watchtower that stops silently is worse than none:
   - The page warns. If the newest read in the record is more than 30 minutes old, the header turns red:
     "The reader has not run since HH:MM UTC. The history below may be incomplete." The live read of f02
     keeps working, it does not depend on the job.
   - The job catches up by itself. Each run starts from the last epoch it finished and reads at most 720
     epochs (6 hours of chain), so one run heals a stop of up to 6 hours. The limit was 120 epochs until
     2026-09-18. That day GitHub started the job once in the first 5.5 hours (its scheduler is "best effort"),
     and with runs an hour or more apart a 1-hour limit meant the record fell further behind on every run.
   - A gap that cannot be healed is recorded, not hidden. If the endpoint no longer serves the blocks of the
     gap (limit 2 above), the job writes one record "epochs X to Y could not be read", and the page shows it
     in the history, so silence is never taken for "nothing happened".
   Telling a person that the job stopped is the alert, which is outside the PoC.
3. Hosting (decided 2026-09-17 and 2026-09-18): the website is served from IPFS/Filecoin through Filecoin
   Pin, not from GitHub Pages. The page is fixed and is re-published only when the page itself changes, so it
   has one stable link. When it opens, it fetches the record from this repo, where the scheduled job commits
   it; if the repo does not answer, it falls back to the record bundled at publish time. This is the shape of
   the PDP explorer (`pdp.filecoin.cloud`): fixed page files, data fetched by the browser on load (there from
   a Goldsky index; checked 2026-09-18 by listing the page's requests). Known delay: up to about 15 to 20
   minutes (10-minute schedule, GitHub starting scheduled jobs late, and a 5-minute cache on raw files,
   `cache-control: max-age=300`, measured 2026-09-18).
   Rejected for now: re-uploading the whole folder on every change and re-pointing a name (ENS or a domain)
   to the newest CID. It adds the upload time and the gateway lag to the delay, needs a name someone has to
   give us and two secrets in CI, and none of the team's explorers works that way. It stays the later option
   if the record itself must live on Filecoin; until then a daily snapshot of the record can be uploaded.
   Later improvement, same decision: a Goldsky subgraph for the SRA and SWA events, as the PDP explorer has,
   to shorten the delay for them. It cannot cover f02 (not a contract) or failed messages (no event).
4. The alert: needs a named person and a channel.
