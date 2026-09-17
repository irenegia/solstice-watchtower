// JSON-RPC calls to a Filecoin node, plus the two clock rules: epoch -> time and epoch -> quarter.

export function makeRpc(url) {
  let id = 0
  return async function rpc(method, params = []) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        })
        const body = await res.json()
        if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { rpc: body.error })
        return body.result
      } catch (err) {
        if (err.rpc || attempt === 3) throw err // the node answered with an error: retrying will not help
        await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
    }
  }
}

export const toHex = (n) => '0x' + BigInt(n).toString(16)

export const epochToTime = (cfg, epoch) =>
  new Date((cfg.genesisTimestamp + epoch * cfg.epochSeconds) * 1000).toISOString()

// FIP-0118 §2.2: "Quarter Q is [Start(Q), Start(Q+1)), with
// Start(Q) = ACTIVATION_EPOCH + (Q-1) * EPOCHS_PER_QUARTER". 0 means before activation.
export function quarterOf(cfg, epoch) {
  if (!cfg.activationEpoch || epoch < cfg.activationEpoch) return 0
  return Math.floor((epoch - cfg.activationEpoch) / cfg.epochsPerQuarter) + 1
}
