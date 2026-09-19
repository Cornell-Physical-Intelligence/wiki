import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Public catalog, shared with the custom admin menus. Effort support is from
// the OpenAI model reference, not inferred from Codex's separate model menu.
const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
export const AI_MODELS = [
  { id: 'gpt-5.6-luna', label: 'Luna', description: 'Fastest', efforts },
  { id: 'gpt-5.6-sol', label: 'Sol', description: 'More capable', efforts },
  { id: 'gpt-6-astra', label: 'Astra', description: 'Most capable', efforts: efforts.slice(1) },
];
export const AI_DEFAULTS = { model: 'gpt-5.6-luna', effort: 'none' };

export function aiSelection(settings = {}) {
  const model = AI_MODELS.find((m) => m.id === settings.model) || AI_MODELS[0];
  return { model: model.id, effort: model.efforts.includes(settings.effort) ? settings.effort : model.efforts[0] };
}

export function validateAiSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Invalid AI settings' };
  const model = AI_MODELS.find((m) => m.id === body.model);
  if (!model || !model.efforts.includes(body.effort)) return { error: 'Choose a supported model and effort level' };
  if (body.key !== undefined && typeof body.key !== 'string') return { error: 'Enter an OpenAI API key' };
  const key = (body.key || '').trim();
  if (key && !/^sk-[A-Za-z0-9_-]{16,500}$/.test(key)) return { error: 'That does not look like an OpenAI API key' };
  return { value: { model: model.id, effort: body.effort, key } };
}

function encryptionKey() {
  const secret = process.env.WIKI_CREDENTIAL_SECRET || process.env.SESSION_SECRET
    || (!process.env.VERCEL && process.env.DEV_FAKE_AUTH ? 'local-preview-only' : '');
  if (!secret) throw new Error('Credential storage is not configured on this server');
  return createHash('sha256').update('cupi-wiki/ai-credential/v1/' + secret).digest();
}

export function sealAiKey(key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from('cupi-wiki/openai'));
  const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function openAiKey(value) {
  if (!value || value.v !== 1) return '';
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'));
  decipher.setAAD(Buffer.from('cupi-wiki/openai'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
}

export function aiPublicSettings(settings = {}, admin = false) {
  const enabled = settings.enabled !== false;
  const keySet = !!settings.credential;
  const source = keySet ? 'saved' : process.env.OPENAI_API_KEY ? 'environment' : 'none';
  return { ...aiSelection(settings), enabled, connected: enabled && source !== 'none', revision: settings.updatedAt || 0,
    ...(admin ? { keySet, keyTail: keySet ? settings.keyTail || '' : '', source } : {}) };
}

export function resolveAiConnection(settings = {}) {
  const selection = aiSelection(settings);
  if (settings.enabled === false) return { ...selection, apiKey: '' };
  // A saved key is authoritative; an invalid replacement cannot silently bill
  // a different account via the deployment's environment key.
  try { return { ...selection, apiKey: settings.credential ? openAiKey(settings.credential) : process.env.OPENAI_API_KEY || '' }; }
  catch { return { ...selection, apiKey: '' }; }
}
