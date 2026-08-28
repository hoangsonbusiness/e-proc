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
      // Axios errors carry the server response; signaling errors are plain
      // Errors. Keep the latter visible so deployment issues are diagnosable
      // without exposing JWTs, ICE credentials, or other secrets.
      const message = err.response?.data?.error || err.message || 'Không thể mở phiên xem live.';
      console.error('[live-monitor] could not start viewer', {
        message,
        status: err.response?.status,
      });
      setError(message);
      setStatus('failed');
    }
  };

  if (!isLoading && !isAdmin) return <Navigate to="/admin/dashboard" replace />;
  const statusText: Record<LiveViewerStatus, string> = {
    connecting: 'Đang chờ học viên kết nối…', 'connected-direct': 'Đang xem P2P trực tiếp',
    'connected-relay': 'Đang xem qua TURN relay', failed: 'Không kết nối được', ended: 'Đã dừng',
  };
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="container space-y-6">
        <div className="flex flex-col items-start justify-between gap-4 border-b border-slate-200 pb-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-emerald-100 p-2 text-emerald-600">
              <MonitorPlay size={24} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Live Monitor</h1>
              <p className="text-sm text-slate-500">Theo dõi màn hình học viên đang thi theo thời gian thực.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
            >
              <RefreshCw size={15} />
              Làm mới
            </button>
            <Link
              to={`/admin/batches/${id}/students`}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
            >
              <ArrowLeft size={16} />
              <span className="hidden sm:inline">Học viên</span>
            </Link>
          </div>
        </div>

        <AdminNav />

        {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-900">Đang thi ({students.length})</h2>
            {loading ? <p className="mt-4 text-sm text-slate-500">Đang tải…</p> : students.length === 0 ? <p className="mt-4 text-sm text-slate-500">Chưa có học viên đang thi.</p> : (
              <div className="mt-4 space-y-3">
                {students.map((student) => (
                  <div key={student.id} className="rounded-lg border border-slate-200 p-3">
                    <p className="truncate text-sm font-medium text-slate-900">{student.email}</p>
                    <p className="mt-1 text-xs text-slate-500">{student.exam_started_at ? new Date(student.exam_started_at).toLocaleString() : 'Đang khởi tạo'}</p>
                    <button disabled={!!selected} onClick={() => void view(student)} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                      <MonitorPlay size={15} />
                      Xem live
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-950 p-4 text-white shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 text-sm"><Wifi size={15} />{status ? statusText[status] : 'Chưa chọn học viên'}</span>
              {selected && <button onClick={() => void stop()} className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-red-700"><Square size={14} />Dừng xem</button>}
            </div>
            <div className="aspect-video overflow-hidden rounded-lg bg-black"><video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" /></div>
            <p className="mt-3 text-xs text-slate-400">Mỗi admin chỉ xem một luồng tại một thời điểm. Hoạt động mở/dừng phiên được ghi audit.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
export default LiveMonitor;
