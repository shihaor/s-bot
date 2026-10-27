import type { ChatIntro, Member } from '@sbot/shared';

interface Props {
  intro: ChatIntro | null;
  members: Member[];
  loading: boolean;
  onAsk: (text: string) => void;
  onStartTask: () => void;
}

function Ava({ member, size = 34 }: { member: Member; size?: number }) {
  return (
    <span
      className="intro-av"
      style={{
        width: size,
        height: size,
        flexBasis: size,
        fontSize: size * 0.38,
        background: `${member.color}22`,
        border: `2px solid ${member.color}`,
        color: member.color,
      }}
    >
      {member.initial}
    </span>
  );
}

export default function Intro({ intro, members, loading, onAsk, onStartTask }: Props) {
  const isGroup = intro?.kind === 'group' || (!intro && members.length > 1);
  const shown = members.slice(0, 4);

  return (
    <div className="intro">
      <div className="intro-inner">
        <div className="intro-avas">
          {isGroup ? joinedAvatars(shown) : shown[0] && <Ava member={shown[0]} size={40} />}
        </div>

        <h3 className="intro-title">{intro?.title ?? members[0]?.role ?? '新会话'}</h3>

        <p className={`intro-greet ${intro ? '' : 'dim'}`}>
          {intro ? intro.greeting : '正在准备开场…'}
        </p>

        {loading || !intro ? (
          <div className="intro-loading">
            <span className="dots"><i /><i /><i /></span>
            正在想几个适合开口的问题…
          </div>
        ) : (
          <div className="intro-chips">
            {intro.kind === 'group' && (
              <button className="sugg primary" onClick={onStartTask}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                点击开始为团队加入任务
              </button>
            )}
            {intro.suggestions.map((q) => (
              <button key={q} className="sugg" onClick={() => onAsk(q)}>{q}</button>
            ))}
          </div>
        )}

        <div className="intro-hint">
          {isGroup ? '它们会像同事一样，一个接一个地说。' : 'Enter 发送 · @ 可以点名'}
        </div>
      </div>
    </div>
  );
}

function joinedAvatars(members: Member[]) {
  if (members.length === 0) return null;
  return (
    <span className="intro-stack">
      {members.map((m) => <Ava key={m.memberId} member={m} size={36} />)}
    </span>
  );
}
