/**
 * СМЭШ AI inference gateway.
 *
 * The extension starts a bounded server-side job and reads its output through
 * short authenticated polls. New work is authorized locally with a short-lived
 * HMAC capability issued by the license Worker; raw license keys and activation
 * tokens are never accepted here. Quotas, processor routing, feature switches,
 * upload capabilities and no-content operational logging are enforced in this
 * process. Caddy terminates TLS and proxies only to the loopback listener.
 *
 * Zero npm runtime dependencies: Node 24 built-ins only.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

/* ------------------------------- config ------------------------------- */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function parsePort(value) {
  const port = Number(value || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid PORT: expected an integer from 1 to 65535.');
  }
  return port;
}

function parseLoopbackHost(value) {
  const host = String(value || '127.0.0.1').trim().toLowerCase();
  // Client-IP and per-IP admission rely on Caddy being the only network peer.
  // Refuse an accidental public bind instead of trusting X-Forwarded-For from
  // arbitrary clients.
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('Invalid HOST: smesh-proxy must listen on loopback behind Caddy.');
  }
  return host;
}

function parseServiceUrl(name, value, fallback) {
  let url;
  try { url = new URL(String(value || fallback)); }
  catch { throw new Error(`Invalid ${name}: expected an absolute HTTPS URL.`); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error(`Invalid ${name}: HTTPS is required outside loopback tests.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid ${name}: credentials, query strings, and fragments are not allowed.`);
  }
  return url.toString().replace(/\/+$/, '');
}

const PORT = parsePort(process.env.PORT);
const HOST = parseLoopbackHost(process.env.HOST);

// 302.AI (OpenAI-compatible). ai-proxy.js appends /chat/completions itself.
const UPSTREAM_BASE_URL = parseServiceUrl(
  'AI_PROXY_BASE_URL',
  process.env.AI_PROXY_BASE_URL,
  'https://api.302.ai/v1'
);
const UPSTREAM_KEY = process.env.AI_PROXY_API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
// A separate, narrowly-scoped credential for live model routing. Unlike
// ADMIN_KEY it cannot invoke diagnostic completions; unlike the 302.AI key it
// cannot be used at the provider. It is safe to type into the owner dashboard
// for one browser session, but must still be a high-entropy secret.
const MODEL_ADMIN_KEY = process.env.MODEL_ADMIN_KEY || '';
// Shared only with the license Worker. Clients receive signed, ten-minute AI
// capabilities; the VPS never receives or stores their license/activation keys.
const ENTITLEMENT_SECRET = process.env.ENTITLEMENT_SECRET || '';
const ENTITLEMENT_SECRET_VALID = Buffer.byteLength(ENTITLEMENT_SECRET) >= 32 &&
  Buffer.byteLength(ENTITLEMENT_SECRET) <= 512;
const RUNTIME_CONFIG_PRIVATE_KEY_B64 = process.env.RUNTIME_CONFIG_PRIVATE_KEY_B64 || '';
function parseDashboardOrigin(value) {
  const raw = String(value || 'https://ayeepat.github.io').replace(/\/+$/, '');
  let url;
  try { url = new URL(raw); } catch { return ''; }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.origin !== raw ||
      url.username || url.password || url.search || url.hash) return '';
  return raw;
}
const MODEL_DASHBOARD_ORIGIN = parseDashboardOrigin(process.env.MODEL_DASHBOARD_ORIGIN);
const MODEL_ADMIN_KEY_VALID = Buffer.byteLength(MODEL_ADMIN_KEY) >= 32 &&
  Buffer.byteLength(MODEL_ADMIN_KEY) <= 256;

// Opt-in server-side usage reporting → the license worker's POST /t/ai (see
// backend/src/analytics.js handleServerIngest). Off unless INGEST_KEY is set
// (must match the worker's INGEST_KEY secret); each request must also carry a
// strict telemetry_opt_in:true flag from extension storage.
const INGEST_URL = parseServiceUrl(
  'INGEST_URL',
  process.env.INGEST_URL,
  'https://smeshapi.site/t/ai'
);
const INGEST_KEY = process.env.INGEST_KEY || '';

// Keep active/complex formats such as SVG away from the shared paid upstream
// parser. The extension only produces these raster formats.
const SAFE_IMAGE_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i;
const PDF_DATA_URI_PREFIX = 'data:application/pdf;base64,';
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

// Where the daily quota counters persist. Admission is fail-closed unless the
// updated counters have been atomically written and fsynced.
const QUOTA_FILE = process.env.QUOTA_FILE || '/var/lib/smesh-proxy/quota.json';
const MODEL_CONFIG_FILE = process.env.MODEL_CONFIG_FILE || '/var/lib/smesh-proxy/model-config.json';
// Deep readiness probes exercise create/fsync/rename, but /ready is public and
// must not turn every monitoring request into synchronous disk writes. Actual
// admissions also refresh this proof when they durably reserve quota.
const configuredQuotaProbeMs = Number(process.env.QUOTA_READINESS_DEEP_PROBE_MS);
const QUOTA_READINESS_DEEP_PROBE_MS = Number.isSafeInteger(configuredQuotaProbeMs) &&
  configuredQuotaProbeMs >= 1000 && configuredQuotaProbeMs <= 5 * 60_000
  ? configuredQuotaProbeMs
  : 60_000;
// A normal day can contain at most GLOBAL_DAILY admissions, so two MiB leaves
// generous migration headroom while preventing a corrupt local file from
// turning startup/readiness into an unbounded synchronous allocation.
const MAX_QUOTA_FILE_BYTES = 2 * 1024 * 1024;

const env = process.env;
function safeErrorCode(error) {
  const name = typeof error?.name === 'string' && /^[A-Za-z]{1,32}$/.test(error.name)
    ? error.name : 'Error';
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code)
    ? error.code : 'UNCLASSIFIED';
  return `${name}:${code}`;
}
const quotaConfigErrors = [];
const boundedQuotaVar = (name, v, fallback, min, max) => {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    quotaConfigErrors.push(`${name} must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return n;
};

// One model answers everything that is not a PDF: qwen3.8-flash is multimodal
// (text + images), cheaper per token than qwen3.7-plus on both sides, and —
// unlike the 3.7 line — exposes a real reasoning_effort dial. qwen3.7-plus
// stays as the first fallback rather than being deleted: it is the model this
// service ran on for months, so a qwen3.8-flash outage or de-listing degrades
// to something already proven live instead of to nothing.
const PROVIDERS = {
  qwen: {
    name: 'Qwen',
    model: (env.PROXY_QWEN_MODEL || 'qwen3.8-flash').trim(),
    fallbacks: (env.PROXY_QWEN_FALLBACK_MODELS || 'qwen3.7-plus,qwen-vl-plus,qwen-plus'),
    visionFallbacks: (env.PROXY_QWEN_VISION_FALLBACK_MODELS || 'qwen3.7-plus,qwen-vl-plus'),
    reasoningEffort: true
  },
  deepseek: {
    // `deepseek` is a frozen client route id, not the upstream vendor. Old
    // Chrome builds already send it for Auto, so changing the id would strand
    // them until a Web Store update. The dashboard remains the authority that
    // can point this route back at DeepSeek (or any other 302.AI model).
    name: 'Auto',
    model: (env.PROXY_AUTO_MODEL || 'qwen3.8-flash').trim(),
    fallbacks: '',
    // qwen3.8-flash is multimodal, so Auto needs no separate vision model.
    visionFallbacks: (env.PROXY_AUTO_VISION_FALLBACK_MODELS || 'qwen3.7-plus,qwen-vl-plus'),
    reasoningEffort: true
  }
};
const GLOBAL_DAILY = boundedQuotaVar('PROXY_GLOBAL_DAILY', env.PROXY_GLOBAL_DAILY, 3000, 1, 100000);
const QUOTA_CONFIG_VALID = quotaConfigErrors.length === 0;
if (!QUOTA_CONFIG_VALID) console.error('invalid quota configuration; admissions disabled');

// Caller-supplied provider ids are looked up here. A bare `PROVIDERS[id]` also
// resolves Object.prototype members, so `provider:"constructor"` used to pass
// the "unknown provider" gate with an object that has no `cap` — and
// `mine > undefined` is false, i.e. no per-license daily limit at all. Resolve
// own properties only.
function providerById(id) {
  return typeof id === 'string' && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
}

// PDF-capable model. Keep document parsing on the independently verified PDF
// chain: 302.AI's Gemini accepts a {type:'file'} data-URI part and reads it in
// streaming mode (verified live 2026-07-08). Any PDF job is routed here; its
// quota is still charged to the stable client route the student selected.
// -lite leads: it reads a PDF file part just as well (verified live
// 2026-07-11) at a fraction of the per-token price.
const PDF_MODEL = (env.PROXY_PDF_MODEL || 'gemini-2.5-flash-lite').trim();
// gemini-2.0-flash is gone from 302.AI (returns -10003 parameter error,
// checked 2026-07-11), so the fallback is the full 2.5 Flash.
const PDF_FALLBACK_MODELS = env.PROXY_PDF_FALLBACK_MODELS || 'gemini-2.5-flash';

/* ------------------------- live model routing ------------------------ */

const MODEL_CONFIG_VERSION = 1;
const MAX_MODEL_CONFIG_BYTES = 64 * 1024;
const MAX_MODEL_HISTORY = 10;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MODEL_ROUTE_IDS = ['qwen', 'deepseek', 'standard'];
const FEATURE_IDS = [
  'ai_text', 'ai_images', 'ai_documents', 'mesh_attachments',
  'autofill', 'other_sites', 'telemetry', 'gdz'
];

// Every capability ships ON. These switches exist so the operator can take a
// feature down from the dashboard during an incident, not as a default-off
// posture: a fresh deployment must serve text, images and documents.
const defaultFeatures = () => Object.fromEntries(FEATURE_IDS.map((id) => [id, true]));

function defaultProcessor(model) {
  const lower = model.toLowerCase();
  if (lower.startsWith('qwen')) {
    return { display_name: 'Qwen', operator: 'Alibaba Cloud', privacy_url: 'https://www.alibabacloud.com/help/en/model-studio/privacy-notice', enabled: true };
  }
  if (lower.startsWith('gemini')) {
    return { display_name: 'Gemini', operator: 'Google via 302.AI', privacy_url: 'https://price.302.ai/en/privacy/', enabled: true };
  }
  if (lower.startsWith('glm')) {
    return { display_name: 'GLM', operator: 'Zhipu AI via 302.AI', privacy_url: 'https://price.302.ai/en/privacy/', enabled: true };
  }
  if (lower.startsWith('deepseek')) {
    return { display_name: 'DeepSeek', operator: 'DeepSeek via 302.AI', privacy_url: 'https://price.302.ai/en/privacy/', enabled: true };
  }
  return { display_name: model, operator: '302.AI gateway', privacy_url: 'https://price.302.ai/en/privacy/', enabled: true };
}

function commaModels(value) {
  const seen = new Set();
  const models = [];
  for (const candidate of String(value || '').split(',')) {
    const model = candidate.trim();
    if (model && !seen.has(model)) { seen.add(model); models.push(model); }
  }
  return models;
}

function bootstrapModelConfig() {
  const qwenText = commaModels([
    PROVIDERS.qwen.model, PROVIDERS.qwen.fallbacks
  ].filter(Boolean).join(','));
  // Vision chains list VISION-CAPABLE models only. PROVIDERS.qwen.fallbacks
  // ends in text-only qwen-plus, which answers an image request with HTTP 200
  // and a confident wrong guess instead of an error (live probe, see the
  // visionFallbackVar comment in backend/src/ai-proxy.js) — a silent bad
  // answer is worse than no answer, so it never enters a vision chain.
  const qwenVision = commaModels([
    PROVIDERS.qwen.model, PROVIDERS.qwen.visionFallbacks
  ].filter(Boolean).join(','));
  const deepseekText = commaModels([
    PROVIDERS.deepseek.model, PROVIDERS.deepseek.fallbacks
  ].filter(Boolean).join(','));
  const deepseekVision = commaModels([
    PROVIDERS.deepseek.model, PROVIDERS.deepseek.visionFallbacks
  ].filter(Boolean).join(','));
  // The cheap chain runs the SAME model as the frontier routes, at a lower
  // reasoning_effort rather than on a different vendor: qwen3.8-flash's `low`
  // effort is what makes an any-site solve cheap (see the effort policy below).
  // glm-5.3-flash trails it — vision-capable, and a different vendor — so a
  // Qwen-wide outage still leaves the post-frontier allowance servable.
  const standardChain = commaModels(`${PROVIDERS.deepseek.model},glm-5.3-flash`);
  return {
    limits: {
      requests_per_minute: boundedQuotaVar(
        'PROXY_REQUESTS_PER_MINUTE', env.PROXY_REQUESTS_PER_MINUTE, 5, 1, 60
      ),
      frontier_per_license: boundedQuotaVar(
        'PROXY_FRONTIER_DAILY', env.PROXY_FRONTIER_DAILY, 15, 0, 5000
      ),
      standard_per_license: boundedQuotaVar(
        'PROXY_STANDARD_DAILY', env.PROXY_STANDARD_DAILY, 70, 1, 10000
      ),
      global_daily: GLOBAL_DAILY,
      force_standard: false
    },
    routes: {
      qwen: {
        // Older extensions upgrade Auto screenshots to the `qwen` route before
        // they reach the VPS. Now that Auto is Qwen too, that upgrade lands on
        // the same model the request would have used anyway.
        label: 'Think', text: qwenText, vision: qwenVision,
        reasoning_effort: PROVIDERS.qwen.reasoningEffort
      },
      deepseek: {
        label: 'Auto', text: deepseekText, vision: deepseekVision,
        reasoning_effort: PROVIDERS.deepseek.reasoningEffort
      },
      // reasoning_effort stays FALSE here even though the chain's lead model
      // takes one. This flag governs only the generic passthrough branch — the
      // "anything else the dashboard picks" case — and the standard route is
      // reached two very different ways: an any-site solve that asked for it,
      // and МЭШ homework spilling over after the frontier allowance. Only
      // `body.tier` tells those apart, so the per-model branches read that
      // instead, and an unknown model here must not inherit a client's 'low'.
      standard: {
        label: 'Standard', text: [...standardChain], vision: [...standardChain],
        reasoning_effort: false
      },
      pdf: {
        label: 'PDF', models: commaModels(`${PDF_MODEL},${PDF_FALLBACK_MODELS}`)
      }
    },
    // Published list rates, USD per 1M tokens. These are the dashboard's
    // starting estimate, not a bill: 302.AI resells at its own margin, so the
    // operator overwrites any row that drifts from the invoice.
    rates: {
      'qwen3.8-flash': { input_usd_per_m: 0.15, output_usd_per_m: 0.47 },
      'qwen3.7-plus': { input_usd_per_m: 0.32, output_usd_per_m: 1.28 },
      'qwen-vl-plus': { input_usd_per_m: 0.32, output_usd_per_m: 1.28 },
      'glm-5.3-flash': { input_usd_per_m: 0.075, output_usd_per_m: 0.25 },
      'glm-4.6v-flash': { input_usd_per_m: 0, output_usd_per_m: 0 }
    },
    processors: Object.fromEntries([
      ...qwenText, ...qwenVision, ...deepseekText, ...deepseekVision,
      ...standardChain, PDF_MODEL, ...commaModels(PDF_FALLBACK_MODELS)
    ].filter(Boolean).map((model) => [model, defaultProcessor(model)])),
    features: defaultFeatures()
  };
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${name}.${key} is not supported`);
  }
}

function validModelChain(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new Error(`${name} must contain 1 to 8 model ids`);
  }
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const model = typeof raw === 'string' ? raw.trim() : '';
    if (!MODEL_ID.test(model)) throw new Error(`${name} contains an invalid model id`);
    if (!seen.has(model)) { seen.add(model); out.push(model); }
  }
  return out;
}

