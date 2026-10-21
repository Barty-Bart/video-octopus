// Claude's stream can report a single window or legacy unified windows.
// Model-specific weekly and overage limits must not be labelled as the whole plan.
export function claudeUsage(info, at = Date.now()) {
 const ratio = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
 const windows = info?.unifiedWindows || {};
 const out = {engine:'claude', at, fiveHour:ratio(windows.five_hour?.utilization), sevenDay:ratio(windows.seven_day?.utilization)};
 const key = {five_hour:'fiveHour',seven_day:'sevenDay'}[info?.rateLimitType];
 if (key) out[key] = ratio(info.utilization);
 return out.fiveHour == null && out.sevenDay == null ? null : out;
}
