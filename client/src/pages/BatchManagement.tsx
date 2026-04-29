import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { adminApi } from '../services/api';

interface BlueprintItem {
  module: string;
  easy: number;
  medium: number;
  hard: number;
}

function BatchManagement() {
  const navigate = useNavigate();
  const [batches, setBatches] = useState<any[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    start_time: '',
    end_time: '',
    duration: 30,
    blueprint: [] as BlueprintItem[]
  });
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [editingBatch, setEditingBatch] = useState<any>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [emails, setEmails] = useState('');
  const handleEditBatch = (batch: any) => {
    setEditingBatch({
      ...batch,
      blueprint: typeof batch.blueprint === 'string' ? JSON.parse(batch.blueprint) : (batch.blueprint || [])
    });
  };

  const handleUpdateBatch = async () => {
    if (!editingBatch) return;
    setLoading(true);
    try {
      await adminApi.updateBatch(editingBatch.id, {
        name: editingBatch.name,
        start_time: editingBatch.start_time,
        end_time: editingBatch.end_time,
        duration: editingBatch.duration,
        blueprint: editingBatch.blueprint
      });
      loadBatches();
      setEditingBatch(null);
    } catch (err: any) {
      alert(err.response?.data?.error || err.message);
    }
    setLoading(false);
  };
  const [inviteResult, setInviteResult] = useState<{success: number; emails: {email: string; code: string}[]} | null>(null);
  const [feasibilityErrors, setFeasibilityErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const auth = localStorage.getItem('adminAuth');
    if (!auth) {
      navigate('/admin');
      return;
    }
    loadBatches();
    loadModules();
  }, []);

  useEffect(() => {
    if (modules.length > 0 && formData.blueprint.length === 0) {
      setFormData(prev => ({
        ...prev,
        blueprint: [{ module: modules[0], easy: 0, medium: 0, hard: 0 }]
      }));
    }
  }, [modules]);

  const loadBatches = async () => {
    try {
      const res = await adminApi.getBatches();
      setBatches(res.data);
    } catch (error) {
      console.error(error);
    }
  };

  const loadModules = async () => {
    try {
      const res = await adminApi.getModules();
      console.log('[BatchManagement] Modules loaded:', res.data);
      setModules(res.data);
    } catch (error) {
      console.error('[BatchManagement] loadModules error:', error);
    }
  };

  const addBlueprintRow = () => {
    console.log('[BatchManagement] addBlueprintRow, modules:', modules);
    setFormData(prev => ({
      ...prev,
      blueprint: [...prev.blueprint, { module: modules[0] || '', easy: 0, medium: 0, hard: 0 }]
    }));
  };

  const updateBlueprint = (index: number, field: keyof BlueprintItem, value: any) => {
    console.log('updateBlueprint called:', index, field, value, 'current blueprint:', formData.blueprint);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[BatchManagement] handleSubmit called, formData:', formData);
    setLoading(true);
    setFeasibilityErrors([]);

    const total = formData.blueprint.reduce((sum, item) => sum + item.easy + item.medium + item.hard, 0);
    console.log('[BatchManagement] Total questions:', total);
    if (total < 1 || total > 20) {
      setFeasibilityErrors([`Total questions must be between 1 and 20. Current: ${total}`]);
      setLoading(false);
      return;
    }
    try {
      const startUTC = toUTC(formData.start_time);
      const endUTC = toUTC(formData.end_time);
      
      await adminApi.createBatch({
        name: formData.name,
        start_time: startUTC,
        end_time: endUTC,
        duration: formData.duration,
        blueprint: formData.blueprint
      });
      
      await fetchBatches();
      setShowForm(false);
      setFormData({ name: '', start_time: '', end_time: '', duration: 60, blueprint: [] });
    } catch (error: any) {
      console.log('[BatchManagement] ERROR:', error);
      setFeasibilityErrors([error.response?.data?.error || error.message || 'Error creating batch']);
    }
    setLoading(false);
  };

