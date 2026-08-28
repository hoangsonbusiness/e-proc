import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';

export interface LiveIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface LiveSessionConfig {
  enabled: boolean;
  topic?: string;
  realtimeToken?: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  iceServers?: LiveIceServer[];
  turnAvailable?: boolean;
  expiresAt?: string;
}

export type LiveSignalEvent = 'watch-request' | 'offer' | 'answer' | 'ice-candidate' | 'hangup';

export interface LiveSignal {
  sender: 'student' | 'admin';
  viewerSessionId: string;
  target?: string;
  payload?: RTCSessionDescriptionInit | RTCIceCandidateInit | Record<string, never>;
}

export async function openLiveChannel(
  config: LiveSessionConfig,
  onSignal: (event: LiveSignalEvent, signal: LiveSignal) => void,
): Promise<{ client: SupabaseClient; channel: RealtimeChannel }> {
  if (!config.enabled || !config.topic || !config.realtimeToken || !config.supabaseUrl || !config.supabasePublishableKey) {
    throw new Error('Live monitoring is not configured');
  }
  const client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => config.realtimeToken!,
  });
  const channel = client.channel(config.topic, { config: { private: true } });
  for (const event of ['watch-request', 'offer', 'answer', 'ice-candidate', 'hangup'] as LiveSignalEvent[]) {
    channel.on('broadcast', { event }, ({ payload }) => {
      if (!isLiveSignal(payload)) return;
      onSignal(event, payload);
    });
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Signaling connection timed out')), 12_000);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') { window.clearTimeout(timeout); resolve(); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        window.clearTimeout(timeout); reject(new Error(`Signaling channel ${status.toLowerCase()}`));
      }
    });
  });
  return { client, channel };
}

export function sendLiveSignal(channel: RealtimeChannel, event: LiveSignalEvent, signal: LiveSignal): void {
  void channel.send({ type: 'broadcast', event, payload: signal });
}

export async function closeLiveChannel(client: SupabaseClient | null, channel: RealtimeChannel | null): Promise<void> {
  if (client && channel) await client.removeChannel(channel);
}

function isLiveSignal(value: unknown): value is LiveSignal {
  if (!value || typeof value !== 'object') return false;
  const signal = value as Partial<LiveSignal>;
  return (signal.sender === 'student' || signal.sender === 'admin')
    && typeof signal.viewerSessionId === 'string' && /^[0-9a-f-]{36}$/i.test(signal.viewerSessionId)
    && (signal.target === undefined || typeof signal.target === 'string');
}
