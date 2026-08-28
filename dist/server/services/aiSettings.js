import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { callLlm, connectionFingerprint, normalizeConnectionConfig } from './aiProvider.js';
function encryptionKey() {
    const configured = (process.env.AI_SETTINGS_ENCRYPTION_KEY || '').trim();
    const hasMatchingQuotes = configured.length >= 2 && ((configured.startsWith('"') && configured.endsWith('"'))
        || (configured.startsWith("'") && configured.endsWith("'")));
    const raw = (hasMatchingQuotes ? configured.slice(1, -1) : configured).trim();
    if (/^[a-fA-F0-9]{64}$/.test(raw))
        return Buffer.from(raw, 'hex');
    try {
        const decoded = Buffer.from(raw, 'base64');
        if (decoded.length === 32)
            return decoded;
    }
    catch (_) { /* handled below */ }
    throw new Error(`AI_SETTINGS_ENCRYPTION_KEY must be a 32-byte base64 value or 64 hex characters (received ${raw.length} characters after trimming)`);
}
function encryptSecret(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
        encrypted: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
    };
}
function decryptSecret(row) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(row.key_iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.key_auth_tag, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(row.encrypted_api_key, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}
function keyMask(key) {
    if (!key)
        return '(no key)';
    const prefix = key.slice(0, Math.min(3, key.length));
    const suffix = key.slice(-4);
    return `${prefix}${'*'.repeat(6)}${suffix}`;
}
function jwtSecret() {
    if (!process.env.JWT_SECRET)
        throw new Error('JWT_SECRET is not configured');
    return process.env.JWT_SECRET;
}
export async function loadAiSettingRow(db, userId) {
    const result = await db.query('SELECT * FROM user_ai_settings WHERE user_id = ?', [userId]);
    return result.rows[0] || null;
}
export async function getOwnedAiSetting(db, userId) {
    const row = await loadAiSettingRow(db, userId);
    if (!row)
        return { configured: false, testStatus: 'not_configured', hasApiKey: false };
    return {
        configured: true,
        id: Number(row.id),
        provider: row.provider,
        apiProtocol: row.api_protocol,
        baseUrl: row.base_url,
        model: row.model,
        keyMask: row.key_mask,
        hasApiKey: !!row.encrypted_api_key,
        testStatus: row.test_status,
        testedAt: row.tested_at,
        updatedAt: row.updated_at,
    };
}
export async function deleteOwnedAiSetting(db, userId) {
    const result = await db.query('DELETE FROM user_ai_settings WHERE user_id = ?', [userId]);
    return { success: true, deleted: result.rowCount > 0 };
}
async function resolveDraftConfig(db, userId, input) {
    let apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
    if (!apiKey) {
        const existing = await loadAiSettingRow(db, userId);
        if (existing?.encrypted_api_key)
            apiKey = decryptSecret(existing);
    }
    return normalizeConnectionConfig(input, apiKey);
}
export async function testOwnedAiSetting(db, userId, input) {
    const config = await resolveDraftConfig(db, userId, input);
    const started = performance.now();
    const response = await callLlm(config, {
        system: 'You are a connection tester. Follow the user instruction exactly.',
        prompt: 'Return only this JSON object: {"status":"ok"}',
        maxOutputTokens: 64,
        timeoutMs: 20_000,
    });
    if (!response.trim())
        throw new Error('LLM returned an empty response');
    const fingerprint = connectionFingerprint(config);
    const testToken = jwt.sign({ purpose: 'ai-setting-test', userId, fingerprint }, jwtSecret(), { expiresIn: '10m' });
    return {
        success: true,
        provider: config.provider,
        model: config.model,
        latencyMs: Math.round(performance.now() - started),
        testToken,
    };
}
export async function saveOwnedAiSetting(db, userId, input) {
    const config = await resolveDraftConfig(db, userId, input);
    const token = String(input?.testToken || '');
    let payload;
    try {
        payload = jwt.verify(token, jwtSecret());
    }
    catch {
        throw new Error('Test Connection must pass before saving');
    }
    const fingerprint = connectionFingerprint(config);
    if (payload?.purpose !== 'ai-setting-test' || Number(payload?.userId) !== userId || payload?.fingerprint !== fingerprint) {
        throw new Error('Configuration changed after Test Connection; please test again');
    }
    const secret = encryptSecret(config.apiKey);
    const now = new Date().toISOString();
    await db.query(`
    INSERT INTO user_ai_settings (
      user_id, provider, api_protocol, base_url, encrypted_api_key, key_iv, key_auth_tag,
      encryption_key_version, key_mask, model, test_status, tested_config_hash, tested_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'verified', ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      provider = excluded.provider,
      api_protocol = excluded.api_protocol,
      base_url = excluded.base_url,
      encrypted_api_key = excluded.encrypted_api_key,
      key_iv = excluded.key_iv,
      key_auth_tag = excluded.key_auth_tag,
      encryption_key_version = 1,
      key_mask = excluded.key_mask,
      model = excluded.model,
      test_status = 'verified',
      tested_config_hash = excluded.tested_config_hash,
      tested_at = excluded.tested_at,
      updated_at = excluded.updated_at
  `, [
        userId, config.provider, config.apiProtocol, config.baseUrl, secret.encrypted, secret.iv, secret.authTag,
        keyMask(config.apiKey), config.model, fingerprint, now, now, now,
    ]);
    return getOwnedAiSetting(db, userId);
}
export async function loadVerifiedConnection(db, userId, settingId) {
    const row = await loadAiSettingRow(db, userId);
    if (!row || row.test_status !== 'verified' || (settingId && Number(row.id) !== settingId)) {
        throw new Error('A verified AI setting owned by the batch creator is required');
    }
    const config = normalizeConnectionConfig({
        provider: row.provider,
        apiProtocol: row.api_protocol,
        baseUrl: row.base_url,
        model: row.model,
    }, decryptSecret(row));
    if (connectionFingerprint(config) !== row.tested_config_hash)
        throw new Error('AI setting must be tested again');
    return config;
}
