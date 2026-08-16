import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Cpu, KeyRound, Link as LinkIcon, Save, ShieldAlert, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import AdminNav from '../components/AdminNav';
import { adminApi } from '../services/api';

type AiProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages' | 'gemini_generate_content' | 'ollama_generate';

interface SettingsForm {
  provider: string;
  apiProtocol: AiProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const PROTOCOLS: Array<{ value: AiProtocol; label: string }> = [
  { value: 'openai_chat', label: 'OpenAI Chat Completions' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
  { value: 'gemini_generate_content', label: 'Gemini Generate Content' },
  { value: 'ollama_generate', label: 'Ollama Generate' },
];

const DEFAULT_URLS: Record<AiProtocol, string> = {
  openai_chat: 'https://api.openai.com/v1',
  openai_responses: 'https://api.openai.com/v1',
  anthropic_messages: 'https://api.anthropic.com',
  gemini_generate_content: 'https://generativelanguage.googleapis.com/v1beta',
  ollama_generate: 'http://localhost:11434',
};

const EMPTY_FORM: SettingsForm = {
  provider: '', apiProtocol: 'openai_chat', baseUrl: DEFAULT_URLS.openai_chat, apiKey: '', model: '',
};

function AISettings() {
  const [form, setForm] = useState<SettingsForm>(EMPTY_FORM);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [keyMask, setKeyMask] = useState('');
  const [savedStatus, setSavedStatus] = useState('not_configured');
  const [testedAt, setTestedAt] = useState<string | null>(null);
  const [testToken, setTestToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    adminApi.getAISettings().then((response) => {
      const data = response.data;
      if (data.configured) {
        setForm({
          provider: data.provider || '', apiProtocol: data.apiProtocol || 'openai_chat',
          baseUrl: data.baseUrl || '', apiKey: '', model: data.model || '',
        });
        setHasStoredKey(Boolean(data.hasApiKey));
        setKeyMask(data.keyMask || '');
        setSavedStatus(data.testStatus || 'untested');
        setTestedAt(data.testedAt || null);
      }
    }).catch((error) => {
      setNotice({ success: false, message: error.response?.data?.error || 'Could not load AI settings' });
    }).finally(() => setLoading(false));
  }, []);

  const updateField = <K extends keyof SettingsForm>(field: K, value: SettingsForm[K]) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setTestToken('');
    setNotice(null);
  };

  const handleProtocolChange = (protocol: AiProtocol) => {
    setForm((previous) => ({
      ...previous,
      apiProtocol: protocol,
      baseUrl: !previous.baseUrl || Object.values(DEFAULT_URLS).includes(previous.baseUrl) ? DEFAULT_URLS[protocol] : previous.baseUrl,
    }));
    setTestToken('');
    setNotice(null);
  };

  const validate = () => {
    if (!form.provider.trim()) return 'API Provider is required';
    if (!form.baseUrl.trim()) return 'Base URL is required';
    if (!form.model.trim()) return 'Model is required';
    if (!form.apiKey.trim() && !hasStoredKey && form.apiProtocol !== 'ollama_generate') return 'API Key is required';
    return null;
  };