const handleInviteStudents = async () => {
    alert('FUNCTION STARTED!');
    console.log('handleInviteStudents called');
    if (!selectedBatchId || !emails.trim()) {
      console.log('Early return - missing batchId or emails');
      return;
    }
    
    setLoading(true);
    try {
      const emailList = emails.split('\n').map(e => e.trim()).filter(e => e && e.includes('@'));
      
      if (emailList.length === 0) {
        alert('Please enter valid email addresses');
        setLoading(false);
        return;
      }

      const res = await adminApi.importStudents(selectedBatchId, emailList);
      
      alert('DEBUG: API call completed! Response: ' + JSON.stringify(res.data));
      console.log('Import response:', res.data);
      
      const skipped = res.data.skippedEmails;
      console.log('Skipped emails:', skipped);
      
      if (skipped && skipped.length > 0) {
        console.log('Showing notification for skipped emails');
        alert(`Đã skip ${skipped.length} email trùng:\n${skipped.join('\n')}`);
      }
      
      setInviteResult({
        success: res.data.count,
        emails: res.data.students,
        skipped: res.data.skippedEmails || []
      });
      console.log('INVITE RESULT:', JSON.stringify(res.data));
      
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

  const totalQuestions = formData.blueprint.reduce((sum, item) => sum + item.easy + item.medium + item.hard, 0);

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
            {modules.length === 0 ? (
              <p className="error">Please import questions first to configure the blueprint.</p>
            ) : (
              <>
                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th>Module</th>
                      <th>Easy</th>
                      <th>Medium</th>
                      <th>Hard</th>
                      <th>Total</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {formData.blueprint.map((item, index) => (
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
                        </td>
                        <td>
                          <input 
                            type="number" 
                            min="0" 
                            value={item.easy}
                            onChange={e => updateBlueprint(index, 'easy', e.target.value)}
                          />
                        </td>
                        <td>
                          <input 
                            type="number" 
                            min="0" 
                            value={item.medium}
                            onChange={e => updateBlueprint(index, 'medium', e.target.value)}
                          />
                        </td>
                        <td>
                          <input 
                            type="number" 
                            min="0" 
                            value={item.hard}
                            onChange={e => updateBlueprint(index, 'hard', e.target.value)}
                          />
                        </td>
                        <td>{Number(item.easy) + Number(item.medium) + Number(item.hard)}</td>
                        <td>
                          <button 
                            type="button" 
                            onClick={() => removeBlueprintRow(index)}
                            className="btn btn-danger"
                            style={{ padding: '5px 10px', fontSize: 12 }}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" onClick={addBlueprintRow} className="btn btn-secondary" style={{ marginTop: 10 }}>
                  + Add Module
                </button>
              </>
            )}

            {feasibilityErrors.length > 0 && (
              <div style={{ marginTop: 15 }}>
                {feasibilityErrors.map((err, i) => (
                  <p key={i} className="error">{err}</p>
                ))}
              </div>
            )}

            <button 
              type="submit" 
              disabled={loading || totalQuestions < 1 || totalQuestions > 20 || modules.length === 0}
              className="btn btn-primary" 
              style={{ marginTop: 20 }}
            >
              {loading ? 'Creating...' : 'Create Batch'}
            </button>
          </form>
        </div>
      )}

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
              {inviteResult.skipped && inviteResult.skipped.length > 0 && (
                <h4 style={{ color: '#dc2626' }}>Skipped {inviteResult.skipped.length} duplicate emails: {inviteResult.skipped.join(', ')}</h4>
              )}
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
                <td>{new Date(batch.start_time).toLocaleString()}</td>
                <td>{new Date(batch.end_time).toLocaleString()}</td>
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
                value={editingBatch.start_time?.slice(0, 16)} 
                onChange={e => setEditingBatch({...editingBatch, start_time: e.target.value})}
                required 
              />
            </div>
            <div className="form-group">
              <label>End Time</label>
              <input 
                type="datetime-local" 
                value={editingBatch.end_time?.slice(0, 16)} 
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

          
          {modules.length === 0 ? (
            <p className="error">No modules available</p>
          ) : (
            <table className="matrix-table">
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Easy</th>
                  <th>Medium</th>
                  <th>Hard</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {editingBatch.blueprint?.map((item: any, index: number) => (
                  <tr key={index}>
                    <td>
                      <select 
                        value={item.module}
                        onChange={e => {
                          const newBlueprint = [...editingBatch.blueprint];
                          newBlueprint[index].module = e.target.value;
                          setEditingBatch({...editingBatch, blueprint: newBlueprint});
                        }}
                        style={{ width: '100%' }}
                      >
                        {modules.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </td>
                    <td>
                      <input 
                        type="number" 
                        min={0} 
                        value={item.easy || 0}
                        onChange={e => {
                          const newBlueprint = [...editingBatch.blueprint];
                          newBlueprint[index].easy = parseInt(e.target.value) || 0;
                          setEditingBatch({...editingBatch, blueprint: newBlueprint});
                        }}
                        style={{ width: 60 }}
                      />
                    </td>
                    <td>
                      <input 
                        type="number" 
                        min={0} 
                        value={item.medium || 0}
                        onChange={e => {
                          const newBlueprint = [...editingBatch.blueprint];
                          newBlueprint[index].medium = parseInt(e.target.value) || 0;
                          setEditingBatch({...editingBatch, blueprint: newBlueprint});
                        }}
                        style={{ width: 60 }}
                      />
                    </td>
                    <td>
                      <input 
                        type="number" 
                        min={0} 
                        value={item.hard || 0}
                        onChange={e => {
                          const newBlueprint = [...editingBatch.blueprint];
                          newBlueprint[index].hard = parseInt(e.target.value) || 0;
                          setEditingBatch({...editingBatch, blueprint: newBlueprint});
                        }}
                        style={{ width: 60 }}
                      />
                    </td>
                    <td>
                      <button 
                        onClick={() => {
                          const newBlueprint = editingBatch.blueprint.filter((_: any, i: number) => i !== index);
                          setEditingBatch({...editingBatch, blueprint: newBlueprint});
                        }}
                        className="btn btn-danger"
                        style={{ fontSize: 12, padding: '4px 8px' }}
                      >X</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          
          <button 
            onClick={() => {
              setEditingBatch({
                ...editingBatch,
                blueprint: [...(editingBatch.blueprint || []), { module: modules[0], easy: 0, medium: 0, hard: 0 }]
              });
            }}
            className="btn btn-secondary"
            style={{ marginTop: 10, marginRight: 10 }}
          >
            + Add Module
          </button>
          
          <button 
            onClick={handleUpdateBatch}
            disabled={loading}
            className="btn btn-primary"
            style={{ marginTop: 10 }}
          >
            {loading ? 'Saving...' : 'Save Changes'}
          </button>
          
          <button 
            onClick={() => setEditingBatch(null)}
            className="btn btn-secondary"
            style={{ marginTop: 10, marginLeft: 10 }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export default BatchManagement;
