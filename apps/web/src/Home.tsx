import { useState } from 'react';
import type { Agent, Conversation, Task } from '@sbot/shared';
import type { HumanInfo } from './api';
import { setMemberDrag, type MemberPayload } from './drag';

interface Props {
  agents: Agent[];
  humans: HumanInfo[];
  conversations: Conversation[];
  tasks: Task[];
  userName: string | null;
  onOpenConv: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onGoAgents: () => void;
  onNewGroup: () => void;
  onNewAgent: () => void;
  onInvite: () => void;
  onToast: (msg: string) => void;
  onNewTask: () => void;
  onEditTask: (task: Task) => void;
  onToggleTask: (task: Task) => void;
  onDeleteTask: (id: string) => void;
  onDragMember?: (member: MemberPayload | null) => void;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function taskDate(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(ts);
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function Home({
  agents,
  humans,
  conversations,
  tasks,
  userName,
  onOpenConv,
  onOpenAgent,
  onGoAgents,
  onNewGroup,
  onNewAgent,
  onInvite,
  onToast,
  onNewTask,
  onEditTask,
  onToggleTask,
  onDeleteTask,
  onDragMember,
}: Props) {
  const [taskTab, setTaskTab] = useState<'todo' | 'done'>('todo');
  const now = new Date();
  const hh = now.getHours();
  const greet = hh < 6 ? '凌晨好' : hh < 12 ? '早上好' : hh < 14 ? '中午好' : hh < 18 ? '下午好' : '晚上好';
  const groups = conversations.filter((c) => c.type === 'group');
  const dms = conversations.filter((c) => c.type === 'dm');
  const recent = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
  const date = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

  const todoCount = tasks.filter((t) => t.status !== 'done').length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const shownTasks = tasks.filter((t) => (taskTab === 'done' ? t.status === 'done' : t.status !== 'done'));
  const convTitle = (id: string | null) => conversations.find((c) => c.id === id)?.title ?? null;

  return (
    <div className="page home">
      <div className="home-inner">
        <div className="greet">
          <div>
            <h1>{greet}，{userName ?? '朋友'}</h1>
            <p>{userName ? '和同事、智能体一起把事做完。' : '还没登录。现在可以先用 AI 干活，登录后能拉同事一起。'}</p>
          </div>
          <div className="day">{date}</div>
        </div>

        {!userName && (
          <div className="home-banner">
            <div>
              <div className="bt">登录后可以邀请同事一起协作</div>
              <div className="bd">发现同事 · 拉真人进群 · 多端同步</div>
            </div>
            <button className="btn primary" onClick={() => onToast('登录入口在左下角头像')}>登录</button>
          </div>
        )}

        <div className="quick-grid">
          <button className="quick" onClick={onNewGroup}>
            <div className="qi">💬</div>
            <div className="qt">新建群聊</div>
            <div className="qd">拉 2~6 个智能体，一起评审</div>
          </button>
          <button className="quick" onClick={onNewAgent}>
            <div className="qi">🤖</div>
            <div className="qt">新建智能体</div>
            <div className="qd">人设 + 模型 + 擅长</div>
          </button>
          <button className="quick" onClick={onInvite}>
            <div className="qi">👥</div>
            <div className="qt">{userName ? '找同事' : '邀请同事'}</div>
            <div className="qd">{userName ? '和真人单聊' : '登录后可用'}</div>
          </button>
        </div>

        <div className="home-sec">
          <h2>任务</h2>
          <div className="sec-right">
            <div className="task-tabs">
              <button className={`ttab ${taskTab === 'todo' ? 'on' : ''}`} onClick={() => setTaskTab('todo')}>
                进行中<i>{todoCount}</i>
              </button>
              <button className={`ttab ${taskTab === 'done' ? 'on' : ''}`} onClick={() => setTaskTab('done')}>
                已完成<i>{doneCount}</i>
              </button>
            </div>
            <span className="more" onClick={onNewTask}>+ 新建任务</span>
          </div>
        </div>
        <div className="task-list">
          {shownTasks.length === 0 ? (
            <div className="task-empty">
              {taskTab === 'todo'
                ? <>没有进行中的任务，<b onClick={onNewTask}>新建一个</b></>
                : '还没有已完成的任务'}
            </div>
          ) : (
            shownTasks.map((t) => {
              const groupName = convTitle(t.conversationId);
              return (
                <div key={t.id} className={`task ${t.status === 'done' ? 'done' : ''}`} onClick={() => onEditTask(t)}>
                  <div
                    className="cb"
                    onClick={(e) => { e.stopPropagation(); onToggleTask(t); }}
                    title={t.status === 'done' ? '标记为未完成' : '标记为完成'}
                  >
                    {t.status === 'done' ? '✓' : ''}
                  </div>
                  <div className="tt">{t.title}</div>
                  <div className="meta">
                    {groupName ? (
                      <span
                        className="grp"
                        onClick={(e) => { e.stopPropagation(); if (t.conversationId) onOpenConv(t.conversationId); }}
                      >
                        {groupName}
                      </span>
                    ) : (
                      <span className="grp none">未分配</span>
                    )}
                    <span className={`pri ${t.priority}`} title={t.priority === 'high' ? '高优先级' : t.priority === 'mid' ? '中优先级' : '低优先级'} />
                    <span className="date">{taskDate(t.createdAt)}</span>
                    <button
                      className="del"
                      title="删除"
                      onClick={(e) => { e.stopPropagation(); onDeleteTask(t.id); }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="home-sec">
          <h2>我的智能体</h2>
          <span className="more" onClick={onGoAgents}>管理</span>
        </div>
        <div className="agent-strip">
          {agents.map((a) => (
            <div
              key={a.id}
              className="acard"
              draggable
              onDragStart={(e) => {
                const payload: MemberPayload = { kind: 'agent', id: a.id, name: a.name };
                setMemberDrag(e, payload);
                onDragMember?.(payload);
              }}
              onDragEnd={() => onDragMember?.(null)}
              onClick={() => onOpenAgent(a.id)}
            >
              <div
                className="av"
                style={{ width: 30, height: 30, flexBasis: 30, fontSize: 11.5, background: `${a.color}22`, border: `2px solid ${a.color}`, color: a.color }}
              >
                {a.initial}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="nm" style={{ color: a.color }}>{a.name}</div>
                <div className="rl">{a.role}</div>
                {a.skills.length > 0 && <div className="sk">{a.skills.slice(0, 2).join(' · ')}</div>}
              </div>
            </div>
          ))}
        </div>

        {humans.length > 0 && (
          <>
            <div className="home-sec">
              <h2>同事</h2>
              <span className="more" onClick={onInvite}>邀请更多</span>
            </div>
            <div className="agent-strip">
              {humans.map((h) => (
                <div
                  key={h.id}
                  className="acard human"
                  draggable
                  title="拖到群聊详情页，直接拉进群"
                  onDragStart={(e) => {
                    const payload: MemberPayload = { kind: 'human', id: h.id, name: h.name };
                    setMemberDrag(e, payload);
                    onDragMember?.(payload);
                  }}
                  onDragEnd={() => onDragMember?.(null)}
                  onClick={onInvite}
                >
                  <div
                    className="av"
                    style={{ width: 30, height: 30, flexBasis: 30, fontSize: 11.5, background: `${h.color}22`, border: `2px solid ${h.color}`, color: h.color }}
                  >
                    {h.initial}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="nm" style={{ color: h.color }}>{h.name}</div>
                    <div className="rl">{h.role || '同事'}</div>
                    <div className="sk human-tag">真人</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="home-sec"><h2>最近会话</h2></div>
        <div className="recent">
          {recent.length === 0 && <div className="home-empty">还没有会话</div>}
          {recent.map((c) => (
            <div key={c.id} className="rrow" onClick={() => onOpenConv(c.id)}>
              <div className="stack">
                {c.members.slice(0, 2).map((m) => (
                  <div
                    key={m.memberId}
                    className="av"
                    style={{ width: 22, height: 22, flexBasis: 22, fontSize: 9.5, background: `${m.color}22`, border: `2px solid ${m.color}`, color: m.color }}
                  >
                    {m.initial}
                  </div>
                ))}
              </div>
              <div className="t">
                <div className="n">{c.title}</div>
                <div className="p">{c.lastMessage ? `${c.lastMessage.authorName}：${c.lastMessage.text}` : '还没有消息'}</div>
              </div>
              <div className="time">{c.lastMessage ? fmtTime(c.lastMessage.at) : ''}</div>
            </div>
          ))}
        </div>

        <div className="stats">
          <div className="stat"><div className="v">{agents.length}</div><div className="k">智能体</div></div>
          <div className="stat"><div className="v">{groups.length}</div><div className="k">群聊</div></div>
          <div className="stat"><div className="v">{dms.length}</div><div className="k">单聊</div></div>
          <div className="stat"><div className="v">{todoCount}</div><div className="k">进行中任务</div></div>
        </div>

        <div className="home-foot">
          <div className="f-brand">
            <div className="f-logo">S</div>
            <div>
              <div className="f-name">S-BOT</div>
              <div className="f-desc">让 AI 同事和真人一起，把事做完。本地优先 · 内网私有化部署。</div>
            </div>
          </div>
          <div className="f-meta">
            <div>版本 <b>v0.1.0</b></div>
            <div>发布于 <b>2026-10-27</b></div>
            <div>Electron 45 · Node 24 · node:sqlite</div>
          </div>
        </div>
      </div>
    </div>
  );
}