function validLimit(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function validateModelConfig(input) {
  exactKeys(input, ['limits', 'routes', 'rates', 'processors', 'features'], 'config');
  exactKeys(input.limits, [
    'requests_per_minute', 'frontier_per_license', 'standard_per_license',
    'global_daily', 'force_standard'
  ], 'config.limits');
  if (typeof input.limits.force_standard !== 'boolean') {
    throw new Error('config.limits.force_standard must be boolean');
  }
  const limits = {
    // Revision-1 config files and an older dashboard do not have this field.
    // Normalize them to the safe production default instead of disabling all
    // AI admission during the mixed-version rollout.
    requests_per_minute: Object.prototype.hasOwnProperty.call(input.limits, 'requests_per_minute')
      ? validLimit(input.limits.requests_per_minute, 'requests_per_minute', 1, 60)
      : 5,
    frontier_per_license: validLimit(
      input.limits.frontier_per_license, 'frontier_per_license', 0, 5000
    ),
    standard_per_license: validLimit(
      input.limits.standard_per_license, 'standard_per_license', 1, 10000
    ),
    global_daily: validLimit(input.limits.global_daily, 'global_daily', 1, 100000),
    force_standard: input.limits.force_standard
  };

  exactKeys(input.routes, ['qwen', 'deepseek', 'standard', 'pdf'], 'config.routes');
  const routes = {};
  for (const id of MODEL_ROUTE_IDS) {
    const route = input.routes[id];
    exactKeys(route, ['label', 'text', 'vision', 'reasoning_effort'], `config.routes.${id}`);
    const label = typeof route.label === 'string' ? route.label.trim() : '';
    if (!label || label.length > 40 || /[\u0000-\u001f\u007f]/.test(label)) {
      throw new Error(`config.routes.${id}.label is invalid`);
    }
    if (typeof route.reasoning_effort !== 'boolean') {
      throw new Error(`config.routes.${id}.reasoning_effort must be boolean`);
    }
    routes[id] = {
      label,
      text: validModelChain(route.text, `config.routes.${id}.text`),
      vision: validModelChain(route.vision, `config.routes.${id}.vision`),
      reasoning_effort: route.reasoning_effort
    };
  }
  exactKeys(input.routes.pdf, ['label', 'models'], 'config.routes.pdf');
  const pdfLabel = typeof input.routes.pdf.label === 'string' ? input.routes.pdf.label.trim() : '';
  if (!pdfLabel || pdfLabel.length > 40 || /[\u0000-\u001f\u007f]/.test(pdfLabel)) {
    throw new Error('config.routes.pdf.label is invalid');
  }
  routes.pdf = {
    label: pdfLabel,
    models: validModelChain(input.routes.pdf.models, 'config.routes.pdf.models')
  };

  exactKeys(input.rates, Object.keys(input.rates), 'config.rates');
  const rates = {};
  if (Object.keys(input.rates).length > 64) throw new Error('config.rates has too many models');
  for (const [model, rate] of Object.entries(input.rates)) {
    if (!MODEL_ID.test(model)) throw new Error('config.rates contains an invalid model id');
    exactKeys(rate, ['input_usd_per_m', 'output_usd_per_m'], `config.rates.${model}`);
    const inputRate = Number(rate.input_usd_per_m);
    const outputRate = Number(rate.output_usd_per_m);
    if (!Number.isFinite(inputRate) || inputRate < 0 || inputRate > 10000 ||
        !Number.isFinite(outputRate) || outputRate < 0 || outputRate > 10000) {
      throw new Error(`config.rates.${model} prices must be from 0 to 10000 USD per 1M tokens`);
    }
    rates[model] = { input_usd_per_m: inputRate, output_usd_per_m: outputRate };
  }
  const routedModels = new Set([
    ...MODEL_ROUTE_IDS.flatMap((id) => [...routes[id].text, ...routes[id].vision]),
    ...routes.pdf.models
  ]);
  const processorInput = input.processors == null
    ? Object.fromEntries([...routedModels].map((model) => [model, defaultProcessor(model)]))
    : input.processors;
  exactKeys(processorInput, Object.keys(processorInput), 'config.processors');
  if (Object.keys(processorInput).length > 64) throw new Error('config.processors has too many models');
  const processors = {};
  for (const [model, processor] of Object.entries(processorInput)) {
    if (!MODEL_ID.test(model)) throw new Error('config.processors contains an invalid model id');
    exactKeys(processor, ['display_name', 'operator', 'privacy_url', 'enabled'], `config.processors.${model}`);
    const displayName = typeof processor.display_name === 'string' ? processor.display_name.trim() : '';
    const operator = typeof processor.operator === 'string' ? processor.operator.trim() : '';
    const privacyUrl = typeof processor.privacy_url === 'string' ? processor.privacy_url.trim() : '';
    let parsedPrivacy;
    try { parsedPrivacy = new URL(privacyUrl); } catch { parsedPrivacy = null; }
    if (!displayName || displayName.length > 80 || !operator || operator.length > 120 ||
        !parsedPrivacy || parsedPrivacy.protocol !== 'https:' || parsedPrivacy.username ||
        parsedPrivacy.password || typeof processor.enabled !== 'boolean') {
      throw new Error(`config.processors.${model} is invalid`);
    }
    processors[model] = {
      display_name: displayName,
      operator,
      privacy_url: parsedPrivacy.href,
      enabled: processor.enabled
    };
  }
  const featureInput = input.features == null ? defaultFeatures() : input.features;
  exactKeys(featureInput, FEATURE_IDS, 'config.features');
  const features = {};
  for (const id of FEATURE_IDS) {
    if (typeof featureInput[id] !== 'boolean') throw new Error(`config.features.${id} must be boolean`);
    features[id] = featureInput[id];
  }
  // A processor must be registered+enabled only when this revision can
  // actually route content to it. This lets the operator atomically disable a
  // feature and its processor in one dashboard save; inactive route templates
  // remain available for a later reviewed re-enable.
  const activeRoutedModels = new Set();
  if (features.ai_text) {
    for (const id of MODEL_ROUTE_IDS) {
      for (const model of routes[id].text) activeRoutedModels.add(model);
      if (features.ai_images) {
        for (const model of routes[id].vision) activeRoutedModels.add(model);
      }
    }
    if (features.ai_documents) {
      for (const model of routes.pdf.models) activeRoutedModels.add(model);
    }
  }
  for (const model of activeRoutedModels) {
    if (!processors[model]?.enabled) throw new Error(`active routed model ${model} is not enabled in processors`);
  }
  return { limits, routes, rates, processors, features };
}

function validateModelState(input) {
  exactKeys(input, ['version', 'revision', 'updated_at', 'reason', 'config', 'history'], 'state');
  if (input.version !== MODEL_CONFIG_VERSION) throw new Error('unsupported model config version');
  const revision = validLimit(input.revision, 'revision', 1, Number.MAX_SAFE_INTEGER);
  const updatedAt = typeof input.updated_at === 'string' ? input.updated_at : '';
  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) throw new Error('invalid updated_at');
  const reason = typeof input.reason === 'string' ? input.reason : '';
  if (reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) throw new Error('invalid reason');
  if (!Array.isArray(input.history) || input.history.length > MAX_MODEL_HISTORY) {
    throw new Error('invalid model config history');
  }
  const history = input.history.map((entry) => {
    exactKeys(entry, ['revision', 'updated_at', 'reason', 'config'], 'history entry');
    const entryRevision = validLimit(entry.revision, 'history revision', 0, revision - 1);
    const entryUpdatedAt = typeof entry.updated_at === 'string' ? entry.updated_at : '';
    if (entryUpdatedAt && Number.isNaN(Date.parse(entryUpdatedAt))) throw new Error('invalid history timestamp');
    const entryReason = typeof entry.reason === 'string' ? entry.reason : '';
    if (entryReason.length > 200 || /[\u0000-\u001f\u007f]/.test(entryReason)) {
      throw new Error('invalid history reason');
    }
    return {
      revision: entryRevision, updated_at: entryUpdatedAt, reason: entryReason,
      config: validateModelConfig(entry.config)
    };
  });
  return {
    version: MODEL_CONFIG_VERSION, revision, updated_at: updatedAt, reason,
    config: validateModelConfig(input.config), history
  };
}

let modelState = {
  version: MODEL_CONFIG_VERSION,
  revision: 0,
  updated_at: '',
  reason: 'environment defaults',
  config: validateModelConfig(bootstrapModelConfig()),
  history: []
};
let modelConfigHealthy = quotaConfigErrors.length === 0;
let modelConfigFileLoaded = false;

