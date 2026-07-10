import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../services/api';

// Convert "YYYY-MM-DDTHH:mm" (treated as GMT+7 input) → UTC ISO string
const localToUTC = (localStr: string): string => {
  if (!localStr) return localStr;
  // Append +07:00 so browser parses as GMT+7, then convert to UTC
  return new Date(`${localStr}:00+07:00`).toISOString();
};

// Convert UTC ISO string → "YYYY-MM-DDTHH:mm" in GMT+7 (for datetime-local input)
const utcToLocalInput = (utcStr: string): string => {
  if (!utcStr) return '';
  const date = new Date(utcStr);
  // Shift to GMT+7
  const gmt7 = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return gmt7.toISOString().slice(0, 16);
};

// Format UTC ISO string → human-readable GMT+7 (for display in table)
const formatGMT7 = (utcStr: string): string => {
  if (!utcStr) return '';
  return new Date(utcStr).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
};

type BlueprintMode = 'module' | 'type';

const QUESTION_TYPES = ['Coding', 'Conceptual', 'Fill-in', 'Debug'] as const;
type QuestionType = typeof QUESTION_TYPES[number];

// A (module, question_group) combo shown in Module dropdowns. The same module name can
// exist under multiple question groups (e.g. "Unit Testing" under both CPP_EMB_PRINT_IOT
// and CPP_EMB_AUTOSAR), so module alone is not a unique selector.
interface ModuleGroupOption {
  module: string;
  question_group: string; // '' when the question has no group
}

interface BlueprintItem {
  module: string;
  question_group: string;
  easy: number;
  medium: number;
  hard: number;
}

interface BlueprintItemByType {
  module: string;
  question_group: string;
  type: QuestionType;
  easy: number;
  medium: number;
  hard: number;
}

interface TypeStats {
  type: string;
  easy: number;
  medium: number;
  hard: number;
}

interface ModuleGroupStats {
  module: string;
  question_group: string;
  easy: number;
  medium: number;
  hard: number;
}

interface ModuleGroupTypeStats {
  module: string;
  question_group: string;
  type: string;
  easy: number;
  medium: number;
  hard: number;
}

/** Encode a (module, question_group) pair as a single <select> option value */
const comboKey = (module: string, group: string) => `${module}|||${group || ''}`;
/** Decode a <select> option value back into { module, question_group } */
const decodeComboKey = (key: string): { module: string; question_group: string } => {
  const [module, question_group] = key.split('|||');
  return { module, question_group: question_group || '' };
};
/** Human-readable label for a (module, question_group) combo, e.g. "Chapter 10: Unit Testing (CPP_EMB_PRINT_IOT)" */
const comboLabel = (module: string, group: string) => (group ? `${module} (${group})` : module);

