import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';

export const AI_PROTOCOLS = [
  'openai_chat',
  'openai_responses',
  'anthropic_messages',
  'gemini_generate_content',
  'ollama_generate',
] as const;

export type AiProtocol = typeof AI_PROTOCOLS[number];

export interface LlmConnectionConfig {
  provider: string;
  apiProtocol: AiProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface LlmRequest {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 1_000_000;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] >= 224;
}

function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1'
      || normalized === '::'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.');
  }
  return true;
}

export function normalizeConnectionConfig(input: any, apiKey = ''): LlmConnectionConfig {
  const provider = String(input?.provider || '').trim().slice(0, 100);
  const apiProtocol = String(input?.apiProtocol || input?.api_protocol || '') as AiProtocol;
  const baseUrl = String(input?.baseUrl || input?.base_url || '').trim().replace(/\/+$/, '');
  const model = String(input?.model || '').trim().slice(0, 200);
  if (!provider) throw new Error('API provider is required');
  if (!AI_PROTOCOLS.includes(apiProtocol)) throw new Error('Unsupported API protocol');
  if (!baseUrl) throw new Error('Base URL is required');
  if (!model) throw new Error('Model is required');
  if (!apiKey && apiProtocol !== 'ollama_generate') throw new Error('API key is required');
  return { provider, apiProtocol, baseUrl, apiKey, model };
}

export async function assertSafeProviderUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Base URL is invalid');
  }
  if (url.username || url.password) throw new Error('Credentials are not allowed in Base URL');
  const production = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  if (production && url.protocol !== 'https:') throw new Error('Base URL must use HTTPS in production');
  if (!production && !['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL must use HTTP or HTTPS');

  if (production) {
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('Local/private URLs are not allowed');
    const addresses = net.isIP(hostname)
      ? [{ address: hostname }]
      : await dns.lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new Error('Local/private URLs are not allowed');
    }
  }
  return url;
}

function endpoint(baseUrl: string, suffix: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith(suffix) ? normalized : `${normalized}${suffix}`;
}

function safeProviderError(status: number, _body: string): Error {
  // Provider error bodies are deliberately not forwarded: some gateways echo
  // request headers, URLs, or credentials in their diagnostics.
  return new Error(`LLM API returned ${status}`);
}

async function readResponse(response: Response): Promise<any> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('LLM response is too large');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('LLM response is too large');
  if (!response.ok) throw safeProviderError(response.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('LLM returned an invalid JSON envelope');
  }
}

export async function callLlm(config: LlmConnectionConfig, request: LlmRequest): Promise<string> {
  await assertSafeProviderUrl(config.baseUrl);
  const timeoutMs = Math.max(1_000, Math.min(request.timeoutMs || 60_000, 120_000));
  const maxOutputTokens = Math.max(32, Math.min(request.maxOutputTokens || 8_000, 32_000));
  const temperature = Math.max(0, Math.min(request.temperature ?? 0.1, 2));
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let url = config.baseUrl;
  let body: Record<string, unknown>;

  if (config.apiProtocol === 'openai_chat') {
    url = endpoint(url, '/chat/completions');
    headers.Authorization = `Bearer ${config.apiKey}`;
    body = {
      model: config.model,
      messages: [
        ...(request.system ? [{ role: 'system', content: request.system }] : []),
        { role: 'user', content: request.prompt },
      ],
      temperature,
      max_tokens: maxOutputTokens,
    };
  } else if (config.apiProtocol === 'openai_responses') {
    url = endpoint(url, '/responses');
    headers.Authorization = `Bearer ${config.apiKey}`;
    body = {
      model: config.model,
      instructions: request.system,
      input: request.prompt,
      temperature,
      max_output_tokens: maxOutputTokens,
    };
  } else if (config.apiProtocol === 'anthropic_messages') {
    url = endpoint(url, '/v1/messages');
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: config.model,
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
      temperature,
      max_tokens: maxOutputTokens,
    };
  } else if (config.apiProtocol === 'gemini_generate_content') {
    const model = encodeURIComponent(config.model);
    url = endpoint(url, `/models/${model}:generateContent`);
    const parsed = new URL(url);
    parsed.searchParams.set('key', config.apiKey);
    url = parsed.toString();
    body = {
      systemInstruction: request.system ? { parts: [{ text: request.system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' },
    };
  } else {
    url = endpoint(url, '/api/generate');
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    body = {
      model: config.model,
      system: request.system,
      prompt: request.prompt,
      stream: false,
      format: 'json',
      options: { temperature, num_predict: maxOutputTokens },
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) throw new Error('LLM redirects are not allowed');
  const data = await readResponse(response);

  if (config.apiProtocol === 'openai_chat') return String(data?.choices?.[0]?.message?.content || '');
  if (config.apiProtocol === 'openai_responses') {
    if (typeof data?.output_text === 'string') return data.output_text;
    const texts = (data?.output || []).flatMap((item: any) => item?.content || []).map((item: any) => item?.text).filter(Boolean);
    return texts.join('\n');
  }
  if (config.apiProtocol === 'anthropic_messages') {
    return (data?.content || []).map((item: any) => item?.text).filter(Boolean).join('\n');
  }
  if (config.apiProtocol === 'gemini_generate_content') {
    return (data?.candidates?.[0]?.content?.parts || []).map((item: any) => item?.text).filter(Boolean).join('\n');
  }
  return String(data?.response || '');
}

export function connectionFingerprint(config: LlmConnectionConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    provider: config.provider,
    apiProtocol: config.apiProtocol,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyHash: crypto.createHash('sha256').update(config.apiKey).digest('hex'),
  })).digest('hex');
}
