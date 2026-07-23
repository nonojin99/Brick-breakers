// net.js — Supabase 연동: 익명 인증, 리더보드, Realtime 랭킹전
// config.js가 비어 있으면 모든 함수가 안전하게 no-op/null 반환 (솔로 모드는 항상 동작)
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

let sb = null;

export function isOnline() { return sb !== null; }

export async function initNet() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
  const { createClient } = await import(
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
  );
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  // 익명 로그인 (Supabase 대시보드에서 Anonymous sign-in 활성화 필요)
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    const { error } = await sb.auth.signInAnonymously();
    if (error) { console.error('익명 로그인 실패:', error.message); sb = null; return false; }
  }
  return true;
}

async function uid() {
  const { data } = await sb.auth.getUser();
  return data.user.id;
}

// ── 리더보드 ──────────────────────────────────────────────
export async function saveScore(nickname, round, balls) {
  if (!sb) return;
  const user_id = await uid();
  await sb.from('scores').insert({ user_id, nickname, round, balls });
}

export async function topScores(limit = 10) {
  if (!sb) return [];
  const { data, error } = await sb
    .from('scores')
    .select('nickname, round, balls, created_at')
    .order('round', { ascending: false })
    .limit(limit);
  return error ? [] : data;
}

// ── 랭킹전 매치메이킹 + Realtime ──────────────────────────
// 흐름: waiting 매치 검색 → 있으면 참가(p2), 없으면 생성(p1) 후 대기.
// 이후 통신은 전부 Broadcast 채널 (match-{id}). 같은 seed로 양쪽 로컬 시뮬레이션.
export async function findMatch(handlers) {
  if (!sb) return null;
  const myId = await uid();

  // 1) 대기 중인 매치 참가 시도 (내가 만든 방 제외)
  const { data: waiting } = await sb
    .from('matches')
    .select('id, seed, p1')
    .eq('status', 'waiting')
    .neq('p1', myId)
    .order('created_at', { ascending: true })
    .limit(1);

  let match, isHost;
  if (waiting && waiting.length > 0) {
    // 참가: status 조건부 업데이트로 동시 참가 경합 방지
    const { data: upd } = await sb
      .from('matches')
      .update({ status: 'playing', p2: myId })
      .eq('id', waiting[0].id)
      .eq('status', 'waiting')
      .select();
    if (upd && upd.length > 0) { match = upd[0]; isHost = false; }
  }
  if (!match) {
    // 2) 방 생성 후 대기
    const seed = Math.floor(Math.random() * 2 ** 31); // 시드 자체는 방마다 달라도 됨
    const { data: ins, error } = await sb
      .from('matches')
      .insert({ p1: myId, seed, status: 'waiting' })
      .select();
    if (error) { console.error(error.message); return null; }
    match = ins[0];
    isHost = true;
  }

  const ch = sb.channel('match-' + match.id, {
    config: {
      broadcast: { self: false },
      presence: { key: myId },   // Presence: 유저별 접속 상태 추적
    },
  });
  ch.on('broadcast', { event: 'joined' }, () => handlers.onOpponentJoined?.());
  ch.on('broadcast', { event: 'state' },  ({ payload }) => handlers.onOpponentState?.(payload));
  ch.on('broadcast', { event: 'dead' },   ({ payload }) => handlers.onOpponentDead?.(payload));
  // Presence leave: 상대가 창을 닫거나 연결이 끊기면 발생 (수 초 내 감지)
  ch.on('presence', { event: 'leave' }, ({ key }) => {
    if (key !== myId) handlers.onOpponentLeft?.();
  });

  await new Promise((res) =>
    ch.subscribe(async (s) => {
      if (s === 'SUBSCRIBED') {
        await ch.track({ joined_at: Date.now() }); // 내 접속 상태 등록
        res();
      }
    })
  );
  if (!isHost) ch.send({ type: 'broadcast', event: 'joined', payload: {} });

  return {
    seed: match.seed,
    matchId: match.id,
    isHost,
    send(event, payload) { ch.send({ type: 'broadcast', event, payload }); },
    async finish(winnerId) {
      await sb.from('matches').update({ status: 'done', winner: winnerId }).eq('id', match.id);
    },
    async leave() {
      // 대기 중 취소면 방 정리
      await sb.from('matches').delete().eq('id', match.id).eq('status', 'waiting');
      sb.removeChannel(ch);
    },
    myId,
  };
}
