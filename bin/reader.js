#!/usr/bin/env node
// One run of the reader: fetch what is new since the last run, append it to the record, move the cursor.
// Usage: node bin/reader.js config/calibnet.json
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as dagCbor from '@ipld/dag-cbor'
import { encodeFunctionData, decodeFunctionResult } from 'viem'
import { makeRpc, toHex, epochToTime, quarterOf } from '../lib/chain.js'
import { decodeActorEvent, decodeStreamsState, idToEthAddress, slotOf, writeOutcome } from '../site/lib/f02.js'
import { abi, decodeLog, decodeCall, decodeRevert, plain } from '../lib/evm.js'

// ponytail: no reorg handling. The reader stays LAG epochs behind the head; a deeper reorg can leave an
// orphaned line in the append-only record. Upgrade: re-check the last N epochs on every run.
const LAG = 5
// ponytail: messages are found by downloading every block (~50 KB each). Fine at one run per 10 minutes;
// if that gets slow, move to an indexer or Filecoin.StateListMessages on a node that allows it.
// 720 epochs = 6 hours of chain. It was 120 (1 hour) until 2026-09-18: GitHub then started the job about once an
// hour or less, so each run read less chain than had passed and the record fell behind after every late run.
const MAX_EPOCHS_PER_RUN = 720
const ZERO = '0x0000000000000000000000000000000000000000'
// f02 state fields that change every epoch and are not part of FIP-0118: left out of the record.
const NOISY = ['Epoch', 'ThisEpochReward', 'TotalStoragePowerReward', 'ThisEpochRewardSmoothed','CumsumBaseline', 'CumsumRealized', 'EffectiveBaselinePower', 'ThisEpochBaselinePower', 'EffectiveNetworkTime']

const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'config/calibnet.json', 'utf8'))
const rpc = makeRpc(cfg.rpcUrl)
mkdirSync(cfg.dataDir, { recursive: true })
const statusPath = join(cfg.dataDir, 'status.json')
const recordsPath = join(cfg.dataDir, 'records.jsonl')
const status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf8')) : { lastEpoch: null, reads: {} }
// Queued writes the reader has seen and whose outcome it has not recorded yet, kept between runs in status.json.
status.pending ??= {}

// address -> name, lower case. A contract still at the zero address is not deployed yet and is skipped.
const contracts = new Map([['SRA', cfg.sra], ['SWA', cfg.swa]].filter(([, a]) => a !== ZERO).map(([n, a]) => [a.toLowerCase(), n]))
const owners = new Map(Object.entries(cfg.owners).map(([n, a]) => [a.toLowerCase(), n]))

const chainHead = Number(await rpc('eth_blockNumber'))
const from = status.lastEpoch === null ? (cfg.startEpoch ?? chainHead - LAG - 20) : status.lastEpoch + 1
const to = Math.min(chainHead - LAG, from + (cfg.maxEpochsPerRun ?? MAX_EPOCHS_PER_RUN) - 1)
if (to < from) {
  console.log(`nothing new: last epoch read ${status.lastEpoch}, chain head ${chainHead}`)
  process.exit(0)
}

const records = []
const rec = (kind, epoch, source, name, fields, extra = {}) =>
  records.push({ kind, epoch, time: epochToTime(cfg, epoch), quarter: quarterOf(cfg, epoch), source, name, fields, ...extra })

// 1. f02 actor events. A node can have this API switched off; that is recorded, and the run goes on.
let f02Events = []
try {
  f02Events = (await rpc('Filecoin.GetActorEventsRaw', [{ addresses: [cfg.f02], fromHeight: from, toHeight: to }])) ?? []
} catch (err) {
  rec('gap', from, 'reader', 'f02 events could not be read', { fromEpoch: from, toEpoch: to, reason: err.message.slice(0, 160) })
}
for (const ev of f02Events) {
  if (ev.reverted) continue
  const extra = { msgCid: ev.msgCid?.['/'], raw: ev.entries }
  let decoded
  try {
    decoded = decodeActorEvent(ev, cfg.addressPrefix)
  } catch (err) {
    decoded = { name: 'undecoded', fields: { error: err.message } } // the raw entries are still saved
  }
  rec('event', ev.height, 'f02', decoded.name, decoded.fields, extra)
  if (decoded.name === 'claim-payout') await claimCheck(ev.height, decoded.fields)
  if (decoded.name === 'write-queued') watchWrite(decoded.fields)
  if (decoded.name === 'write-cancelled') delete status.pending[pendingKey(decoded.fields)]
}