  const handleTest = async () => {
    const error = validate();
    if (error) return setNotice({ success: false, message: error });
    setTesting(true);
    setNotice(null);
    try {
      const response = await adminApi.testAI(form);
      setTestToken(response.data.testToken);
      setNotice({ success: true, message: `Connection verified with ${response.data.model} in ${response.data.latencyMs} ms. You can now save.` });
    } catch (requestError: any) {
      setTestToken('');
      setNotice({ success: false, message: requestError.response?.data?.error || 'Connection test failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!testToken) return;
    setSaving(true);
    try {
      const response = await adminApi.saveAISettings({ ...form, testToken });
      setHasStoredKey(Boolean(response.data.hasApiKey));
      setKeyMask(response.data.keyMask || '');
      setSavedStatus(response.data.testStatus || 'verified');
      setTestedAt(response.data.testedAt || null);
      setForm((previous) => ({ ...previous, apiKey: '' }));
      setTestToken('');
      setNotice({ success: true, message: 'Your encrypted LLM configuration has been saved.' });
    } catch (requestError: any) {
      setNotice({ success: false, message: requestError.response?.data?.error || 'Could not save AI settings' });
    } finally {
      setSaving(false);
    }
  };

  const controlClassName = 'w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-transparent focus:bg-white focus:ring-2 focus:ring-blue-500';
  const iconControlClassName = `${controlClassName} pl-10 font-mono text-sm`;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="container space-y-6">
        <div className="flex flex-col items-start justify-between gap-4 border-b border-slate-200 pb-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-indigo-100 p-2 text-indigo-600">
              <Cpu size={24} />
            </div>
            <div>
              <h1 className="m-0 border-none pb-0 text-2xl font-bold tracking-tight text-slate-900">AI Settings</h1>
              <p className="mt-1 text-sm text-slate-500">This configuration belongs only to your account.</p>
            </div>
          </div>
          <Link
            to="/admin/dashboard"
            aria-label="Back to Dashboard"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
          >
            <ArrowLeft size={16} />
            <span className="hidden sm:inline">Back to Dashboard</span>
          </Link>
        </div>

        <AdminNav />

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col items-start justify-between gap-3 border-b border-slate-200 bg-slate-50/70 p-5 sm:flex-row sm:items-center sm:px-6">
            <div>
              <h2 className="m-0 border-none pb-0 text-lg font-bold text-slate-900">Custom LLM connection</h2>
              <p className="mt-1 text-sm text-slate-500">Configure the provider, protocol, endpoint, key, and model used to grade your essay batches.</p>
            </div>
            <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${savedStatus === 'verified' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
              {savedStatus === 'verified' ? 'Verified' : 'Not configured'}
            </span>
          </div>

          <div className="p-5 sm:p-6">
            {loading ? (
              <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
                Loading settings...
              </div>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <div className="space-y-2">
                    <label className="block text-sm font-bold text-slate-700">API Provider</label>
                    <input
                      list="provider-suggestions"
                      value={form.provider}
                      onChange={(event) => updateField('provider', event.target.value)}
                      placeholder="e.g. OpenAI, Anthropic, STU Gateway"
                      className={controlClassName}
                    />
                    <datalist id="provider-suggestions">
                      <option value="OpenAI" /><option value="Anthropic" /><option value="Google Gemini" />
                      <option value="OpenRouter" /><option value="Groq" /><option value="DeepSeek" /><option value="Ollama" />
                    </datalist>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-bold text-slate-700">API Protocol</label>
                    <select
                      value={form.apiProtocol}
                      onChange={(event) => handleProtocolChange(event.target.value as AiProtocol)}
                      className={`${controlClassName} bg-white`}
                    >
                      {PROTOCOLS.map((protocol) => <option key={protocol.value} value={protocol.value}>{protocol.label}</option>)}
                    </select>
                    <p className="text-xs leading-5 text-slate-500">Protocol tells the backend how to construct requests and read responses.</p>
                  </div>

                  <div className="space-y-2 lg:col-span-2">
                    <label className="block text-sm font-bold text-slate-700">Base URL</label>
                    <div className="relative">
                      <LinkIcon size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input
                        value={form.baseUrl}
                        onChange={(event) => updateField('baseUrl', event.target.value)}
                        placeholder="https://api.example.com/v1"
                        className={iconControlClassName}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-bold text-slate-700">API Key</label>
                    <div className="relative">
                      <KeyRound size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={form.apiKey}
                        onChange={(event) => updateField('apiKey', event.target.value)}
                        placeholder={hasStoredKey ? `Stored key: ${keyMask} (leave blank to keep it)` : 'Enter API key'}
                        className={iconControlClassName}
                      />
                    </div>
                    <p className="text-xs leading-5 text-slate-500">The plaintext key is never returned to this page.</p>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-bold text-slate-700">Model</label>
                    <input
                      value={form.model}
                      onChange={(event) => updateField('model', event.target.value)}
                      placeholder="Enter the exact model identifier"
                      className={`${controlClassName} font-mono text-sm`}
                    />
                  </div>
                </div>

                {notice && (
                  <div className={`flex items-start gap-2 rounded-xl border p-4 text-sm ${notice.success ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
                    {notice.success ? <CheckCircle2 size={18} className="mt-0.5 shrink-0" /> : <XCircle size={18} className="mt-0.5 shrink-0" />}
                    <span className="min-w-0 break-words leading-5">{notice.message}</span>
                  </div>
                )}

                <div className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-6 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-xs text-slate-500">
                    {testedAt ? `Last verified: ${new Date(testedAt).toLocaleString()}` : 'Test the connection successfully before saving.'}
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <button
                      type="button"
                      onClick={handleTest}
                      disabled={testing || saving}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-blue-300 bg-white px-4 py-2.5 text-sm font-bold text-blue-700 shadow-sm transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                    >
                      <Cpu size={17} /> {testing ? 'Testing...' : 'Test Connection'}
                    </button>
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={!testToken || testing || saving}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                    >
                      <Save size={17} /> {saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-800">
                  <ShieldAlert size={18} className="mt-0.5 shrink-0" />
                  <span>Production blocks localhost/private-network URLs. A local Ollama endpoint cannot be reached from Vercel unless it is exposed through a secure public HTTPS endpoint.</span>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export default AISettings;