function BatchManagement() {
  const [batches, setBatches] = useState<any[]>([]);
  const [moduleGroups, setModuleGroups] = useState<ModuleGroupOption[]>([]);
  const [moduleGroupStats, setModuleGroupStats] = useState<ModuleGroupStats[]>([]);
  const [typeStats, setTypeStats] = useState<TypeStats[]>([]);
  const [moduleGroupTypeStats, setModuleGroupTypeStats] = useState<ModuleGroupTypeStats[]>([]);
  // Create form state
  const [blueprintMode, setBlueprintMode] = useState<BlueprintMode>('module');
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    start_time: '',
    end_time: '',
    duration: 30,
    blueprint: [] as BlueprintItem[],
    blueprintByType: [] as BlueprintItemByType[]
  });
  // Edit form state
  const [editBlueprintMode, setEditBlueprintMode] = useState<BlueprintMode>('module');
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [editingBatch, setEditingBatch] = useState<any>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [emails, setEmails] = useState('');
  const [inviteResult, setInviteResult] = useState<{success: number; emails: {email: string; code: string}[]} | null>(null);
  const [feasibilityErrors, setFeasibilityErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Return stats for a given (module, question_group) combination (zeros if not found) */
  const getStatsForModuleGroup = (moduleName: string, group: string): ModuleGroupStats =>
    moduleGroupStats.find(s => s.module === moduleName && (s.question_group || '') === (group || ''))
      ?? { module: moduleName, question_group: group || '', easy: 0, medium: 0, hard: 0 };

  /** Return stats for a given (module, question_group, type) combination (zeros if not found) */
  const getStatsForModuleGroupType = (moduleName: string, group: string, typeName: string): ModuleGroupTypeStats =>
    moduleGroupTypeStats.find(s => s.module === moduleName && (s.question_group || '') === (group || '') && s.type === typeName)
      ?? { module: moduleName, question_group: group || '', type: typeName, easy: 0, medium: 0, hard: 0 };

  /** Validate blueprint (by module) against available question counts */
  const validateBlueprintAgainstStats = (blueprint: BlueprintItem[]): string[] => {
    const errors: string[] = [];
    for (const item of blueprint) {
      const stats = getStatsForModuleGroup(item.module, item.question_group);
      const label = comboLabel(item.module, item.question_group);
      if (item.easy > stats.easy)
        errors.push(`Module "${label}": Easy yêu cầu ${item.easy}, chỉ có ${stats.easy} câu.`);
      if (item.medium > stats.medium)
        errors.push(`Module "${label}": Medium yêu cầu ${item.medium}, chỉ có ${stats.medium} câu.`);
      if (item.hard > stats.hard)
        errors.push(`Module "${label}": Hard yêu cầu ${item.hard}, chỉ có ${stats.hard} câu.`);
    }
    return errors;
  };

  /** Validate blueprint (by module+type) against available question counts */
  const validateTypesBlueprintAgainstStats = (blueprint: BlueprintItemByType[]): string[] => {
    const errors: string[] = [];
    for (const item of blueprint) {
      const stats = getStatsForModuleGroupType(item.module, item.question_group, item.type);
      const label = comboLabel(item.module, item.question_group);
      if (item.easy > stats.easy)
        errors.push(`Module "${label}" / Type "${item.type}": Easy yêu cầu ${item.easy}, chỉ có ${stats.easy} câu.`);
      if (item.medium > stats.medium)
        errors.push(`Module "${label}" / Type "${item.type}": Medium yêu cầu ${item.medium}, chỉ có ${stats.medium} câu.`);
      if (item.hard > stats.hard)
        errors.push(`Module "${label}" / Type "${item.type}": Hard yêu cầu ${item.hard}, chỉ có ${stats.hard} câu.`);
    }
    return errors;
  };

  /**
   * Build the blueprint payload to send to the server.
   * Wraps into { blueprintMode, items } object.
   */
  const buildBlueprintPayload = (mode: BlueprintMode, moduleItems: BlueprintItem[], typeItems: BlueprintItemByType[]) => ({
    blueprintMode: mode,
    items: mode === 'type' ? typeItems : moduleItems,
  });

  // ─── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadBatches();
    loadModuleGroups();
    loadModuleGroupStats();
    loadTypeStats();
    loadModuleGroupTypeStats();
  }, []);


  useEffect(() => {
    if (moduleGroups.length > 0 && formData.blueprint.length === 0) {
      const first = moduleGroups[0];
      setFormData(prev => ({
        ...prev,
        blueprint: [{ module: first.module, question_group: first.question_group, easy: 0, medium: 0, hard: 0 }]
      }));
    }
  }, [moduleGroups]);

  // ─── Loaders ────────────────────────────────────────────────────────────────

  const loadBatches = async () => {
    try {
      const res = await adminApi.getBatches();
      setBatches(res.data);
    } catch (error) {
      console.error(error);
    }
  };

  const loadModuleGroups = async () => {
    try {
      const res = await adminApi.getModuleGroups();
      console.log('[BatchManagement] Module groups loaded:', res.data);
      setModuleGroups(res.data);
    } catch (error) {
      console.error('[BatchManagement] loadModuleGroups error:', error);
    }
  };

  const loadModuleGroupStats = async () => {
    try {
      const res = await adminApi.getModuleGroupStats();
      console.log('[BatchManagement] Module-group stats loaded:', res.data);
      setModuleGroupStats(res.data);
    } catch (error) {
      console.error('[BatchManagement] loadModuleGroupStats error:', error);
    }
  };

  const loadTypeStats = async () => {
    try {
      const res = await adminApi.getTypeStats();
      console.log('[BatchManagement] Type stats loaded:', res.data);
      setTypeStats(res.data);
    } catch (error) {
      console.error('[BatchManagement] loadTypeStats error:', error);
    }
  };

  const loadModuleGroupTypeStats = async () => {
    try {
      const res = await adminApi.getModuleGroupTypeStats();
      console.log('[BatchManagement] Module-group-type stats loaded:', res.data);
      setModuleGroupTypeStats(res.data);
    } catch (error) {
      console.error('[BatchManagement] loadModuleGroupTypeStats error:', error);
    }
  };

  // ─── Blueprint helpers (Create form) ────────────────────────────────────────

  const addBlueprintRow = () => {
    const first = moduleGroups[0];
    setFormData(prev => ({
      ...prev,
      blueprint: [...prev.blueprint, { module: first?.module || '', question_group: first?.question_group || '', easy: 0, medium: 0, hard: 0 }]
    }));
  };

  const updateBlueprint = (index: number, field: keyof BlueprintItem, value: any) => {
    const newBlueprint = [...formData.blueprint];
    const convertedValue = (field === 'module' || field === 'question_group') ? value : Number(value);
    newBlueprint[index] = { ...newBlueprint[index], [field]: convertedValue };
    setFormData(prev => ({ ...prev, blueprint: newBlueprint }));
  };

  /** Update module + question_group together, since the dropdown selects a single combo */
  const updateBlueprintModuleGroup = (index: number, module: string, question_group: string) => {
    const newBlueprint = [...formData.blueprint];
    newBlueprint[index] = { ...newBlueprint[index], module, question_group };
    setFormData(prev => ({ ...prev, blueprint: newBlueprint }));
  };

  const removeBlueprintRow = (index: number) => {
    setFormData(prev => ({
      ...prev,
      blueprint: prev.blueprint.filter((_, i) => i !== index)
    }));
  };

  // ─── Blueprint helpers (By Type – Create form) ───────────────────────────────

  /** (module, question_group, type) combos already used in By Type blueprint */
  const usedModuleTypeCombos = formData.blueprintByType.map(i => `${i.module}||${i.question_group}||${i.type}`);

  /** Find first available (module, question_group, type) combo not yet used */
  const getNextAvailableModuleType = (): { module: string; question_group: string; type: QuestionType } | null => {
    for (const mg of moduleGroups) {
      for (const t of QUESTION_TYPES) {
        if (!usedModuleTypeCombos.includes(`${mg.module}||${mg.question_group}||${t}`)) {
          return { module: mg.module, question_group: mg.question_group, type: t };
        }
      }
    }
    return null;
  };
  const nextAvailableModuleType = getNextAvailableModuleType();

  const addTypeBlueprintRow = () => {
    if (!nextAvailableModuleType) return;
    setFormData(prev => ({
      ...prev,
      blueprintByType: [...prev.blueprintByType, {
        module: nextAvailableModuleType.module,
        question_group: nextAvailableModuleType.question_group,
        type: nextAvailableModuleType.type,
        easy: 0, medium: 0, hard: 0
      }]
    }));
  };

  const updateTypeBlueprint = (index: number, field: keyof BlueprintItemByType, value: any) => {
    const newBlueprint = [...formData.blueprintByType];
    const convertedValue = (field === 'module' || field === 'question_group' || field === 'type') ? value : Number(value);
    newBlueprint[index] = { ...newBlueprint[index], [field]: convertedValue };
    setFormData(prev => ({ ...prev, blueprintByType: newBlueprint }));
  };

  /** Update module + question_group together, since the dropdown selects a single combo */
  const updateTypeBlueprintModuleGroup = (index: number, module: string, question_group: string) => {
    const newBlueprint = [...formData.blueprintByType];
    newBlueprint[index] = { ...newBlueprint[index], module, question_group };
    setFormData(prev => ({ ...prev, blueprintByType: newBlueprint }));
  };

  const removeTypeBlueprintRow = (index: number) => {
    setFormData(prev => ({
      ...prev,
      blueprintByType: prev.blueprintByType.filter((_, i) => i !== index)
    }));
  };

  /** Switch blueprint mode in Create form – resets rows */
  const switchBlueprintMode = (newMode: BlueprintMode) => {
    setBlueprintMode(newMode);
    setFormData(prev => ({ ...prev, blueprint: [], blueprintByType: [] }));
    setFeasibilityErrors([]);
  };

  // ─── Blueprint helpers (Edit form) ───────────────────────────────────────────

  const usedModuleTypeCombosEdit = ((editingBatch?.blueprintByType || []) as BlueprintItemByType[]).map(i => `${i.module}||${i.question_group}||${i.type}`);
  const getNextAvailableModuleTypeEdit = (): { module: string; question_group: string; type: QuestionType } | null => {
    for (const mg of moduleGroups) {
      for (const t of QUESTION_TYPES) {
        if (!usedModuleTypeCombosEdit.includes(`${mg.module}||${mg.question_group}||${t}`)) {
          return { module: mg.module, question_group: mg.question_group, type: t };
        }
      }
    }
    return null;
  };
  const nextAvailableModuleTypeEdit = getNextAvailableModuleTypeEdit();

  /** Switch blueprint mode in Edit form – resets rows */
  const switchEditBlueprintMode = (newMode: BlueprintMode) => {
    setEditBlueprintMode(newMode);
    setEditingBatch((prev: any) => ({ ...prev, blueprint: [], blueprintByType: [] }));
  };

  // ─── Handlers ───────────────────────────────────────────────────────────────

  const handleEditBatch = (batch: any) => {
    const rawBlueprint = typeof batch.blueprint === 'string' ? JSON.parse(batch.blueprint) : (batch.blueprint || []);
    // Detect blueprint mode from saved data
    let detectedMode: BlueprintMode = 'module';
    let moduleItems: BlueprintItem[] = [];
    let typeItems: BlueprintItemByType[] = [];

    // Older batches were saved before question_group existed — default it to '' so the
    // combo-based dropdowns below always have a valid value to select.
    const withGroup = <T extends { question_group?: string }>(items: T[]): T[] =>
      items.map(it => ({ ...it, question_group: it.question_group || '' }));

    if (Array.isArray(rawBlueprint)) {
      // Legacy format: plain array → by module
      detectedMode = 'module';
      moduleItems = withGroup(rawBlueprint);
    } else if (rawBlueprint && rawBlueprint.blueprintMode) {
      detectedMode = rawBlueprint.blueprintMode;
      if (detectedMode === 'type') {
        typeItems = withGroup(rawBlueprint.items || []);
      } else {
        moduleItems = withGroup(rawBlueprint.items || []);
      }
    }

    setEditBlueprintMode(detectedMode);
    setEditingBatch({
      ...batch,
      start_time: utcToLocalInput(batch.start_time),
      end_time: utcToLocalInput(batch.end_time),
      blueprint: moduleItems,
      blueprintByType: typeItems,
    });
  };

  const handleUpdateBatch = async () => {
    if (!editingBatch) return;

    // Validate against question bank availability based on edit mode
    let statsErrors: string[] = [];
    if (editBlueprintMode === 'type') {
      statsErrors = validateTypesBlueprintAgainstStats(editingBatch.blueprintByType || []);
    } else {
      statsErrors = validateBlueprintAgainstStats(editingBatch.blueprint || []);
    }
    if (statsErrors.length > 0) {
      alert('Không thể lưu vì blueprint vượt quá số câu hỏi có sẵn:\n\n' + statsErrors.join('\n'));
      return;
    }

    const blueprintPayload = buildBlueprintPayload(
      editBlueprintMode,
      editingBatch.blueprint || [],
      editingBatch.blueprintByType || []
    );

    setLoading(true);
    try {
      await adminApi.updateBatch(editingBatch.id, {
        name: editingBatch.name,
        start_time: localToUTC(editingBatch.start_time),
        end_time: localToUTC(editingBatch.end_time),
        duration: editingBatch.duration,
        blueprint: blueprintPayload
      });
      loadBatches();
      setEditingBatch(null);
    } catch (err: any) {
      alert(err.response?.data?.error || err.message);
    }
    setLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[BatchManagement] handleSubmit called, blueprintMode:', blueprintMode, 'formData:', formData);
    setLoading(true);
    setFeasibilityErrors([]);

    // Compute total based on active mode
    const activeItems = blueprintMode === 'type' ? formData.blueprintByType : formData.blueprint;
    const total = activeItems.reduce((sum, item) => sum + (item.easy || 0) + (item.medium || 0) + (item.hard || 0), 0);
    console.log('[BatchManagement] Total questions:', total);
    if (total < 1 || total > 20) {
      setFeasibilityErrors([`Total questions must be between 1 and 20. Current: ${total}`]);
      setLoading(false);
      return;
    }

    // Validate against question bank availability
    let statsErrors: string[] = [];
    if (blueprintMode === 'type') {
      statsErrors = validateTypesBlueprintAgainstStats(formData.blueprintByType);
    } else {
      statsErrors = validateBlueprintAgainstStats(formData.blueprint);
    }
    if (statsErrors.length > 0) {
      setFeasibilityErrors(statsErrors);
      setLoading(false);
      return;
    }

    const blueprintPayload = buildBlueprintPayload(blueprintMode, formData.blueprint, formData.blueprintByType);

    try {
      console.log('[BatchManagement] Submitting blueprintPayload:', JSON.stringify(blueprintPayload));
      const res = await adminApi.createBatch({
        name: formData.name,
        start_time: localToUTC(formData.start_time),
        end_time: localToUTC(formData.end_time),
        duration: formData.duration,
        blueprint: blueprintPayload,
      });
      console.log('[BatchManagement] Response:', res.data);
      const batchId = res.data.id;
      setShowForm(false);
      setFormData({ name: '', start_time: '', end_time: '', duration: 30, blueprint: [], blueprintByType: [] });
      setBlueprintMode('module');
      loadBatches();
      setSelectedBatchId(batchId);
      setShowInviteForm(true);
    } catch (error: any) {
      console.error('[BatchManagement] Error:', error, error.response);
      setFeasibilityErrors([error.response?.data?.error || error.message || 'Error creating batch']);
    }
    setLoading(false);
  };

  const handleInviteStudents = async () => {
    if (!selectedBatchId || !emails.trim()) return;

    setLoading(true);
    try {
      const emailList = emails.split('\n').map(e => e.trim()).filter(e => e && e.includes('@'));

      if (emailList.length === 0) {
        alert('Please enter valid email addresses');
        setLoading(false);
        return;
      }

      const res = await adminApi.importStudents(selectedBatchId, emailList);

      const skipped = res.data.skippedEmails;
      if (skipped && skipped.length > 0) {
        alert(`Đã skip ${skipped.length} email trùng:\n${skipped.join('\n')}`);
      }

      setInviteResult({
        success: res.data.count,
        emails: res.data.students
      });

      setEmails('');
    } catch (error: any) {
      alert(error.response?.data?.error || 'Error inviting students');
    }
    setLoading(false);
  };

  const exportStudents = async (batchId: number) => {
    try {
      const res = await adminApi.exportStudents(batchId);
      const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `students-${batchId}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
    }
  };

  // ─── Derived state ───────────────────────────────────────────────────────────

  const activeCreateItems = blueprintMode === 'type' ? formData.blueprintByType : formData.blueprint;
  const totalQuestions = activeCreateItems.reduce((sum, item) => sum + (item.easy || 0) + (item.medium || 0) + (item.hard || 0), 0);

  const createBlueprintErrors = blueprintMode === 'type'
    ? validateTypesBlueprintAgainstStats(formData.blueprintByType)
    : validateBlueprintAgainstStats(formData.blueprint);

  const editBlueprintErrors = editBlueprintMode === 'type'
    ? validateTypesBlueprintAgainstStats((editingBatch?.blueprintByType || []) as BlueprintItemByType[])
    : validateBlueprintAgainstStats(editingBatch?.blueprint || []);

  // ─── Sub-components ─────────────────────────────────────────────────────────

  /** Tab-style blueprint mode toggle */
  const BlueprintModeToggle = ({
    value,
    onChange,
  }: {
    value: BlueprintMode;
    onChange: (m: BlueprintMode) => void;
  }) => (
    <div style={{ display: 'flex', gap: 0, marginBottom: 16, border: '1.5px solid #6366f1', borderRadius: 8, overflow: 'hidden', width: 'fit-content' }}>
      {(['module', 'type'] as BlueprintMode[]).map(mode => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          style={{
            padding: '7px 22px',
            fontSize: 13,
            fontWeight: 600,
            border: 'none',
            cursor: 'pointer',
            background: value === mode ? '#6366f1' : '#f5f3ff',
            color: value === mode ? '#fff' : '#6366f1',
            transition: 'background 0.18s, color 0.18s',
          }}
        >
          {mode === 'module' ? '🗂 By Module' : '🏷 By Type'}
        </button>
      ))}
    </div>
  );

  /** <select> of (module, question_group) combos, labeled "module (group)" */
  const ModuleGroupSelect = ({
    value,
    onChange,
    style,
  }: {
    value: { module: string; question_group: string };
    onChange: (module: string, question_group: string) => void;
    style?: React.CSSProperties;
  }) => (
    <select
      style={{ width: '100%', padding: '8px', ...style }}
      value={comboKey(value.module, value.question_group)}
      onChange={e => {
        const decoded = decodeComboKey(e.target.value);
        onChange(decoded.module, decoded.question_group);
      }}
    >
      {moduleGroups.map(mg => (
        <option key={comboKey(mg.module, mg.question_group)} value={comboKey(mg.module, mg.question_group)}>
          {comboLabel(mg.module, mg.question_group)}
        </option>
      ))}
    </select>
  );

  /** Panel showing available question counts by module (+ question group) */
  const QuestionBankStatsPanel = () => {
    if (moduleGroupStats.length === 0) return null;
    return (
      <div style={{
        marginBottom: 20,
        padding: '14px 18px',
        background: 'linear-gradient(135deg, #eff6ff 0%, #f0fdf4 100%)',
        border: '1px solid #93c5fd',
        borderRadius: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 18 }}>📊</span>
          <strong style={{ color: '#1e40af', fontSize: 14 }}>Question Bank – By Module</strong>
          <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 4 }}>
            — Số câu hỏi có sẵn theo Module (và Question Group)
          </span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(59,130,246,0.1)' }}>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#1e3a5f' }}>Module</th>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#1e3a5f' }}>Question Group</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#15803d' }}>🟢 Easy</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#b45309' }}>🟡 Medium</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#b91c1c' }}>🔴 Hard</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#374151' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {moduleGroupStats.map((stat, i) => (
              <tr key={comboKey(stat.module, stat.question_group)} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.5)', borderTop: '1px solid #e5e7eb' }}>
                <td style={{ padding: '5px 10px', fontWeight: 500, color: '#1f2937' }}>{stat.module}</td>
                <td style={{ padding: '5px 10px', color: '#4b5563' }}>{stat.question_group || '-'}</td>
                <td style={{ padding: '5px 10px', textAlign: 'center', color: '#166534', fontWeight: 600 }}>{stat.easy}</td>
                <td style={{ padding: '5px 10px', textAlign: 'center', color: '#92400e', fontWeight: 600 }}>{stat.medium}</td>
                <td style={{ padding: '5px 10px', textAlign: 'center', color: '#991b1b', fontWeight: 600 }}>{stat.hard}</td>
                <td style={{ padding: '5px 10px', textAlign: 'center', color: '#374151', fontWeight: 700 }}>
                  {stat.easy + stat.medium + stat.hard}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  /** Panel showing available question counts by module × question group × type */
  const QuestionBankTypeStatsPanel = () => {
    if (moduleGroupTypeStats.length === 0) return null;
    const typeEmoji: Record<string, string> = { Coding: '💻', Conceptual: '🧠', 'Fill-in': '✏️', Debug: '🐛' };
    return (
      <div style={{
        marginBottom: 20,
        padding: '14px 18px',
        background: 'linear-gradient(135deg, #faf5ff 0%, #f0fdf4 100%)',
        border: '1px solid #c4b5fd',
        borderRadius: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 18 }}>🏷</span>
          <strong style={{ color: '#6d28d9', fontSize: 14 }}>Question Bank – By Module + Type</strong>
          <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 4 }}>
            — Số câu hỏi có sẵn theo từng Module (Question Group) × Type
          </span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(139,92,246,0.1)' }}>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#4c1d95' }}>Module</th>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#4c1d95' }}>Question Group</th>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#4c1d95' }}>Type</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#15803d' }}>🟢 Easy</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#b45309' }}>🟡 Medium</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#b91c1c' }}>🔴 Hard</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#374151' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {moduleGroups.map(mg => {
              const stats = moduleGroupTypeStats.filter(
                s => s.module === mg.module && (s.question_group || '') === (mg.question_group || '')
              );
              return stats.map((stat, i) => (
                <tr key={`${comboKey(mg.module, mg.question_group)}-${stat.type}`} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.5)', borderTop: '1px solid #e5e7eb' }}>
                  {i === 0 && (
                    <>
                      <td rowSpan={stats.length} style={{ padding: '5px 10px', fontWeight: 600, color: '#1f2937', verticalAlign: 'top', borderRight: '1px solid #e5e7eb' }}>
                        {mg.module}
                      </td>
                      <td rowSpan={stats.length} style={{ padding: '5px 10px', color: '#4b5563', verticalAlign: 'top', borderRight: '1px solid #e5e7eb' }}>
                        {mg.question_group || '-'}
                      </td>
                    </>
                  )}
                  <td style={{ padding: '5px 10px', color: '#374151' }}>{typeEmoji[stat.type] || '❓'} {stat.type}</td>
                  <td style={{ padding: '5px 10px', textAlign: 'center', color: '#166534', fontWeight: 600 }}>{stat.easy}</td>
                  <td style={{ padding: '5px 10px', textAlign: 'center', color: '#92400e', fontWeight: 600 }}>{stat.medium}</td>
                  <td style={{ padding: '5px 10px', textAlign: 'center', color: '#991b1b', fontWeight: 600 }}>{stat.hard}</td>
                  <td style={{ padding: '5px 10px', textAlign: 'center', color: '#374151', fontWeight: 700 }}>
                    {stat.easy + stat.medium + stat.hard}
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    );
  };

  /** A number input cell with inline validation warning */
  const ValidatedInput = ({
    value,
    max,
    onChange,
  }: {
    value: number;
    max: number;
    onChange: (v: string) => void;
  }) => {
    const exceeded = value > max;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <input
          type="number"
          min={0}
          max={max}
          value={value}
          onChange={e => onChange(e.target.value)}
          style={{
            width: 70,
            padding: '6px 8px',
            border: exceeded ? '2px solid #ef4444' : '1px solid #d1d5db',
            borderRadius: 6,
            background: exceeded ? '#fef2f2' : 'white',
            color: exceeded ? '#b91c1c' : '#111827',
            fontWeight: exceeded ? 700 : 400,
            textAlign: 'center',
            outline: 'none',
          }}
        />
        {exceeded && (
          <span style={{ fontSize: 10, color: '#ef4444', whiteSpace: 'nowrap' }}>
            ⚠️ Max: {max}
          </span>
        )}
      </div>
    );
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="container">
      <div className="header">
        <h1>Batch Management</h1>
        <Link to="/admin/dashboard" className="btn btn-secondary">Back to Dashboard</Link>
      </div>

      <div className="nav">
        <Link to="/admin/dashboard">Dashboard</Link>
        <Link to="/admin/questions">Question Bank</Link>
        <Link to="/admin/batches">Batches</Link>
        <Link to="/admin/settings">AI Settings</Link>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2>Batches</h2>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? 'Cancel' : 'Create New Batch'}
        </button>
      </div>

      {/* ── Create Batch Form ──────────────────────────────────────────── */}
      {showForm && (
        <div className="card">
          <h3>Create New Batch</h3>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
              <div className="form-group">
                <label>Batch Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  required
                />
              </div>
              <div className="form-group">
                <label>Duration (minutes)</label>
                <input
                  type="number"
                  value={formData.duration}
                  onChange={e => setFormData(prev => ({ ...prev, duration: parseInt(e.target.value) }))}
                  min={10}
                  required
                />
              </div>
              <div className="form-group">
                <label>Start Time</label>
                <input
                  type="datetime-local"
                  value={formData.start_time}
                  onChange={e => setFormData(prev => ({ ...prev, start_time: e.target.value }))}
                  required
                />
              </div>
              <div className="form-group">
                <label>End Time</label>
                <input
                  type="datetime-local"
                  value={formData.end_time}
                  onChange={e => setFormData(prev => ({ ...prev, end_time: e.target.value }))}
                  required
                />
              </div>
            </div>

            <h4 style={{ marginTop: 20, marginBottom: 10 }}>Exam Blueprint (Total: {totalQuestions}/20)</h4>

            {/* Blueprint Mode Toggle */}
            <BlueprintModeToggle value={blueprintMode} onChange={switchBlueprintMode} />

            {moduleGroups.length === 0 && blueprintMode === 'module' ? (
              <p className="error">Please import questions first to configure the blueprint.</p>
            ) : typeStats.length === 0 && blueprintMode === 'type' ? (
              <p className="error">Please import questions first to configure the blueprint.</p>
            ) : blueprintMode === 'module' ? (
              <>
                {/* Stats panel – By Module */}
                <QuestionBankStatsPanel />

                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th>Module</th>
                      <th>🟢 Easy</th>
                      <th>🟡 Medium</th>
                      <th>🔴 Hard</th>
                      <th>Total</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {formData.blueprint.map((item, index) => {
                      const stats = getStatsForModuleGroup(item.module, item.question_group);
                      return (
                        <tr key={index}>
                          <td>
                            <ModuleGroupSelect
                              value={item}
                              onChange={(module, question_group) => updateBlueprintModuleGroup(index, module, question_group)}
                            />
                            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, paddingLeft: 2 }}>
                              Có sẵn: {stats.easy}E / {stats.medium}M / {stats.hard}H
                            </div>
                          </td>
                          <td>
                            <ValidatedInput value={item.easy} max={stats.easy} onChange={v => updateBlueprint(index, 'easy', v)} />
                          </td>
                          <td>
                            <ValidatedInput value={item.medium} max={stats.medium} onChange={v => updateBlueprint(index, 'medium', v)} />
                          </td>
                          <td>
                            <ValidatedInput value={item.hard} max={stats.hard} onChange={v => updateBlueprint(index, 'hard', v)} />
                          </td>
                          <td style={{ textAlign: 'center', fontWeight: 600 }}>
                            {Number(item.easy) + Number(item.medium) + Number(item.hard)}
                          </td>
                          <td>
                            <button type="button" onClick={() => removeBlueprintRow(index)} className="btn btn-danger" style={{ padding: '5px 10px', fontSize: 12 }}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <button type="button" onClick={addBlueprintRow} className="btn btn-secondary" style={{ marginTop: 10 }}>
                  + Add Module
                </button>
              </>
            ) : (
              <>
                {/* Stats panel – By Module + Type */}
                <QuestionBankTypeStatsPanel />

                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th>Module</th>
                      <th>Type</th>
                      <th>🟢 Easy</th>
                      <th>🟡 Medium</th>
                      <th>🔴 Hard</th>
                      <th>Total</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {formData.blueprintByType.map((item, index) => {
                      const stats = getStatsForModuleGroupType(item.module, item.question_group, item.type);
                      // Combos used by OTHER rows
                      const otherCombos = formData.blueprintByType
                        .filter((_, i) => i !== index)
                        .map(i => `${i.module}||${i.question_group}||${i.type}`);
                      return (
                        <tr key={index}>
                          <td style={{ minWidth: 160 }}>
                            <ModuleGroupSelect
                              value={item}
                              onChange={(module, question_group) => updateTypeBlueprintModuleGroup(index, module, question_group)}
                            />
                          </td>
                          <td style={{ minWidth: 120 }}>
                            <select
                              style={{ width: '100%', padding: '8px' }}
                              value={item.type}
                              onChange={e => updateTypeBlueprint(index, 'type', e.target.value as QuestionType)}
                            >
                              {QUESTION_TYPES.map(t => {
                                const combo = `${item.module}||${item.question_group}||${t}`;
                                const isUsed = otherCombos.includes(combo);
                                return (
                                  <option key={t} value={t} disabled={isUsed}>
                                    {t}{isUsed ? ' (đã chọn)' : ''}
                                  </option>
                                );
                              })}
                            </select>
                            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, paddingLeft: 2 }}>
                              Có sẵn: {stats.easy}E / {stats.medium}M / {stats.hard}H
                            </div>
                          </td>
                          <td>
                            <ValidatedInput value={item.easy} max={stats.easy} onChange={v => updateTypeBlueprint(index, 'easy', v)} />
                          </td>
                          <td>
                            <ValidatedInput value={item.medium} max={stats.medium} onChange={v => updateTypeBlueprint(index, 'medium', v)} />
                          </td>
                          <td>
                            <ValidatedInput value={item.hard} max={stats.hard} onChange={v => updateTypeBlueprint(index, 'hard', v)} />
                          </td>
                          <td style={{ textAlign: 'center', fontWeight: 600 }}>
                            {Number(item.easy) + Number(item.medium) + Number(item.hard)}
                          </td>
                          <td>
                            <button type="button" onClick={() => removeTypeBlueprintRow(index)} className="btn btn-danger" style={{ padding: '5px 10px', fontSize: 12 }}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <button
                  type="button"
                  onClick={addTypeBlueprintRow}
                  disabled={!nextAvailableModuleType}
                  className="btn btn-secondary"
                  style={{ marginTop: 10 }}
                  title={!nextAvailableModuleType ? 'Tất cả combinations đã được thêm' : ''}
                >
                  + Add Module / Type
                </button>
              </>
            )}

            {/* Validation errors */}
            {(feasibilityErrors.length > 0 || createBlueprintErrors.length > 0) && (
              <div style={{ marginTop: 15, padding: '12px 16px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8 }}>
                <strong style={{ color: '#991b1b', fontSize: 13 }}>⚠️ Lỗi Blueprint:</strong>
                {[...feasibilityErrors, ...createBlueprintErrors.filter(e => !feasibilityErrors.includes(e))].map((err, i) => (
                  <p key={i} style={{ color: '#b91c1c', margin: '4px 0 0', fontSize: 13 }}>{err}</p>
                ))}
              </div>
            )}

            <button
              type="submit"
              disabled={
                loading ||
                totalQuestions < 1 ||
                totalQuestions > 20 ||
                (blueprintMode === 'module' && moduleGroups.length === 0) ||
                (blueprintMode === 'type' && moduleGroupTypeStats.length === 0) ||
                createBlueprintErrors.length > 0
              }
              className="btn btn-primary"
              style={{ marginTop: 20 }}
            >
              {loading ? 'Creating...' : 'Create Batch'}
            </button>
          </form>
        </div>
      )}

      {/* ── Invite Students Form ───────────────────────────────────────── */}
      {showInviteForm && selectedBatchId && (
        <div className="card" style={{ borderColor: '#22c55e', background: '#f0fdf4' }}>
          <h3 style={{ color: '#166534' }}>Invite Students to Batch #{selectedBatchId}</h3>
          <p style={{ color: '#166534', fontSize: 14 }}>Enter email addresses (one per line)</p>
          <textarea
            value={emails}
            onChange={e => setEmails(e.target.value)}
            placeholder={`student1@example.com\nstudent2@example.com\nstudent3@example.com`}
            rows={6}
            style={{ width: '100%', padding: 10, marginTop: 10, fontFamily: 'monospace' }}
          />
          <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
            <button
              onClick={handleInviteStudents}
              disabled={loading || !emails.trim()}
              className="btn btn-primary"
            >
              {loading ? 'Inviting...' : 'Invite Students'}
            </button>
            <button
              onClick={() => { setShowInviteForm(false); setInviteResult(null); }}
              className="btn btn-secondary"
            >
              Close
            </button>
          </div>

          {inviteResult && (
            <div style={{ marginTop: 20 }}>
              <h4 style={{ color: '#166534' }}>Invited {inviteResult.success} students:</h4>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
                <thead>
                  <tr style={{ background: '#e5e7eb' }}>
                    <th style={{ padding: 8, textAlign: 'left' }}>Email</th>
                    <th style={{ padding: 8, textAlign: 'left' }}>Access Code</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteResult.emails.map((s, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #e5e7eb' }}>
                      <td style={{ padding: 8 }}>{s.email}</td>
                      <td style={{ padding: 8, fontFamily: 'monospace', fontWeight: 'bold' }}>{s.code}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                onClick={() => exportStudents(selectedBatchId)}
                className="btn btn-secondary"
                style={{ marginTop: 10 }}
              >
                Export to Excel
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Batches Table ──────────────────────────────────────────────── */}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Start Time</th>
              <th>End Time</th>
              <th>Duration</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {batches.map(batch => (
              <tr key={batch.id}>
                <td>{batch.id}</td>
                <td>{batch.name}</td>
                <td>{formatGMT7(batch.start_time)}</td>
                <td>{formatGMT7(batch.end_time)}</td>
                <td>{batch.duration} min</td>
                <td>
                  <button
                    onClick={() => { setSelectedBatchId(batch.id); setShowInviteForm(true); setInviteResult(null); }}
                    className="btn btn-primary"
                    style={{ marginRight: 5, fontSize: 12 }}
                  >
                    Invite
                  </button>
                  <Link to={`/admin/batches/${batch.id}/students`} className="btn btn-secondary" style={{ marginRight: 5, fontSize: 12 }}>
                    Students
                  </Link>
                  <Link to={`/admin/batches/${batch.id}/results`} className="btn btn-secondary" style={{ marginRight: 5, fontSize: 12 }}>
                    Results
                  </Link>
                  <button
                    onClick={() => handleEditBatch(batch)}
                    className="btn btn-secondary"
                    style={{ marginRight: 5, fontSize: 12 }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm('Delete this batch? All students and exam data will be lost.')) {
                        adminApi.deleteBatch(batch.id).then(() => {
                          setBatches(batches.filter(b => b.id !== batch.id));
                        });
                      }
                    }}
                    className="btn btn-danger"
                    style={{ fontSize: 12 }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {batches.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-light)' }}>No batches yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Edit Batch Form ────────────────────────────────────────────── */}
      {editingBatch && (
        <div className="card" style={{ marginTop: 20, borderColor: '#3b82f6', background: '#eff6ff' }}>
          <h3 style={{ color: '#1d4ed8' }}>Edit Batch #{editingBatch.id}</h3>

          <div className="form-group">
            <label>Batch Name</label>
            <input
              type="text"
              value={editingBatch.name}
              onChange={e => setEditingBatch({...editingBatch, name: e.target.value})}
              required
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group">
              <label>Start Time</label>
              <input
                type="datetime-local"
                value={editingBatch.start_time || ''}
                onChange={e => setEditingBatch({...editingBatch, start_time: e.target.value})}
                required
              />
            </div>
            <div className="form-group">
              <label>End Time</label>
              <input
                type="datetime-local"
                value={editingBatch.end_time || ''}
                onChange={e => setEditingBatch({...editingBatch, end_time: e.target.value})}
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label>Duration (minutes)</label>
            <input
              type="number"
              value={editingBatch.duration}
              onChange={e => setEditingBatch({...editingBatch, duration: parseInt(e.target.value)})}
              min={1}
              required
            />
          </div>

          <h4 style={{ marginTop: 16, marginBottom: 10, color: '#1e40af' }}>Exam Blueprint</h4>

          {/* Blueprint Mode Toggle for Edit form */}
          <BlueprintModeToggle value={editBlueprintMode} onChange={switchEditBlueprintMode} />

          {editBlueprintMode === 'module' ? (
            moduleGroups.length === 0 ? (
              <p className="error">No modules available</p>
            ) : (
              <>
                <QuestionBankStatsPanel />
                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th>Module</th>
                      <th>🟢 Easy</th>
                      <th>🟡 Medium</th>
                      <th>🔴 Hard</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(editingBatch.blueprint || []).map((item: BlueprintItem, index: number) => {
                      const stats = getStatsForModuleGroup(item.module, item.question_group || '');
                      return (
                        <tr key={index}>
                          <td>
                            <ModuleGroupSelect
                              value={{ module: item.module, question_group: item.question_group || '' }}
                              onChange={(module, question_group) => {
                                const newBlueprint = [...editingBatch.blueprint];
                                newBlueprint[index] = { ...newBlueprint[index], module, question_group };
                                setEditingBatch({ ...editingBatch, blueprint: newBlueprint });
                              }}
                            />
                            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, paddingLeft: 2 }}>
                              Có sẵn: {stats.easy}E / {stats.medium}M / {stats.hard}H
                            </div>
                          </td>
                          <td>
                            <ValidatedInput value={item.easy || 0} max={stats.easy} onChange={v => {
                              const nb = [...editingBatch.blueprint]; nb[index].easy = parseInt(v) || 0;
                              setEditingBatch({ ...editingBatch, blueprint: nb });
                            }} />
                          </td>
                          <td>
                            <ValidatedInput value={item.medium || 0} max={stats.medium} onChange={v => {
                              const nb = [...editingBatch.blueprint]; nb[index].medium = parseInt(v) || 0;
                              setEditingBatch({ ...editingBatch, blueprint: nb });
                            }} />
                          </td>
                          <td>
                            <ValidatedInput value={item.hard || 0} max={stats.hard} onChange={v => {
                              const nb = [...editingBatch.blueprint]; nb[index].hard = parseInt(v) || 0;
                              setEditingBatch({ ...editingBatch, blueprint: nb });
                            }} />
                          </td>
                          <td>
                            <button
                              onClick={() => setEditingBatch({
                                ...editingBatch,
                                blueprint: editingBatch.blueprint.filter((_: any, i: number) => i !== index)
                              })}
                              className="btn btn-danger"
                              style={{ fontSize: 12, padding: '4px 8px' }}
                            >X</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )
          ) : (
            moduleGroupTypeStats.length === 0 ? (
              <p className="error">No type data available</p>
            ) : (
              <>
                <QuestionBankTypeStatsPanel />
                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th>Module</th>
                      <th>Type</th>
                      <th>🟢 Easy</th>
                      <th>🟡 Medium</th>
                      <th>🔴 Hard</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {((editingBatch.blueprintByType || []) as BlueprintItemByType[]).map((item, index) => {
                      const stats = getStatsForModuleGroupType(item.module, item.question_group || '', item.type);
                      const otherCombos = ((editingBatch.blueprintByType || []) as BlueprintItemByType[])
                        .filter((_, i) => i !== index)
                        .map(i => `${i.module}||${i.question_group}||${i.type}`);
                      return (
                        <tr key={index}>
                          <td style={{ minWidth: 160 }}>
                            <ModuleGroupSelect
                              value={{ module: item.module, question_group: item.question_group || '' }}
                              onChange={(module, question_group) => {
                                const nb = [...editingBatch.blueprintByType];
                                nb[index] = { ...nb[index], module, question_group };
                                setEditingBatch({ ...editingBatch, blueprintByType: nb });
                              }}
                            />
                          </td>
                          <td style={{ minWidth: 120 }}>
                            <select
                              value={item.type}
                              onChange={e => {
                                const nb = [...editingBatch.blueprintByType];
                                nb[index].type = e.target.value;
                                setEditingBatch({ ...editingBatch, blueprintByType: nb });
                              }}
                              style={{ width: '100%' }}
                            >
                              {QUESTION_TYPES.map(t => {
                                const combo = `${item.module}||${item.question_group}||${t}`;
                                const isUsed = otherCombos.includes(combo);
                                return (
                                  <option key={t} value={t} disabled={isUsed}>
                                    {t}{isUsed ? ' (đã chọn)' : ''}
                                  </option>
                                );
                              })}
                            </select>
                            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, paddingLeft: 2 }}>
                              Có sẵn: {stats.easy}E / {stats.medium}M / {stats.hard}H
                            </div>
                          </td>
                          <td>
                            <ValidatedInput value={item.easy || 0} max={stats.easy} onChange={v => {
                              const nb = [...editingBatch.blueprintByType]; nb[index].easy = parseInt(v) || 0;
                              setEditingBatch({ ...editingBatch, blueprintByType: nb });
                            }} />
                          </td>
                          <td>
                            <ValidatedInput value={item.medium || 0} max={stats.medium} onChange={v => {
                              const nb = [...editingBatch.blueprintByType]; nb[index].medium = parseInt(v) || 0;
                              setEditingBatch({ ...editingBatch, blueprintByType: nb });
                            }} />
                          </td>
                          <td>
                            <ValidatedInput value={item.hard || 0} max={stats.hard} onChange={v => {
                              const nb = [...editingBatch.blueprintByType]; nb[index].hard = parseInt(v) || 0;
                              setEditingBatch({ ...editingBatch, blueprintByType: nb });
                            }} />
                          </td>
                          <td>
                            <button
                              onClick={() => setEditingBatch({
                                ...editingBatch,
                                blueprintByType: (editingBatch.blueprintByType || []).filter((_: any, i: number) => i !== index)
                              })}
                              className="btn btn-danger"
                              style={{ fontSize: 12, padding: '4px 8px' }}
                            >X</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )
          )}

          {/* Edit blueprint validation errors */}
          {editBlueprintErrors.length > 0 && (
            <div style={{ marginTop: 12, padding: '12px 16px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8 }}>
              <strong style={{ color: '#991b1b', fontSize: 13 }}>⚠️ Blueprint vượt quá số câu hỏi có sẵn:</strong>
              {editBlueprintErrors.map((err, i) => (
                <p key={i} style={{ color: '#b91c1c', margin: '4px 0 0', fontSize: 13 }}>{err}</p>
              ))}
            </div>
          )}

          <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {editBlueprintMode === 'module' ? (
              <button
                onClick={() => setEditingBatch({
                  ...editingBatch,
                  blueprint: [...(editingBatch.blueprint || []), {
                    module: moduleGroups[0]?.module || '',
                    question_group: moduleGroups[0]?.question_group || '',
                    easy: 0, medium: 0, hard: 0
                  }]
                })}
                className="btn btn-secondary"
              >
                + Add Module
              </button>
            ) : (
              <button
                onClick={() => {
                  if (!nextAvailableModuleTypeEdit) return;
                  setEditingBatch({
                    ...editingBatch,
                    blueprintByType: [
                      ...(editingBatch.blueprintByType || []),
                      {
                        module: nextAvailableModuleTypeEdit.module,
                        question_group: nextAvailableModuleTypeEdit.question_group,
                        type: nextAvailableModuleTypeEdit.type,
                        easy: 0, medium: 0, hard: 0
                      }
                    ]
                  });
                }}
                disabled={!nextAvailableModuleTypeEdit}
                className="btn btn-secondary"
                title={!nextAvailableModuleTypeEdit ? 'Tất cả combinations đã được thêm' : ''}
              >
                + Add Module / Type
              </button>
            )}

            <button
              onClick={handleUpdateBatch}
              disabled={loading || editBlueprintErrors.length > 0}
              className="btn btn-primary"
            >
              {loading ? 'Saving...' : 'Save Changes'}
            </button>

            <button
              onClick={() => setEditingBatch(null)}
              className="btn btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default BatchManagement;