// A Claim is checked twice: the event gives recipient and amount, the wallet balance must move by the same amount.
async function claimCheck(epoch, { recipient, amountAttoFil }) {
  const wallet = idToEthAddress(recipient.slice(2))
  const [before, after] = await Promise.all([epoch - 1, epoch + 1].map((e) => rpc('eth_getBalance', [wallet, toHex(e)])))
  const difference = (BigInt(after) - BigInt(before)).toString()
  rec('read', epoch + 1, 'f02', 'claim check', { recipient, amountAttoFil, balanceBefore: BigInt(before).toString(), balanceAfter: BigInt(after).toString(), difference, matches: difference === amountAttoFil })
}

const unreadable = [] // epochs whose block the node could not serve; recorded as a gap, never hidden

if (contracts.size) {
  // 2. SRA and SWA events
  for (const log of await rpc('eth_getLogs', [{ address: [...contracts.keys()], fromBlock: toHex(from), toBlock: toHex(to) }])) {
    const { name, fields } = decodeLog(log)
    rec('event', Number(log.blockNumber), contracts.get(log.address.toLowerCase()), name, fields, { tx: log.transactionHash, raw: { topics: log.topics, data: log.data } })
  }

  // 3. messages to the SRA, the SWA or one of their owner multisigs, with their result
  for (let epoch = from; epoch <= to; epoch++) {
    let block
    try {
      block = await rpc('eth_getBlockByNumber', [toHex(epoch), true])
    } catch (err) {
      if (/null round/.test(err.message)) continue // an epoch with no block
      unreadable.push({ epoch, reason: err.message.slice(0, 160) }) // usually: the node no longer keeps this block
      continue
    }
    for (const tx of block?.transactions ?? []) {
      const sentTo = tx.to?.toLowerCase()
      if (!contracts.has(sentTo) && !owners.has(sentTo)) continue
      const call = decodeCall(tx.input)
      const target = call.innerTo ?? sentTo
      if (!contracts.has(target)) continue // a multisig doing something unrelated
      const receipt = await rpc('eth_getTransactionReceipt', [tx.hash])
      // a Safe message can succeed while the call inside it fails: the Safe then emits ExecutionFailure
      const innerFailed = receipt.logs.some((l) => decodeLog(l).name === 'ExecutionFailure')
      const ok = receipt.status === '0x1' && !innerFailed
      // A direct call: the chain keeps its revert reason in the receipt. A call sent through a multisig: the
      // receipt holds the multisig's own result, so the reason of the call inside it needs a replay.
      const error = ok ? undefined : call.innerTo ? await replayReason(sentTo, target, call.innerData, call.innerValue, epoch) : await receiptReason(tx.hash)
      rec('message', epoch, contracts.get(target), call.name, call.fields, { from: tx.from, via: owners.get(sentTo), ok, error, tx: tx.hash, raw: { input: tx.input } })
    }
  }
}