function readModelState() {
  let fd;
  try {
    fd = fs.openSync(MODEL_CONFIG_FILE, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > MAX_MODEL_CONFIG_BYTES) {
      throw new Error('invalid model config file size');
    }
    // Read through the checked descriptor into a fixed-size buffer. A local
    // writer growing the inode after fstat must not turn this small config
    // read into an unbounded allocation.
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = fs.readSync(fd, bytes, total, bytes.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total !== before.size) throw new Error('model config changed while reading');
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      throw new Error('model config changed while reading');
    }
    const raw = bytes.subarray(0, total).toString('utf8');
    // A config saved before processors/features existed carries neither key;
    // validateModelConfig fills both from the shipped defaults.
    return validateModelState(JSON.parse(raw));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

try {
  modelState = readModelState();
  modelConfigFileLoaded = true;
  modelConfigHealthy = true;
} catch (error) {
  if (error?.code !== 'ENOENT') {
    modelConfigHealthy = false;
    console.error('model config load failed; admissions disabled', String(error?.code || error?.name || 'unknown'));
  }
}

function persistModelState(nextState) {
  let temporary = '';
  try {
    const validated = validateModelState(nextState);
    const serialized = JSON.stringify(validated);
    if (Buffer.byteLength(serialized) > MAX_MODEL_CONFIG_BYTES) throw new Error('model config too large');
    const directory = path.dirname(MODEL_CONFIG_FILE);
    fs.mkdirSync(directory, { recursive: true });
    temporary = path.join(directory, `.${path.basename(MODEL_CONFIG_FILE)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, MODEL_CONFIG_FILE);
    temporary = '';
    let dirFd;
    try { dirFd = fs.openSync(directory, 'r'); fs.fsyncSync(dirFd); }
    finally { if (dirFd !== undefined) fs.closeSync(dirFd); }
    const committed = readModelState();
    if (JSON.stringify(committed) !== serialized) throw new Error('model config commit mismatch');
    modelState = committed;
    modelConfigHealthy = true;
    modelConfigFileLoaded = true;
    return true;
  } catch (error) {
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } }
    modelConfigHealthy = false;
    console.error('model config persist failed; admissions disabled', String(error?.code || error?.name || 'unknown'));
    return false;
  }
}

function routeForRequest(providerId, tier, hasImages, hasPdfs, state = modelState) {
  const config = state.config;
  if (!config.features.ai_text || (hasImages && !config.features.ai_images) ||
      (hasPdfs && !config.features.ai_documents)) {
    return { name: 'Disabled', models: [], reasoningEffort: false };
  }
  if (hasPdfs) {
    return { name: config.routes.pdf.label, models: [...config.routes.pdf.models], reasoningEffort: false };
  }
  const route = tier === 'standard' ? config.routes.standard : config.routes[providerId];
  return {
    name: route.label,
    models: [...(hasImages ? route.vision : route.text)],
    reasoningEffort: route.reasoning_effort
  };
}

// The vocabulary the CLIENT may send (src/lib/task-classifier.js emits these).
// It is not any single vendor's vocabulary — each model's branch below
// translates it.
const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const GLM_53_FLASH = /^glm-5\.3-flash$/i;
// Older Qwen (3.7-plus, -vl-plus, -plus) THINKS BY DEFAULT and has no
// OpenAI-style effort levels — its only knobs are enable_thinking/
// thinking_budget. Sending reasoning_effort there is at best ignored and at
// worst a -10003 parameter error, so the effort passthrough is suppressed per
// ACTUAL model rather than per route.
//
// qwen3.8-flash is the exception this pattern is narrowed for: it DOES take a
// top-level reasoning_effort, so it is excluded here and handled by
// QWEN_38_FLASH below. Without the exclusion the live model would silently
// inherit the "send nothing" branch and always run at its own xhigh default,
// with no way for the cheap any-site chain to ask for less.
const QWEN_NO_EFFORT = /^qwen(?!3\.8-flash\b)/i;
// qwen3.8-flash and its -next sibling. Their effort vocabulary is
// low / medium / xhigh (xhigh is the model's own default) — there is NO
// 'high', so the client's hint is TRANSLATED, never passed through raw.
const QWEN_38_FLASH = /^qwen3\.8-flash\b/i;
const QWEN_38_EFFORT = { low: 'low', medium: 'medium', high: 'xhigh' };
// Schoolwork and tests are what this service is for, so the frontier routes
// always ask for the deepest setting: an installed client sends 'low' as a
// generic cost hint, and honouring it there would under-think real homework.
// Same asymmetry as the GLM branch below.
const QWEN_38_FRONTIER_EFFORT = 'xhigh';
// JSON mode is dropped for EVERY Qwen model on an image request, qwen3.8-flash
// included — that is a separate, unrelated finding from the effort knob (see
// dropJsonForQwenVision) and stays deliberately broad until a live probe says
// otherwise. Widening it costs nothing: the answer parser recovers the shape
// from prose.
const QWEN_MODEL = /^qwen/i;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// Request bodies arrive before JSON credentials can be verified. Bound that
// anonymous pre-authentication memory separately from active AI job storage.
const MAX_BUFFERED_BODY_BYTES = 48 * 1024 * 1024;
const MAX_BODY_REQUESTS = 32;
const MAX_BODY_REQUESTS_PER_IP = 4;
const MAX_SMALL_BODY_BYTES = 4 * 1024;
const MAX_MESSAGES = 60;
const MAX_PARTS = 20;
const MAX_TEXT_PART_CHARS = 50000;
const MAX_IMAGE_DATA_URI_CHARS = 6 * 1024 * 1024;
const MAX_IMAGES_PER_REQUEST = 6;
const MAX_PDF_DATA_URI_CHARS = 8 * 1024 * 1024; // ~5.8 MB raw; fits (with JSON overhead) inside one MAX_BLOB_CHARS messages blob
// 6, not 1-2: follow-ups replay up to 4 prior user turns WITH their files
// (see the extension's MAX_HISTORY_MESSAGES), so the same PDF can legally
// appear several times in one request. MAX_BODY_BYTES gates the real weight.
const MAX_PDFS_PER_REQUEST = 6;
const MAX_TOKENS_OUT = 8192;

// Poll-job lifecycle. A job whose client stops polling is abandoned (abort
// upstream so we stop paying 302.AI); finished jobs linger briefly so a
// client can drain the tail even across a flaky poll or two.
// Each active job can retain an ~8 MiB request plus a 2 MiB output buffer.
// Keep the aggregate below the systemd 768 MiB ceiling even under hostile
// concurrency; completed jobs are separately capped while clients drain them.
const MAX_ACTIVE_JOBS = 24;
const MAX_RETAINED_JOBS = 64;
const MAX_JOBS_PER_LICENSE = 2;
const MAX_JOBS_PER_DEVICE = 2;
const MAX_JOBS_PER_IP = 4;
const JOB_START_IP_RATE_LIMIT = 60;
const JOB_START_RATE_WINDOW_MS = 60 * 1000;
const JOB_START_IP_RATE_WINDOW_MS = 10 * 60 * 1000;
// Request bodies arrive before their signed entitlement can be verified.
// Bound that pre-authentication work separately so random traffic cannot
// occupy every outbound socket or consume the service's request budget.
const UPSTREAM_CONNECT_TIMEOUT_MS = 20 * 1000;
// PDF jobs: 302.AI holds the response (headers included) until Gemini has
// ingested the whole file — measured live 2026-07-11: a 2.8 MB PDF took 31 s
// to first byte, so the cap must scale to MAX_PDF_DATA_URI_CHARS (~60 s est.)
// yet stay under the extension's 90 s no-new-bytes give-up (IDLE_TIMEOUT_MS
// in smesh-proxy.js), which keeps ticking while we wait on this connect.
const UPSTREAM_CONNECT_TIMEOUT_PDF_MS = 75 * 1000;
const UPSTREAM_IDLE_TIMEOUT_MS = 60 * 1000;
const MAX_JOB_DURATION_MS = 5 * 60 * 1000;
const MAX_JOB_OUTPUT_BYTES = 2 * 1024 * 1024;
const JOB_ABANDON_MS = 90 * 1000;       // running + unpolled this long → dead client
const JOB_LINGER_MS = 5 * 60 * 1000;    // done + unpolled this long → GC
const JOB_GC_INTERVAL_MS = 30 * 1000;

// Long-poll hold: /ai/poll waits up to this long for new tokens before
// returning (a heartbeat with an empty chunk if none arrive). Two reasons it's
// short: (1) each poll connection must stay well under the RU DPI clamp window
// (~6s on Cloudflare, ~12s here — proven), and (2) the client re-polls with NO
// setTimeout gap, so a fetch is ALWAYS pending → the MV3 service worker stays
// alive (a bare setTimeout does not keep it alive; that killed the first cut).
const POLL_HOLD_MS = 4000;
const POLL_CHECK_MS = 100;
// Long polls occupy real listener slots even while they are idle. Keep retries
// from one job, leaked capabilities, or one network origin from monopolizing
// the process, and reserve most of server.maxConnections for health/control
// traffic and unrelated users.
const MAX_POLLS_PER_JOB = 2;
const MAX_POLLS_PER_TOKEN = 2;
const MAX_POLLS_PER_IP = 6;
const MAX_IN_FLIGHT_POLLS = 32;
// The RU path has a measured ~16 KiB per-connection transfer allowance. A
// client that missed several polls must still be able to drain a large backlog
// in independently deliverable pieces; budget the JSON-encoded chunk itself
// to 8 KiB, leaving ample room for the response envelope and TLS/HTTP framing.
const MAX_POLL_CHUNK_JSON_BYTES = 8 * 1024;

// Chunked upload store (the UPLOAD mirror of the poll transport). A large
// image / PDF can't ride one /ai/start POST from RU — the upload clamps mid-
// body — so the client slices it into /ai/blob chunks that reassemble here,
// then references the blob from a tiny /ai/start. Blobs are ephemeral and
// bounded: no entitlement check per chunk, so the store is capped hard and
// swept on a short TTL. A blob is useless without a valid /ai/start, which
// verifies the signed capability again.
const BLOB_TTL_MS = 90 * 1000;
// Sliding-only expiry let duplicate chunks pin reservations and blob memory
// forever. Production is ten minutes; a bounded override keeps lifecycle tests
// deterministic without changing the deployed default.
const UPLOAD_ABSOLUTE_TTL_MS = Math.min(
  10 * 60 * 1000,
  Math.max(100, Number.isFinite(Number(process.env.UPLOAD_ABSOLUTE_TTL_MS)) &&
    Number(process.env.UPLOAD_ABSOLUTE_TTL_MS) > 0
    ? Number(process.env.UPLOAD_ABSOLUTE_TTL_MS)
    : 10 * 60 * 1000)
);
const MAX_BLOBS = 120;                       // concurrent uploads (complete or in-progress)
const MAX_BLOB_CHARS = 9 * 1024 * 1024;      // one blob: a whole messages JSON incl. a ~5 MB PDF's data URI
const MAX_TOTAL_BLOB_CHARS = 80 * 1024 * 1024; // across ALL blobs — bounds worst-case memory
const MAX_RESERVED_BLOB_CHARS = 40 * 1024 * 1024; // leave half the store for uploads that actually make progress
const MAX_RESERVED_PER_DEVICE = 10 * 1024 * 1024;
const MAX_RESERVED_PER_LICENSE = 12 * 1024 * 1024;
const MAX_RESERVED_PER_IP = 18 * 1024 * 1024;
const UPLOAD_FIRST_CHUNK_DEADLINE_MS = 12 * 1000;
const UPLOAD_PROGRESS_DEADLINE_MS = 20 * 1000;
const MAX_CHUNK_CHARS = 256 * 1024;          // per-chunk sanity (client sends ~8 KB)
const MAX_BLOB_REQUEST_BYTES = MAX_CHUNK_CHARS + 32 * 1024; // JSON/base64 escaping + metadata headroom
const MAX_BLOB_PARTS = 4096;
const MAX_UPLOAD_GENERATION = 1;             // one large probe followed by one RU-safe fallback
const MAX_UPLOAD_TICKETS_PER_DEVICE = 2;     // bounds pre-start reservations by one valid license/device
const MAX_UPLOAD_TICKETS_PER_LICENSE = 2;    // one license has one active device; allow one retrying upload
const MAX_UPLOAD_TICKETS_PER_IP = 4;         // multiple licensed users can still share one attack source
const MAX_UPLOAD_TICKETS = 240;              // bounds capability records even across many licenses
const UPLOAD_TICKET_RATE_WINDOW_MS = 10 * 60 * 1000;
const UPLOAD_TICKET_RATE_PER_LICENSE = 20;
const UPLOAD_TICKET_RATE_PER_IP = 30;

// Student-facing copy — identical wording to ai-proxy.js. Never mentions keys.
const UNAVAILABLE = 'ИИ-сервис временно недоступен. Попробуйте позже или переключитесь на другой провайдер в настройках.';
const NEED_LICENSE = 'ИИ СМЭШ работает по лицензии. Введите ключ доступа (SMESH-…) в настройках расширения.';
const NEED_DEVICE_ID = 'Не удалось подтвердить устройство. Обновите расширение СМЭШ AI до последней версии и попробуйте снова.';
const OVERLOADED = 'Сервер СМЭШ сейчас перегружен. Попробуйте позже или переключитесь на другой провайдер в настройках.';
const JOB_NOT_FOUND = 'Сессия ответа не найдена или устарела. Задайте вопрос ещё раз.';
const LICENSE_ERRORS = {
  not_found: 'Ключ лицензии не найден. Проверьте его в настройках расширения.',
  expired: 'Срок действия лицензии истёк. Продлите её, чтобы пользоваться ИИ СМЭШ.',
  revoked: 'Эта лицензия была отозвана. Напишите в поддержку.',
  device_in_use: 'Этот ключ уже используется на устройстве №1. Сначала деактивируйте его там.',
  device_limit: 'Достигнут лимит устройств для этой лицензии.',
  bad_device: NEED_DEVICE_ID
};
const TOO_BIG = 'Запрос слишком большой. Уберите часть вложений и попробуйте снова.';

// Authority-supplied reason strings index this table, so resolve own
// properties only (see providerById for the same prototype hazard).
function licenseErrorMessage(reason) {
  return (typeof reason === 'string' && Object.hasOwn(LICENSE_ERRORS, reason)
    ? LICENSE_ERRORS[reason]
    : '') || NEED_LICENSE;
}

// Extension fetches bypass CORS via host_permissions, and curl diagnostics do
// not need ACAO. Keep only the generic transport/preflight headers here.
const BASE_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Job-Token'
};
let shutdownStarted = false;

/* ------------------------------ helpers ------------------------------- */

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    ...BASE_HEADERS,
    ...extraHeaders
  });
  res.end(body);
}
function sendErr(res, status, message, extraHeaders = {}) {
  sendJson(res, status, { ok: false, error: { message } }, extraHeaders);
}

function responseGone(res) {
  return !!(res.destroyed || res.closed || !res.writable);
}

// Moscow calendar day (UTC+3, no DST) — matches the worker's mskDay().
function mskDay() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function normalizeKey(k) {
  const normalized = String(k || '').trim().toUpperCase();
  return normalized.length <= 128 && /^[A-Z0-9-]+$/.test(normalized) ? normalized : '';
}

function normalizeDeviceId(value) {
  // The extension creates this identifier with crypto.randomUUID(). Keeping
  // the public boundary to that exact opaque shape prevents caller-chosen
  // phone numbers, license fragments, or other PII from becoming cache/rate
  // keys or reaching opt-in server telemetry as a "device id".
  return typeof value === 'string' && UUID_V4.test(value) ? value.toLowerCase() : '';
}

function readHeader(req, name) {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : String(raw || '');
}

// Shared constant-time compare for every secret header. Length check first is
// deliberate: timingSafeEqual throws on different sizes, and a missing secret
// must fail closed without turning into a distinct error path.
function safeEqualSecret(expected, supplied) {
  const expectedBytes = Buffer.from(String(expected || ''));
  const suppliedBytes = Buffer.from(String(supplied || ''));
  return expectedBytes.length === suppliedBytes.length &&
    expectedBytes.length > 0 &&
    crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

// Diagnostic routes are deliberately invisible unless an operator opted in.
// Constant-time comparison avoids turning the shared secret into a timing
// oracle; a missing or wrong key gets the same 404 as an absent route.
function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  return safeEqualSecret(ADMIN_KEY, readHeader(req, 'x-admin-key'));
}

const modelAdminFailures = new Map();
const MODEL_ADMIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MODEL_ADMIN_FAILURE_LIMIT = 20;
const MAX_MODEL_ADMIN_FAILURE_IPS = 4096;

function modelAdminCors(req) {
  const origin = readHeader(req, 'origin').replace(/\/+$/, '');
  if (origin && origin !== MODEL_DASHBOARD_ORIGIN) return null;
  return origin ? {
    'Access-Control-Allow-Origin': MODEL_DASHBOARD_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Model-Admin-Key',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  } : {};
}

function modelAdminAllowed(req) {
  const ip = requestIp(req);
  if (MODEL_ADMIN_KEY_VALID && safeEqualSecret(MODEL_ADMIN_KEY, readHeader(req, 'x-model-admin-key'))) {
    modelAdminFailures.delete(ip);
    return { ok: true };
  }
  const now = Date.now();
  const recent = (modelAdminFailures.get(ip) || []).filter(
    (timestamp) => timestamp > now - MODEL_ADMIN_FAILURE_WINDOW_MS
  );
  if (recent.length >= MODEL_ADMIN_FAILURE_LIMIT) {
    modelAdminFailures.set(ip, recent);
    return { ok: false, status: 429 };
  }
  if (!modelAdminFailures.has(ip) && modelAdminFailures.size >= MAX_MODEL_ADMIN_FAILURE_IPS) {
    return { ok: false, status: 429 };
  }
  recent.push(now);
  modelAdminFailures.set(ip, recent);
  return { ok: false, status: MODEL_ADMIN_KEY_VALID ? 401 : 503 };
}

setInterval(() => {
  const cutoff = Date.now() - MODEL_ADMIN_FAILURE_WINDOW_MS;
  for (const [ip, attempts] of modelAdminFailures) {
    const recent = attempts.filter((timestamp) => timestamp > cutoff);
    if (recent.length) modelAdminFailures.set(ip, recent);
    else modelAdminFailures.delete(ip);
  }
}, MODEL_ADMIN_FAILURE_WINDOW_MS).unref();

function publicModelState() {
  return {
    ok: true,
    healthy: modelConfigHealthy,
    source: modelConfigFileLoaded ? 'saved' : 'environment_defaults',
    version: modelState.version,
    revision: modelState.revision,
    updated_at: modelState.updated_at,
    reason: modelState.reason,
    config: modelState.config,
    history: modelState.history
  };
}

function publicProcessors() {
  const active = new Set();
  if (modelState.config.features.ai_text) {
    for (const id of MODEL_ROUTE_IDS) {
      for (const model of modelState.config.routes[id].text) active.add(model);
      if (modelState.config.features.ai_images) {
        for (const model of modelState.config.routes[id].vision) active.add(model);
      }
    }
    if (modelState.config.features.ai_documents) {
      for (const model of modelState.config.routes.pdf.models) active.add(model);
    }
  }
  return Object.entries(modelState.config.processors).map(([model, processor]) => ({
    model,
    display_name: processor.display_name,
    operator: processor.operator,
    privacy_url: processor.privacy_url,
    enabled: processor.enabled,
    in_use: active.has(model)
  }));
}

let runtimeSigningKey;
function getRuntimeSigningKey() {
  if (runtimeSigningKey !== undefined) return runtimeSigningKey;
  runtimeSigningKey = null;
  if (!RUNTIME_CONFIG_PRIVATE_KEY_B64 || RUNTIME_CONFIG_PRIVATE_KEY_B64.length > 16384) return null;
  try {
    const pem = Buffer.from(RUNTIME_CONFIG_PRIVATE_KEY_B64, 'base64').toString('utf8');
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    runtimeSigningKey = key;
  } catch { /* invalid or missing signing key */ }
  return runtimeSigningKey;
}

function signedRuntimeConfig() {
  const key = getRuntimeSigningKey();
  if (!key) return null;
  const now = Date.now();
  const payloadBytes = Buffer.from(JSON.stringify({
    configVersion: modelState.revision,
    issuedAt: now,
    // Clients refresh every five minutes. A one-hour signed lifetime tolerates
    // a brief control-plane outage without letting an old "enabled" policy
    // survive an emergency stop for a full day.
    expiresAt: now + 60 * 60 * 1000,
    features: modelState.config.features
  }));
  const signature = crypto.sign('sha256', payloadBytes, { key, dsaEncoding: 'ieee-p1363' });
  if (signature.length !== 64) return null;
  return { payload: payloadBytes.toString('base64url'), signature: signature.toString('base64url') };
}

function handleModelConfigGet(req, res, corsHeaders) {
  const auth = modelAdminAllowed(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, {
      ok: false,
      reason: auth.status === 503 ? 'model_admin_key_not_configured' :
        auth.status === 429 ? 'too_many_attempts' : 'unauthorized'
    }, corsHeaders);
  }
  return sendJson(res, 200, publicModelState(), corsHeaders);
}

function parseModelAdminBody(rawBody) {
  if (Buffer.byteLength(rawBody) > MAX_SMALL_BODY_BYTES * 4) {
    throw Object.assign(new Error('request_too_large'), { status: 413 });
  }
  let body;
  try { body = JSON.parse(rawBody); }
  catch { throw Object.assign(new Error('bad_json'), { status: 400 }); }
  exactKeys(body, ['expected_revision', 'reason', 'config', 'rollback_revision'], 'request');
  if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0) {
    throw Object.assign(new Error('invalid_expected_revision'), { status: 400 });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw Object.assign(new Error('invalid_reason'), { status: 400 });
  }
  const hasConfig = Object.hasOwn(body, 'config');
  const hasRollback = Object.hasOwn(body, 'rollback_revision');
  if (hasConfig === hasRollback) {
    throw Object.assign(new Error('provide_config_or_rollback'), { status: 400 });
  }
  return { ...body, reason };
}

function handleModelConfigPut(res, rawBody, corsHeaders) {
  let body;
  try { body = parseModelAdminBody(rawBody); }
  catch (error) {
    return sendJson(res, error.status || 400, { ok: false, reason: String(error.message || 'invalid_config') }, corsHeaders);
  }
  if (body.expected_revision !== modelState.revision) {
    return sendJson(res, 409, {
      ok: false, reason: 'stale_revision', current_revision: modelState.revision
    }, corsHeaders);
  }

  let nextConfig;
  try {
    if (Object.hasOwn(body, 'rollback_revision')) {
      if (!Number.isSafeInteger(body.rollback_revision) || body.rollback_revision < 0) {
        throw new Error('invalid_rollback_revision');
      }
      const target = modelState.history.find((entry) => entry.revision === body.rollback_revision);
      if (!target) throw new Error('rollback_revision_not_found');
      nextConfig = validateModelConfig(target.config);
    } else {
      nextConfig = validateModelConfig(body.config);
    }
  } catch (error) {
    return sendJson(res, 400, { ok: false, reason: String(error.message || 'invalid_config') }, corsHeaders);
  }

  const now = new Date().toISOString();
  const previous = {
    revision: modelState.revision,
    updated_at: modelState.updated_at,
    reason: modelState.reason,
    config: modelState.config
  };
  const nextState = {
    version: MODEL_CONFIG_VERSION,
    revision: modelState.revision + 1,
    updated_at: now,
    reason: body.reason || (Object.hasOwn(body, 'rollback_revision')
      ? `rollback to revision ${body.rollback_revision}`
      : 'dashboard update'),
    config: nextConfig,
    history: [previous, ...modelState.history].slice(0, MAX_MODEL_HISTORY)
  };
  if (!persistModelState(nextState)) {
    return sendJson(res, 503, { ok: false, reason: 'model_config_persist_failed' }, corsHeaders);
  }
  console.log('model config updated', 'revision=' + modelState.revision,
    'force_standard=' + modelState.config.limits.force_standard,
    'reason=' + JSON.stringify(modelState.reason));
  return sendJson(res, 200, publicModelState(), corsHeaders);
}

function upstreamUrl() {
  return UPSTREAM_BASE_URL.endsWith('/chat/completions')
    ? UPSTREAM_BASE_URL
    : `${UPSTREAM_BASE_URL}/chat/completions`;
}

function modelChoices(p) {
  const seen = new Set();
  const out = [];
  const add = (m) => { m = String(m || '').trim(); if (m && !seen.has(m)) { seen.add(m); out.push(m); } };
  for (const model of p?.models || []) add(model);
  return out;
}

// 302.AI answers an unknown/unentitled model with 503 + err_code -10008.
function isUnpurchased(text) {
  return /No available models|"err_code"\s*:\s*-10008|AccessDenied\.Unpurchased|access to model denied|eligible for using the model/i.test(text || '');
}

// Prefix checks alone are not enough: an attacker with a valid license could
// put arbitrary multi-byte Unicode after `;base64,`, stay under a UTF-16
// character limit, then make JSON serialization allocate several times that
// budget. FileReader emits canonical padded base64, so reject every other
// representation before it reaches the shared paid upstream.
function isCanonicalBase64DataUri(value, prefix) {
  if (typeof value !== 'string') return false;
  const matchedPrefix = typeof prefix === 'string' ? prefix : value.match(prefix)?.[0];
  if (!matchedPrefix || !value.startsWith(matchedPrefix)) return false;
  const payload = value.slice(matchedPrefix.length);
  if (payload.length === 0 || payload.length % 4 !== 0 || !BASE64_PAYLOAD.test(payload)) return false;
  // RFC 4648 canonical encoding requires unused bits in the last symbol to be
  // zero. Without this, alternate strings such as `Zh==` decode to the same
  // byte as canonical `Zg==`, creating parser/signature differentials.
  if (payload.endsWith('==')) {
    return (BASE64_ALPHABET.indexOf(payload[payload.length - 3]) & 0x0f) === 0;
  }
  if (payload.endsWith('=')) {
    return (BASE64_ALPHABET.indexOf(payload[payload.length - 2]) & 0x03) === 0;
  }
  return true;
}

/* ------------------------------ quota (local) ------------------------- */
// In-memory counters mirrored to a JSON file so they survive a restart. Low
// pre-launch traffic makes one synchronous atomic write per admitted job a
// deliberate trade-off: a 200 /ai/start must mean the quota reservation is
// already durable, even if the process is killed immediately afterward.

let quota = { day: mskDay(), counts: {} };
let quotaNeedsPrivacyRewrite = false;
let quotaLoadBlocked = false;
let quotaPersistenceHealthy = true;
let quotaFailureFingerprint = '';
let quotaFileLoaded = false;
let quotaLastStoreProofAt = 0;
const MISSING_QUOTA_TARGET = 'missing';
let quotaAuthoritativeTarget = MISSING_QUOTA_TARGET;
let quotaLastReadinessTarget = MISSING_QUOTA_TARGET;
let quotaLastWriteCommitted = false;
function quotaLicenseRef(licenseKey) {
  if (/^h:[a-f0-9]{64}$/.test(String(licenseKey))) return String(licenseKey);
  return `h:${crypto.createHash('sha256').update(String(licenseKey)).digest('hex')}`;
}

function sanitizeQuotaCount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid quota counter');
  }
  return value;
}

function sanitizeQuotaCounts(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid counts object');
  }
  const out = {};
  let hasLegacySubjects = false;
  for (const [key, value] of Object.entries(input)) {
    if (key === '*|all') { out[key] = sanitizeQuotaCount(value); continue; }
    const split = key.lastIndexOf('|');
    if (split <= 0) throw new Error('invalid quota key');
    const subject = key.slice(0, split);
    const provider = key.slice(split + 1);
    if (!/^[a-z0-9_-]{1,32}$/i.test(provider)) throw new Error('invalid quota provider');
    const safeSubject = /^h:[a-f0-9]{64}$/.test(subject) ? subject : quotaLicenseRef(subject);
    if (safeSubject !== subject) {
      quotaNeedsPrivacyRewrite = true;
      hasLegacySubjects = true;
    }
    const safeValue = sanitizeQuotaCount(value);
    const safeKey = `${safeSubject}|${provider}`;
    const combined = (out[safeKey] || 0) + safeValue;
    if (!Number.isSafeInteger(combined)) quotaNeedsPrivacyRewrite = true;
    out[safeKey] = Number.isSafeInteger(combined) ? combined : Number.MAX_SAFE_INTEGER;
  }
  // Every admitted request increments exactly one license/provider counter and
  // the global breaker in the same durable snapshot. Accepting a restored file
  // with a lower global value would silently reopen capacity already consumed.
  // Historical plaintext stores incremented a provider counter before checking
  // its per-license cap, so safely migrate those by raising (never lowering)
  // the global breaker. Empty snapshots may omit *|all, which is equivalent to 0.
  let providerTotal = 0;
  for (const [key, value] of Object.entries(out)) {
    if (key === '*|all') continue;
    if (providerTotal > Number.MAX_SAFE_INTEGER - value) {
      throw new Error('invalid quota totals');
    }
    providerTotal += value;
  }
  if (providerTotal > (out['*|all'] || 0)) {
    if (!hasLegacySubjects) throw new Error('invalid quota totals');
    out['*|all'] = providerTotal;
    quotaNeedsPrivacyRewrite = true;
  }
  return out;
}

function parseQuotaFile(raw) {
  const loaded = JSON.parse(raw);
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new Error('invalid root object');
  }
  const day = String(loaded.day || '');
  const parsedDay = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? new Date(`${day}T00:00:00.000Z`)
    : null;
  if (!parsedDay || Number.isNaN(parsedDay.getTime()) ||
      parsedDay.toISOString().slice(0, 10) !== day || day > mskDay()) {
    throw new Error('invalid quota day');
  }
  return { day, counts: sanitizeQuotaCounts(loaded.counts) };
}

function quotaStoreError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function quotaTargetFingerprint(target) {
  return [
    target.dev, target.ino, target.mode, target.size,
    target.mtimeNs ?? target.mtimeMs, target.ctimeNs ?? target.ctimeMs
  ].join(':');
}

function inspectQuotaTarget() {
  let directory;
  try {
    directory = fs.lstatSync(path.dirname(QUOTA_FILE), { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        directory: null,
        target: null,
        fileFingerprint: MISSING_QUOTA_TARGET,
        fingerprint: 'directory-missing'
      };
    }
    throw error;
  }
  if (!directory.isDirectory()) throw quotaStoreError('EQUOTADIRECTORY');
  const directoryFingerprint = quotaTargetFingerprint(directory);
  try {
    const target = fs.lstatSync(QUOTA_FILE, { bigint: true });
    const fileFingerprint = quotaTargetFingerprint(target);
    return {
      directory,
      target,
      fileFingerprint,
      fingerprint: `directory:${directoryFingerprint}|file:${fileFingerprint}`
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        directory,
        target: null,
        fileFingerprint: MISSING_QUOTA_TARGET,
        fingerprint: `directory:${directoryFingerprint}|file:${MISSING_QUOTA_TARGET}`
      };
    }
    throw error;
  }
}

function readQuotaBytesBounded(fd, expectedSize) {
  const size = Number(expectedSize);
  // Read one sentinel byte beyond the size established by fstat. A whole-file
  // helper can continue allocating if another local writer grows the same
  // inode after that check; this buffer is capped before any read occurs.
  const bytes = Buffer.allocUnsafe(size + 1);
  let total = 0;
  while (total < bytes.length) {
    const read = fs.readSync(fd, bytes, total, bytes.length - total, null);
    if (read === 0) break;
    total += read;
  }
  if (total !== size) throw quotaStoreError('EQUOTARACE');
  return bytes.subarray(0, size).toString('utf8');
}

// Read through one no-follow file descriptor, then prove the authoritative
// pathname still names those same bytes. This prevents a local backup/restore
// race from being parsed from one inode and trusted as another.
function readQuotaTarget() {
  let fd;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(QUOTA_FILE, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw quotaStoreError('EQUOTATARGET');
    if (before.size <= 0n || before.size > BigInt(MAX_QUOTA_FILE_BYTES)) {
      throw quotaStoreError('EQUOTASIZE');
    }
    const raw = readQuotaBytesBounded(fd, before.size);
    const after = fs.fstatSync(fd, { bigint: true });
    const fingerprint = quotaTargetFingerprint(after);
    if (quotaTargetFingerprint(before) !== fingerprint) {
      throw quotaStoreError('EQUOTARACE');
    }
    const snapshot = parseQuotaFile(raw);
    const current = inspectQuotaTarget();
    if (!current.target?.isFile() || current.fileFingerprint !== fingerprint) {
      throw quotaStoreError('EQUOTARACE');
    }
    return { snapshot, fingerprint: current.fingerprint };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// A valid external restore must never lower counters already admitted by this
// process. Merge same-day snapshots monotonically; across days, retain the
// snapshot nearest the current Moscow day (or the lexically newer old day).
function mergeQuotaSnapshots(current, incoming) {
  if (!quotaFileLoaded) return incoming;
  if (current.day === incoming.day) {
    const counts = { ...current.counts };
    for (const [key, value] of Object.entries(incoming.counts)) {
      counts[key] = Math.max(counts[key] || 0, value);
    }
    let providerTotal = 0;
    for (const [key, value] of Object.entries(counts)) {
      if (key === '*|all') continue;
      if (providerTotal > Number.MAX_SAFE_INTEGER - value) {
        throw new Error('invalid quota totals');
      }
      providerTotal += value;
    }
    counts['*|all'] = Math.max(counts['*|all'] || 0, providerTotal);
    return { day: current.day, counts };
  }
  const today = mskDay();
  if (current.day === today) return current;
  if (incoming.day === today) return incoming;
  return current.day > incoming.day ? current : incoming;
}

function markQuotaFailure(kind, error) {
  quotaPersistenceHealthy = false;
  // Error messages from JSON.parse may echo the corrupt source around the
  // failure offset. Quota files from old releases can contain plaintext
  // license identifiers, so log only the non-sensitive error class/code.
  const detail = String(error?.code || error?.name || 'unknown');
  const fingerprint = `${kind}:${detail}`;
  if (fingerprint !== quotaFailureFingerprint) {
    quotaFailureFingerprint = fingerprint;
    console.error(`quota ${kind} failed; admissions disabled`, detail);
  }
}

try {
  const loadedQuota = readQuotaTarget();
  quota = loadedQuota.snapshot;
  quotaFileLoaded = true;
  quotaAuthoritativeTarget = loadedQuota.fingerprint;
  quotaLastReadinessTarget = loadedQuota.fingerprint;
} catch (e) {
  if (e?.code !== 'ENOENT') {
    quotaLoadBlocked = true;
    markQuotaFailure('load', e);
  }
}

let quotaDirty = false;
function writeQuotaNow() {
  quotaLastWriteCommitted = false;
  if (quotaLoadBlocked) return false;
  if (!quotaDirty) return quotaPersistenceHealthy;
  let temporary = '';
  // Timestamp the attempt before any filesystem operation. A failed exact
  // write must be rate-limited just like a successful proof; otherwise public
  // readiness polling can turn a persistent disk fault into an fsync storm.
  quotaLastStoreProofAt = performance.now();
  try {
    const directory = path.dirname(QUOTA_FILE);
    const serialized = JSON.stringify(quota);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_QUOTA_FILE_BYTES) {
      throw quotaStoreError('EQUOTASIZE');
    }
    // Refuse to replace the authoritative file with bytes our own startup
    // parser would reject. This also catches merge/accounting drift before a
    // successful rename can turn it into a persistent readiness outage.
    const validated = parseQuotaFile(serialized);
    if (JSON.stringify(validated) !== serialized) throw quotaStoreError('EQUOTAINVARIANT');
    fs.mkdirSync(directory, { recursive: true });
    temporary = path.join(directory, `.${path.basename(QUOTA_FILE)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, serialized);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, QUOTA_FILE);
    quotaLastWriteCommitted = true;
    temporary = '';
    // Persist the rename itself. The production target is Linux and supports
    // directory fsync; treating EIO/permission/unsupported-filesystem errors
    // as success would acknowledge paid work whose quota entry can disappear
    // after a crash. The outer failure path keeps the committed count in
    // memory and latches admissions down if this durability proof fails.
    let dirFd;
    try { dirFd = fs.openSync(directory, 'r'); fs.fsyncSync(dirFd); }
    finally {
      if (dirFd !== undefined) {
        try { fs.closeSync(dirFd); } catch { /* the committed rename remains authoritative */ }
      }
    }
    // Re-open through O_NOFOLLOW and parse the authoritative pathname after
    // rename. Merely lstat'ing "a regular file" would accept a different
    // regular inode swapped into the tiny rename→inspect window.
    const committed = readQuotaTarget();
    if (JSON.stringify(committed.snapshot) !== serialized) {
      throw quotaStoreError('EQUOTARACE');
    }
    quotaDirty = false;
    quotaFileLoaded = true;
    quotaLoadBlocked = false;
    quotaPersistenceHealthy = true;
    quotaAuthoritativeTarget = committed.fingerprint;
    quotaLastReadinessTarget = committed.fingerprint;
    quotaFailureFingerprint = '';
    quotaNeedsPrivacyRewrite = false;
    return true;
  } catch (e) {
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } }
    if (quotaLastWriteCommitted) {
      // The reservation reached the authoritative pathname, so rolling memory
      // back could allow the same request to be counted twice after restart.
      // Keep the conservative in-memory count, latch admissions down, and make
      // the next recovery reconcile the target before any paid work.
      quotaDirty = false;
      quotaFileLoaded = true;
      quotaLoadBlocked = true;
      quotaAuthoritativeTarget = '';
    }
    markQuotaFailure('persist', e);
    return false;
  }
}

