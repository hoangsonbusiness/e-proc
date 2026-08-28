import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ArrowLeft, MonitorPlay, RefreshCw, Square, Wifi } from 'lucide-react';
import AdminNav from '../components/AdminNav';
import { useAuth } from '../contexts/AuthContext';
import { adminApi } from '../services/api';
import { startLiveViewer, type LiveViewerStatus, type LiveViewer } from '../services/liveViewer';

interface ActiveStudent { id: number; email: string; status: string; exam_started_at: string | null; }

function LiveMonitor() {
  const { id } = useParams<{ id: string }>();
  const { isAdmin, isLoading } = useAuth();
  const batchId = Number(id);
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<LiveViewer | null>(null);
  const viewerSessionIdRef = useRef<string | null>(null);
  const [students, setStudents] = useState<ActiveStudent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<ActiveStudent | null>(null);
  const [status, setStatus] = useState<LiveViewerStatus | null>(null);

  const load = useCallback(async () => {
    if (!Number.isInteger(batchId) || batchId < 1) return;
    try {
      const response = await adminApi.getLiveStudents(batchId);
      setStudents(response.data.students || []);
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Không tải được danh sách đang thi.');
    } finally { setLoading(false); }
  }, [batchId]);

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10_000); return () => window.clearInterval(timer); }, [load]);
  const stop = useCallback(async (outcome = 'ended') => {
    const viewer = viewerRef.current;
    viewerRef.current = null;
    if (viewer) await viewer.stop();
    const sessionId = viewerSessionIdRef.current;
    viewerSessionIdRef.current = null;
    if (sessionId) void adminApi.endLiveSession(sessionId, outcome).catch(() => {});
    if (videoRef.current) videoRef.current.srcObject = null;
    setSelected(null); setStatus(null);
  }, []);
  useEffect(() => () => { void stop(); }, [stop]);

  const view = async (student: ActiveStudent) => {
    await stop();
    setSelected(student); setStatus('connecting'); setError('');
    try {
      const response = await adminApi.createLiveSession(batchId, student.id);
      viewerSessionIdRef.current = response.data.viewerSessionId;
      viewerRef.current = await startLiveViewer(response.data, {
        onStream: (stream) => { if (videoRef.current) { videoRef.current.srcObject = stream; void videoRef.current.play().catch(() => {}); } },
        onStatus: (next) => {
          setStatus(next);
          if (next === 'failed') void adminApi.endLiveSession(response.data.viewerSessionId, 'failed').catch(() => {});
        },
      });
    } catch (err: any) {
      setError(err.response?.data?.error || 'Không thể mở phiên xem live.');
      setStatus('failed');
    }
  };

  if (!isLoading && !isAdmin) return <Navigate to="/admin/dashboard" replace />;
  const statusText: Record<LiveViewerStatus, string> = {
    connecting: 'Đang chờ học viên kết nối…', 'connected-direct': 'Đang xem P2P trực tiếp',
    'connected-relay': 'Đang xem qua TURN relay', failed: 'Không kết nối được', ended: 'Đã dừng',
  };
  return <div className="min-h-screen bg-slate-50 p-4 md:p-8"><div className="max-w-6xl mx-auto">
    <AdminNav />
    <div className="flex items-center justify-between gap-4 mb-6"><div><Link to={`/admin/batches/${id}/students`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-blue-700"><ArrowLeft size={15}/> Học viên</Link><h1 className="mt-2 text-2xl font-bold text-slate-900">Live Monitor</h1><p className="text-sm text-slate-500">WebRTC P2P; TURN chỉ dùng khi không thể kết nối trực tiếp.</p></div><button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><RefreshCw size={15}/> Làm mới</button></div>
    {error && <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]"><section className="rounded-xl border bg-white p-4"><h2 className="font-semibold">Đang thi ({students.length})</h2>{loading ? <p className="mt-4 text-sm text-slate-500">Đang tải…</p> : students.length === 0 ? <p className="mt-4 text-sm text-slate-500">Chưa có học viên đang thi.</p> : <div className="mt-3 space-y-2">{students.map((student) => <div key={student.id} className="rounded-lg border p-3"><p className="truncate text-sm font-medium">{student.email}</p><p className="mt-1 text-xs text-slate-500">{student.exam_started_at ? new Date(student.exam_started_at).toLocaleString() : 'Đang khởi tạo'}</p><button disabled={!!selected} onClick={() => void view(student)} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"><MonitorPlay size={15}/> Xem live</button></div>)}</div>}</section>
    <section className="rounded-xl border bg-slate-950 p-3 text-white"><div className="mb-3 flex items-center justify-between"><span className="inline-flex items-center gap-2 text-sm"><Wifi size={15}/>{status ? statusText[status] : 'Chưa chọn học viên'}</span>{selected && <button onClick={() => void stop()} className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm"><Square size={14}/> Dừng xem</button>}</div><div className="aspect-video overflow-hidden rounded-lg bg-black"><video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" /></div><p className="mt-3 text-xs text-slate-400">Mỗi admin chỉ xem một luồng tại một thời điểm. Hoạt động mở/dừng phiên được ghi audit.</p></section></div>
  </div></div>;
}
export default LiveMonitor;
