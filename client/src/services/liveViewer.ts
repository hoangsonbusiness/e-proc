import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { closeLiveChannel, openLiveChannel, sendLiveSignal, type LiveSessionConfig, type LiveSignal } from './liveSignaling';

export type LiveViewerStatus = 'connecting' | 'connected-direct' | 'connected-relay' | 'failed' | 'ended';

export interface LiveViewer {
  stop(): Promise<void>;
}

export async function startLiveViewer(
  config: LiveSessionConfig & { viewerSessionId: string },
  callbacks: { onStream(stream: MediaStream): void; onStatus(status: LiveViewerStatus): void },
): Promise<LiveViewer> {
  let client: SupabaseClient | null = null;
  let channel: RealtimeChannel | null = null;
  let pc: RTCPeerConnection | null = null;
  let stopped = false;
  const pendingCandidates: RTCIceCandidateInit[] = [];
  const close = async (notify: boolean, status: LiveViewerStatus) => {
    if (stopped) return;
    stopped = true;
    if (notify && channel) sendLiveSignal(channel, 'hangup', { sender: 'admin', viewerSessionId: config.viewerSessionId, target: config.viewerSessionId });
    pc?.close();
    await closeLiveChannel(client, channel);
    callbacks.onStatus(status);
  };
  const classifyTransport = async () => {
    if (!pc) return;
    const stats = await pc.getStats();
    let localCandidate: any;
    stats.forEach((item: any) => {
      if (item.type === 'candidate-pair' && item.selected) localCandidate = stats.get(item.localCandidateId);
    });
    callbacks.onStatus(localCandidate?.candidateType === 'relay' ? 'connected-relay' : 'connected-direct');
  };
  const handleSignal = async (event: string, signal: LiveSignal) => {
    if (stopped || signal.sender !== 'student' || signal.target !== config.viewerSessionId) return;
    if (event === 'hangup') { await close(false, 'ended'); return; }
    if (event === 'ice-candidate' && signal.payload) {
      const candidate = signal.payload as RTCIceCandidateInit;
      if (!pc?.remoteDescription) pendingCandidates.push(candidate);
      else await pc.addIceCandidate(candidate).catch(() => {});
      return;
    }
    if (event !== 'offer' || !signal.payload || pc) return;
    pc = new RTCPeerConnection({ iceServers: config.iceServers });
    pc.ontrack = ({ streams }) => { if (streams[0]) callbacks.onStream(streams[0]); };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && channel) sendLiveSignal(channel, 'ice-candidate', {
        sender: 'admin', viewerSessionId: config.viewerSessionId, target: config.viewerSessionId, payload: candidate.toJSON(),
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'connected') void classifyTransport();
      if (pc?.connectionState === 'failed') void close(true, 'failed');
    };
    try {
      await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
      for (const candidate of pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (channel) sendLiveSignal(channel, 'answer', {
        sender: 'admin', viewerSessionId: config.viewerSessionId, target: config.viewerSessionId, payload: answer,
      });
    } catch { await close(true, 'failed'); }
  };
  const opened = await openLiveChannel(config, (event, signal) => { void handleSignal(event, signal); });
  client = opened.client; channel = opened.channel;
  callbacks.onStatus('connecting');
  sendLiveSignal(channel, 'watch-request', { sender: 'admin', viewerSessionId: config.viewerSessionId });
  const timeout = window.setTimeout(() => { if (!pc) void close(true, 'failed'); }, 20_000);
  return { async stop() { window.clearTimeout(timeout); await close(true, 'ended'); } };
}