function persistCurrentQuota() {
  quotaDirty = true;
  return writeQuotaNow();
}

function probeQuotaStore() {
  let temporary = '';
  let renamed = '';
  // Record attempts as well as successes so an unauthenticated readiness
  // flood cannot amplify a persistent disk failure into an fsync storm.
  quotaLastStoreProofAt = performance.now();
  try {
    const directory = path.dirname(QUOTA_FILE);
    fs.mkdirSync(directory, { recursive: true });
    const nonce = `${process.pid}.${crypto.randomUUID()}`;
    temporary = path.join(directory, `.${path.basename(QUOTA_FILE)}.${nonce}.probe`);
    renamed = `${temporary}.renamed`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, '{}');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, renamed);
    temporary = '';
    fs.unlinkSync(renamed);
    renamed = '';
    let dirFd;
    try { dirFd = fs.openSync(directory, 'r'); fs.fsyncSync(dirFd); }
    finally {
      if (dirFd !== undefined) {
        try { fs.closeSync(dirFd); } catch { /* sibling probe already completed */ }
      }
    }
    const observed = inspectQuotaTarget();
    if (observed.target) throw quotaStoreError('EQUOTARACE');
    quotaPersistenceHealthy = true;
    quotaAuthoritativeTarget = observed.fingerprint;
    quotaLastReadinessTarget = observed.fingerprint;
    quotaFailureFingerprint = '';
    return true;
  } catch (e) {
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } }
    if (renamed) { try { fs.unlinkSync(renamed); } catch { /* best effort */ } }
    markQuotaFailure('probe', e);
    return false;
  }
}

function recoverQuotaPersistence(observedTarget = null) {
  // Bound failed reads as well as failed writes. Without this assignment, a
  // corrupt JSON file leaves the timestamp at zero and every public /ready
  // request retries a synchronous read/parse indefinitely.
  quotaLastStoreProofAt = performance.now();
  let observed = observedTarget;
  try {
    observed ||= inspectQuotaTarget();
  } catch (error) {
    quotaLoadBlocked = true;
    markQuotaFailure('probe', error);
    return false;
  }
  quotaLastReadinessTarget = observed.fingerprint;

  if (!observed.target) {
    if (quotaFileLoaded) {
      // The in-memory snapshot is the last known durable state. Restore it
      // exactly; never reset established counters merely because the file was
      // removed between admissions.
      quotaLoadBlocked = false;
      return persistCurrentQuota();
    }
    // A corrupt startup target that an operator deliberately removed may
    // return to first-run state, but readiness still proves the directory
    // without inventing an authoritative empty quota file.
    quota = { day: mskDay(), counts: {} };
    quotaLoadBlocked = false;
    quotaAuthoritativeTarget = MISSING_QUOTA_TARGET;
    return probeQuotaStore();
  }

  if (!observed.target.isFile()) {
    quotaLoadBlocked = true;
    markQuotaFailure('probe', quotaStoreError('EQUOTATARGET'));
    return false;
  }

  try {
    quotaNeedsPrivacyRewrite = false;
    const loaded = readQuotaTarget();
    const merged = mergeQuotaSnapshots(quota, loaded.snapshot);
    quota = merged;
    quotaFileLoaded = true;
    quotaLoadBlocked = false;
    quotaPersistenceHealthy = true;
    quotaAuthoritativeTarget = loaded.fingerprint;
    quotaLastReadinessTarget = loaded.fingerprint;
  } catch (error) {
    quotaLoadBlocked = true;
    markQuotaFailure('load', error);
    return false;
  }

  // Reading a valid replacement is not enough: exercise the exact atomic
  // commit path and normalize legacy/private keys before admitting paid work.
  return persistCurrentQuota();
}

function ensureQuotaPersistence() {
  let observed;
  try {
    observed = inspectQuotaTarget();
  } catch (error) {
    quotaLoadBlocked = true;
    markQuotaFailure('probe', error);
    return false;
  }
  quotaLastReadinessTarget = observed.fingerprint;

  if (observed.target && !observed.target.isFile()) {
    quotaLoadBlocked = true;
    markQuotaFailure('probe', quotaStoreError('EQUOTATARGET'));
    return false;
  }

  const targetChanged = observed.fingerprint !== quotaAuthoritativeTarget;
  if (quotaLoadBlocked || !quotaPersistenceHealthy || targetChanged ||
      (observed.target && !quotaFileLoaded)) {
    return recoverQuotaPersistence(observed);
  }
  return true;
}

// Readiness is an observation of the storage target NOW, not merely the last
// admission's health latch. Preserve the intentional no-authoritative-file
// behavior before the first charge, but once quota state has existed, exercise
// the exact atomic replacement path with the current in-memory snapshot.
function verifyQuotaPersistenceForReadiness() {
  let observed;
  try {
    observed = inspectQuotaTarget();
  } catch (error) {
    quotaLoadBlocked = true;
    markQuotaFailure('probe', error);
    return false;
  }
  const targetChanged = observed.fingerprint !== quotaLastReadinessTarget;
  quotaLastReadinessTarget = observed.fingerprint;
  const deepProbeDue = performance.now() - quotaLastStoreProofAt >= QUOTA_READINESS_DEEP_PROBE_MS;

  // A directory, device, or symlink at the authoritative pathname can still
  // allow sibling probes while making the real rename fail.
  if (observed.target && !observed.target.isFile()) {
    quotaLoadBlocked = true;
    markQuotaFailure('probe', quotaStoreError('EQUOTATARGET'));
    return false;
  }

  // A failed read/write is retried only for a changed target or on the bounded
  // cadence. Successful admissions and probes both reset that cadence.
  if (quotaLoadBlocked || !quotaPersistenceHealthy) {
    return targetChanged || deepProbeDue
      ? recoverQuotaPersistence(observed)
      : false;
  }

  // A regular-file restore/replacement is authoritative input, not a path to
  // overwrite from stale memory. Re-read, monotonically merge, and exact-write
  // it once before reporting ready. The same check runs on admission.
  if (observed.fingerprint !== quotaAuthoritativeTarget ||
      (observed.target && !quotaFileLoaded)) {
    return recoverQuotaPersistence(observed);
  }

  if (!deepProbeDue) return true;
  if (!observed.target) {
    // Preserve intentional first-run absence while proving sibling
    // create/write/fsync/rename/unlink on a bounded cadence.
    return probeQuotaStore();
  }
  // Existing authoritative state receives a bounded exact-path replacement,
  // which catches immutable/ACL target failures that a sibling probe cannot.
  return persistCurrentQuota();
}

function flushPendingQuota() {
  return quotaDirty ? writeQuotaNow() : quotaPersistenceHealthy;
}

// Existing state is exact-written once at startup so readiness begins with a
// current proof of the real replacement target. A first-run store gets only a
// sibling probe and remains absent until the first durable reservation.
if (!quotaLoadBlocked) {
  if (quotaFileLoaded) persistCurrentQuota();
  else probeQuotaStore();
}

// Returns the durable quota bucket plus an immutable routing snapshot. The
// caller-selected qwen/deepseek id chooses the frontier experience; once the
// combined frontier allowance is consumed, both experiences continue on the
// standard chain.
//
// `requestStandard` is the client's downgrade-only hint (any-site solving). It
// can force the standard tier but never the frontier one, so the worst a
// hostile client achieves is spending its own cheap bucket.
function chargeQuota(
  licenseKey, providerId, provider, requestStandard = false, hasImages = false, hasPdfs = false
) {
  if (!QUOTA_CONFIG_VALID || !modelConfigHealthy) {
    return { ok: false, status: 503, message: UNAVAILABLE };
  }
  if (!ensureQuotaPersistence()) {
    return { ok: false, status: 503, message: UNAVAILABLE };
  }
  if (!provider || !/^(?:qwen|deepseek)$/.test(String(providerId || ''))) {
    console.error('quota refused: unknown client route', String(providerId));
    return { ok: false, status: 503, message: UNAVAILABLE };
  }

  const routingState = modelState;
  const limits = routingState.config.limits;
  const today = mskDay();
  const counts = quota.day === today ? quota.counts : {};
  const licenseRef = quotaLicenseRef(licenseKey);
  const qwenUsed = sanitizeQuotaCount(counts[`${licenseRef}|qwen`] || 0);
  const deepseekUsed = sanitizeQuotaCount(counts[`${licenseRef}|deepseek`] || 0);
  const frontierUsed = qwenUsed > Number.MAX_SAFE_INTEGER - deepseekUsed
    ? Number.MAX_SAFE_INTEGER
    : qwenUsed + deepseekUsed;
  const tier = requestStandard === true || limits.force_standard ||
    frontierUsed >= limits.frontier_per_license
    ? 'standard'
    : 'frontier';
  const bucket = tier === 'frontier' ? providerId : 'standard';
  const cap = tier === 'frontier' ? limits.frontier_per_license : limits.standard_per_license;
  const providerKey = `${licenseRef}|${bucket}`;
  const mine = Math.min(Number.MAX_SAFE_INTEGER, sanitizeQuotaCount(counts[providerKey] || 0) + 1);
  if (mine > cap) {
    return {
      ok: false,
      status: 429,
      message: tier === 'frontier'
        ? 'Дневной лимит быстрых ИИ-запросов исчерпан. Запрос будет доступен через стандартный режим.'
        : `Дневной лимит ИИ по вашей лицензии исчерпан (${cap} запросов). Счётчик сбросится завтра.`
    };
  }

  const total = Math.min(Number.MAX_SAFE_INTEGER, sanitizeQuotaCount(counts['*|all'] || 0) + 1);
  if (total > limits.global_daily) {
    console.error('GLOBAL DAILY BREAKER TRIPPED', total, '>', limits.global_daily);
    return { ok: false, status: 429, message: OVERLOADED };
  }

  // Resolve the exact content route before touching durable counters. A
  // document/image kill switch must reject admission without spending quota or
  // creating an empty job that fails later in the background runner.
  const route = routeForRequest(providerId, tier, hasImages, hasPdfs, routingState);
  if (!route.models.length) return { ok: false, status: 503, message: UNAVAILABLE };

  const previousQuota = quota;
  quota = {
    day: today,
    counts: { ...counts, [providerKey]: mine, '*|all': total }
  };
  if (!persistCurrentQuota()) {
    if (!quotaLastWriteCommitted) {
      // The new snapshot never reached the authoritative pathname. Restore
      // memory to the same state as disk; a post-rename observation failure is
      // handled conservatively inside writeQuotaNow and keeps the count.
      quota = previousQuota;
      quotaDirty = false;
    }
    return { ok: false, status: 503, message: UNAVAILABLE };
  }
  return {
    ok: true,
    day: today,
    bucket,
    tier,
    revision: routingState.revision,
    routingState
  };
}

// Give a reservation back when the request provably bought nothing: the job
// was discarded before its capability reached the client, or the upstream
// stream never opened. Both counters were advanced together, so both are
// released together. A refund is best effort — a failed one over-counts, which
// fails closed. It never runs across a day boundary (the new day's counters
// belong to other requests) and never drives a counter below zero.
function refundQuota(day, licenseKey, bucket) {
  if (!day || quota.day !== day || !licenseKey || !bucket) return false;
  const providerKey = `${quotaLicenseRef(licenseKey)}|${bucket}`;
  const counts = quota.counts;
  const mine = Number(counts[providerKey] || 0);
  const total = Number(counts['*|all'] || 0);
  if (!Number.isSafeInteger(mine) || !Number.isSafeInteger(total) || mine < 1 || total < 1) {
    return false;
  }
  const previousQuota = quota;
  quota = { day, counts: { ...counts, [providerKey]: mine - 1, '*|all': total - 1 } };
  if (!persistCurrentQuota()) {
    if (!quotaLastWriteCommitted) {
      // The release never reached the authoritative pathname; keep memory and
      // disk identical by restoring the higher (conservative) counters.
      quota = previousQuota;
      quotaDirty = false;
    }
    return false;
  }
  return true;
}

/* ------------------------ entitlement verify -------------------------- */
// Verify the license Worker's short-lived AI capability locally. The token is
// purpose-bound and carries only a pseudonymous quota subject plus device id.
const ENTITLEMENT_TOKEN = /^et1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const ENTITLEMENT_TTL_MS = 10 * 60 * 1000;
const ENTITLEMENT_CLOCK_SKEW_MS = 60 * 1000;

function verifyEntitlement(rawToken, now = Date.now()) {
  const token = typeof rawToken === 'string' && rawToken.length <= 2048 ? rawToken : '';
  const match = ENTITLEMENT_TOKEN.exec(token);
  if (!match || !ENTITLEMENT_SECRET_VALID) return { ok: false, reason: 'bad_entitlement' };
  let payloadBytes;
  let signature;
  try {
    payloadBytes = Buffer.from(match[1], 'base64url');
    signature = Buffer.from(match[2], 'base64url');
  } catch {
    return { ok: false, reason: 'bad_entitlement' };
  }
  if (payloadBytes.toString('base64url') !== match[1] ||
      signature.toString('base64url') !== match[2] || signature.length !== 32) {
    return { ok: false, reason: 'bad_entitlement' };
  }
  const expected = crypto.createHmac('sha256', ENTITLEMENT_SECRET)
    .update(`et1.${match[1]}`).digest();
  if (!crypto.timingSafeEqual(signature, expected)) return { ok: false, reason: 'bad_entitlement' };
  let payload;
  try { payload = JSON.parse(payloadBytes.toString('utf8')); }
  catch { return { ok: false, reason: 'bad_entitlement' }; }
  const issuedAt = Number(payload?.iat);
  const expiresAt = Number(payload?.exp);
  const current = Math.trunc(Number(now));
  if (payload?.v !== 1 || payload?.p !== 'ai' ||
      !/^h:[a-f0-9]{64}$/.test(payload?.l || '') ||
      !normalizeDeviceId(payload?.d) ||
      !Number.isSafeInteger(current) || !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) || issuedAt < 0 ||
      expiresAt <= issuedAt || expiresAt > issuedAt + ENTITLEMENT_TTL_MS ||
      issuedAt > current + ENTITLEMENT_CLOCK_SKEW_MS || expiresAt <= current ||
      expiresAt > current + ENTITLEMENT_TTL_MS + ENTITLEMENT_CLOCK_SKEW_MS) {
    return { ok: false, reason: expiresAt <= current ? 'expired_entitlement' : 'bad_entitlement' };
  }
  return {
    ok: true,
    licenseRef: payload.l,
    deviceId: normalizeDeviceId(payload.d),
    expiresAt
  };
}
async function readResponseTextBounded(response, maxBytes) {
  if (!response?.body) return '';
  const chunks = [];
  let retained = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const take = Math.min(bytes.length, maxBytes - retained);
      if (take > 0) {
        chunks.push(bytes.subarray(0, take));
        retained += take;
      }
      if (take < bytes.length || retained >= maxBytes) {
        try { await response.body.cancel('response limit reached'); } catch { /* stream is locked/closed */ }
        break;
      }
    }
  } catch { return ''; }
  return Buffer.concat(chunks, retained).toString('utf8');
}

/* ------------------------- message sanitizer -------------------------- */
// Rebuild from scratch — accept only the shapes the extension produces. Same
// caps as ai-proxy.js sanitizeMessages().

function sanitizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null;
  const out = [];
  let imageCount = 0;
  let pdfCount = 0;
  for (const m of raw) {
    const role = m && m.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
    const content = m.content;
    if (typeof content === 'string') {
      if (content.length > MAX_TEXT_PART_CHARS) return null;
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content) || content.length === 0 || content.length > MAX_PARTS) return null;
    const parts = [];
    for (const part of content) {
      if (part && part.type === 'text' && typeof part.text === 'string') {
        if (part.text.length > MAX_TEXT_PART_CHARS) return null;
        parts.push({ type: 'text', text: part.text });
        continue;
      }
      if (part && part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string' &&
          SAFE_IMAGE_DATA_URI.test(part.image_url.url)) {
        if (part.image_url.url.length > MAX_IMAGE_DATA_URI_CHARS ||
            !isCanonicalBase64DataUri(part.image_url.url, SAFE_IMAGE_DATA_URI)) return null;
        if (++imageCount > MAX_IMAGES_PER_REQUEST) return null;
        parts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        continue;
      }
      // PDF as an OpenAI-style file part (data URI only — never a URL, so this
      // box can't be turned into a fetch proxy). Routed to the Gemini chain by
      // modelChoices; 302.AI passes the file through to the model (verified).
      if (part && part.type === 'file' && part.file && typeof part.file.file_data === 'string' &&
          part.file.file_data.startsWith(PDF_DATA_URI_PREFIX)) {
        if (part.file.file_data.length > MAX_PDF_DATA_URI_CHARS ||
            !isCanonicalBase64DataUri(part.file.file_data, PDF_DATA_URI_PREFIX)) return null;
        if (++pdfCount > MAX_PDFS_PER_REQUEST) return null;
        const filename = String(part.file.filename || 'document.pdf').slice(0, 120);
        parts.push({ type: 'file', file: { filename, file_data: part.file.file_data } });
        continue;
      }
      return null;
    }
    out.push({ role, content: parts });
  }
  return out;
}

function hasImageParts(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
}

function hasPdfParts(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'file'));
}

/* ----------------------------- blob store ----------------------------- */
// Reassembles chunk-uploaded attachments (see /ai/blob). blob_id → { parts,
// total, chars, mime, name, done, data, createdAt, lastAccess }. `data` is the
// reassembled STRING — the raw messages JSON a start references by
// `messages_blob`. Bounded + TTL'd.

const blobs = new Map();
let totalBlobChars = 0;
let reservedBlobChars = 0;
// Short-lived, entitlement-verified capabilities for /ai/blob. A blob upload happens
// before /ai/start can charge a quota, so accepting anonymous chunks turned this
// bounded memory store into a public denial-of-service primitive.
const uploadTickets = new Map(); // token -> { blobId, licenseKey, deviceId, ip, declaredChars, chars, createdAt, expiresAt, lastAccess }
const uploadTicketStartsByLicense = new Map();
const uploadTicketStartsByIp = new Map();

function ticketReservation(ticket) {
  return Math.max(0, (ticket?.declaredChars || 0) - (ticket?.chars || 0));
}

function deleteUploadTicket(token) {
  const ticket = uploadTickets.get(token);
  if (!ticket) return;
  reservedBlobChars = Math.max(0, reservedBlobChars - ticketReservation(ticket));
  uploadTickets.delete(token);
}

function setTicketChars(ticket, chars) {
  const before = ticketReservation(ticket);
  const priorChars = ticket.chars;
  ticket.chars = Math.max(0, chars);
  reservedBlobChars += ticketReservation(ticket) - before;
  if (reservedBlobChars < 0) reservedBlobChars = 0;
  if (ticket.chars > priorChars) {
    const now = Date.now();
    ticket.progressDeadline = Math.min(
      now + UPLOAD_PROGRESS_DEADLINE_MS,
      ticket.createdAt + UPLOAD_ABSOLUTE_TTL_MS
    );
    ticket.expiresAt = Math.min(now + BLOB_TTL_MS, ticket.createdAt + UPLOAD_ABSOLUTE_TTL_MS);
  }
}

function freeBlob(id) {
  const b = blobs.get(id);
  if (!b) return;
  totalBlobChars -= b.chars || 0;
  if (totalBlobChars < 0) totalBlobChars = 0;
  if (b.uploadToken) deleteUploadTicket(b.uploadToken);
  blobs.delete(id);
}

function ticketFor(token, blobId) {
  const normalizedToken = typeof token === 'string' ? token : '';
  const ticket = uploadTickets.get(normalizedToken);
  if (!ticket || ticket.blobId !== blobId) return null;
  const now = Date.now();
  const absoluteExpiry = ticket.createdAt + UPLOAD_ABSOLUTE_TTL_MS;
  if (ticket.expiresAt <= now || absoluteExpiry <= now ||
      (!blobs.get(ticket.blobId)?.done && ticket.progressDeadline <= now)) {
    if (blobs.has(ticket.blobId)) freeBlob(ticket.blobId);
    else deleteUploadTicket(normalizedToken);
    return null;
  }
  return ticket;
}

async function handleUploadTicket(req, res, rawBody) {
  let body;
  try { body = JSON.parse(rawBody); } catch { return sendErr(res, 400, 'Некорректный запрос.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendErr(res, 400, 'Некорректный запрос.');
  }
  const entitlement = verifyEntitlement(body.entitlement_token);
  const licenseKey = entitlement.ok ? entitlement.licenseRef : '';
  const deviceId = entitlement.ok ? entitlement.deviceId : '';
  const suppliedSize = Number(body.size);
  const declaredChars = Number.isInteger(suppliedSize) && suppliedSize >= 1 && suppliedSize <= MAX_BLOB_CHARS
    ? suppliedSize : MAX_BLOB_CHARS;
  if (!entitlement.ok) return sendErr(res, 403, NEED_LICENSE);
  if (shutdownStarted) return sendErr(res, 503, OVERLOADED, { 'Connection': 'close' });

  let activeForDevice = 0;
  let activeForLicense = 0;
  let activeForIp = 0;
  let reservedForDevice = 0;
  let reservedForLicense = 0;
  let reservedForIp = 0;
  const now = Date.now();
  const ip = requestIp(req);
  // Sweep here as well as in the interval so a full map cannot stay wedged on
  // expired entries for up to one GC period.
  for (const [token, ticket] of uploadTickets) {
    if (ticket.expiresAt <= now) {
      if (blobs.has(ticket.blobId)) freeBlob(ticket.blobId);
      else deleteUploadTicket(token);
    }
  }
  if (uploadTickets.size >= MAX_UPLOAD_TICKETS) return sendErr(res, 503, OVERLOADED);
  for (const ticket of uploadTickets.values()) {
    const reservation = ticketReservation(ticket);
    if (ticket.expiresAt > now && ticket.licenseKey === licenseKey && ticket.deviceId === deviceId) {
      activeForDevice += 1;
      reservedForDevice += reservation;
    }
    if (ticket.expiresAt > now && ticket.licenseKey === licenseKey) {
      activeForLicense += 1;
      reservedForLicense += reservation;
    }
    if (ticket.expiresAt > now && ticket.ip === ip) {
      activeForIp += 1;
      reservedForIp += reservation;
    }
  }
  if (activeForDevice >= MAX_UPLOAD_TICKETS_PER_DEVICE ||
      activeForLicense >= MAX_UPLOAD_TICKETS_PER_LICENSE || activeForIp >= MAX_UPLOAD_TICKETS_PER_IP) {
    return sendErr(res, 429, 'Слишком много незавершённых загрузок. Подождите минуту и попробуйте ещё раз.');
  }
  const licenseStarts = recentStarts(uploadTicketStartsByLicense, licenseKey, now, UPLOAD_TICKET_RATE_WINDOW_MS);
  const ipStarts = recentStarts(uploadTicketStartsByIp, ip, now, UPLOAD_TICKET_RATE_WINDOW_MS);
  if (licenseStarts.length >= UPLOAD_TICKET_RATE_PER_LICENSE || ipStarts.length >= UPLOAD_TICKET_RATE_PER_IP) {
    return sendErr(res, 429, 'Слишком много загрузок за короткое время. Подождите несколько минут и попробуйте снова.');
  }
  if (reservedBlobChars + declaredChars > MAX_RESERVED_BLOB_CHARS ||
      reservedForDevice + declaredChars > MAX_RESERVED_PER_DEVICE ||
      reservedForLicense + declaredChars > MAX_RESERVED_PER_LICENSE ||
      reservedForIp + declaredChars > MAX_RESERVED_PER_IP) {
    return sendErr(res, 429, 'Слишком много зарезервированных загрузок. Начните предыдущую загрузку или подождите несколько секунд.');
  }
  if (totalBlobChars + reservedBlobChars + declaredChars > MAX_TOTAL_BLOB_CHARS) {
    return sendErr(res, 503, OVERLOADED);
  }

  const uploadToken = crypto.randomBytes(32).toString('base64url');
  const blobId = crypto.randomUUID();
  uploadTickets.set(uploadToken, {
    blobId, licenseKey, deviceId, ip,
    declaredChars, chars: 0, createdAt: now,
    expiresAt: Math.min(now + BLOB_TTL_MS, now + UPLOAD_ABSOLUTE_TTL_MS),
    progressDeadline: now + UPLOAD_FIRST_CHUNK_DEADLINE_MS,
    lastAccess: now
  });
  reservedBlobChars += declaredChars;
  licenseStarts.push(now);
  ipStarts.push(now);
  uploadTicketStartsByLicense.set(licenseKey, licenseStarts);
  uploadTicketStartsByIp.set(ip, ipStarts);
  res.once('close', () => {
    if (!res.writableFinished) deleteUploadTicket(uploadToken);
  });
  try {
    sendJson(res, 200, { ok: true, upload_token: uploadToken, blob_id: blobId });
  } catch (error) {
    deleteUploadTicket(uploadToken);
    throw error;
  }
}

function resetBlobAttempt(blob, ticket, total, generation, protocol, body) {
  totalBlobChars -= blob.chars;
  if (totalBlobChars < 0) totalBlobChars = 0;
  setTicketChars(ticket, ticket.chars - blob.chars);
  blob.parts.clear();
  blob.total = total;
  blob.generation = generation;
  blob.protocol = protocol;
  blob.chars = 0;
  blob.done = false;
  blob.data = '';
  blob.mime = typeof body.mime === 'string' ? body.mime.slice(0, 80) : '';
  blob.name = typeof body.name === 'string' ? body.name.slice(0, 120) : '';
}

function sendBlobProgress(res, id, blob) {
  sendJson(res, 200, {
    ok: true,
    blob_id: id,
    generation: blob.generation,
    received: blob.done ? blob.total : blob.parts.size,
    complete: !!blob.done
  });
}

// One chunk of a blob. Chunks are plain SUBSTRINGS concatenated in seq order
// — the server never decodes anything, it just reassembles the original
// string. Idempotent per (blob_id, generation, seq, chunk): an exact retry is
// ignored, while conflicting bytes for the same sequence invalidate the
// ambiguous upload instead of silently assembling whichever request happened
// to win. The generation disambiguates a late probe request from the RU-safe
// fallback that superseded it.
function handleBlob(req, res, rawBody) {
  let b;
  try { b = JSON.parse(rawBody); } catch { return sendErr(res, 400, 'Некорректный запрос.'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    return sendErr(res, 400, 'Некорректный запрос.');
  }
  const id = typeof b.blob_id === 'string' && UUID_V4.test(b.blob_id) ? b.blob_id : '';
  const hasGeneration = Object.prototype.hasOwnProperty.call(b, 'generation');
  const generation = hasGeneration ? b.generation : 0;
  const seq = b.seq;
  const total = b.total;
  const chunk = typeof b.chunk === 'string' ? b.chunk : null;
  if (!id || chunk === null || chunk.length === 0 || !Number.isSafeInteger(seq) || seq < 0 ||
      !Number.isSafeInteger(total) || total < 1 || total > MAX_BLOB_PARTS || seq >= total ||
      !Number.isSafeInteger(generation) || generation < 0 || generation > MAX_UPLOAD_GENERATION) {
    return sendErr(res, 400, 'Некорректный запрос.');
  }
  if (chunk.length > MAX_CHUNK_CHARS) return sendErr(res, 413, TOO_BIG);
  const ticket = ticketFor(b.upload_token, id);
  if (!ticket) return sendErr(res, 403, 'Загрузка не подтверждена или устарела. Попробуйте ещё раз.');

  let blob = blobs.get(id);
  if (!blob) {
    if (blobs.size >= MAX_BLOBS || totalBlobChars + chunk.length > MAX_TOTAL_BLOB_CHARS) {
      return sendErr(res, 503, OVERLOADED);
    }
    blob = {
      parts: new Map(), total, chars: 0, done: false, data: '',
      generation, protocol: hasGeneration ? 'generation' : 'legacy',
      legacyRestarted: false, retiredLegacyTotal: null,
      mime: typeof b.mime === 'string' ? b.mime.slice(0, 80) : '',
      name: typeof b.name === 'string' ? b.name.slice(0, 120) : '',
      uploadToken: b.upload_token,
      licenseKey: ticket.licenseKey,
      deviceId: ticket.deviceId,
      activationHash: ticket.activationHash,
      createdAt: ticket.createdAt,
      lastAccess: Date.now()
    };
    blobs.set(id, blob);
  }
  if (blob.uploadToken !== b.upload_token) {
    return sendErr(res, 403, 'Загрузка не подтверждена или устарела. Попробуйте ещё раз.');
  }

  if (hasGeneration) {
    // A request from the superseded probe can finish after generation 1 has
    // already started or completed. It is a successful idempotent no-op.
    if (generation < blob.generation) return sendBlobProgress(res, id, blob);
    if (generation > blob.generation) {
      resetBlobAttempt(blob, ticket, total, generation, 'generation', b);
    } else if (blob.total !== total) {
      freeBlob(id);
      return sendErr(res, 409, 'Параметры загрузки изменились. Пришлите вложение ещё раз.');
    } else {
      // A generation-aware request upgrades an in-flight legacy-compatible
      // record without changing its bytes.
      blob.protocol = 'generation';
    }
  } else if (blob.protocol === 'generation') {
    // Generation-less requests cannot supersede explicit client intent. They
    // may be delayed requests from an extension version that was replaced
    // mid-upload, so acknowledge them without touching the current attempt.
    if (blob.total !== total || blob.generation > 0) return sendBlobProgress(res, id, blob);
  } else if (blob.total !== total) {
    // Compatibility for already-installed clients that do not send a
    // generation. The fallback always uses smaller chunks and therefore a
    // larger total. Permit that transition once; lower totals are necessarily
    // delayed probe traffic and become harmless no-ops.
    if (total < blob.total || total === blob.retiredLegacyTotal) {
      return sendBlobProgress(res, id, blob);
    }
    if (blob.legacyRestarted) {
      freeBlob(id);
      return sendErr(res, 409, 'Параметры загрузки изменились. Пришлите вложение ещё раз.');
    }
    blob.retiredLegacyTotal = blob.total;
    blob.legacyRestarted = true;
    resetBlobAttempt(blob, ticket, total, 0, 'legacy', b);
  }
  blob.lastAccess = Date.now();

  if (!blob.done && blob.parts.has(seq) && blob.parts.get(seq) !== chunk) {
    freeBlob(id);
    return sendErr(res, 409, 'Часть загрузки изменилась при повторе. Пришлите вложение ещё раз.');
  }
  if (!blob.done && !blob.parts.has(seq)) {
    if (blob.chars + chunk.length > MAX_BLOB_CHARS || ticket.chars + chunk.length > ticket.declaredChars ||
        totalBlobChars + chunk.length > MAX_TOTAL_BLOB_CHARS) {
      freeBlob(id);
      return sendErr(res, 413, TOO_BIG);
    }
    blob.parts.set(seq, chunk);
    blob.chars += chunk.length;
    setTicketChars(ticket, ticket.chars + chunk.length);
    totalBlobChars += chunk.length;
  }
  if (!blob.done && blob.parts.size >= blob.total) {
    let s = '';
    for (let i = 0; i < blob.total; i++) s += blob.parts.get(i) || '';
    blob.data = s;
    blob.parts.clear();     // free the piecewise copy; keep only the joined string
    blob.done = true;
  }
  sendBlobProgress(res, id, blob);
}

/* --------------------- shared request preparation --------------------- */
// Everything /ai/chat and /ai/start have in common: parse, validate and verify
// the entitlement. Job slots and quota are reserved only AFTER this returns,
// so an anonymous invalid request cannot consume scarce active-job slots.

async function prepareChat(req, res, rawBody, { checkStartReplay = false } = {}) {
  if (!UPSTREAM_KEY) { console.error('AI_PROXY_API_KEY not set'); return { err: { status: 503, message: UNAVAILABLE } }; }

  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return { err: { status: 413, message: TOO_BIG } };
  let body;
  try { body = JSON.parse(rawBody); } catch { return { err: { status: 400, message: 'Некорректный запрос.' } }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { err: { status: 400, message: 'Некорректный запрос.' } };
  }

  const provider = providerById(body.provider);
  if (!provider) return { err: { status: 400, message: 'Неизвестный провайдер.' } };
  const providerId = body.provider;

  const entitlement = verifyEntitlement(body.entitlement_token);
  const licenseKey = entitlement.ok ? entitlement.licenseRef : '';
  const deviceId = entitlement.ok ? entitlement.deviceId : '';
  const telemetryOptIn = body.telemetry_opt_in === true;
  if (!entitlement.ok) return { err: { status: 403, message: NEED_LICENSE } };
  if (shutdownStarted) {
    return { err: { status: 503, message: OVERLOADED, headers: { 'Connection': 'close' } } };
  }

  // /ai/start retries must be recognized before consuming a one-shot
  // messages_blob. The first successful start records the exact request bytes
  // plus the authenticated principal; an identical retry can therefore recover
  // the original job even though its upload was deliberately freed.
  const idempotencyKey = readIdempotencyKey(body);
  const principal = sha256Hex(`${licenseKey}\u0000${deviceId}`);
  const requestDigest = sha256Hex(rawBody);
  if (checkStartReplay && idempotencyKey) {
    pruneStartIdempotency(Date.now());
    const existing = startIdempotency.get(idempotencyKey);
    if (existing) {
      if (!safeEqualSecret(existing.principal, principal) || existing.digest !== requestDigest) {
        return { err: { status: 409, message: 'Повторный запрос не совпадает с исходным. Начните заново.' } };
      }
      // The recorded job may already be gone: a user cancel, the abandon
      // sweep, or the done+linger GC — whose window (JOB_LINGER_MS) is
      // shorter than this entry's TTL. Returning it would hand the client a
      // job_id that every /ai/poll must 404 on until the entry itself
      // expires. Drop the stale entry and fall through to a fresh start.
      if (!jobs.has(existing.jobId)) {
        startIdempotency.delete(idempotencyKey);
      } else {
        return { replay: { jobId: existing.jobId, token: existing.token } };
      }
    }
  }

  // A large request arrives with its messages chunk-uploaded to /ai/blob. Bind
  // the completed blob to this same license/device before reading it, so a
  // guessed or leaked blob id cannot be redeemed by another caller.
  let blobId = '';
  let blobDigest = '';
  if (typeof body.messages_blob === 'string') {
    blobId = body.messages_blob;
    const blob = blobs.get(body.messages_blob);
    if (!blob || !blob.done) {
      return { err: { status: 410, message: 'Загруженное вложение устарело. Пришлите его ещё раз.' } };
    }
    if (blob.licenseKey !== licenseKey || blob.deviceId !== deviceId) {
      return { err: { status: 403, message: 'Загрузка не принадлежит этому устройству. Пришлите вложение ещё раз.' } };
    }
    // Bind the recorded start to the immutable completed upload as well as its
    // reference. This is retained for audit/debugging; replay authorization is
    // still exact-body + authenticated-principal and never trusts a new blob.
    blobDigest = sha256Hex(blob.data);
    try { body.messages = JSON.parse(blob.data); }
    catch { freeBlob(body.messages_blob); return { err: { status: 400, message: 'Некорректный запрос.' } }; }
    freeBlob(body.messages_blob);
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages) return { err: { status: 400, message: 'Некорректный формат сообщений.' } };
  const hasImages = hasImageParts(messages);
  const hasPdfs = hasPdfParts(messages);

  // Retain only the two whitelisted upstream options. Keeping the original
  // parsed body here duplicated every large attachment (and arbitrary ignored
  // fields) for the full AI job despite sanitizeMessages rebuilding messages.
  const requestOptions = {};
  if (body.response_format === 'json_object') requestOptions.response_format = 'json_object';
  if (REASONING_EFFORTS.has(body.reasoning_effort)) {
    requestOptions.reasoning_effort = body.reasoning_effort;
  }
  // DOWNGRADE-only route hint. The extension sends it for pages solved outside
  // МЭШ (any-site solving — see src/lib/web-solve.js): answer them on the cheap
  // standard chain and charge the standard bucket, leaving the frontier
  // allowance for the schoolwork the licence is actually sold for. 'standard'
  // is the ONLY accepted value, so the field can never buy a better model than
  // the quota state already allows.
  if (body.tier === 'standard') requestOptions.tier = 'standard';

  return {
    provider, providerId, body: requestOptions, messages,
    hasImages, hasPdfs, licenseKey, deviceId, telemetryOptIn,
    // Surfaced separately because `body` above is deliberately reduced to the
    // two whitelisted upstream options — the raw parsed request is not kept.
    idempotencyKey, principal, requestDigest, blobId, blobDigest
  };
}

/* ------------------------ upstream connection ------------------------- */
// Open the 302.AI stream, walking the model fallback chain. Returns
// { upstream } (a fetch Response with .ok) or { err: { status, message } }.
// Shared by the diagnostic streaming route and the poll-job runner.

// Two solves fired at once (each a PDF-sized body) can make the OUTBOUND
// fetch to 302.AI itself throw — not a 4xx/5xx from 302.AI, but a transport-
// level failure (reset connection, DNS hiccup, or this box's own CPU/network
// briefly saturated re-serializing two multi-MB JSON bodies at once on a
// t3.micro). Observed live: one of two concurrent PDF solves got exactly this
// path while the other succeeded. The job-wide connect ceiling (20 s text,
// 75 s PDF — see UPSTREAM_CONNECT_TIMEOUT_*) rules out
// "just needs more time"; what actually helps is trying again a moment later,
// once the other job has released whatever it was contending for. Retried
// ONLY on a thrown fetch (this loop's catch) — an honest 4xx/5xx from 302.AI
// itself is handled below and is not retried here (isUnpurchased fallback,
// or a real error code the caller should see). A thrown fetch is not
// automatically safe to retry: a reset after the POST reached 302.AI is an
// ambiguous paid effect. Retry only failures that prove no connection/request
// reached the provider.
const UPSTREAM_CONNECT_RETRIES = 2;
const UPSTREAM_CONNECT_RETRY_DELAY_MS = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRE_DISPATCH_RETRY_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT'
]);

