import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../services/api';

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
      <div className="header">
        <h1>AI Settings</h1>
        <Link to="/admin/dashboard" className="btn btn-secondary">Back to Dashboard</Link>
      </div>

      <div className="nav">
        <Link to="/admin/dashboard">Dashboard</Link>
        <Link to="/admin/questions">Question Bank</Link>
        <Link to="/admin/batches">Batches</Link>
        <Link to="/admin/settings">AI Settings</Link>
      </div>

      <div className="card" style={{ maxWidth: 800 }}>
        <h3>AI Configuration</h3>
        <p style={{ color: 'var(--text-light)', marginBottom: 20 }}>
          Configure the AI provider for automatic answer grading.
        </p>

        <div className="form-group">
          <label>AI Provider</label>
          <select 
            value={settings.provider}
            onChange={e => handleProviderChange(e.target.value)}
          >
            {PROVIDERS.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Model</label>
          <select 
            value={settings.model}
            onChange={e => setSettings(prev => ({ ...prev, model: e.target.value }))}
          >
            {PROVIDERS.find(p => p.id === settings.provider)?.models.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>API Key</label>
          <div style={{ display: 'flex', gap: 10 }}>
            <input 
              type={showApiKey ? 'text' : 'password'}
              value={settings.apiKey}
              onChange={e => setSettings(prev => ({ ...prev, apiKey: e.target.value }))}
              placeholder="Enter API key..."
              style={{ flex: 1 }}
            />
            <button 
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="btn btn-secondary"
              style={{ minWidth: 80 }}
            >
              {showApiKey ? 'Hide' : 'Show'}
            </button>
          </div>
          {settings.provider === 'ollama' && (
            <p style={{ fontSize: 12, color: 'var(--text-light)', marginTop: 5 }}>
              For Ollama, enter your local server URL (e.g., http://localhost:11434)
            </p>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
          <div className="form-group">
            <label>Temperature ({settings.temperature})</label>
            <input 
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={settings.temperature}
              onChange={e => setSettings(prev => ({ ...prev, temperature: parseFloat(e.target.value) }))}
            />
            <p style={{ fontSize: 12, color: 'var(--text-light)' }}>
              Lower = more focused, Higher = more creative
            </p>
          </div>

          <div className="form-group">
            <label>Max Tokens</label>
            <input 
              type="number"
              min="100"
              max="10000"
              value={settings.maxTokens}
              onChange={e => setSettings(prev => ({ ...prev, maxTokens: parseInt(e.target.value) || 2048 }))}
            />
            <p style={{ fontSize: 12, color: 'var(--text-light)' }}>
              Maximum response length
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button 
            onClick={handleSave}
            disabled={saving}
            className="btn btn-primary"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          <button 
            onClick={handleTest}
            disabled={testing || !settings.apiKey}
            className="btn btn-secondary"
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
        </div>

        {testResult && (
          <div style={{ 
            marginTop: 20, 
            padding: 15, 
            borderRadius: 6,
            background: testResult.success ? '#dcfce7' : '#fee2e2',
            color: testResult.success ? '#166534' : '#dc2626'
          }}>
            <strong>{testResult.success ? '✓ Success' : '✗ Error'}</strong>
            <p style={{ marginTop: 5, wordBreak: 'break-all' }}>{testResult.message}</p>
          </div>
        )}
      </div>

      <div className="card" style={{ maxWidth: 800, marginTop: 20 }}>
        <h4>Provider Information</h4>
        <table style={{ width: '100%', fontSize: 14 }}>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Free Tier</th>
              <th>Website</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Google Gemini</td>
              <td>15 req/min, 1500/day</td>
              <td><a href="https://aistudio.google.com" target="_blank">aistudio.google.com</a></td>
            </tr>
            <tr>
              <td>OpenAI</td>
              <td>$5 free credits</td>
              <td><a href="https://platform.openai.com" target="_blank">platform.openai.com</a></td>
            </tr>
            <tr>
              <td>DeepSeek</td>
              <td>Very Generous</td>
              <td><a href="https://platform.deepseek.com" target="_blank">platform.deepseek.com</a></td>
            </tr>
            <tr>
              <td>Groq</td>
              <td>14,400 tokens/min</td>
              <td><a href="https://console.groq.com" target="_blank">console.groq.com</a></td>
            </tr>
            <tr>
              <td>Anthropic Claude</td>
              <td>$5 free credits</td>
              <td><a href="https://console.anthropic.com" target="_blank">console.anthropic.com</a></td>
            </tr>
            <tr>
              <td>OpenRouter</td>
              <td>$1 free credits</td>
              <td><a href="https://openrouter.ai" target="_blank">openrouter.ai</a></td>
            </tr>
            <tr>
              <td>Ollama (Local)</td>
              <td>Free (local)</td>
              <td><a href="https://ollama.com" target="_blank">ollama.com</a></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default AISettings;
