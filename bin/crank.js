#!/usr/bin/env node
// Backup cranker: sends the two permissionless Solstice calls when they are due and nobody else sent them.
//   submitShares(q)       on the SRA, once quarter q is bound and lastSubmittedQuarter < q
//   quarterlyGateCheck()  on the SWA, once the next quarter is bound and the hold is over
// Each call is simulated first (eth_call); a call that would revert is never sent, so a run with nothing due
// costs nothing. Backup, not a race: a call is sent only when its simulation has passed for CRANK_DELAY epochs
// (30 minutes on calibnet), which leaves the primary cranker (decentramike/solstice-cranker) time to act first.
// The "possible since" epoch is kept in <dataDir>/crank.json between runs. Without CRANK_KEY the run is a dry run.
// The Claim (f02) is not here: it needs an f1/f3 sender, and this key is an f410 (MetaMask) account.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, http, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { abi, decodeRevert } from '../lib/evm.js'

const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'config/calibnet.json', 'utf8'))
const DELAY = cfg.crankDelayEpochs ?? 60 // 30 minutes at 30 s per epoch
const chain = { id: cfg.chainId, name: cfg.network, nativeCurrency: { name: 'FIL', symbol: 'FIL', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } }
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) })
const key = process.env.CRANK_KEY && (process.env.CRANK_KEY.startsWith('0x') ? process.env.CRANK_KEY : '0x' + process.env.CRANK_KEY)
const account = key ? privateKeyToAccount(key) : null
const wallet = account ? createWalletClient({ account, chain, transport: http(cfg.rpcUrl) }) : null
const statePath = join(cfg.dataDir, 'crank.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { possibleSince: {} }

// The revert data sits somewhere down viem's error chain; decode it with the contracts' ABI, else keep viem's words.
const revertReason = (err) => { for (let e = err; e; e = e.cause) if (typeof e.data === 'string' && e.data.startsWith('0x') && e.data.length > 2) return decodeRevert(e.data); return err.shortMessage ?? err.message }

const head = Number(await pub.getBlockNumber())
const word = async (address, slot) => BigInt(await pub.getStorageAt({ address, slot }))
// SRA: SraStorageQuarter at QUARTER_SLOT, lastSubmittedQuarter in the low 8 bytes (SraStorage.sol).
const lastSubmitted = Number((await word(cfg.sra, '0x347e624280399e1e720d839edbd7cd00c80c69bf34cd8ee59e27f691732af300')) & 0xffffffffffffffffn)
// SWA: GateParamsInfo at GATE_PARAMS_SLOT: lastCheckedQuarter, then target.base, target.stepRatio, steps (GateParams.sol).
const GATE = 0xf9abab00248d945495524c8caf6be2b837274c1becd1964fb3775f62fd6e4600n
const lastChecked = Number(await word(cfg.swa, '0x' + GATE.toString(16)))
const steps = Number(await word(cfg.swa, '0x' + (GATE + 3n).toString(16)))
const bound = (q) => cfg.activationEpoch + q * cfg.epochsPerQuarter + cfg.postPeriod + cfg.verificationWindow // quarter q binds here
const quarterNow = Math.floor((head - cfg.activationEpoch) / cfg.epochsPerQuarter) + 1
console.log(`${cfg.network} epoch ${head} (quarter ${quarterNow}) · lastSubmittedQuarter ${lastSubmitted} · gate lastCheckedQuarter ${lastChecked}, steps ${steps} · ${account ? 'key ' + account.address : 'DRY RUN, no key'}`)

// The calls that may be due. submitShares(q) for the newest bound quarter the SRA has not submitted (the SRA counts
// skipped quarters as submitted when a later one lands); quarterlyGateCheck if the quarter it would read is bound.
const due = []
for (let q = lastSubmitted + 1; q < quarterNow; q++) if (head >= bound(q)) due.push({ name: 'submitShares', to: cfg.sra, args: [BigInt(q)], key: `submitShares(${q})` })
if (steps < 8 && head >= bound(lastChecked + 1)) due.push({ name: 'quarterlyGateCheck', to: cfg.swa, args: [], key: `quarterlyGateCheck(${lastChecked + 1})` })
if (!due.length) console.log('nothing due')

for (const call of due) {
  const data = encodeFunctionData({ abi, functionName: call.name, args: call.args })
  let ok = true, reason = ''
  try { await pub.call({ to: call.to, data, account: account?.address }) } catch (err) { ok = false; reason = revertReason(err) }
  if (!ok) { delete state.possibleSince[call.key]; console.log(`${call.key}: not possible yet (${reason})`); continue }
  const since = state.possibleSince[call.key] ??= head
  const waited = head - since
  if (waited < DELAY) { console.log(`${call.key}: possible since epoch ${since}, waiting for the primary cranker (${DELAY - waited} epochs left)`); continue }
  if (!wallet) { console.log(`${call.key}: would send now (dry run)`); continue }
  const hash = await wallet.sendTransaction({ to: call.to, data })
  console.log(`${call.key}: sent ${hash}`)
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  console.log(`${call.key}: ${receipt.status} in block ${receipt.blockNumber}`)
  delete state.possibleSince[call.key]
}
writeFileSync(statePath, JSON.stringify({ possibleSince: state.possibleSince, lastRun: new Date().toISOString(), head }, null, 2))