function isPreDispatchFailure(error) {
  const code = String(error?.cause?.code || error?.code || '');
  return PRE_DISPATCH_RETRY_CODES.has(code);
}

/**
 * Statuses that prove the provider REFUSED the request instead of running it.
 * Mirrors backend/src/ai-proxy.js isNonBillableRejection — keep both in sync.
 * Receiving a status at all means the request body reached 302.AI, so only its
 * own explicit rejections are safe to refund. Anything else (cancel, timeout,
 * reset, ambiguous 5xx) may have executed a paid completion we never read.
 */
const NON_BILLABLE_STATUSES = new Set([400, 401, 402, 403, 404, 405, 413, 422, 429]);

function isNonBillableRejection(status, text) {
  return NON_BILLABLE_STATUSES.has(status) || isUnpurchased(text);
}

/**
 * "You sent a field I don't accept" — 302.AI answers this with HTTP 400 and
 * {"error":{"err_code":-10003,"message":"Parameter error"}}; a plain
 * OpenAI-compatible upstream answers with an invalid_request_error naming the
 * field. Unlike isUnpurchased this does NOT mean "try the next model": the
 * same model may well work once the offending field is dropped.
 *
 * It exists for exactly one field. reasoning_effort support is a per-model,
 * per-reseller fact that can only be established by a live probe
 * (tests/302ai-verify.sh), and a wrong guess in the effort policy above would
 * otherwise turn into a 502 on EVERY request rather than a quality downgrade.
 */
function isParameterRejection(status, text) {
  return status === 400 &&
    /"err_code"\s*:\s*-10003|invalid_request_error|unsupported[_ ]parameter|unknown field|reasoning_effort/i.test(text || '');
}

