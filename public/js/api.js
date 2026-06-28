// Thin fetch wrappers around the localhost REST surface. All same-origin.

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `${path} → ${res.status}`);
  return data;
}

export const fetchState = () => getJson('/api/state');
export const fetchHistory = (limit = 50) => getJson(`/api/history?limit=${limit}`);
export const fetchHealth = () => getJson('/api/health');

/** Acknowledge an alarm: server clears the flag → card relocates to "In stock now". */
export const silence = (id) => postJson('/api/silence', { id });

/** Drop a family from the watched set (persists to config + reloads). */
export const removeFamily = (family) => postJson('/api/watchlist/remove', { family });
