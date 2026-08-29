import { Fragment, useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import AdminNav from '../components/AdminNav';
import PageSizeSelect, { type PageSize } from '../components/PageSizeSelect';
import { getQuestionCatalogSummaryCached } from '../services/adminCatalogCache';
import {
  ArrowLeft,
  BarChart3,
  ChevronDown,
  Copy,
  FolderKanban,
  ListChecks,
  MonitorPlay,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';

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

interface BlueprintItem {
  module: string;
  easy: number;
  medium: number;
  hard: number;
}

interface BlueprintItemByType {
  module: string;
  type: QuestionType;
  easy: number;
  medium: number;
  hard: number;
}

interface ModuleStats {
  module: string;
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

interface ModuleTypeStats {
  module: string;
  type: string;
  easy: number;
  medium: number;
  hard: number;
}

interface NormalizedBatchBlueprint {
  mode: BlueprintMode;
  moduleItems: BlueprintItem[];
  typeItems: BlueprintItemByType[];
}

/** Normalize both legacy arrays and the current { blueprintMode, items } format. */
const normalizeBatchBlueprint = (blueprint: unknown): NormalizedBatchBlueprint => {
  const rawBlueprint = typeof blueprint === 'string'
    ? JSON.parse(blueprint)
    : (blueprint || []);

  if (Array.isArray(rawBlueprint)) {
    return {
      mode: 'module',
      moduleItems: rawBlueprint.map(item => ({ ...item })) as BlueprintItem[],
      typeItems: [],
    };
  }

  if (rawBlueprint && typeof rawBlueprint === 'object') {
    const blueprintObject = rawBlueprint as { blueprintMode?: unknown; items?: unknown };
    const mode: BlueprintMode = blueprintObject.blueprintMode === 'type' ? 'type' : 'module';
    const items = Array.isArray(blueprintObject.items) ? blueprintObject.items : [];

    return mode === 'type'
      ? {
          mode,
          moduleItems: [],
          typeItems: items.map(item => ({ ...item })) as BlueprintItemByType[],
        }
      : {
          mode,
          moduleItems: items.map(item => ({ ...item })) as BlueprintItem[],
          typeItems: [],
        };
  }

  return { mode: 'module', moduleItems: [], typeItems: [] };
};

function BatchManagement() {
  const { isAdmin, userId } = useAuth();
  const createFormRef = useRef<HTMLDivElement>(null);
  const catalogRequestRef = useRef<Promise<void> | null>(null);
  const [batches, setBatches] = useState<any[]>([]);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchTotalPages, setBatchTotalPages] = useState(1);
  const [modules, setModules] = useState<string[]>([]);
  const [moduleStats, setModuleStats] = useState<ModuleStats[]>([]);
  const [typeStats, setTypeStats] = useState<TypeStats[]>([]);
  const [moduleTypeStats, setModuleTypeStats] = useState<ModuleTypeStats[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  // Pagination
  const [batchPageSize, setBatchPageSize] = useState<PageSize>(10);
  const [batchCurrentPage, setBatchCurrentPage] = useState(1);
  // Create form state
  const [blueprintMode, setBlueprintMode] = useState<BlueprintMode>('module');
  const [showForm, setShowForm] = useState(false);
  const [isCreateBlueprintExpanded, setIsCreateBlueprintExpanded] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    start_time: '',
    end_time: '',
    duration: 30,
    blueprint: [] as BlueprintItem[],
    blueprintByType: [] as BlueprintItemByType[],
    record_mode: 'none' as 'none' | 'local' | 's3',
    exam_type: 'essay' as 'essay' | 'quiz',
  });
  // Edit form state
  const [editBlueprintMode, setEditBlueprintMode] = useState<BlueprintMode>('module');
  const [isEditBlueprintExpanded, setIsEditBlueprintExpanded] = useState(false);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [editingBatch, setEditingBatch] = useState<any>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [emails, setEmails] = useState('');
  const [inviteResult, setInviteResult] = useState<{ success: number; emails: { email: string; code: string }[] } | null>(null);
  const [feasibilityErrors, setFeasibilityErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [aiSettingsVerified, setAiSettingsVerified] = useState(false);
  const [gradingBatchId, setGradingBatchId] = useState<number | null>(null);

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Return stats for a given module name (zeros if not found) */
  const getStatsForModule = (moduleName: string): ModuleStats =>
    moduleStats.find(s => s.module === moduleName) ?? { module: moduleName, easy: 0, medium: 0, hard: 0 };

  /** Return stats for a given (module, type) combination (zeros if not found) */
  const getStatsForModuleType = (moduleName: string, typeName: string): ModuleTypeStats =>
    moduleTypeStats.find(s => s.module === moduleName && s.type === typeName)
    ?? { module: moduleName, type: typeName, easy: 0, medium: 0, hard: 0 };

  /** Validate blueprint (by module) against available question counts */
  const validateBlueprintAgainstStats = (blueprint: BlueprintItem[]): string[] => {
    const errors: string[] = [];
    for (const item of blueprint) {
      const stats = getStatsForModule(item.module);
      if (item.easy > stats.easy)
        errors.push(`Module "${item.module}": Easy requires ${item.easy}, only ${stats.easy} available.`);
      if (item.medium > stats.medium)
        errors.push(`Module "${item.module}": Medium requires ${item.medium}, only ${stats.medium} available.`);
      if (item.hard > stats.hard)
        errors.push(`Module "${item.module}": Hard requires ${item.hard}, only ${stats.hard} available.`);
    }
    return errors;
  };

  /** Validate blueprint (by module+type) against available question counts */
  const validateTypesBlueprintAgainstStats = (blueprint: BlueprintItemByType[]): string[] => {
    const errors: string[] = [];
    for (const item of blueprint) {
      const stats = getStatsForModuleType(item.module, item.type);
      if (item.easy > stats.easy)
        errors.push(`Module "${item.module}" / Type "${item.type}": Easy requires ${item.easy}, only ${stats.easy} available.`);
      if (item.medium > stats.medium)
        errors.push(`Module "${item.module}" / Type "${item.type}": Medium requires ${item.medium}, only ${stats.medium} available.`);
      if (item.hard > stats.hard)
        errors.push(`Module "${item.module}" / Type "${item.type}": Hard requires ${item.hard}, only ${stats.hard} available.`);
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
  }, [batchCurrentPage, batchPageSize]);

  useEffect(() => {
    if (modules.length > 0 && formData.blueprint.length === 0) {
      setFormData(prev => ({
        ...prev,
        blueprint: [{ module: modules[0], easy: 0, medium: 0, hard: 0 }]
      }));
    }
  }, [modules]);

  // ─── Loaders ────────────────────────────────────────────────────────────────

  const loadBatches = async () => {
    try {
      const res = await adminApi.getPagedBatches({
        page: batchCurrentPage,
        pageSize: batchPageSize,
        includeBlueprint: true,
      });
      setBatches(res.data.items);
      setBatchTotal(Number(res.data.total) || 0);
      setBatchTotalPages(Number(res.data.totalPages) || 1);
      setAiSettingsVerified(Boolean(res.data.aiSettingsVerified));
      if (res.data.page !== batchCurrentPage) setBatchCurrentPage(res.data.page);
    } catch (error) {
      console.error(error);
    }
  };

  const loadCatalogSummary = async () => {
    setCatalogLoading(true);
    try {
      const data = await getQuestionCatalogSummaryCached();
      setModules(data.modules);
      setModuleStats(data.moduleStats);
      setTypeStats(data.typeStats);
      setModuleTypeStats(data.moduleTypeStats);
      setCatalogLoaded(true);
    } catch (error) {
      console.error('[BatchManagement] loadCatalogSummary error:', error);
    } finally {
      setCatalogLoading(false);
    }
  };

  const ensureCatalogSummary = () => {
    if (catalogLoaded) return Promise.resolve();
    if (!catalogRequestRef.current) {
      catalogRequestRef.current = loadCatalogSummary().finally(() => {
        catalogRequestRef.current = null;
      });
    }
    return catalogRequestRef.current;
  };

  // ─── Blueprint helpers (Create form) ────────────────────────────────────────

  const addBlueprintRow = () => {
    console.log('[BatchManagement] addBlueprintRow, modules:', modules);
    setFormData(prev => ({
      ...prev,
      blueprint: [...prev.blueprint, { module: modules[0] || '', easy: 0, medium: 0, hard: 0 }]
    }));
  };

  const updateBlueprint = (index: number, field: keyof BlueprintItem, value: any) => {
    const newBlueprint = [...formData.blueprint];
    const convertedValue = field === 'module' ? value : Number(value);
    newBlueprint[index] = { ...newBlueprint[index], [field]: convertedValue };
    setFormData(prev => ({ ...prev, blueprint: newBlueprint }));
  };

  const removeBlueprintRow = (index: number) => {
    setFormData(prev => ({
      ...prev,
      blueprint: prev.blueprint.filter((_, i) => i !== index)
    }));
  };

  // ─── Blueprint helpers (By Type – Create form) ───────────────────────────────

  /** (module, type) combos already used in By Type blueprint */
  const usedModuleTypeCombos = formData.blueprintByType.map(i => `${i.module}||${i.type}`);

  /** Find first available (module, type) combo not yet used */
  const getNextAvailableModuleType = (): { module: string; type: QuestionType } | null => {
    for (const m of modules) {
      for (const t of QUESTION_TYPES) {
        if (!usedModuleTypeCombos.includes(`${m}||${t}`)) {
          return { module: m, type: t };
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
      blueprintByType: [...prev.blueprintByType, { module: nextAvailableModuleType.module, type: nextAvailableModuleType.type, easy: 0, medium: 0, hard: 0 }]
    }));
  };

  const updateTypeBlueprint = (index: number, field: keyof BlueprintItemByType, value: any) => {
    const newBlueprint = [...formData.blueprintByType];
    const convertedValue = (field === 'module' || field === 'type') ? value : Number(value);
    newBlueprint[index] = { ...newBlueprint[index], [field]: convertedValue };
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

  const usedModuleTypeCombosEdit = ((editingBatch?.blueprintByType || []) as BlueprintItemByType[]).map(i => `${i.module}||${i.type}`);
  const getNextAvailableModuleTypeEdit = (): { module: string; type: QuestionType } | null => {
    for (const m of modules) {
      for (const t of QUESTION_TYPES) {
        if (!usedModuleTypeCombosEdit.includes(`${m}||${t}`)) {
          return { module: m, type: t };
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

  const handleEditBatch = async (batch: any) => {
    await ensureCatalogSummary();
    const { mode, moduleItems, typeItems } = normalizeBatchBlueprint(batch.blueprint);

    setEditBlueprintMode(mode);
    setIsEditBlueprintExpanded(false);
    setEditingBatch({
      ...batch,
      start_time: utcToLocalInput(batch.start_time),
      end_time: utcToLocalInput(batch.end_time),
      blueprint: moduleItems,
      blueprintByType: typeItems,
    });
  };

  const handleCloneBatch = async (batch: any) => {
    await ensureCatalogSummary();
    const { mode, moduleItems, typeItems } = normalizeBatchBlueprint(batch.blueprint);
    const sourceRecordMode = batch.record_mode;
    const recordMode = isAdmin && ['none', 'local', 's3'].includes(sourceRecordMode)
      ? sourceRecordMode as 'none' | 'local' | 's3'
      : 'none';

    setBlueprintMode(mode);
    setFormData({
      name: `${batch.name} CLONE`,
      start_time: utcToLocalInput(batch.start_time),
      end_time: utcToLocalInput(batch.end_time),
      duration: Number(batch.duration),
      blueprint: moduleItems,
      blueprintByType: typeItems,
      record_mode: recordMode,
      exam_type: batch.exam_type === 'quiz' ? 'quiz' : 'essay',
    });
    setFeasibilityErrors([]);
    setIsCreateBlueprintExpanded(false);
    setEditingBatch(null);
    setIsEditBlueprintExpanded(false);
    setShowInviteForm(false);
    setSelectedBatchId(null);
    setEmails('');
    setInviteResult(null);
    setShowForm(true);

    window.requestAnimationFrame(() => {
      createFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      alert('Cannot save because the blueprint exceeds the available question count:\n\n' + statsErrors.join('\n'));
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
        blueprint: blueprintPayload,
        record_mode: editingBatch.record_mode || 'none',
        exam_type: editingBatch.exam_type === 'quiz' ? 'quiz' : 'essay',
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
    if (total < 1 || total > 100) {
      setFeasibilityErrors([`Total questions must be between 1 and 100. Current: ${total}`]);
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
        record_mode: formData.record_mode,
        exam_type: formData.exam_type,
      });
      console.log('[BatchManagement] Response:', res.data);
      const batchId = res.data.id;
      setShowForm(false);
      setFormData({ name: '', start_time: '', end_time: '', duration: 30, blueprint: [], blueprintByType: [], record_mode: 'none', exam_type: 'essay' });
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
        alert(`Skipped ${skipped.length} duplicate email(s):\n${skipped.join('\n')}`);
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

  const handleAiGrade = async (batch: any) => {
    if (batch.exam_type !== 'essay' || Number(batch.created_by) !== userId || !aiSettingsVerified) return;
    if (!confirm(`Run AI Grade for all submitted students in "${batch.name}"? This may take several minutes.`)) return;
    setGradingBatchId(Number(batch.id));
    try {
      const response = await adminApi.gradeBatchWithAI(Number(batch.id));
      const result = response.data;
      const failureDetails = Array.isArray(result.failures)
        ? result.failures.map((failure: any) => `Student #${failure.studentId}: ${failure.error}`).join('\n')
        : '';
      alert(`AI Grade finished. Completed: ${result.completed}, Failed: ${result.failed}, Remaining: ${result.remaining}.${failureDetails ? `\n\n${failureDetails}` : ''}`);
      await loadBatches();
    } catch (error: any) {
      alert(error.response?.data?.error || error.message || 'AI grading failed');
      await loadBatches();
    } finally {
      setGradingBatchId(null);
    }
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

  const activeEditItems = editBlueprintMode === 'type'
    ? ((editingBatch?.blueprintByType || []) as BlueprintItemByType[])
    : ((editingBatch?.blueprint || []) as BlueprintItem[]);
  const editTotalQuestions = activeEditItems.reduce(
    (sum, item) => sum + (item.easy || 0) + (item.medium || 0) + (item.hard || 0),
    0
  );

  const createBlueprintErrors = blueprintMode === 'type'
    ? validateTypesBlueprintAgainstStats(formData.blueprintByType)
    : validateBlueprintAgainstStats(formData.blueprint);

  const editBlueprintErrors = editBlueprintMode === 'type'
    ? validateTypesBlueprintAgainstStats((editingBatch?.blueprintByType || []) as BlueprintItemByType[])
    : validateBlueprintAgainstStats(editingBatch?.blueprint || []);

  // ─── Batch pagination derived state ──────────────────────────────────────────

  const handleBatchPageSizeChange = (size: PageSize) => {
    setBatchPageSize(size);
    setBatchCurrentPage(1);
    setEditingBatch(null);
  };

  const handleBatchPageChange = (page: number) => {
    setBatchCurrentPage(page);
    setEditingBatch(null);
  };

  const getBatchPageNumbers = () => {
    const delta = 2;
    const range: (number | '...')[] = [];
    const left = Math.max(2, batchCurrentPage - delta);
    const right = Math.min(batchTotalPages - 1, batchCurrentPage + delta);
    range.push(1);
    if (left > 2) range.push('...');
    for (let i = left; i <= right; i++) range.push(i);
    if (right < batchTotalPages - 1) range.push('...');
    if (batchTotalPages > 1) range.push(batchTotalPages);
    return range;
  };

  /** Mod chỉ được CRUD batch của mình; admin được tất cả */
  const canEditBatch = (batch: any) => isAdmin || batch.created_by === userId;

  /** Live is available through the entire end-date, regardless of end time. */
  const canViewLiveBatch = (batch: any) => {
    if (userId === null || batch.created_by === null || batch.created_by === undefined || Number(batch.created_by) !== userId || !batch.end_time) return false;
    const endDate = new Date(batch.end_time);
    if (Number.isNaN(endDate.getTime())) return false;
    endDate.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return endDate >= today;
  };

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

  /** Panel showing available question counts by module */
  const QuestionBankStatsPanel = () => {
    if (moduleStats.length === 0) return null;
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
            — Available question counts by Module
          </span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(59,130,246,0.1)' }}>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#1e3a5f' }}>Module</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#15803d' }}>🟢 Easy</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#b45309' }}>🟡 Medium</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#b91c1c' }}>🔴 Hard</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#374151' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {moduleStats.map((stat, i) => (
              <tr key={stat.module} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.5)', borderTop: '1px solid #e5e7eb' }}>
                <td style={{ padding: '5px 10px', fontWeight: 500, color: '#1f2937' }}>{stat.module}</td>
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

  /** Panel showing available question counts by module × type */
  const QuestionBankTypeStatsPanel = () => {
    if (moduleTypeStats.length === 0) return null;
    const typeEmoji: Record<string, string> = { Coding: '💻', Conceptual: '🧠', 'Fill-in': '✏️', Debug: '🐛' };
    // Group by module
    const grouped = modules.reduce<Record<string, ModuleTypeStats[]>>((acc, m) => {
      acc[m] = moduleTypeStats.filter(s => s.module === m);
      return acc;
    }, {});
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
            — Available question counts by Module × Type
          </span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(139,92,246,0.1)' }}>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#4c1d95' }}>Module</th>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#4c1d95' }}>Type</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#15803d' }}>🟢 Easy</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#b45309' }}>🟡 Medium</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#b91c1c' }}>🔴 Hard</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#374151' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(grouped).map(([mod, stats]) =>
              stats.map((stat, i) => (
                <tr key={`${mod}-${stat.type}`} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.5)', borderTop: '1px solid #e5e7eb' }}>
                  {i === 0 && (
                    <td rowSpan={stats.length} style={{ padding: '5px 10px', fontWeight: 600, color: '#1f2937', verticalAlign: 'top', borderRight: '1px solid #e5e7eb' }}>
                      {mod}
                    </td>
                  )}
                  <td style={{ padding: '5px 10px', color: '#374151' }}>{typeEmoji[stat.type] || '❓'} {stat.type}</td>
                  <td style={{ padding: '5px 10px', textAlign: 'center', color: '#166534', fontWeight: 600 }}>{stat.easy}</td>
                  <td style={{ padding: '5px 10px', textAlign: 'center', color: '#92400e', fontWeight: 600 }}>{stat.medium}</td>
                  <td style={{ padding: '5px 10px', textAlign: 'center', color: '#991b1b', fontWeight: 600 }}>{stat.hard}</td>
                  <td style={{ padding: '5px 10px', textAlign: 'center', color: '#374151', fontWeight: 700 }}>
                    {stat.easy + stat.medium + stat.hard}
                  </td>
                </tr>
              ))
            )}
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
    <div className="min-h-screen bg-slate-50">
      <div className="container space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 pb-4 border-b border-slate-200 gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-100 text-emerald-600 rounded-lg">
              <FolderKanban size={24} />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight m-0 border-none pb-0">Batch Management</h1>
          </div>
          <Link to="/admin/dashboard" className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg font-medium text-sm hover:bg-slate-50 transition-colors shadow-sm">
            <ArrowLeft size={16} />
            <span className="hidden sm:inline">Back to Dashboard</span>
          </Link>
        </div>

        <AdminNav />

        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white px-6 py-4 rounded-xl shadow-sm border border-slate-200 gap-4">
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2 m-0 border-none pb-0">
            <ListChecks size={18} className="text-slate-500" />
            Batches List
          </h3>
          <button
            onClick={() => {
              const nextShowForm = !showForm;
              setShowForm(nextShowForm);
              if (nextShowForm) {
                setIsCreateBlueprintExpanded(false);
                void ensureCatalogSummary();
              }
            }}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all shadow-sm ${showForm ? 'bg-slate-100 text-slate-700 hover:bg-slate-200' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
          >
            {showForm ? 'Cancel' : (
              <>
                <Plus size={16} />
                Create New Batch
              </>
            )}
          </button>
        </div>

      {/* ── Create Batch Form ──────────────────────────────────────────── */}
      {showForm && (
        <div ref={createFormRef} className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-6">
          <div className="p-6 border-b border-slate-100 bg-slate-50/50">
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              Create New Batch
            </h3>
          </div>
          <div className="p-6">
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="block text-sm font-bold text-slate-700">Batch Name</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    required
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                    placeholder="e.g. Midterm Fall 2023"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-bold text-slate-700">Duration (minutes)</label>
                  <input
                    type="number"
                    value={formData.duration}
                    onChange={e => setFormData(prev => ({ ...prev, duration: parseInt(e.target.value) }))}
                    min={10}
                    required
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-bold text-slate-700">Start Time</label>
                  <input
                    type="datetime-local"
                    value={formData.start_time}
                    onChange={e => setFormData(prev => ({ ...prev, start_time: e.target.value }))}
                    required
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-bold text-slate-700">End Time</label>
                  <input
                    type="datetime-local"
                    value={formData.end_time}
                    onChange={e => setFormData(prev => ({ ...prev, end_time: e.target.value }))}
                    required
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-4 bg-slate-50 border border-slate-200 rounded-xl">
                <div className="space-y-2">
                  <label className="block text-sm font-bold text-slate-700">Exam Type</label>
                  <select
                    value={formData.exam_type}
                    onChange={e => setFormData(prev => ({ ...prev, exam_type: e.target.value as 'essay' | 'quiz' }))}
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                  >
                    <option value="essay">Tự luận / Coding (Essay)</option>
                    <option value="quiz">Trắc nghiệm (Quiz)</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-bold text-slate-700">Screen Recording</label>
                  <select
                    value={formData.record_mode}
                    disabled={!isAdmin}
                    onChange={e => setFormData(prev => ({ ...prev, record_mode: e.target.value as 'none' | 'local' | 's3' }))}
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none disabled:opacity-60 disabled:bg-slate-100"
                  >
                    <option value="none">Default (No recording)</option>
                    <option value="local">Record Local (Save on student's machine)</option>
                    <option value="s3">Record S3 (Save to AWS S3)</option>
                  </select>
                  {!isAdmin && (
                    <p className="text-xs text-amber-600 font-medium">Only admin accounts can change this setting.</p>
                  )}
                </div>
              </div>

            <div className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="m-0 text-base font-bold text-slate-900">Question Configuration</h4>
                <span className="rounded-full bg-blue-50 px-3 py-1 text-sm font-semibold text-blue-700">
                  Total: {totalQuestions}/100
                </span>
              </div>

                  <BlueprintModeToggle value={blueprintMode} onChange={switchBlueprintMode} />

                  {modules.length === 0 && blueprintMode === 'module' ? (
              <p className={catalogLoading ? 'text-slate-500' : 'error'}>{catalogLoading ? 'Loading question catalog...' : 'Please import questions first to configure the blueprint.'}</p>
            ) : typeStats.length === 0 && blueprintMode === 'type' ? (
              <p className="error">Please import questions first to configure the blueprint.</p>
            ) : blueprintMode === 'module' ? (
              <>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="matrix-table min-w-[720px]">
                  <thead>
                    <tr>
                      <th>Module</th>
                      <th className="text-center">🟢 Easy</th>
                      <th className="text-center">🟡 Medium</th>
                      <th className="text-center">🔴 Hard</th>
                      <th className="text-center">Total</th>
                      <th className="w-28 text-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {formData.blueprint.map((item, index) => {
                      const stats = getStatsForModule(item.module);
                      return (
                        <tr key={index}>
                          <td>
                            <select
                              name={`module_${index}`}
                              id={`module_${index}`}
                              style={{ width: '100%', padding: '8px' }}
                              value={item.module}
                              onChange={e => updateBlueprint(index, 'module', e.target.value)}
                            >
                              {modules.map(m => (
                                <option key={m} value={m}>{m}</option>
                              ))}
                            </select>
                            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, paddingLeft: 2 }}>
                              Available: {stats.easy}E / {stats.medium}M / {stats.hard}H
                            </div>
                          </td>
                          <td className="text-center">
                            <ValidatedInput value={item.easy} max={stats.easy} onChange={v => updateBlueprint(index, 'easy', v)} />
                          </td>
                          <td className="text-center">
                            <ValidatedInput value={item.medium} max={stats.medium} onChange={v => updateBlueprint(index, 'medium', v)} />
                          </td>
                          <td className="text-center">
                            <ValidatedInput value={item.hard} max={stats.hard} onChange={v => updateBlueprint(index, 'hard', v)} />
                          </td>
                          <td style={{ textAlign: 'center', fontWeight: 600 }}>
                            {Number(item.easy) + Number(item.medium) + Number(item.hard)}
                          </td>
                          <td className="text-center">
                            <button type="button" onClick={() => removeBlueprintRow(index)} className="btn btn-danger" style={{ padding: '5px 10px', fontSize: 12 }}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </>
            ) : (
              <>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="matrix-table min-w-[840px]">
                  <thead>
                    <tr>
                      <th>Module</th>
                      <th>Type</th>
                      <th className="text-center">🟢 Easy</th>
                      <th className="text-center">🟡 Medium</th>
                      <th className="text-center">🔴 Hard</th>
                      <th className="text-center">Total</th>
                      <th className="w-28 text-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {formData.blueprintByType.map((item, index) => {
                      const stats = getStatsForModuleType(item.module, item.type);
                      // Combos used by OTHER rows
                      const otherCombos = formData.blueprintByType
                        .filter((_, i) => i !== index)
                        .map(i => `${i.module}||${i.type}`);
                      return (
                        <tr key={index}>
                          <td style={{ minWidth: 140 }}>
                            <select
                              style={{ width: '100%', padding: '8px' }}
                              value={item.module}
                              onChange={e => updateTypeBlueprint(index, 'module', e.target.value)}
                            >
                              {modules.map(m => (
                                <option key={m} value={m}>{m}</option>
                              ))}
                            </select>
                          </td>
                          <td style={{ minWidth: 120 }}>
                            <select
                              style={{ width: '100%', padding: '8px' }}
                              value={item.type}
                              onChange={e => updateTypeBlueprint(index, 'type', e.target.value as QuestionType)}
                            >
                              {QUESTION_TYPES.map(t => {
                                const combo = `${item.module}||${t}`;
                                const isUsed = otherCombos.includes(combo);
                                return (
                                  <option key={t} value={t} disabled={isUsed}>
                                    {t}{isUsed ? ' (selected)' : ''}
                                  </option>
                                );
                              })}
                            </select>
                            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, paddingLeft: 2 }}>
                              Available: {stats.easy}E / {stats.medium}M / {stats.hard}H
                            </div>
                          </td>
                          <td className="text-center">
                            <ValidatedInput value={item.easy} max={stats.easy} onChange={v => updateTypeBlueprint(index, 'easy', v)} />
                          </td>
                          <td className="text-center">
                            <ValidatedInput value={item.medium} max={stats.medium} onChange={v => updateTypeBlueprint(index, 'medium', v)} />
                          </td>
                          <td className="text-center">
                            <ValidatedInput value={item.hard} max={stats.hard} onChange={v => updateTypeBlueprint(index, 'hard', v)} />
                          </td>
                          <td style={{ textAlign: 'center', fontWeight: 600 }}>
                            {Number(item.easy) + Number(item.medium) + Number(item.hard)}
                          </td>
                          <td className="text-center">
                            <button type="button" onClick={() => removeTypeBlueprintRow(index)} className="btn btn-danger" style={{ padding: '5px 10px', fontSize: 12 }}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </>
            )}

              <div className="flex flex-wrap justify-start gap-2">
                {blueprintMode === 'module' ? (
                  <button
                    type="button"
                    onClick={addBlueprintRow}
                    disabled={modules.length === 0}
                    className="btn btn-secondary gap-2"
                    title={modules.length === 0 ? 'No modules available' : ''}
                  >
                    <Plus size={16} />
                    Add Module
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={addTypeBlueprintRow}
                    disabled={!nextAvailableModuleType}
                    className="btn btn-secondary gap-2"
                    title={!nextAvailableModuleType ? 'All combinations have been added' : ''}
                  >
                    <Plus size={16} />
                    Add Module / Type
                  </button>
                )}
              </div>

              {/* Validation errors */}
              {(feasibilityErrors.length > 0 || createBlueprintErrors.length > 0) && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-xl space-y-2">
                  <strong className="text-red-800 text-sm flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    Blueprint Errors:
                  </strong>
                  {[...feasibilityErrors, ...createBlueprintErrors.filter(e => !feasibilityErrors.includes(e))].map((err, i) => (
                    <p key={i} className="text-red-700 text-sm ml-6">{err}</p>
                  ))}
                </div>
              )}
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => setIsCreateBlueprintExpanded(prev => !prev)}
                aria-expanded={isCreateBlueprintExpanded}
                aria-controls="create-blueprint-content"
                className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-bold text-slate-900">Exam Blueprint</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">Reference only</span>
                  <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
                    {blueprintMode === 'module' ? 'By Module' : 'By Type'}
                  </span>
                </span>
                <ChevronDown
                  size={20}
                  className={`shrink-0 text-slate-500 transition-transform ${isCreateBlueprintExpanded ? 'rotate-180' : ''}`}
                />
              </button>

              {isCreateBlueprintExpanded && (
                <div id="create-blueprint-content" className="border-t border-slate-200 p-4 sm:p-5">
                  {blueprintMode === 'module' ? <QuestionBankStatsPanel /> : <QuestionBankTypeStatsPanel />}
                </div>
              )}
            </div>

              <div className="pt-6 border-t border-slate-100 flex justify-end">
                <button
                  type="submit"
                  disabled={
                    loading ||
                    totalQuestions < 1 ||
                    totalQuestions > 100 ||
                    (blueprintMode === 'module' && modules.length === 0) ||
                    (blueprintMode === 'type' && moduleTypeStats.length === 0) ||
                    createBlueprintErrors.length > 0
                  }
                  className="inline-flex items-center justify-center gap-2 px-8 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors shadow-md shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create Batch'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Invite Students Form ───────────────────────────────────────── */}
      {showInviteForm && selectedBatchId && (
        <div className="bg-emerald-50 rounded-2xl shadow-sm border border-emerald-200 overflow-hidden mb-6">
          <div className="p-6 border-b border-emerald-100 bg-emerald-100/50">
            <h3 className="text-lg font-bold text-emerald-800 flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
              Invite Students to Batch #{selectedBatchId}
            </h3>
            <p className="text-emerald-700 text-sm mt-1">Enter email addresses (one per line)</p>
          </div>
          <div className="p-6 space-y-4">
            <textarea
              value={emails}
              onChange={e => setEmails(e.target.value)}
              placeholder="student1@example.com&#10;student2@example.com"
              rows={6}
              className="w-full px-4 py-3 rounded-xl border border-emerald-200 bg-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all outline-none font-mono text-sm shadow-inner"
            />
            <div className="flex gap-3">
              <button
                onClick={handleInviteStudents}
                disabled={loading || !emails.trim()}
                className="inline-flex items-center gap-2 px-6 py-2.5 bg-emerald-600 text-white rounded-lg font-bold hover:bg-emerald-700 transition-colors shadow-sm disabled:opacity-50"
              >
                {loading ? 'Inviting...' : 'Invite Students'}
              </button>
              <button
                onClick={() => { setShowInviteForm(false); setInviteResult(null); }}
                className="inline-flex items-center gap-2 px-6 py-2.5 bg-white text-slate-700 border border-slate-300 rounded-lg font-bold hover:bg-slate-50 transition-colors shadow-sm"
              >
                Close
              </button>
            </div>

            {inviteResult && (
              <div className="mt-6 pt-6 border-t border-emerald-200">
                <h4 className="text-emerald-800 font-bold mb-4">Invited {inviteResult.success} students successfully:</h4>
                <div className="bg-white rounded-xl border border-emerald-100 overflow-hidden shadow-sm">
                  <table className="w-full text-left text-sm text-slate-600">
                    <thead className="bg-emerald-50 text-emerald-800 border-b border-emerald-100">
                      <tr>
                        <th className="px-6 py-3 font-bold">Email</th>
                        <th className="px-6 py-3 font-bold">Access Code</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-emerald-50">
                      {inviteResult.emails.map((s, i) => (
                        <tr key={i} className="hover:bg-emerald-50/50 transition-colors">
                          <td className="px-6 py-3">{s.email}</td>
                          <td className="px-6 py-3 font-mono font-bold text-emerald-600">{s.code}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button
                  onClick={() => exportStudents(selectedBatchId)}
                  className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-emerald-100 text-emerald-700 rounded-lg font-bold hover:bg-emerald-200 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Export to Excel
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Batches Table ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-6 border-b border-slate-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <h3 className="text-lg font-bold text-slate-900 m-0 border-none pb-0">
            Batches List <span className="text-slate-400 font-normal ml-1">({batchTotal} total)</span>
          </h3>
          <PageSizeSelect value={batchPageSize} onChange={handleBatchPageSizeChange} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-slate-50 text-slate-800 border-b border-slate-200">
              <tr>
                <th className="px-6 py-4 font-bold">ID</th>
                <th className="px-6 py-4 font-bold">Name</th>
                <th className="px-6 py-4 font-bold">Start Time</th>
                <th className="px-6 py-4 font-bold">End Time</th>
                <th className="px-6 py-4 font-bold">Duration</th>
                <th className="px-6 py-4 font-bold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {batches.map(batch => {
                const editable = canEditBatch(batch);
                return (
                  <Fragment key={batch.id}>
                  <tr className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4 font-mono font-medium text-slate-500">#{batch.id}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900">{batch.name}</span>
                        {!editable && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500 uppercase tracking-wider">
                            View Only
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">{formatGMT7(batch.start_time)}</td>
                    <td className="px-6 py-4">{formatGMT7(batch.end_time)}</td>
                    <td className="px-6 py-4 font-medium">{batch.duration} min</td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleCloneBatch(batch)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-cyan-700 border border-cyan-200 rounded-lg text-sm font-medium hover:bg-cyan-50 hover:border-cyan-300 transition-colors"
                        >
                          <Copy size={14} />
                          Clone
                        </button>
                        {batch.exam_type === 'essay' && aiSettingsVerified && Number(batch.created_by) === userId && (
                          <button
                            type="button"
                            onClick={() => handleAiGrade(batch)}
                            disabled={gradingBatchId !== null}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white border border-indigo-600 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50"
                          >
                            <Sparkles size={14} />
                            {gradingBatchId === Number(batch.id) ? 'Grading...' : 'AI Grade'}
                          </button>
                        )}
                        <Link to={`/admin/batches/${batch.id}/students`} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-blue-700 border border-blue-200 rounded-lg text-sm font-medium hover:bg-blue-50 hover:border-blue-300 transition-colors">
                          <Users size={14} />
                          Students
                        </Link>
                        <Link to={`/admin/batches/${batch.id}/results`} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-purple-700 border border-purple-200 rounded-lg text-sm font-medium hover:bg-purple-50 hover:border-purple-300 transition-colors">
                          <BarChart3 size={14} />
                          Results
                        </Link>
                        {canViewLiveBatch(batch) && <Link to={`/admin/batches/${batch.id}/live`} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-emerald-700 border border-emerald-200 rounded-lg text-sm font-medium hover:bg-emerald-50 hover:border-emerald-300 transition-colors">
                          <MonitorPlay size={14} />
                          Live
                        </Link>}
                        {editable && (
                          <>
                            <button
                              onClick={() => handleEditBatch(batch)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-slate-700 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors"
                            >
                              <Pencil size={14} />
                              Edit
                            </button>
                            <button
                              onClick={() => {
                                if (confirm('Delete this batch? All students and exam data will be lost.')) {
                                  adminApi.deleteBatch(batch.id).then(() => loadBatches());
                                }
                              }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-red-700 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-50 hover:border-red-300 transition-colors"
                            >
                              <Trash2 size={14} />
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {Number(editingBatch?.id) === Number(batch.id) && (
                    <tr>
                      <td colSpan={6} className="p-4 bg-slate-50">
                        {renderEditBatchForm()}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
              {batches.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                      </svg>
                      No batches found.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        {batchTotalPages > 1 && (
          <div className="p-4 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-4 bg-slate-50/50">
            <span className="text-sm text-slate-500 font-medium">
              Page {batchCurrentPage} of {batchTotalPages} <span className="mx-2 text-slate-300">|</span> 
              Showing {(batchCurrentPage - 1) * batchPageSize + 1} to {Math.min(batchCurrentPage * batchPageSize, batchTotal)} of {batchTotal}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => handleBatchPageChange(Math.max(1, batchCurrentPage - 1))}
                disabled={batchCurrentPage === 1}
                className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              {getBatchPageNumbers().map((p, i) =>
                p === '...' ? (
                  <span key={`el-${i}`} className="px-3 py-1.5 text-slate-400">…</span>
                ) : (
                  <button
                    key={p}
                    onClick={() => handleBatchPageChange(p as number)}
                    className={`px-3 py-1.5 rounded-md text-sm font-bold transition-colors min-w-[32px] ${
                      batchCurrentPage === p 
                        ? 'bg-blue-600 text-white shadow-sm' 
                        : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {p}
                  </button>
                )
              )}
              <button
                onClick={() => handleBatchPageChange(Math.min(batchTotalPages, batchCurrentPage + 1))}
                disabled={batchCurrentPage === batchTotalPages}
                className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );

  function renderEditBatchForm() {
    if (!editingBatch) return null;

    return (
        <div className="bg-blue-50 rounded-2xl shadow-sm border border-blue-200 overflow-hidden">
          <div className="p-6 border-b border-blue-100 bg-blue-100/50">
            <h3 className="text-lg font-bold text-blue-800 flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Edit Batch #{editingBatch.id}
            </h3>
          </div>

          <div className="p-6 space-y-6">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Batch Name</label>
                <input
                  type="text"
                  value={editingBatch.name}
                  onChange={e => setEditingBatch({ ...editingBatch, name: e.target.value })}
                  required
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none text-slate-900"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Start Time</label>
                  <input
                    type="datetime-local"
                    value={editingBatch.start_time || ''}
                    onChange={e => setEditingBatch({ ...editingBatch, start_time: e.target.value })}
                    required
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-300 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">End Time</label>
                  <input
                    type="datetime-local"
                    value={editingBatch.end_time || ''}
                    onChange={e => setEditingBatch({ ...editingBatch, end_time: e.target.value })}
                    required
                    className="w-full px-4 py-2.5 rounded-xl border border-slate-300 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none text-slate-900"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Duration (minutes)</label>
                <input
                  type="number"
                  value={editingBatch.duration}
                  onChange={e => setEditingBatch({ ...editingBatch, duration: parseInt(e.target.value) })}
                  min={1}
                  required
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none text-slate-900"
                />
              </div>

              {/* Exam type */}
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Exam Type</label>
                <select
                  value={editingBatch.exam_type === 'quiz' ? 'quiz' : 'essay'}
                  onChange={e => setEditingBatch({ ...editingBatch, exam_type: e.target.value })}
                  className="px-4 py-2.5 rounded-xl border border-slate-300 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none text-slate-900 min-w-[200px]"
                >
                  <option value="essay">Tự luận / Coding</option>
                  <option value="quiz">Trắc nghiệm (Quiz)</option>
                </select>
              </div>

              {/* Chế độ ghi màn hình */}
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Screen Recording</label>
                <select
                  value={editingBatch.record_mode || 'none'}
                  disabled={!isAdmin}
                  onChange={e => setEditingBatch({ ...editingBatch, record_mode: e.target.value })}
                  className="px-4 py-2.5 rounded-xl border border-slate-300 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none text-slate-900 min-w-[300px] disabled:bg-slate-50 disabled:text-slate-500"
                >
                  <option value="none">Default (No recording)</option>
                  <option value="local">Record Local (Save on student's machine, encrypted)</option>
                  <option value="s3">Record S3 (Save to AWS S3)</option>
                </select>
                {!isAdmin && (
                  <p className="mt-2 text-sm text-amber-600 font-medium">Only admin accounts can change this setting.</p>
                )}
              </div>
            </div>

            <div className="pt-6 border-t border-blue-200">
              <div className="space-y-4 rounded-xl border border-blue-200 bg-white p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4 className="m-0 text-lg font-bold text-blue-800">Question Configuration</h4>
                  <span className="rounded-full bg-blue-100 px-3 py-1 text-sm font-semibold text-blue-700">
                    Total: {editTotalQuestions}/100
                  </span>
                </div>

                    <BlueprintModeToggle value={editBlueprintMode} onChange={switchEditBlueprintMode} />

                    {editBlueprintMode === 'module' ? (
                modules.length === 0 ? (
                  <div className={`p-4 rounded-xl border ${catalogLoading ? 'bg-slate-50 text-slate-600 border-slate-200' : 'bg-red-50 text-red-700 border-red-200'}`}>{catalogLoading ? 'Loading question catalog...' : 'No modules available'}</div>
                ) : (
                  <>
                    <div className="overflow-x-auto bg-white rounded-xl border border-blue-100 shadow-sm">
                      <table className="min-w-[720px] w-full text-left text-sm text-slate-600">
                        <thead className="bg-blue-50 text-blue-800 border-b border-blue-100">
                          <tr>
                            <th className="px-4 py-3 font-bold">Module</th>
                            <th className="px-4 py-3 font-bold text-center">🟢 Easy</th>
                            <th className="px-4 py-3 font-bold text-center">🟡 Medium</th>
                            <th className="px-4 py-3 font-bold text-center">🔴 Hard</th>
                            <th className="px-4 py-3 font-bold text-center">Total</th>
                            <th className="w-20 px-4 py-3 font-bold text-center">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-blue-50">
                          {(editingBatch.blueprint || []).map((item: any, index: number) => {
                            const stats = getStatsForModule(item.module);
                            return (
                              <tr key={index} className="hover:bg-blue-50/30 transition-colors">
                                <td className="px-4 py-3 align-top min-w-[200px]">
                                  <select
                                    value={item.module}
                                    onChange={e => {
                                      const newBlueprint = [...editingBatch.blueprint];
                                      newBlueprint[index].module = e.target.value;
                                      setEditingBatch({ ...editingBatch, blueprint: newBlueprint });
                                    }}
                                    className="w-full px-3 py-1.5 rounded-lg border border-slate-200 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-slate-700"
                                  >
                                    {modules.map(m => <option key={m} value={m}>{m}</option>)}
                                  </select>
                                  <div className="text-[11px] text-slate-500 mt-1.5 ml-1 font-medium">
                                    Available: {stats.easy}E / {stats.medium}M / {stats.hard}H
                                  </div>
                                </td>
                                <td className="px-4 py-3 align-top text-center">
                                  <ValidatedInput value={item.easy || 0} max={stats.easy} onChange={v => {
                                    const nb = [...editingBatch.blueprint]; nb[index].easy = parseInt(v) || 0;
                                    setEditingBatch({ ...editingBatch, blueprint: nb });
                                  }} />
                                </td>
                                <td className="px-4 py-3 align-top text-center">
                                  <ValidatedInput value={item.medium || 0} max={stats.medium} onChange={v => {
                                    const nb = [...editingBatch.blueprint]; nb[index].medium = parseInt(v) || 0;
                                    setEditingBatch({ ...editingBatch, blueprint: nb });
                                  }} />
                                </td>
                                <td className="px-4 py-3 align-top text-center">
                                  <ValidatedInput value={item.hard || 0} max={stats.hard} onChange={v => {
                                    const nb = [...editingBatch.blueprint]; nb[index].hard = parseInt(v) || 0;
                                    setEditingBatch({ ...editingBatch, blueprint: nb });
                                  }} />
                                </td>
                                <td className="px-4 py-3 align-top text-center font-semibold text-slate-700">
                                  {Number(item.easy || 0) + Number(item.medium || 0) + Number(item.hard || 0)}
                                </td>
                                <td className="px-4 py-3 align-top text-center">
                                  <button
                                    onClick={() => setEditingBatch({
                                      ...editingBatch,
                                      blueprint: editingBatch.blueprint.filter((_: any, i: number) => i !== index)
                                    })}
                                    className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                                    title="Remove"
                                  >
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )
              ) : (
                moduleTypeStats.length === 0 ? (
                  <div className="p-4 bg-red-50 text-red-700 rounded-xl border border-red-200">No type data available</div>
                ) : (
                  <>
                    <div className="overflow-x-auto bg-white rounded-xl border border-blue-100 shadow-sm">
                      <table className="min-w-[840px] w-full text-left text-sm text-slate-600">
                        <thead className="bg-blue-50 text-blue-800 border-b border-blue-100">
                          <tr>
                            <th className="px-4 py-3 font-bold">Module</th>
                            <th className="px-4 py-3 font-bold">Type</th>
                            <th className="px-4 py-3 font-bold text-center">🟢 Easy</th>
                            <th className="px-4 py-3 font-bold text-center">🟡 Medium</th>
                            <th className="px-4 py-3 font-bold text-center">🔴 Hard</th>
                            <th className="px-4 py-3 font-bold text-center">Total</th>
                            <th className="w-20 px-4 py-3 font-bold text-center">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-blue-50">
                          {((editingBatch.blueprintByType || []) as BlueprintItemByType[]).map((item, index) => {
                            const stats = getStatsForModuleType(item.module, item.type);
                            const otherCombos = ((editingBatch.blueprintByType || []) as BlueprintItemByType[])
                              .filter((_, i) => i !== index)
                              .map(i => `${i.module}||${i.type}`);
                            return (
                              <tr key={index} className="hover:bg-blue-50/30 transition-colors">
                                <td className="px-4 py-3 align-top min-w-[140px]">
                                  <select
                                    value={item.module}
                                    onChange={e => {
                                      const nb = [...editingBatch.blueprintByType];
                                      nb[index].module = e.target.value;
                                      setEditingBatch({ ...editingBatch, blueprintByType: nb });
                                    }}
                                    className="w-full px-3 py-1.5 rounded-lg border border-slate-200 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-slate-700"
                                  >
                                    {modules.map(m => <option key={m} value={m}>{m}</option>)}
                                  </select>
                                </td>
                                <td className="px-4 py-3 align-top min-w-[140px]">
                                  <select
                                    value={item.type}
                                    onChange={e => {
                                      const nb = [...editingBatch.blueprintByType];
                                      nb[index].type = e.target.value;
                                      setEditingBatch({ ...editingBatch, blueprintByType: nb });
                                    }}
                                    className="w-full px-3 py-1.5 rounded-lg border border-slate-200 bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-slate-700"
                                  >
                                    {QUESTION_TYPES.map(t => {
                                      const combo = `${item.module}||${t}`;
                                      const isUsed = otherCombos.includes(combo);
                                      return (
                                        <option key={t} value={t} disabled={isUsed}>
                                          {t}{isUsed ? ' (selected)' : ''}
                                        </option>
                                      );
                                    })}
                                  </select>
                                  <div className="text-[11px] text-slate-500 mt-1.5 ml-1 font-medium">
                                    Available: {stats.easy}E / {stats.medium}M / {stats.hard}H
                                  </div>
                                </td>
                                <td className="px-4 py-3 align-top text-center">
                                  <ValidatedInput value={item.easy || 0} max={stats.easy} onChange={v => {
                                    const nb = [...editingBatch.blueprintByType]; nb[index].easy = parseInt(v) || 0;
                                    setEditingBatch({ ...editingBatch, blueprintByType: nb });
                                  }} />
                                </td>
                                <td className="px-4 py-3 align-top text-center">
                                  <ValidatedInput value={item.medium || 0} max={stats.medium} onChange={v => {
                                    const nb = [...editingBatch.blueprintByType]; nb[index].medium = parseInt(v) || 0;
                                    setEditingBatch({ ...editingBatch, blueprintByType: nb });
                                  }} />
                                </td>
                                <td className="px-4 py-3 align-top text-center">
                                  <ValidatedInput value={item.hard || 0} max={stats.hard} onChange={v => {
                                    const nb = [...editingBatch.blueprintByType]; nb[index].hard = parseInt(v) || 0;
                                    setEditingBatch({ ...editingBatch, blueprintByType: nb });
                                  }} />
                                </td>
                                <td className="px-4 py-3 align-top text-center font-semibold text-slate-700">
                                  {Number(item.easy || 0) + Number(item.medium || 0) + Number(item.hard || 0)}
                                </td>
                                <td className="px-4 py-3 align-top text-center">
                                  <button
                                    onClick={() => setEditingBatch({
                                      ...editingBatch,
                                      blueprintByType: (editingBatch.blueprintByType || []).filter((_: any, i: number) => i !== index)
                                    })}
                                    className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                                    title="Remove"
                                  >
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )
              )}

              <div className="flex flex-wrap justify-start gap-2">
                {editBlueprintMode === 'module' ? (
                  <button
                    type="button"
                    onClick={() => setEditingBatch({
                      ...editingBatch,
                      blueprint: [...(editingBatch.blueprint || []), { module: modules[0], easy: 0, medium: 0, hard: 0 }]
                    })}
                    disabled={modules.length === 0}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white text-slate-700 border border-slate-300 rounded-lg font-bold hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={modules.length === 0 ? 'No modules available' : ''}
                  >
                    <Plus size={16} />
                    Add Module
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (!nextAvailableModuleTypeEdit) return;
                      setEditingBatch({
                        ...editingBatch,
                        blueprintByType: [
                          ...(editingBatch.blueprintByType || []),
                          { module: nextAvailableModuleTypeEdit.module, type: nextAvailableModuleTypeEdit.type, easy: 0, medium: 0, hard: 0 }
                        ]
                      });
                    }}
                    disabled={!nextAvailableModuleTypeEdit}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white text-slate-700 border border-slate-300 rounded-lg font-bold hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={!nextAvailableModuleTypeEdit ? 'All combinations have been added' : ''}
                  >
                    <Plus size={16} />
                    Add Module / Type
                  </button>
                )}
              </div>

              {/* Edit blueprint validation errors */}
              {editBlueprintErrors.length > 0 && (
                <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-xl">
                  <strong className="text-red-800 text-sm font-bold flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    Blueprint exceeds available question count:
                  </strong>
                  <ul className="mt-2 space-y-1 list-disc list-inside">
                    {editBlueprintErrors.map((err, i) => (
                      <li key={i} className="text-red-700 text-sm">{err}</li>
                    ))}
                  </ul>
                </div>
              )}
              </div>

              <div className="mt-4 overflow-hidden rounded-xl border border-blue-200 bg-white">
                <button
                  type="button"
                  onClick={() => setIsEditBlueprintExpanded(prev => !prev)}
                  aria-expanded={isEditBlueprintExpanded}
                  aria-controls="edit-blueprint-content"
                  className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-blue-50/50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-lg font-bold text-blue-800">Exam Blueprint</span>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">Reference only</span>
                    <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-700">
                      {editBlueprintMode === 'module' ? 'By Module' : 'By Type'}
                    </span>
                  </span>
                  <ChevronDown
                    size={20}
                    className={`shrink-0 text-blue-600 transition-transform ${isEditBlueprintExpanded ? 'rotate-180' : ''}`}
                  />
                </button>

                {isEditBlueprintExpanded && (
                  <div id="edit-blueprint-content" className="border-t border-blue-200 p-4 sm:p-5">
                    {editBlueprintMode === 'module' ? <QuestionBankStatsPanel /> : <QuestionBankTypeStatsPanel />}
                  </div>
                )}
              </div>

              <div className="mt-8 flex flex-wrap gap-3 items-center">
                <button
                  type="button"
                  onClick={handleUpdateBatch}
                  disabled={loading || editBlueprintErrors.length > 0}
                  className="inline-flex items-center gap-2 px-6 py-2.5 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Saving...' : 'Save Changes'}
                </button>

                <button
                  type="button"
                  onClick={() => setEditingBatch(null)}
                  className="inline-flex items-center gap-2 px-6 py-2.5 bg-slate-100 text-slate-700 rounded-lg font-bold hover:bg-slate-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
    );
  }
}

export default BatchManagement;