async function connectUpstream(provider, body, messages, hasImages, hasPdfs, signal = null) {
  let upstream = null, lastFailure = null, usedModel = null;
  // Flips only once a response proves the request reached the provider, or an
  // ambiguous transport failure means it may have. A connect-level refusal is
  // positively pre-dispatch and remains refundable even after fetch() began.
  let providerMayHaveRun = false;
  // One entry per dispatch, not per model: a model whose only questionable
  // field is the reasoning_effort this function synthesized is re-queued once
  // with `dropEffort` set, rather than being abandoned for the next model in
  // the chain. See isParameterRejection at the bottom of the loop.
  const attempts = modelChoices(provider).map((model) => ({ model, dropEffort: false }));
  for (let i = 0; i < attempts.length; i++) {
    const { model, dropEffort } = attempts[i];
    usedModel = model;
    const upstreamBody = {
      model, messages, temperature: 0.3, max_tokens: MAX_TOKENS_OUT,
      stream: true, stream_options: { include_usage: true }
    };
    // JSON mode is dropped when a Qwen model is asked to read an IMAGE: Qwen
    // has shown unreliable json_object behaviour once a picture is in the
    // request, which is why the client-side wrapper already strips it there
    // (src/lib/qwen.js wantJson). The test solver survives this — its parser
    // recovers the {answers:[{n,a}]} shape out of ordinary prose — whereas a
    // model that silently stops honouring the format returns nothing usable.
    const dropJsonForQwenVision = hasImages && QWEN_MODEL.test(model);
    if (body.response_format === 'json_object' && !dropJsonForQwenVision) {
      upstreamBody.response_format = { type: 'json_object' };
    }
    // The quality policy is enforced per ACTUAL model, not per route: the
    // dashboard owns which model each route resolves to, and every model has a
    // different thinking knob.
    //   - qwen3.8-flash (the live model for everything but PDFs) takes a real
    //     reasoning_effort, in its own low/medium/xhigh vocabulary.
    //   - older Qwen thinks by default and has no effort levels, so nothing is
    //     sent — see QWEN_NO_EFFORT.
    //   - GLM-5.3-Flash (the cheap chain's fallback) needs forced thinking at
    //     max effort, otherwise a client's LOW hint leaves it shallow.
    //   - anything else the dashboard picks keeps the ordinary passthrough.
    // PDF jobs use the separate Gemini chain, where these fields are unverified.
    if (hasPdfs || QWEN_NO_EFFORT.test(model)) {
      // no effort knob to send
    } else if (QWEN_38_FLASH.test(model)) {
      // Who asked decides the depth. A client that explicitly requested the
      // standard tier is the any-site path — it MEANT cheap, and honouring its
      // hint is the whole point of sending one. Everything else is МЭШ
      // homework or a test, and gets the deepest setting regardless of the
      // generic 'low' an already-installed build sends.
      upstreamBody.reasoning_effort =
        body.tier === 'standard' && REASONING_EFFORTS.has(body.reasoning_effort)
          ? QWEN_38_EFFORT[body.reasoning_effort]
          : QWEN_38_FRONTIER_EFFORT;
    } else if (GLM_53_FLASH.test(model)) {
      // GLM has to be told to think at all. The EFFORT, though, depends on who
      // asked: an already-installed Auto client sends 'low' as a generic cost
      // hint and would be left shallow on real schoolwork, so it is overridden
      // to max. A client that explicitly asked for the standard tier is the
      // any-site path — it MEANT cheap, and honouring its effort is the whole
      // point of the hint.
      upstreamBody.thinking = { type: 'enabled' };
      upstreamBody.reasoning_effort = body.tier === 'standard' && REASONING_EFFORTS.has(body.reasoning_effort)
        ? body.reasoning_effort
        : 'max';
    } else if (provider.reasoningEffort && REASONING_EFFORTS.has(body.reasoning_effort)) {
      upstreamBody.reasoning_effort = body.reasoning_effort;
    }
    // The degradation retry: same model, same messages, no effort field. The
    // model's own default depth applies instead — a worse answer than the one
    // the policy asked for, but an answer.
    if (dropEffort) delete upstreamBody.reasoning_effort;
    const sentEffort = upstreamBody.reasoning_effort !== undefined;
    // Serialize ONCE per model attempt, not once per retry — retries resend
    // the identical bytes, no need to re-stringify a possibly multi-MB body.
    const upstreamPayload = JSON.stringify(upstreamBody);

    let connectErr = null;
    for (let attempt = 0; attempt <= UPSTREAM_CONNECT_RETRIES && !upstream; attempt++) {
      if (signal?.aborted) {
        return { err: { status: 499, message: UNAVAILABLE, refundable: !providerMayHaveRun } };
      }
      if (attempt > 0) await sleep(UPSTREAM_CONNECT_RETRY_DELAY_MS * attempt);
      if (signal?.aborted) {
        return { err: { status: 499, message: UNAVAILABLE, refundable: !providerMayHaveRun } };
      }

      try {
        upstream = await fetch(upstreamUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${UPSTREAM_KEY}` },
          body: upstreamPayload,
          redirect: 'error',
          signal
        });
        providerMayHaveRun = true;
        connectErr = null;
      } catch (e) {
        // A cancelled job aborts the connect too — expected, not an upstream
        // problem. The body was already handed to the socket, so the provider
        // may be working on it: the reservation stands.
        connectErr = e;
        const retryable = isPreDispatchFailure(e);
        if (!retryable) providerMayHaveRun = true;
        if (signal && signal.aborted) {
          return { err: { status: 499, message: UNAVAILABLE, refundable: !providerMayHaveRun } };
        }
        console.error('upstream fetch failed', usedModel, 'attempt', attempt + 1,
          'pre_dispatch=' + retryable, safeErrorCode(e));
        if (!retryable) break;
      }
    }
    if (connectErr) {
      // Only the codes that prove no connection was ever established (see
      // PRE_DISPATCH_RETRY_CODES) are safe to refund. ECONNRESET and friends
      // are deliberately absent: they can fire after the body was delivered.
      return {
        err: {
          status: 502,
          message: `${provider.name}: не удалось связаться с ИИ-сервисом. Попробуйте ещё раз через минуту.`,
          refundable: isPreDispatchFailure(connectErr)
        }
      };
    }

    if (upstream.ok) break;
    const status = upstream.status;
    const text = await readResponseTextBounded(upstream, 64 * 1024);
    lastFailure = { status, text, model };
    upstream = null;
    if (isUnpurchased(text)) { console.warn('model not enabled, trying fallback', model); continue; }
    // A rejected parameter is not a rejected model. Retry THIS model once
    // without the effort field before spending the chain's next fallback on
    // what may be a body problem. A 400 is a non-billable refusal, so the
    // extra dispatch costs nothing but latency.
    if (sentEffort && !dropEffort && isParameterRejection(status, text)) {
      console.warn('upstream rejected reasoning_effort, retrying without it', model);
      attempts.splice(i + 1, 0, { model, dropEffort: true });
      continue;
    }
    break;
  }

  if (!upstream) {
    const status = lastFailure ? lastFailure.status : 502;
    const text = lastFailure ? lastFailure.text : '';
    // No dispatch at all (an empty model chain) is free; otherwise only the
    // provider's own explicit refusals are.
    const refundable = !providerMayHaveRun || isNonBillableRejection(status, text);
    if (status === 401 || status === 403 || status === 402 || isUnpurchased(text)) {
      console.error('UPSTREAM KEY/BILLING/MODEL PROBLEM', status, usedModel);
      return { err: { status: 503, message: UNAVAILABLE, refundable } };
    }
    if (status === 429) return { err: { status: 429, message: `${provider.name}: сервис перегружен. Подождите минуту и попробуйте снова.`, refundable } };
    console.error('upstream error', status, usedModel, 'refundable=' + refundable);
    return { err: { status: 502, message: `${provider.name}: не удалось получить ответ. Попробуйте ещё раз.`, refundable } };
  }

  return { upstream };
}

/* --------------------------- poll-job store --------------------------- */

const jobs = new Map(); // job_id → { text, done, error, ctrl, lastAccess, accounting }

// Poll admission is synchronous and reserved before a timer is installed, so
// concurrent requests cannot pass the checks against the same stale counts.
let inFlightPolls = 0;
const pollsByJob = new Map();
const pollsByToken = new Map();
const pollsByIp = new Map();

// Admission is intentionally plain synchronous state: Node cannot interleave
// another request between the checks and increments below. Callers reach this
// only after local entitlement verification and perform no await before job registration.
let activeJobSlots = 0;
const activeJobsByLicense = new Map();
const activeJobsByDevice = new Map();
const activeJobsByIp = new Map();
const startsByLicense = new Map();
const startsByDevice = new Map();
const startsByIp = new Map();

function mapCount(map, key) {
  return key ? (map.get(key) || 0) : 0;
}

function addMapCount(map, key) {
  if (key) map.set(key, mapCount(map, key) + 1);
}

function removeMapCount(map, key) {
  if (!key) return;
  const next = mapCount(map, key) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

function requestIp(req) {
  // Caddy is the only process that can reach this loopback listener and sets
  // X-Forwarded-For, so the first hop is the student rather than 127.0.0.1.
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '');
  const candidate = value.split(',')[0].trim();
  if (net.isIP(candidate)) {
    const mapped = candidate.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    return mapped && net.isIP(mapped[1]) === 4 ? mapped[1] : candidate.toLowerCase();
  }
  const peer = String(req.socket.remoteAddress || '').trim();
  return net.isIP(peer) ? peer.toLowerCase() : 'unknown';
}

function reserveJobAccounting(req, prep) {
  const { licenseKey, deviceId } = prep;
  const ip = requestIp(req);
  if (activeJobSlots >= MAX_ACTIVE_JOBS) {
    console.error('MAX_ACTIVE_JOBS reached', MAX_ACTIVE_JOBS);
    return { err: { status: 503, message: OVERLOADED } };
  }
  if ((licenseKey && mapCount(activeJobsByLicense, licenseKey) >= MAX_JOBS_PER_LICENSE) ||
      (deviceId && mapCount(activeJobsByDevice, deviceId) >= MAX_JOBS_PER_DEVICE) ||
      mapCount(activeJobsByIp, ip) >= MAX_JOBS_PER_IP) {
    return { err: { status: 429, message: 'Слишком много одновременных ответов. Дождитесь завершения текущих запросов.' } };
  }

  activeJobSlots += 1;
  addMapCount(activeJobsByLicense, licenseKey);
  addMapCount(activeJobsByDevice, deviceId);
  addMapCount(activeJobsByIp, ip);
  return { licenseKey, deviceId, ip, released: false };
}

function recentStarts(map, key, now, windowMs = JOB_START_RATE_WINDOW_MS) {
  const cutoff = now - windowMs;
  const recent = (map.get(key) || []).filter((timestamp) => timestamp > cutoff);
  if (recent.length) map.set(key, recent);
  else map.delete(key);
  return recent;
}

function makeJobStoreRoom() {
  while (jobs.size >= MAX_RETAINED_JOBS) {
    let oldestId = null;
    let oldestAccess = Infinity;
    for (const [id, job] of jobs) {
      if (job.done && job.lastAccess < oldestAccess) {
        oldestId = id;
        oldestAccess = job.lastAccess;
      }
    }
    if (!oldestId) return false; // all retained jobs are still active
    jobs.delete(oldestId);
  }
  return true;
}

function admitJobStart(reservation, prep) {
  // Keep the identity binding explicit even though both values now come from
  // the same verified preparation object.
  if (reservation.licenseKey !== prep.licenseKey || reservation.deviceId !== prep.deviceId) {
    return { err: { status: 400, message: 'Некорректный запрос.' } };
  }

  const now = Date.now();
  const requestLimit = modelState.config.limits.requests_per_minute;
  const licenseStarts = recentStarts(startsByLicense, prep.licenseKey, now);
  const deviceStarts = recentStarts(startsByDevice, prep.deviceId, now);
  const ipStarts = recentStarts(
    startsByIp, reservation.ip, now, JOB_START_IP_RATE_WINDOW_MS
  );
  if (licenseStarts.length >= requestLimit || deviceStarts.length >= requestLimit) {
    return {
      err: {
        status: 429,
        message: `Лимит запросов в минуту на лицензию: ${requestLimit}. Подождите минуту и попробуйте снова.`
      }
    };
  }
  if (ipStarts.length >= JOB_START_IP_RATE_LIMIT) {
    return { err: { status: 429, message: 'Слишком много запросов с этого адреса. Подождите несколько минут и попробуйте снова.' } };
  }
  if (!makeJobStoreRoom()) return { err: { status: 503, message: OVERLOADED } };

  // Quota and sliding-window admission are committed together with no await,
  // so a rejected burst neither slips through nor consumes extra daily quota.
  const q = chargeQuota(
    prep.licenseKey, prep.providerId, prep.provider,
    prep.body?.tier === 'standard', prep.hasImages, prep.hasPdfs
  );
  if (!q.ok) return { err: { status: q.status || 503, message: q.message } };
  const route = routeForRequest(
    prep.providerId, q.tier, prep.hasImages, prep.hasPdfs, q.routingState
  );
  licenseStarts.push(now);
  deviceStarts.push(now);
  ipStarts.push(now);
  startsByLicense.set(prep.licenseKey, licenseStarts);
  startsByDevice.set(prep.deviceId, deviceStarts);
  startsByIp.set(reservation.ip, ipStarts);
  return {
    ok: true,
    quotaDay: q.day,
    quotaBucket: q.bucket,
    tier: q.tier,
    configRevision: q.revision,
    route,
    rates: q.routingState.config.rates,
    telemetryEnabled: q.routingState.config.features.telemetry === true
  };
}

// Release an admission's daily reservation. Safe to call more than once: the
// first call clears the marker, so a later abandon/settle path cannot
// double-refund a single charge.
function releaseAdmissionQuota(holder) {
  if (!holder?.quotaDay) return false;
  const day = holder.quotaDay;
  holder.quotaDay = null;
  return refundQuota(day, holder.licenseKey, holder.quotaBucket);
}

function releaseJobAccounting(reservation) {
  if (!reservation || reservation.released) return;
  reservation.released = true;
  activeJobSlots = Math.max(0, activeJobSlots - 1);
  removeMapCount(activeJobsByLicense, reservation.licenseKey);
  removeMapCount(activeJobsByDevice, reservation.deviceId);
  removeMapCount(activeJobsByIp, reservation.ip);
}

function tripJobLimit(job, message) {
  if (job.limitError) return;
  job.limitError = message;
  job.error = message;
  job.done = true;
  try { job.ctrl.abort(); } catch { }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!job.done && now - job.lastAccess > JOB_ABANDON_MS) {
      console.warn('job abandoned (client stopped polling), aborting upstream', id);
      job.cancelled = true;
      try { job.ctrl.abort(); } catch { }
      jobs.delete(id);
    } else if (job.done && now - job.lastAccess > JOB_LINGER_MS) {
      jobs.delete(id);
    }
  }
  // Sweep stale blobs: a completed upload whose /ai/start never came, or an
  // upload the client gave up on mid-way. prepareChat frees a blob the instant
  // /ai/start inlines it, so anything left here is genuinely orphaned.
  for (const [id, blob] of blobs) {
    if (now - blob.lastAccess > BLOB_TTL_MS || now - blob.createdAt > UPLOAD_ABSOLUTE_TTL_MS) freeBlob(id);
  }
  for (const [token, ticket] of uploadTickets) {
    if (ticket.expiresAt <= now ||
        (!blobs.get(ticket.blobId)?.done && ticket.progressDeadline <= now)) {
      // A ticket may expire before its first chunk creates a blob.
      if (blobs.has(ticket.blobId)) freeBlob(ticket.blobId);
      else deleteUploadTicket(token);
    }
  }
  // Licence/device bursts keep one configured minute; the shared-IP abuse
  // guard keeps ten. Pruning bounds attacker-controlled keyspace at rest.
  for (const [key] of startsByLicense) recentStarts(startsByLicense, key, now);
  for (const [key] of startsByDevice) recentStarts(startsByDevice, key, now);
  for (const [key] of startsByIp) {
    recentStarts(startsByIp, key, now, JOB_START_IP_RATE_WINDOW_MS);
  }
  for (const [key] of uploadTicketStartsByLicense) {
    recentStarts(uploadTicketStartsByLicense, key, now, UPLOAD_TICKET_RATE_WINDOW_MS);
  }
  for (const [key] of uploadTicketStartsByIp) {
    recentStarts(uploadTicketStartsByIp, key, now, UPLOAD_TICKET_RATE_WINDOW_MS);
  }
}, JOB_GC_INTERVAL_MS).unref();

/* -------------------------- usage reporting --------------------------- */
// Fire-and-forget after every poll job settles: reporting must never delay,
// fail or resurrect a job. Content-free by design — device id, provider,
// model, token counts, estimated cost; never messages or license keys.

// List-rate estimates (USD per token) keyed by model prefix. 302.AI's
// OpenAI-compatible usage frame carries token counts but no cost, so this is
// a dashboard estimate at published rates — not a billing-grade figure (the
// event is tagged est_rates so the dashboard can say so).
const USAGE_RATES = [
  [/^glm-5\.3-flash$/i, { in: 0.075 / 1e6, out: 0.25 / 1e6 }],
  // qwen3.8-flash before the general Qwen pattern: it is the live model for
  // everything but PDFs and is roughly half the price of the 3.7 line, so the
  // broader pattern must not claim it and bill it at 3.7 rates.
  [/^qwen3\.8-flash/i, { in: 0.15 / 1e6, out: 0.47 / 1e6 }],
  [/^qwen/i,        { in: 0.32 / 1e6, out: 1.28 / 1e6 }],
  [/^deepseek/i,    { in: 0.20 / 1e6, out: 0.40 / 1e6 }],
  // -lite first: it is the PDF chain's lead model and an order of magnitude
  // cheaper on output than full 2.5 Flash, so the broader pattern must not
  // claim it.
  [/^gemini-2\.5-flash-lite/i, { in: 0.10 / 1e6, out: 0.40 / 1e6 }],
  [/^gemini-2\.5/i, { in: 0.30 / 1e6, out: 2.50 / 1e6 }],
  [/^gemini/i,      { in: 0.10 / 1e6, out: 0.40 / 1e6 }]
];

function estimateCost(model, tokensIn, tokensOut, configuredRates = null) {
  const exact = configuredRates && Object.hasOwn(configuredRates, String(model || ''))
    ? configuredRates[String(model || '')]
    : null;
  if (exact) {
    return tokensIn * exact.input_usd_per_m / 1e6 +
      tokensOut * exact.output_usd_per_m / 1e6;
  }
  for (const [re, rate] of USAGE_RATES) {
    if (re.test(String(model || ''))) return tokensIn * rate.in + tokensOut * rate.out;
  }
  return 0;
}

// Pull the model id + final usage frame out of the buffered SSE text — the
// same top-level `model` / `usage` fields the extension's SSE sink reads
// (connectUpstream always asks for stream_options.include_usage).
function extractSseUsage(text) {
  let usage = null, model = null, streamError = false;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    // A 200 OK can still carry a provider error MID-STREAM (rate limit hit
    // while generating, moderation block, upstream model drop). The client's
    // SSE parser throws on exactly this frame (src/lib/http.js), so accounting
    // that only looked for a job-level exception recorded the same stream as a
    // success: a provider error plus [DONE] reported ok:true while the student
    // saw an error. Read the same terminal signal the client reads.
    if (json && json.error) streamError = true;
    if (!model && json && typeof json.model === 'string') model = json.model.slice(0, 128);
    if (json && json.usage && typeof json.usage === 'object') usage = json.usage;
  }
  return { usage, model, streamError };
}

function boundedTokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0
    ? Math.min(1_000_000_000, Math.round(count))
    : 0;
}

// Detects the first NON-EMPTY assistant content delta inside an SSE piece. A
// role-only delta (`"delta":{"role":"assistant"}`), an empty `"content":""`,
// keepalive comments and reasoning-only deltas do NOT match — so tFirstToken
// marks the first VISIBLE token, not merely the first upstream byte.
const SSE_CONTENT_RE = /"content"\s*:\s*"(?:\\.|[^"\\])/;

function hasDoneSseFrame(text) {
  // Match an SSE field line, not an arbitrary substring inside an assistant's
  // JSON content (which may legitimately discuss the literal `data: [DONE]`).
  return /^data:[ \t]*\[DONE\][ \t]*\r?$/m.test(String(text || '').slice(-2048));
}

// Per-phase timings for one settled job, in ms (0/absent when a phase never
// happened — e.g. an upstream that errored before the first token). This is the
// ground-truth "where does the solve time go" signal: connect (open the 302.AI
// stream), resp (job start → first upstream byte), ttft (job start → first
// VISIBLE token — the biggest lever; thinking + PDF ingest live in the resp→
// ttft gap), stream (first→last token), plus tokens/sec throughput.
function jobTimings(job) {
  const t = {};
  if (job.tConnected) t.connect_ms = job.tConnected - job.tStart;
  if (job.tFirstByte) t.resp_ms = job.tFirstByte - job.tStart;
  if (job.tFirstToken) t.ttft_ms = job.tFirstToken - job.tStart;
  if (job.tFirstToken && job.tDone) t.stream_ms = job.tDone - job.tFirstToken;
  if (job.tDone) t.total_ms = job.tDone - job.tStart;
  return t;
}

function reportJobUsage(job) {
  if (!INGEST_KEY || job.telemetryOptIn !== true) return;
  try {
    const { usage, model, streamError } = extractSseUsage(job.text);
    const tokensIn = boundedTokenCount(usage && usage.prompt_tokens);
    const tokensOut = boundedTokenCount(usage && usage.completion_tokens);
    const timings = jobTimings(job);
    // tokens/sec over the streaming window only (excludes connect+ttft), so it
    // reflects generation throughput rather than being dragged down by a long
    // think. One decimal is plenty for a dashboard estimate.
    if (timings.stream_ms > 0 && tokensOut > 0) {
      timings.tok_per_s = Math.round((tokensOut / (timings.stream_ms / 1000)) * 10) / 10;
    }
    const event = {
      device_id: job.accounting ? job.accounting.deviceId : '',
      ts: Date.now(),
      provider: job.providerId || null,
      model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: estimateCost(model, tokensIn, tokensOut, job.modelRates),
      meta: {
        src: 'vps',
        ok: !job.error && job.cancelled !== true && !streamError,
        est_rates: true,
        model_tier: job.modelTier || null,
        model_config_revision: job.modelConfigRevision || 0,
        ...timings
      }
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Key': INGEST_KEY },
      body: JSON.stringify({ events: [event] }),
      redirect: 'error',
      signal: ctrl.signal
    }).then(async (response) => {
      if (!response.ok) console.error('usage report failed', 'http', response.status);
      // The ingest acknowledgement body is not part of this contract. Cancel
      // it immediately so a buggy/hostile dependency cannot retain one socket
      // per opt-in job forever after sending only response headers.
      try { await response.body?.cancel(); } catch { /* already closed */ }
    }).catch((e) => console.error('usage report failed', safeErrorCode(e)))
      .finally(() => clearTimeout(timer));
  } catch (e) {
    console.error('usage report failed', safeErrorCode(e));
  }
}

// Background pump: open the upstream stream and accumulate its SSE bytes as
// a string (StringDecoder so a chunk boundary can't split a multi-byte char).
async function runJob(job, provider, body, messages, hasImages, hasPdfs) {
  const dec = new StringDecoder('utf8');
  let connectTimer = null;
  let idleTimer = null;
  let totalTimer = null;
  let streamEnded = false;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => tripJobLimit(
      job,
      'UPSTREAM_IDLE_TIMEOUT: ИИ-сервис не присылал данные 60 секунд; ответ остановлен.'
    ), UPSTREAM_IDLE_TIMEOUT_MS);
  };

  try {
    totalTimer = setTimeout(() => tripJobLimit(
      job,
      'JOB_DURATION_LIMIT: ответ остановлен после максимальных 5 минут.'
    ), MAX_JOB_DURATION_MS);
    const connectTimeoutMs = hasPdfs ? UPSTREAM_CONNECT_TIMEOUT_PDF_MS : UPSTREAM_CONNECT_TIMEOUT_MS;
    connectTimer = setTimeout(() => tripJobLimit(
      job,
      `UPSTREAM_CONNECT_TIMEOUT: ИИ-сервис не начал отвечать за ${connectTimeoutMs / 1000} секунд.`
    ), connectTimeoutMs);

    const conn = await connectUpstream(provider, body, messages, hasImages, hasPdfs, job.ctrl.signal);
    clearTimeout(connectTimer);
    connectTimer = null;
    if (!conn.upstream) {
      if (!job.limitError) job.error = conn.err.message;
      // A stream that never opened is NOT proof of zero spend — the request
      // body may have been delivered before the connection died or the client
      // cancelled. Only refund what connectUpstream could positively classify
      // as unbilled; ambiguous outcomes keep consuming the student's day.
      if (conn.err.refundable) releaseAdmissionQuota(job);
      else console.warn('quota retained: upstream outcome ambiguous', conn.err.status);
      return;
    }
    job.tConnected = Date.now();

    resetIdleTimer();
    for await (const chunk of Readable.fromWeb(conn.upstream.body)) {
      if (!job.tFirstByte) job.tFirstByte = Date.now();
      const chunkBytes = Buffer.byteLength(chunk);
      if (job.outputBytes + chunkBytes > MAX_JOB_OUTPUT_BYTES) {
        tripJobLimit(job, 'JOB_OUTPUT_LIMIT: ответ превысил лимит 2 МБ и был остановлен.');
        return;
      }
      job.outputBytes += chunkBytes;
      const piece = dec.write(chunk);
      job.text += piece;
      // Real time-to-first-token: the first NON-EMPTY assistant content delta,
      // not the first raw byte (often an instant keepalive / role-only delta /
      // hidden reasoning). Scan a small carry + this piece so a `"content":"`
      // token split across a chunk boundary is still caught on the spot rather
      // than one delta late.
      if (!job.tFirstToken) {
        const scan = job.ttftScanTail + piece;
        if (SSE_CONTENT_RE.test(scan)) job.tFirstToken = Date.now();
        else job.ttftScanTail = scan.slice(-24); // > len('"content":"') so any split of it bridges
      }
      resetIdleTimer();
    }
    job.text += dec.end();
    streamEnded = true;
    // A graceful EOF is not success. OpenAI-style upstreams terminate every
    // COMPLETED stream with `data: [DONE]`; a body that simply ends (proxy
    // idle cut, upstream dying with a clean FIN) is a truncated answer and
    // must never be presented or saved as a complete one. The frame sits at
    // the very end of the buffer, so scanning a short tail is sufficient.
    if (!job.ctrl.signal.aborted && !job.limitError && !hasDoneSseFrame(job.text)) {
      job.error = job.text.trim()
        ? `${provider.name}: соединение с ИИ-сервисом прервалось, ответ получен не полностью. Попробуйте ещё раз.`
        : `${provider.name}: не удалось получить ответ. Попробуйте ещё раз.`;
    }
  } catch (e) {
    // Either the client cancelled (abort — expected) or 302.AI dropped the
    // stream. A transport break is always an error: partial bytes remain
    // available to the poller, but must never be presented or saved as a
    // complete answer.
    if (!job.ctrl.signal.aborted && !job.limitError) {
      console.error('job stream broke', safeErrorCode(e));
      job.error = job.text
        ? `${provider.name}: соединение с ИИ-сервисом прервалось, ответ получен не полностью. Попробуйте ещё раз.`
        : `${provider.name}: не удалось получить ответ. Попробуйте ещё раз.`;
    }
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (!streamEnded) dec.end();
    job.tDone = Date.now();
    job.done = true;
    releaseJobAccounting(job.accounting);
    reportJobUsage(job); // fire-and-forget; runs exactly once per job
  }
}

/* ---------------------- /ai/start /ai/poll /ai/cancel ----------------- */

/**
 * Idempotent /ai/start.
 *
 * The job is launched from the response's `finish` event — the kernel accepting
 * the bytes, NOT the client receiving them. A response lost in transit
 * therefore leaves a real upstream job running that no client can ever reach,
 * and the client's retry starts a SECOND paid job: one probe read zero response
 * bytes, destroyed the socket, retried, and produced two upstream calls and
 * quota usage of two.
 *
 * A client-generated key bound to the principal (license + device) AND the
 * request digest makes the retry return the ORIGINAL job instead. The binding
 * matters: without it a leaked key would let another caller adopt someone
 * else's job, and reusing a key for different content would silently answer
 * with the wrong job.
 */
const startIdempotency = new Map(); // key -> { principal, digest, blobId, blobDigest, jobId, token, createdAt }
const MAX_START_IDEMPOTENCY_ENTRIES = 5000;
const START_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

function readIdempotencyKey(body) {
  const raw = typeof body?.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
  return /^[A-Za-z0-9_-]{8,128}$/.test(raw) ? raw : '';
}

function pruneStartIdempotency(now) {
  for (const [key, entry] of startIdempotency) {
    if (now - entry.createdAt > START_IDEMPOTENCY_TTL_MS) startIdempotency.delete(key);
  }
  // Bounded even if every entry is fresh: oldest-first, since Map preserves
  // insertion order.
  while (startIdempotency.size >= MAX_START_IDEMPOTENCY_ENTRIES) {
    const oldest = startIdempotency.keys().next();
    if (oldest.done) break;
    startIdempotency.delete(oldest.value);
  }
}

function rememberIdempotentStart(key, principal, digest, blobId, blobDigest, jobId, token) {
  if (!key) return;
  const now = Date.now();
  pruneStartIdempotency(now);
  startIdempotency.set(key, { principal, digest, blobId, blobDigest, jobId, token, createdAt: now });
}

function forgetIdempotentStart(key, jobId) {
  if (!key) return;
  // An old job can outlive this map's TTL while a continuously polling client
  // keeps it in `jobs`. If the same key is later reused, cancelling that old
  // job must not delete the newer job's idempotency record.
  if (startIdempotency.get(key)?.jobId === jobId) startIdempotency.delete(key);
}

async function handleAiStart(req, res, rawBody) {
  const prep = await prepareChat(req, res, rawBody, { checkStartReplay: true });
  if (prep.aborted || responseGone(res)) return;
  if (prep.err) return sendErr(res, prep.err.status, prep.err.message, prep.err.headers);
  if (prep.replay) {
    return sendJson(res, 200, {
      ok: true, job_id: prep.replay.jobId, job_token: prep.replay.token
    });
  }

  // prepareChat performs the replay lookup only after local entitlement
  // verification, so an unauthenticated caller cannot probe which keys exist.
  const idempotencyKey = prep.idempotencyKey;
  const principal = prep.principal;
  const digest = prep.requestDigest;

  const accounting = reserveJobAccounting(req, prep);
  if (accounting.err) return sendErr(res, accounting.err.status, accounting.err.message);
  let handedToRunner = false;
  try {
    const admission = admitJobStart(accounting, prep);
    if (admission.err) return sendErr(res, admission.err.status, admission.err.message);

    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    const job = {
      text: '', outputBytes: 0, done: false, error: null, limitError: null,
      ctrl: new AbortController(), lastAccess: Date.now(), accounting, token, cancelled: false,
      providerId: prep.providerId, // for the post-job usage report + quota release
      licenseKey: prep.licenseKey,
      quotaBucket: admission.quotaBucket,
      modelTier: admission.tier,
      modelConfigRevision: admission.configRevision,
      modelRates: admission.rates,
      // Carried so a user cancel can forget the /ai/start idempotency entry
      // together with the job it names; a cancelled job must not be
      // resurrectable by a later identical retry.
      idempotencyKey,
      quotaDay: admission.quotaDay,
      // Both parties must allow telemetry: the user opted in AND the operator
      // has not thrown the central kill switch. This snapshot is from the same
      // immutable config revision that admitted and routed the job.
      telemetryOptIn: prep.telemetryOptIn && admission.telemetryEnabled,
      // Per-phase timing marks for the usage report (see reportJobUsage). This
      // box is the only place that measures where the model time actually goes,
      // so it can answer "where does the average solve sit" without guesswork.
      // tFirstByte = upstream started responding (may be a keepalive / reasoning
      // delta); tFirstToken = first VISIBLE content token — the two differ by
      // the model's think/ingest time, which is the whole point of measuring.
      tStart: Date.now(), tConnected: 0, tFirstByte: 0, tFirstToken: 0, tDone: 0,
      ttftScanTail: '' // small carry so a content token split across a chunk boundary still trips tFirstToken
    };
    jobs.set(id, job);
    handedToRunner = true;
    // Recorded BEFORE the response is written, so a retry that races the
    // original's flush still resolves to this job rather than starting a
    // second one.
    rememberIdempotentStart(
      idempotencyKey, principal, digest, prep.blobId, prep.blobDigest, id, token
    );

    let runnerStarted = false;
    const abandonUnlaunched = () => {
      if (runnerStarted) return;
      runnerStarted = true;
      jobs.delete(id);
      forgetIdempotentStart(idempotencyKey, id);
      releaseJobAccounting(job.accounting);
      // No client can ever learn this job id/token, so nothing was bought.
      // Hand the daily reservation back rather than charging a lost response.
      releaseAdmissionQuota(job);
    };
    const launch = () => {
      if (runnerStarted) return;
      runnerStarted = true;
      runJob(job, admission.route, prep.body, prep.messages, prep.hasImages, prep.hasPdfs).catch((e) => {
        console.error('job runner crashed', safeErrorCode(e));
        job.error = job.error || UNAVAILABLE;
        job.done = true;
        releaseJobAccounting(job.accounting);
      });
    };
    // Do not create a paid upstream effect until Node has flushed the
    // capability response. If the socket closes first, no client can know the
    // job id/token, so release the reservation and discard the unreachable job.
    res.once('finish', launch);
    res.once('close', () => {
      if (!res.writableFinished) abandonUnlaunched();
    });
    try {
      sendJson(res, 200, { ok: true, job_id: id, job_token: token });
    } catch (error) {
      abandonUnlaunched();
      throw error;
    }
  } finally {
    // Once registered, runJob owns the reservation; every pre-registration
    // validation/admission error path releases it here.
    if (!handedToRunner) releaseJobAccounting(accounting);
  }
}

function hasJobToken(req, job) {
  return safeEqualSecret(job?.token, readHeader(req, 'x-job-token'));
}

function reservePollAccounting(req, jobId, job) {
  const token = job.token;
  const ip = requestIp(req);
  const limited = { status: 429, message: OVERLOADED, headers: { 'Retry-After': '1' } };

  if (mapCount(pollsByJob, jobId) >= MAX_POLLS_PER_JOB) return { err: limited };
  if (mapCount(pollsByToken, token) >= MAX_POLLS_PER_TOKEN) return { err: limited };
  if (mapCount(pollsByIp, ip) >= MAX_POLLS_PER_IP) return { err: limited };
  if (inFlightPolls >= MAX_IN_FLIGHT_POLLS) {
    return { err: { status: 503, message: OVERLOADED, headers: { 'Retry-After': '1' } } };
  }

  inFlightPolls += 1;
  addMapCount(pollsByJob, jobId);
  addMapCount(pollsByToken, token);
  addMapCount(pollsByIp, ip);
  return { jobId, token, ip, released: false };
}

function releasePollAccounting(accounting) {
  if (!accounting || accounting.released) return;
  accounting.released = true;
  inFlightPolls = Math.max(0, inFlightPolls - 1);
  removeMapCount(pollsByJob, accounting.jobId);
  removeMapCount(pollsByToken, accounting.token);
  removeMapCount(pollsByIp, accounting.ip);
}

function jsonStringBytes(value) {
  return Math.max(0, Buffer.byteLength(JSON.stringify(value)) - 2);
}

function boundedPollChunk(text, start) {
  if (start >= text.length) return '';
  // No single UTF-16 code unit needs more than six JSON bytes (`\uXXXX`), so
  // an 8 KiB character ceiling always contains at least one admissible unit.
  let low = start + 1;
  let high = Math.min(text.length, start + MAX_POLL_CHUNK_JSON_BYTES);
  let best = start;
  while (low <= high) {
    const end = low + Math.floor((high - low) / 2);
    if (jsonStringBytes(text.slice(start, end)) <= MAX_POLL_CHUNK_JSON_BYTES) {
      best = end;
      low = end + 1;
    } else {
      high = end - 1;
    }
  }
  return text.slice(start, best > start ? best : start + 1);
}

function handleAiPoll(req, res, url) {
  const id = url.searchParams.get('job') || '';
  const job = jobs.get(id);
  if (!job) return sendErr(res, 404, JOB_NOT_FOUND);
  if (!hasJobToken(req, job)) return sendErr(res, 404, JOB_NOT_FOUND);
  const accounting = reservePollAccounting(req, id, job);
  if (accounting.err) {
    return sendErr(res, accounting.err.status, accounting.err.message, accounting.err.headers);
  }
  const requestedCursor = Number(url.searchParams.get('cursor'));
  const cursor = Number.isSafeInteger(requestedCursor) && requestedCursor >= 0
    ? Math.min(requestedCursor, job.text.length)
    : 0;
  job.lastAccess = Date.now();

  // Long-poll: return the moment there's new text (or the job finished),
  // otherwise hold the connection ~4s and return a heartbeat. Holding here
  // means the client's fetch stays pending with no client-side timer gap.
  const deadline = Date.now() + POLL_HOLD_MS;
  let closed = false;
  let cleaned = false;
  let timer = null;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (timer) clearTimeout(timer);
    timer = null;
    releasePollAccounting(accounting);
    res.removeListener('finish', onFinished);
    res.removeListener('close', onTransportGone);
    res.removeListener('error', onTransportGone);
    req.removeListener('aborted', onTransportGone);
    req.removeListener('error', onTransportGone);
  }

  function onFinished() {
    closed = true;
    cleanup();
  }

  function onTransportGone() {
    closed = true;
    cleanup();
    if (!res.destroyed) res.destroy();
  }

  res.once('finish', onFinished);
  res.once('close', onTransportGone);
  res.once('error', onTransportGone);
  req.once('aborted', onTransportGone);
  req.once('error', onTransportGone);

  const reply = () => {
    if (closed || responseGone(res)) return onTransportGone();
    job.lastAccess = Date.now();
    const chunk = boundedPollChunk(job.text, cursor);
    const nextCursor = cursor + chunk.length;
    const drained = nextCursor >= job.text.length;
    try {
      sendJson(res, 200, {
        ok: true,
        chunk,
        cursor: nextCursor,
        // A successful completed job is terminal only after every bounded
        // backlog piece has been delivered. Error jobs can terminate
        // immediately because the client surfaces the error after this chunk.
        done: job.done && (drained || !!job.error),
        error: job.error
      });
    } catch {
      console.error('poll response write failed');
      onTransportGone();
    }
  };

  const tick = () => {
    if (closed || responseGone(res)) return onTransportGone();
    if (job.text.length > cursor || job.done || Date.now() >= deadline) return reply();
    timer = setTimeout(tick, POLL_CHECK_MS);
  };
  tick();
}

function handleAiCancel(req, res, rawBody) {
  let id = '';
  try { id = String(JSON.parse(rawBody).job || ''); } catch { /* idempotent */ }
  const job = jobs.get(id);
  if (job && !hasJobToken(req, job)) return sendErr(res, 404, JOB_NOT_FOUND);
  if (job) {
    if (!job.done) job.cancelled = true;
    try { job.ctrl.abort(); } catch { }
    forgetIdempotentStart(job.idempotencyKey, id);
    jobs.delete(id);
  }
  sendJson(res, 200, { ok: true });
}

/* -------------------- /ai/chat (diagnostic streaming) ----------------- */
// Byte-for-byte SSE passthrough. NOT used by the extension anymore (RU DPI
// kills long-lived connections to this SNI) — kept for curl diagnostics.

async function handleAiChat(req, res, rawBody) {
  const prep = await prepareChat(req, res, rawBody);
  if (prep.aborted || responseGone(res)) return;
  if (prep.err) return sendErr(res, prep.err.status, prep.err.message, prep.err.headers);
  const accounting = reserveJobAccounting(req, prep);
  if (accounting.err) return sendErr(res, accounting.err.status, accounting.err.message);
  const ctrl = new AbortController();
  let connectTimer = null;
  let idleTimer = null;
  let totalTimer = null;
  let limitError = null;
  let outputBytes = 0;
  let quotaHolder = null;
  const tripLimit = (message) => {
    if (limitError) return;
    limitError = message;
    try { ctrl.abort(); } catch { }
  };
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => tripLimit(
      'UPSTREAM_IDLE_TIMEOUT: ИИ-сервис не присылал данные 60 секунд; ответ остановлен.'
    ), UPSTREAM_IDLE_TIMEOUT_MS);
  };
  const onClose = () => { try { ctrl.abort(); } catch { } };
  res.on('close', onClose);

  try {
    const admission = admitJobStart(accounting, prep);
    if (admission.err) return sendErr(res, admission.err.status, admission.err.message);
    quotaHolder = {
      licenseKey: prep.licenseKey,
      quotaBucket: admission.quotaBucket,
      quotaDay: admission.quotaDay
    };

    totalTimer = setTimeout(() => tripLimit(
      'JOB_DURATION_LIMIT: ответ остановлен после максимальных 5 минут.'
    ), MAX_JOB_DURATION_MS);
    const connectTimeoutMs = prep.hasPdfs ? UPSTREAM_CONNECT_TIMEOUT_PDF_MS : UPSTREAM_CONNECT_TIMEOUT_MS;
    connectTimer = setTimeout(() => tripLimit(
      `UPSTREAM_CONNECT_TIMEOUT: ИИ-сервис не начал отвечать за ${connectTimeoutMs / 1000} секунд.`
    ), connectTimeoutMs);
    const conn = await connectUpstream(
      admission.route, prep.body, prep.messages, prep.hasImages, prep.hasPdfs, ctrl.signal
    );
    clearTimeout(connectTimer);
    connectTimer = null;
    if (!conn.upstream) {
      // Same rule as the poll runner: refund only positively-unbilled outcomes.
      if (conn.err.refundable) releaseAdmissionQuota(quotaHolder);
      else console.warn('quota retained: upstream outcome ambiguous', conn.err.status);
      return sendErr(res, limitError ? 504 : conn.err.status, limitError || conn.err.message);
    }

    res.writeHead(200, {
      'Content-Type': conn.upstream.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Accel-Buffering': 'no',
      ...BASE_HEADERS
    });
    resetIdleTimer();
    for await (const chunk of Readable.fromWeb(conn.upstream.body)) {
      const chunkBytes = Buffer.byteLength(chunk);
      if (outputBytes + chunkBytes > MAX_JOB_OUTPUT_BYTES) {
        tripLimit('JOB_OUTPUT_LIMIT: ответ превысил лимит 2 МБ и был остановлен.');
        break;
      }
      outputBytes += chunkBytes;
      resetIdleTimer();
      res.write(chunk); // capped at 2 MB, so diagnostics cannot build an unbounded socket buffer
    }
  } catch (e) {
    if (!ctrl.signal.aborted) console.error('stream pipe failed', safeErrorCode(e));
    if (!res.headersSent) sendErr(res, 502, limitError || UNAVAILABLE);
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    res.removeListener('close', onClose);
    try { ctrl.abort(); } catch { }
    if (res.headersSent && !res.writableEnded) {
      try { res.end(); } catch { }
    }
    releaseJobAccounting(accounting);
  }
}

