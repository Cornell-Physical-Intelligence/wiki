import { createHash } from 'node:crypto';

const cache = new Map();
export async function evaluateJev(state, questions, { apiKey = process.env.TYPESAFE_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) return { available: false };
  const body = JSON.stringify({ model: 'jev-latest', state, questions });
  const key = createHash('sha256').update(apiKey + body).digest('hex');
  const now = Date.now();
  for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
  if (cache.has(key)) return cache.get(key).promise;
  while (cache.size >= 100) cache.delete(cache.keys().next().value);
  const promise = (async () => {
    try {
      const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body, signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) return { available: false };
      const data = await response.json();
      return data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers)
        ? { available: true, answers: data.answers } : { available: false };
    } catch { return { available: false }; }
  })();
  const entry = { promise, expires: now + 10 * 60 * 1000 };
  cache.set(key, entry);
  const result = await promise;
  if (!result.available && cache.get(key) === entry) entry.expires = Date.now() + 10000;
  return result;
}

export function validCandidates(value, maxCount = 32, maxExcerpt = 700) {
  if (!Array.isArray(value) || value.length > maxCount) return false;
  const ids = new Set();
  return value.every((item) => {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 160 || ids.has(item.id)
      || typeof item.title !== 'string' || item.title.length > 90
      || typeof item.excerpt !== 'string' || item.excerpt.length > maxExcerpt) return false;
    ids.add(item.id); return true;
  });
}

export const yesProbability = (answer) => answer?.type === 'noul' && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1 ? answer.noul : 0;
