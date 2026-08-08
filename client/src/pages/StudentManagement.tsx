import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { adminApi } from '../services/api';
import AdminNav from '../components/AdminNav';
import { Users, ArrowLeft, Upload, FileDown, Trash2, Mail, Hash, Activity } from 'lucide-react';

function StudentManagement() {
  const { id } = useParams<{ id: string }>();
  const [students, setStudents] = useState<any[]>([]);
  const [batch, setBatch] = useState<any>(null);
  const [emails, setEmails] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    loadBatch();
    loadStudents();
  }, [id]);

  const loadBatch = async () => {
    try {
      const res = await adminApi.getBatch(parseInt(id!));
      setBatch(res.data);
    } catch (error) {
      console.error(error);
    }
  };

  const loadStudents = async () => {
    try {
      const res = await adminApi.getStudents(parseInt(id!));
      setStudents(res.data);
    } catch (error) {
      console.error(error);
    }
  };

  const handleImport = async () => {
    if (!emails.trim()) return;
    setLoading(true);
    setMessage('');
    setIsError(false);
    try {
      const emailList = emails.split('\n').map(e => e.trim()).filter(e => e);
      await adminApi.importStudents(parseInt(id!), emailList);
      setMessage(`Successfully imported ${emailList.length} students`);
      setEmails('');
      loadStudents();
    } catch (error: any) {
      setIsError(true);
      setMessage('Error: ' + (error.response?.data?.error || error.message));
    }
    setLoading(false);
  };

  const handleExport = async () => {
    try {
      const res = await adminApi.exportStudents(parseInt(id!));
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `students-${id}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      console.error(error);
    }
  };

  const handleDelete = async (studentId: number, email: string) => {
    if (!confirm(`Are you sure you want to delete ${email}? This will also delete all exam data associated with this student.`)) return;
    try {
      await adminApi.deleteStudent(studentId);
      loadStudents();
    } catch (error: any) {
      alert('Error: ' + (error.response?.data?.error || error.message));
    }
  };

  return (
    <div className="container">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 pb-4 border-b border-slate-200 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 text-blue-600 rounded-lg">
            <Users size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight m-0 border-none pb-0">Student Management</h1>
            {batch && <p className="text-sm text-slate-500 font-medium mt-1">Batch: {batch.name}</p>}
          </div>
        </div>
        <Link 
          to="/admin/batches" 
          className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg font-medium text-sm hover:bg-slate-50 transition-colors shadow-sm"
        >
          <ArrowLeft size={16} />
          <span className="hidden sm:inline">Back to Batches</span>
        </Link>
      </div>

      <AdminNav />

      <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 gap-8">
        <div className="lg:col-span-1">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden sticky top-8">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
              <Upload size={18} className="text-slate-500" />
              <h3 className="font-bold text-slate-900 m-0 border-none pb-0 text-base">Import Students</h3>
            </div>
            
            <div className="p-5">
              <p className="text-sm text-slate-600 mb-3">
                Enter email addresses (one per line)
              </p>
              
              <div className="relative mb-4">
                <textarea 
                  rows={8}
                  value={emails}
                  onChange={e => setEmails(e.target.value)}
                  placeholder="student1@example.com&#10;student2@example.com&#10;student3@example.com"
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:ring-2 focus:ring-blue-500 text-sm resize-y font-mono"
                  style={{ minHeight: '160px' }}
                />
              </div>
              
              <button 
                onClick={handleImport} 
                disabled={!emails.trim() || loading} 
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50"
              >
                <Upload size={16} />
                {loading ? 'Importing...' : 'Import Emails'}
              </button>
              
              {message && (
                <div className={`mt-4 p-3 rounded-lg text-sm flex items-start gap-2 border ${
                  isError ? 'bg-red-50 text-red-700 border-red-100' : 'bg-emerald-50 text-emerald-700 border-emerald-100'
                }`}>
                  <span className="font-medium">{message}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 xl:col-span-3 min-w-0">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <h3 className="font-bold text-slate-900 m-0 border-none pb-0 text-base flex items-center gap-2">
                <Users size={18} className="text-slate-500" />
                Students List
                <span className="bg-slate-200 text-slate-700 py-0.5 px-2 rounded-full text-xs font-medium ml-2">
                  {students.length}
                </span>
              </h3>
              
              <button 
                onClick={handleExport} 
                disabled={students.length === 0} 
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors shadow-sm disabled:opacity-50"
              >
                <FileDown size={14} />
                Export Codes
              </button>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-5 py-3 font-semibold text-slate-600 w-16">ID</th>
                    <th className="px-5 py-3 font-semibold text-slate-600">
                      <div className="flex items-center gap-1.5">
                        <Mail size={14} className="text-slate-400" />
                        Email
                      </div>
                    </th>
                    <th className="px-5 py-3 font-semibold text-slate-600">
                      <div className="flex items-center gap-1.5">
                        <Hash size={14} className="text-slate-400" />
                        Access Code
                      </div>
                    </th>
                    <th className="px-5 py-3 font-semibold text-slate-600">
                      <div className="flex items-center gap-1.5">
                        <Activity size={14} className="text-slate-400" />
                        Status
                      </div>
                    </th>
                    <th className="px-5 py-3 font-semibold text-slate-600 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {students.map(s => (
                    <tr key={s.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-5 py-3 font-mono text-xs text-slate-500">{s.id}</td>
                      <td className="px-5 py-3 font-medium text-slate-900">{s.email}</td>
                      <td className="px-5 py-3">
                        <span className="font-mono bg-slate-100 text-slate-800 px-2 py-1 rounded text-sm tracking-widest font-bold">
                          {s.access_code}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
                          s.status === 'submitted' 
                            ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' 
                            : s.status === 'in_progress' 
                              ? 'bg-amber-100 text-amber-700 border border-amber-200' 
                              : 'bg-slate-100 text-slate-600 border border-slate-200'
                        }`}>
                          {s.status === 'submitted' ? 'Submitted' : s.status === 'in_progress' ? 'In Progress' : 'Pending'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button 
                          onClick={() => handleDelete(s.id, s.email)}
                          className="inline-flex items-center justify-center p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                          title="Delete student"
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {students.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-12 text-center text-slate-500">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <Users size={32} className="text-slate-300" />
                          <p>No students imported yet. Add emails using the form to the left.</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default StudentManagement;
