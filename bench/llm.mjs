/** One way to call every free provider the benchmark uses, and one record of every call. */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const PROVIDERS = {
  groq: { base: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY' },
  openrouter: { base: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY' },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'GEMINI_API_KEY' }
};

function loadKeys() {
  const keys = {};
  const files = (process.env.BENCH_ENV_FILES ?? '').split(path.delimiter).filter(Boolean);
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, '');
      if (value && !keys[match[1]]) keys[match[1]] = value;
    }
  }
  for (const { key } of Object.values(PROVIDERS)) {
    if (process.env[key]) keys[key] = process.env[key];
  }
  return keys;
}

const KEYS = loadKeys();

export function hasProvider(provider) {
  return Boolean(KEYS[PROVIDERS[provider]?.key]);
}

function headers(provider) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${KEYS[PROVIDERS[provider].key]}`,
    // Groq sits behind Cloudflare, which answers 403 "error code: 1010" to a client with no
    // User-Agent.
    'user-agent': 'agent-shared-memory-bench/1.0',
    ...(provider === 'openrouter' ? { 'x-title': 'agent-shared-memory bench' } : {})
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function listModels(provider) {
  const response = await fetch(`${PROVIDERS[provider].base}/models`, { headers: headers(provider) });
  if (!response.ok) throw new Error(`${provider} /models -> ${response.status}`);
  const body = await response.json();
  return body.data ?? body.models ?? [];
}

/** Calls whose response was a quota refusal, per provider/model -- reported, never retried forever. */
export class QuotaExhausted extends Error {}

/** One chat completion, retried through rate limits and transient failures. */
export async function chat({ provider, model, messages, tools, temperature = 0.2, maxTokens = 4096, meta = {}, log }) {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {})
  };

  // Per-minute limits always clear, so they get many attempts.
  let malformed = 0;
  for (let attempt = 1; attempt <= 25; attempt++) {
    const started = Date.now();
    let response;
    let text = '';
    try {
      response = await fetch(`${PROVIDERS[provider].base}/chat/completions`, {
        method: 'POST',
        headers: headers(provider),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000)
      });
      text = await response.text();
    } catch (error) {
      record(log, { ...meta, provider, model, attempt, status: 'network', ms: Date.now() - started, error: String(error).slice(0, 200) });
      if (attempt > 6) break;
      await sleep(2000 * Math.min(attempt, 5));
      continue;
    }

    const ms = Date.now() - started;
    if (response.ok) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        record(log, { ...meta, provider, model, attempt, status: 'bad-json', ms });
        if (attempt > 6) break;
        await sleep(2000 * Math.min(attempt, 5));
        continue;
      }
      // OpenRouter can answer 200 with an error object from the upstream model.
      if (parsed.error || !parsed.choices?.length) {
        record(log, { ...meta, provider, model, attempt, status: 'upstream-error', ms, error: JSON.stringify(parsed.error ?? parsed).slice(0, 300) });
        if (attempt > 6) break;
        await sleep(3000 * Math.min(attempt, 5));
        continue;
      }
      const usage = parsed.usage ?? {};
      record(log, {
        ...meta,
        provider,
        model,
        attempt,
        status: 200,
        ms,
        prompt_tokens: usage.prompt_tokens ?? null,
        completion_tokens: usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
        cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? null,
        finish: parsed.choices[0].finish_reason
      });
      return { message: parsed.choices[0].message, usage, ms };
    }

    record(log, { ...meta, provider, model, attempt, status: response.status, ms, error: text.slice(0, 300) });

    // A request larger than the per-minute budget will never fit, however long we wait.
    if (response.status === 413 || /reduce the length|too large|context.length|maximum context/i.test(text)) {
      throw new Error(`request too large for ${provider}/${model}`);
    }
    if (response.status === 429) {
      // A daily quota will not come back within this run; a per-minute one will.
      if (/per.?day|PerDay|daily|RPD|TPD|free-models-per-day/i.test(text)) {
        throw new QuotaExhausted(`${provider}/${model}: daily quota`);
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const hinted = /try again in ([\d.]+)(ms|s)/i.exec(text);
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : hinted
          ? Number(hinted[1]) * (hinted[2] === 'ms' ? 1 : 1000)
          : 10_000 * attempt;
      await sleep(Math.min(wait + 500, 90_000));
      continue;
    }
    if (response.status >= 500) {
      if (attempt > 6) break;
      await sleep(3000 * Math.min(attempt, 5));
      continue;
    }
    // gpt-oss on Groq sometimes emits a tool call its own server cannot parse.
    if (response.status === 400 && /parse tool call|tool call validation/i.test(text) && malformed < 3) {
      malformed++;
      continue;
    }
    throw new Error(`${provider}/${model} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  throw new Error(`${provider}/${model}: gave up after 25 attempts`);
}

function record(log, entry) {
  if (!log) return;
  mkdirSync(path.dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
}