// 3b. messages sent to f02 itself (Claim, and any direct call of a stream method). These are native Filecoin
// messages, so they are not in the Eth blocks above. Only from the activation epoch on: before it, f02 has no
// such methods. ponytail: two more requests per epoch; drop when an index serves messages by address.
// Method numbers: solstice src/lib/FVMRewardMethod.sol (FRC-0042 hashes of the method names).
const F02_METHODS = { 386660827: 'RegisterStream', 1623858416: 'RemoveStream', 3362570548: 'SetWeightRecords', 3951753085: 'StepWeightRecords', 3872725033: 'SetDistribution', 187585191: 'CancelPending', 2414422607: 'SetShares', 4045527845: 'Claim', 3068846150: 'ReplaceAddress' }
const f02Id = cfg.f02.slice(1) // "t02" and "f02" name the same actor
for (let epoch = Math.max(from, cfg.activationEpoch || Infinity); epoch <= to; epoch++) {
  let messages
  try {
    const tipset = await rpc('Filecoin.ChainGetTipSetByHeight', [epoch, null])
    if (tipset.Height !== epoch) continue // a null round: the node answers with the tipset before it
    messages = await rpc('Filecoin.ChainGetMessagesInTipset', [tipset.Cids])
  } catch (err) {
    unreadable.push({ epoch, reason: err.message.slice(0, 160) })
    continue
  }
  for (const { Cid, Message: m } of messages ?? []) {
    if (m.To.slice(1) !== f02Id) continue
    const receipt = (await rpc('Filecoin.StateSearchMsg', [null, Cid, -1, true]))?.Receipt
    let params
    try {
      params = m.Params ? plainCbor(dagCbor.decode(Buffer.from(m.Params, 'base64'))) : null
    } catch {
      params = m.Params // kept as sent
    }
    rec('message', epoch, 'f02', F02_METHODS[m.Method] ?? `method ${m.Method}`, { params }, { from: m.From, ok: receipt?.ExitCode === 0, error: receipt?.ExitCode ? `exit code ${receipt.ExitCode}` : undefined, msgCid: Cid['/'] })
  }
}
function plainCbor(v) {
  return v instanceof Uint8Array ? '0x' + Buffer.from(v).toString('hex') : typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(plainCbor) : v
}

// Rule: a gap that cannot be read is recorded, not hidden. Consecutive epochs become one record.
for (let i = 0; i < unreadable.length; ) {
  let j = i
  while (j + 1 < unreadable.length && unreadable[j + 1].epoch === unreadable[j].epoch + 1) j++
  rec('gap', unreadable[i].epoch, 'reader', 'could not be read', { fromEpoch: unreadable[i].epoch, toEpoch: unreadable[j].epoch, reason: unreadable[i].reason })
  i = j + 1
}

// The reason as stored on chain: the message receipt's Return is a CBOR byte string holding the revert data.
async function receiptReason(txHash) {
  const cid = await rpc('Filecoin.EthGetMessageCidByTransactionHash', [txHash])
  const found = await rpc('Filecoin.StateSearchMsg', [null, cid, -1, true])
  const ret = found?.Receipt?.Return
  return decodeRevert(ret ? '0x' + Buffer.from(dagCbor.decode(Buffer.from(ret, 'base64'))).toString('hex') : undefined)
}

// ponytail: the replay runs on the state of the epoch before, so another message in the same epoch can change
// the outcome; the result is labeled as a replay for that reason.
async function replayReason(sender, target, data, value, epoch) {
  try {
    await rpc('eth_call', [{ from: sender, to: target, data, value: toHex(value ?? 0) }, toHex(epoch - 1)])
    return 'replay did not revert'
  } catch (err) {
    return `${decodeRevert(err.rpc?.data)} (from a replay of the inner call)`
  }
}

function pendingKey(w) { return `${slotOf(w)}|${w.effectiveEpoch}` }
function watchWrite(w) { status.pending[pendingKey(w)] ??= { op: w.op, streamId: w.streamId, effectiveEpoch: w.effectiveEpoch, payload: w.payload } }

// The f02 stream state as it was at a past epoch.
async function streamsAt(epoch) {
  const tipset = await rpc('Filecoin.ChainGetTipSetByHeight', [epoch, null])
  const { State } = await rpc('Filecoin.StateReadState', [cfg.f02, tipset.Cids])
  const root = Object.values(State).find((v) => v && typeof v === 'object' && '/' in v)?.['/']
  if (!root) throw new Error('f02 has no stream state at that epoch')
  return decodeStreamsState(Buffer.from(await rpc('Filecoin.ChainReadObj', [{ '/': root }]), 'base64'), cfg.addressPrefix)
}

// 4. reads: values that leave no event. A read is recorded only when its value changed since the last run.
async function read(source, name, fn) {
  let fields
  try {
    fields = await fn()
  } catch (err) {
    fields = { error: err.message }
  }
  const json = JSON.stringify(fields)
  if (status.reads[name] === json) return
  status.reads[name] = json
  rec('read', chainHead, source, name, fields)
}