/* ---------------------------- /ai/streamtest -------------------------- */
// RU-DPI probe: a data: frame every `interval` ms for `seconds` s, no AI.
// This is how the SNI clamp was proven — keep it, it costs nothing and lets
// us re-measure RU behavior any time.

function handleStreamTest(req, res, url) {
  const interval = Math.min(Math.max(Number(url.searchParams.get('interval')) || 2000, 500), 10000);
  const seconds = Math.min(Math.max(Number(url.searchParams.get('seconds')) || 30, 2), 90);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Accel-Buffering': 'no',
    ...BASE_HEADERS
  });
  const t0 = Date.now();
  let n = 0;
  const timer = setInterval(() => {
    if (Date.now() - t0 >= seconds * 1000) {
      clearInterval(timer);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    n += 1;
    res.write(`data: {"n":${n},"elapsed_ms":${Date.now() - t0}}\n\n`);
  }, interval);
  res.on('close', () => clearInterval(timer));
}

/* ------------------------------- server ------------------------------- */

// Collect a bounded request body, then hand off. Shared by all POST routes.
// Accounting stays reserved through the async handler because parsing and
// entitlement verification still retains the decoded string/object after `end`.
let bodyRequestsInFlight = 0;
let bufferedBodyBytes = 0;
const bodyRequestsByIp = new Map();

function withBody(req, res, handler, maxBytes = MAX_BODY_BYTES) {
  const ip = requestIp(req);
  if (bodyRequestsInFlight >= MAX_BODY_REQUESTS) {
    sendErr(res, 503, OVERLOADED, { 'Connection': 'close' });
    req.resume();
    return;
  }
  if (mapCount(bodyRequestsByIp, ip) >= MAX_BODY_REQUESTS_PER_IP) {
    sendErr(res, 429, 'Слишком много одновременных запросов. Подождите и попробуйте снова.', { 'Connection': 'close' });
    req.resume();
    return;
  }

  bodyRequestsInFlight += 1;
  addMapCount(bodyRequestsByIp, ip);
  const chunks = [];
  let size = 0;
  let aborted = false;
  let inputEnded = false;
  let responded = false;
  let discardAfterReply = false;
  let released = false;
  const declaredLength = Number(req.headers['content-length']);
  const release = () => {
    if (released) return;
    released = true;
    bufferedBodyBytes = Math.max(0, bufferedBodyBytes - size);
    size = 0;
    bodyRequestsInFlight = Math.max(0, bodyRequestsInFlight - 1);
    removeMapCount(bodyRequestsByIp, ip);
  };
  const abandonBody = () => {
    if (aborted || inputEnded) return;
    aborted = true;
    chunks.length = 0;
    release();
  };
  const finishOverflow = () => {
    if (!discardAfterReply) return;
    discardAfterReply = false;
    try { req.destroy(); } catch { }
  };
  const rejectBody = (status, message) => {
    if (responded) return;
    responded = true;
    abandonBody();
    discardAfterReply = true;
    // The current request body is junk from our point of view. Force-close the
    // connection after the response so HTTP/1.1 keep-alive cannot accidentally reuse
    // a socket that still has unread overflow bytes queued behind it.
    sendErr(res, status, message, { 'Connection': 'close' });
    if (res.writableFinished) finishOverflow();
  };
  res.on('finish', finishOverflow);
  res.on('close', finishOverflow);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    rejectBody(413, TOO_BIG);
    req.resume(); // drain/discard the announced body so the client gets the 413 body cleanly
    return;
  }
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BUFFERED_BODY_BYTES - bufferedBodyBytes) {
    rejectBody(503, OVERLOADED);
    req.resume();
    return;
  }
  req.on('data', (c) => {
    if (aborted) return;
    if (size + c.length > maxBytes) {
      rejectBody(413, TOO_BIG);
      return;
    }
    if (bufferedBodyBytes + c.length > MAX_BUFFERED_BODY_BYTES) {
      rejectBody(503, OVERLOADED);
      return;
    }
    size += c.length;
    bufferedBodyBytes += c.length;
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    inputEnded = true;
    let rawBody;
    try { rawBody = Buffer.concat(chunks).toString('utf8'); }
    catch {
      release();
      if (!res.headersSent) sendErr(res, 400, 'Некорректный запрос.');
      return;
    }
    chunks.length = 0;
    Promise.resolve(handler(rawBody))
      .catch((e) => { console.error('handler unexpected', safeErrorCode(e)); if (!res.headersSent) sendErr(res, 503, UNAVAILABLE); })
      .finally(release);
  });
  // A prematurely closed request is terminal. Mark it before releasing the
  // counters so no late data/end event can retain bytes or dispatch a partial
  // body after the reservation has already become available to another call.
  req.on('aborted', abandonBody);
  req.on('error', () => {
    if (inputEnded) return;
    abandonBody();
    if (!res.headersSent && !res.destroyed) sendErr(res, 400, 'Некорректный запрос.');
  });
}

const server = http.createServer((req, res) => {
  // Routing needs only a pathname/query. A fixed base keeps an attacker-owned
  // Host header out of URL parsing and prevents malformed Host values from
  // throwing out of the request callback.
  let url;
  try { url = new URL(req.url || '/', 'http://localhost'); }
  catch { return sendErr(res, 400, 'Некорректный запрос.'); }
  const pathName = url.pathname;

  if (pathName === '/processors' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      revision: modelState.revision,
      updated_at: modelState.updated_at,
      gateway: { name: '302.AI', privacy_url: 'https://price.302.ai/en/privacy/' },
      processors: publicProcessors()
    }, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  }
  if (pathName === '/public/runtime-config' && req.method === 'GET') {
    const envelope = signedRuntimeConfig();
    return envelope
      ? sendJson(res, 200, envelope, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
      : sendJson(res, 503, { ok: false, reason: 'runtime_signing_unavailable' }, { 'Cache-Control': 'no-store' });
  }

  if (pathName === '/admin/model-config') {
    const corsHeaders = modelAdminCors(req);
    if (!corsHeaders) return sendJson(res, 403, { ok: false, reason: 'origin_not_allowed' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...BASE_HEADERS, ...corsHeaders });
      return res.end();
    }
    if (req.method === 'GET') return handleModelConfigGet(req, res, corsHeaders);
    if (req.method === 'PUT') {
      // Authenticate before reserving a request-body slot. This keeps an
      // unauthenticated caller from tying up the bounded body parser with a
      // deliberately slow upload.
      const auth = modelAdminAllowed(req);
      if (!auth.ok) {
        return sendJson(res, auth.status, {
          ok: false,
          reason: auth.status === 503 ? 'model_admin_key_not_configured' :
            auth.status === 429 ? 'too_many_attempts' : 'unauthorized'
        }, corsHeaders);
      }
      return withBody(
        req, res,
        (raw) => handleModelConfigPut(res, raw, corsHeaders),
        MAX_SMALL_BODY_BYTES * 4
      );
    }
    return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' }, {
      ...corsHeaders, Allow: 'GET, PUT, OPTIONS'
    });
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, BASE_HEADERS); return res.end(); }
  if (pathName === '/health') return sendJson(res, 200, { ok: true });
  if (pathName === '/ready') {
    const checks = {
      upstream_key: Boolean(UPSTREAM_KEY),
      entitlement_secret: ENTITLEMENT_SECRET_VALID,
      runtime_signing_key: Boolean(getRuntimeSigningKey()),
      quota_config: QUOTA_CONFIG_VALID,
      quota_store: verifyQuotaPersistenceForReadiness(),
      model_config: modelConfigHealthy
    };
    const ok = Object.values(checks).every(Boolean);
    return sendJson(res, ok ? 200 : 503, { ok, checks });
  }
  if (pathName === '/ai/streamtest' && req.method === 'GET') {
    if (!isAdmin(req)) return sendJson(res, 404, { ok: false, reason: 'not_found' });
    return handleStreamTest(req, res, url);
  }
  if (pathName === '/ai/poll' && req.method === 'GET') return handleAiPoll(req, res, url);
  if (pathName === '/ai/upload-ticket' && req.method === 'POST') return withBody(req, res, (raw) => handleUploadTicket(req, res, raw), MAX_SMALL_BODY_BYTES);
  if (pathName === '/ai/blob' && req.method === 'POST') return withBody(req, res, (raw) => handleBlob(req, res, raw), MAX_BLOB_REQUEST_BYTES);
  if (pathName === '/ai/start' && req.method === 'POST') return withBody(req, res, (raw) => handleAiStart(req, res, raw));
  if (pathName === '/ai/cancel' && req.method === 'POST') return withBody(req, res, (raw) => handleAiCancel(req, res, raw), MAX_SMALL_BODY_BYTES);
  if (pathName === '/ai/chat' && req.method === 'POST') {
    if (!isAdmin(req)) return sendJson(res, 404, { ok: false, reason: 'not_found' });
    return withBody(req, res, (raw) => handleAiChat(req, res, raw));
  }

  sendJson(res, 404, { ok: false, reason: 'not_found' });
});

// Bound slow-header/body connections even if Caddy is bypassed accidentally.
// requestTimeout covers receiving the request body, not the long AI response.
server.requestTimeout = 30 * 1000;
server.headersTimeout = 15 * 1000;
server.keepAliveTimeout = 5 * 1000;
server.maxHeadersCount = 64;
server.maxConnections = 128;

server.listen(PORT, HOST, () => {
  console.log(`smesh-proxy listening on ${HOST}:${PORT} → upstream ${upstreamUrl()} · entitlement local`);
});

function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`smesh-proxy shutting down (${signal})`);
  for (const job of jobs.values()) {
    if (!job.done) job.cancelled = true;
    try { job.ctrl.abort(); } catch { }
  }
  flushPendingQuota();
  const finish = () => {
    // A request that was already inside its async handler may have charged a
    // quota after the first flush. Persist once more immediately before exit.
    flushPendingQuota();
    process.exit(0);
  };
  server.close(finish);
  setTimeout(finish, 5000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
