// Short, process-local exclusion for app/skill updates. No timers, IO or settings on import.
let operation = null;
let probe = () => [];
let writes = 0;
export const setActivityProbe = (fn) => { probe = fn; };
export const beginWrite = () => { writes++; let finished = false; return () => { if (!finished) { finished = true; writes--; } }; };
export const maintenanceActive = () => Boolean(operation);
export function activityView() {
  const reasons = [...(operation ? [operation] : []), ...(writes ? ['An edit, upload or setup request is still finishing.'] : []), ...probe()].filter(Boolean);
  return { busy: reasons.length > 0, reasons };
}
export function beginMaintenance(label) {
  const view = activityView();
  if (view.busy) throw new Error(`Finish current work before updating: ${view.reasons.join(' ')}`);
  operation = label;
}
export const endMaintenance = () => { operation = null; };
export function assertNotUpdating() {
  if (operation) throw new Error(`${operation} New work is paused until it finishes or the app restarts.`);
}
