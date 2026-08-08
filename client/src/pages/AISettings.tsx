import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../services/api';
import AdminNav from '../components/AdminNav';
import { Cpu, Save, Link as LinkIcon, ShieldAlert, CheckCircle2, XCircle, Info, KeyRound, ArrowLeft, Settings } from 'lucide-react';

interface AISettings {
  provider: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

const PROVIDERS = [
  { id: 'gemini', name: 'Google Gemini', models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'] },
  { id: 'openai', name: 'OpenAI (ChatGPT)', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
  { id: 'grok', name: 'xAI Grok', models: ['grok-2', 'grok-2-mini', 'grok-beta'] },
  { id: 'deepseek', name: 'DeepSeek', models: ['deepseek-chat', 'deepseek-coder'] },
  { id: 'claude', name: 'Anthropic Claude', models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'] },
  { id: 'groq', name: 'Groq', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'llama_guard-8b'] },
  { id: 'openrouter', name: 'OpenRouter', models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-2.0-flash'] },
  { id: 'azure', name: 'Azure OpenAI', models: ['gpt-4o', 'gpt-4-turbo', 'gpt-35-turbo'] },
  { id: 'ollama', name: 'Ollama (Local)', models: ['llama3.1', 'llama3', 'codellama', 'mistral', 'phi3'] },
];

function AISettings() {
  const [settings, setSettings] = useState<AISettings>({
    provider: 'gemini',
    apiKey: '',
    model: 'gemini-2.0-flash',
    temperature: 0.3,
    maxTokens: 2048
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{success: boolean; message: string} | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const res = await adminApi.getAISettings();
      if (res.data) {
        setSettings(res.data);
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await adminApi.saveAISettings(settings);
      alert('Settings saved successfully!');
    } catch (error) {
      console.error(error);
      alert('Error saving settings');
    }
    setSaving(false);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await adminApi.testAI(settings);
      setTestResult({ success: true, message: `Success! Response: ${res.data.response}` });
    } catch (error: any) {
      setTestResult({ success: false, message: error.response?.data?.error || 'Test failed' });
    }
    setTesting(false);
  };

  const handleProviderChange = (providerId: string) => {
    const provider = PROVIDERS.find(p => p.id === providerId);
    setSettings(prev => ({
      ...prev,
      provider: providerId,
      model: provider?.models[0] || ''
    }));
  };

  return (
    <div className="container">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 pb-4 border-b border-slate-200 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-100 text-indigo-600 rounded-lg">
            <Cpu size={24} />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight m-0 border-none pb-0">AI Settings</h1>
        </div>
        <Link 
          to="/admin/dashboard" 
          className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg font-medium text-sm hover:bg-slate-50 transition-colors shadow-sm"
        >
          <ArrowLeft size={16} />
          <span className="hidden sm:inline">Back to Dashboard</span>
        </Link>
      </div>

      <AdminNav />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-100 bg-slate-50/50">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2 m-0 border-none pb-0">
                <Settings size={20} className="text-slate-500" />
                AI Configuration
              </h3>
              <p className="text-sm text-slate-500 mt-1">
                Configure the AI provider for automatic code grading and evaluation.
              </p>
            </div>
            
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">AI Provider</label>
                  <select 
                    value={settings.provider}
                    onChange={e => handleProviderChange(e.target.value)}
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:ring-2 focus:ring-blue-500"
                  >
                    {PROVIDERS.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Model</label>
                  <select 
                    value={settings.model}
                    onChange={e => setSettings(prev => ({ ...prev, model: e.target.value }))}
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:ring-2 focus:ring-blue-500"
                  >
                    {PROVIDERS.find(p => p.id === settings.provider)?.models.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2 flex items-center justify-between">
                  API Key
                  {settings.provider === 'ollama' && (
                    <span className="text-xs text-slate-500 font-normal">Enter local server URL (e.g., http://localhost:11434)</span>
                  )}
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <KeyRound size={16} className="text-slate-400" />
                    </div>
                    <input 
                      type={showApiKey ? 'text' : 'password'}
                      value={settings.apiKey}
                      onChange={e => setSettings(prev => ({ ...prev, apiKey: e.target.value }))}
                      placeholder={settings.provider === 'ollama' ? "http://localhost:11434" : "Enter API key..."}
                      className="block w-full pl-10 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                    />
                  </div>
                  <button 
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="px-4 py-2.5 bg-slate-100 border border-slate-200 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 transition-colors"
                  >
                    {showApiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="block text-sm font-medium text-slate-700">Temperature</label>
                    <span className="bg-slate-100 text-slate-700 text-xs font-semibold px-2 py-0.5 rounded-full border border-slate-200">
                      {settings.temperature}
                    </span>
                  </div>
                  <input 
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={settings.temperature}
                    onChange={e => setSettings(prev => ({ ...prev, temperature: parseFloat(e.target.value) }))}
                    className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                  <div className="flex justify-between mt-2">
                    <span className="text-xs text-slate-500">More focused</span>
                    <span className="text-xs text-slate-500">More creative</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Max Tokens</label>
                  <input 
                    type="number"
                    min="100"
                    max="10000"
                    value={settings.maxTokens}
                    onChange={e => setSettings(prev => ({ ...prev, maxTokens: parseInt(e.target.value) || 2048 }))}
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-slate-500 mt-2">
                    Maximum response length for evaluations
                  </p>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex flex-wrap items-center gap-3">
              <button 
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50"
              >
                <Save size={18} />
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
              <button 
                onClick={handleTest}
                disabled={testing || !settings.apiKey}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-300 text-slate-700 rounded-lg font-medium hover:bg-slate-50 transition-colors shadow-sm disabled:opacity-50"
              >
                <LinkIcon size={18} />
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
            </div>
          </div>

          {testResult && (
            <div className={`rounded-xl p-4 flex items-start gap-3 border ${
              testResult.success 
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800' 
                : 'bg-red-50 border-red-200 text-red-800'
            }`}>
              <div className="mt-0.5 shrink-0">
                {testResult.success ? <CheckCircle2 size={20} className="text-emerald-600" /> : <XCircle size={20} className="text-red-600" />}
              </div>
              <div>
                <h4 className={`text-sm font-bold m-0 ${testResult.success ? 'text-emerald-900' : 'text-red-900'}`}>
                  {testResult.success ? 'Connection Successful' : 'Connection Failed'}
                </h4>
                <p className="text-sm mt-1 whitespace-pre-wrap leading-relaxed opacity-90 break-all">
                  {testResult.message}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden h-fit">
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
            <Info size={18} className="text-slate-500" />
            <h3 className="font-bold text-slate-800 m-0 border-none pb-0">Provider Info</h3>
          </div>
          <div className="p-0">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="bg-slate-50">
                  <th className="px-5 py-3 font-semibold text-slate-600 border-b border-slate-200">Provider</th>
                  <th className="px-5 py-3 font-semibold text-slate-600 border-b border-slate-200">Free Tier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 text-slate-800 font-medium">Google Gemini</td>
                  <td className="px-5 py-3 text-slate-600 text-xs">15 req/min, 1500/day</td>
                </tr>
                <tr className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 text-slate-800 font-medium">OpenAI</td>
                  <td className="px-5 py-3 text-slate-600 text-xs">$5 free credits</td>
                </tr>
                <tr className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 text-slate-800 font-medium">DeepSeek</td>
                  <td className="px-5 py-3 text-slate-600 text-xs">Very Generous</td>
                </tr>
                <tr className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 text-slate-800 font-medium">Groq</td>
                  <td className="px-5 py-3 text-slate-600 text-xs">14,400 tokens/min</td>
                </tr>
                <tr className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 text-slate-800 font-medium">Anthropic</td>
                  <td className="px-5 py-3 text-slate-600 text-xs">$5 free credits</td>
                </tr>
                <tr className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 text-slate-800 font-medium">OpenRouter</td>
                  <td className="px-5 py-3 text-slate-600 text-xs">$1 free credits</td>
                </tr>
                <tr className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 text-slate-800 font-medium">Ollama</td>
                  <td className="px-5 py-3 text-slate-600 text-xs flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500"></span> Local</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="bg-amber-50 p-4 border-t border-slate-100">
            <div className="flex gap-2 text-amber-800 text-xs leading-relaxed">
              <ShieldAlert size={16} className="shrink-0 text-amber-600" />
              <p>Keep your API keys secure. They are stored encrypted in the database.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AISettings;
