// Agent-reported snapshots, never an account polling API. Unknown is not zero.
export const USAGE_MAX_AGE = 5 * 60 * 1000;
export function usageView(snapshot, engine = 'claude', now = Date.now()) {
 const at = Number(snapshot?.at), age = now - at;
 const valid = snapshot?.engine === engine && Number.isFinite(at) && at > 0 && age >= 0 && age < USAGE_MAX_AGE;
 const percent = key => valid && typeof snapshot[key] === 'number' && Number.isFinite(snapshot[key]) && snapshot[key] >= 0 && snapshot[key] <= 1 ? Math.round(snapshot[key] * 100) : null;
 return { fiveHour: percent('fiveHour'), sevenDay: percent('sevenDay'), at: valid ? at : null,
  note: valid ? `Last reported ${new Date(at).toLocaleTimeString()} · not live` : 'Current usage unavailable · updates when the agent reports it' };
}
