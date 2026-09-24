// One Slack message per reader run that found something new. The webhook URL comes from the environment
// (SLACK_WEBHOOK, a GitHub secret); without it nothing is sent. A failed post never fails the run.
// Slack accepts {"text": "..."} for both an Incoming WebHook and a Workflow Builder webhook with a `text` variable.
const PAGE = 'https://solsticewatchtower.eth.limo/'
const MAX_LINES = 40

const flat = (v) => (v === null || v === undefined ? '–' : Array.isArray(v) ? v.map(flat).join(', ') : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${flat(x)}`).join(', ') : String(v))

// The records worth a message: events, messages, gaps, and the two reads that judge something.
export const notable = (r) => r.kind !== 'read' || r.name === 'queued write outcome' || r.name === 'claim check'

export function slackLine(r) {
  const result = r.kind === 'message' ? (r.ok ? 'ok' : `REVERTED ${r.error ?? ''}`) : r.name === 'claim check' ? (r.fields.matches ? 'matches' : 'DOES NOT MATCH') : r.kind === 'gap' ? 'NOT READ' : ''
  const who = r.via ? ` via ${r.via}` : ''
  return `• ${r.time.slice(11, 16)} UTC · ${r.source} ${r.kind} \`${r.name}\`${who} ${result} · ${flat(r.fields).slice(0, 140)}`
}

export function slackText(records, cfg, from, to) {
  const lines = records.filter(notable).map(slackLine)
  if (!lines.length) return null
  const more = lines.length > MAX_LINES ? `\n… and ${lines.length - MAX_LINES} more, see the page` : ''
  const view = cfg.network === 'calibnet' ? PAGE : `${PAGE}?data=${cfg.network}`
  return `*${cfg.network}* · epochs ${from} to ${to} · ${lines.length} new\n${lines.slice(0, MAX_LINES).join('\n')}${more}\n${view}`
}

export async function notify(records, cfg, from, to) {
  const url = process.env.SLACK_WEBHOOK
  if (!url || cfg.notify === false) return
  const text = slackText(records, cfg, from, to)
  if (!text) return
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    if (!res.ok) console.error(`slack: ${res.status} ${(await res.text()).slice(0, 200)}`)
  } catch (err) {
    console.error(`slack: ${err.message}`) // never fail the run over a notification
  }
}
