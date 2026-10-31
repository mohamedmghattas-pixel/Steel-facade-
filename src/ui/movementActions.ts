/** Movement / survey commands shared by the UI and the assistant. */
import { derived, useStore } from '../state/store';
import { download, safeName } from '../state/storage';
import { settingOutCsv, settingOutXlsx } from '../core/survey';

/** Download the setting-out table (XLSX also carries the survey points and the movement report). */
export function exportSettingOut(kind: 'csv' | 'xlsx') {
  const p = useStore.getState().project;
  const dm = derived(p);
  const base = safeName(p.info.name);
  if (kind === 'csv') download(`${base}-setting-out.csv`, settingOutCsv(p, dm), 'text/csv');
  else download(`${base}-setting-out.xlsx`, settingOutXlsx(p, dm), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