async function view(address, functionName, args = []) {
  const data = encodeFunctionData({ abi, functionName, args })
  try {
    const out = decodeFunctionResult({ abi, functionName, data: await rpc('eth_call', [{ to: address, data }, 'latest']) })
    const outputName = abi.find((x) => x.type === 'function' && x.name === functionName).outputs[0].name || 'result'
    return { [outputName]: plain(out) }
  } catch (err) {
    return { reverted: decodeRevert(err.rpc?.data) }
  }
}

let streamsRoot
await read('f02', 'f02 state', async () => {
  const { State } = await rpc('Filecoin.StateReadState', [cfg.f02, null])
  streamsRoot = Object.values(State).find((v) => v && typeof v === 'object' && '/' in v)?.['/'] // the one CID in the state
  return Object.fromEntries(Object.entries(State).filter(([k]) => !NOISY.includes(k)))
})
if (streamsRoot) {
  await read('f02', 'f02 streams', async () => {
    const state = decodeStreamsState(Buffer.from(await rpc('Filecoin.ChainReadObj', [{ '/': streamsRoot }]), 'base64'), cfg.addressPrefix)
    state.pendingWrites.forEach(watchWrite) // the queue in the state is the second source of queued writes, next to the events
    return state
  })
}

// 5. outcome of every queued write, read at its effective epoch. f02 writes no visible event when a due write takes
// effect or is dropped inside a block reward (FIP-0118 §2.4.9), so the state is the only evidence. A write with
// effective epoch E is handled while tipset E executes, so its effect shows in the state of tipset E+1; E+2 is read
// too when E+1 still shows it queued (an epoch without a block).
for (const [key, write] of Object.entries(status.pending)) {
  const E = write.effectiveEpoch
  if (E + 2 > chainHead - LAG) continue // not due yet
  let outcome, readAt
  try {
    for (readAt of [E + 1, E + 2]) {
      outcome = writeOutcome(write, await streamsAt(readAt))
      if (outcome !== 'still queued') break
    }
  } catch (err) {
    outcome = `could not be read: ${err.message.slice(0, 120)}` // usually: the node no longer keeps that state
  }
  if (outcome === 'still queued' && chainHead - E < 20) continue // give it a few more epochs before saying so
  rec('read', readAt, 'f02', 'queued write outcome', { op: write.op, streamId: write.streamId ?? null, effectiveEpoch: E, outcome, readAtEpoch: readAt, payload: write.payload })
  delete status.pending[key]
}
for (const [label, address] of Object.entries(cfg.wallets)) {
  await read('balance', `balance of ${label}`, async () => ({ address, attoFil: BigInt(await rpc('eth_getBalance', [address, 'latest'])).toString() }))
}
const sra = [...contracts].find(([, n]) => n === 'SRA')?.[0]
if (sra) {
  const q = quarterOf(cfg, chainHead)
  await read('SRA', 'SRA admittedCount', () => view(sra, 'admittedCount'))
  await read('SRA', 'SRA orchestratorCount', () => view(sra, 'orchestratorCount'))
  for (const past of [q - 1, q - 2].filter((x) => x >= 1)) {
    await read('SRA', `SRA aggregatedFilecoinPayVolume(${past})`, () => view(sra, 'aggregatedFilecoinPayVolume', [BigInt(past)]))
  }
}

records.sort((a, b) => a.epoch - b.epoch)
if (records.length) appendFileSync(recordsPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
// rpcUrl, f02 and addressPrefix are here for the page's live read of f02
const { network, rpcUrl, f02, addressPrefix, genesisTimestamp, epochSeconds, activationEpoch, epochsPerQuarter, swaTimelockEpochs } = cfg
writeFileSync(statusPath, JSON.stringify({ network, rpcUrl, f02, addressPrefix, genesisTimestamp, epochSeconds, activationEpoch, epochsPerQuarter, swaTimelockEpochs, lastEpoch: to, lastRun: new Date().toISOString(), reads: status.reads, pending: status.pending }, null, 2))
console.log(`epochs ${from}..${to} (chain head ${chainHead}): ${records.length} new records -> ${recordsPath}`)
