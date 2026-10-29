// The log of resumes Kevin has tailored, kept on this device only (it holds full resume text).
export const STATUSES = ['Drafted', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn'];
const CAP = 60;

export function addEntry(list, entry, now = new Date()) {
  const full = { id: `h${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: now.toISOString(), status: 'Drafted', ...entry };
  return { list: [full, ...list].slice(0, CAP), entry: full };
}

export const updateEntry = (list, id, patch) => list.map((e) => (e.id === id ? { ...e, ...patch } : e));
export const removeEntry = (list, id) => list.filter((e) => e.id !== id);

export function label(entry) {
  return [entry.title, entry.company].filter(Boolean).join(' at ') || 'Untitled posting';
}
