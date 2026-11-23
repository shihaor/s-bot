import { networkInterfaces } from 'node:os';
import { getSettings, getOrCreateInstanceId, listAgents, listTasks, getAgent, getConversation, listModels } from './repo.js';
import { getLanIdentity } from './lan.js';
import { readLocalSkills } from './opencode.js';

/**
 * 把本机 S-BOT 的信息上报给「技术组件中心」（business-item-manager 的 /item/sbot/report）：
 * 终端信息 + 已共享的智能体 + 已共享的技能 + 本机任务。
 * 只上报 shared=true 的智能体和技能，服务端也只展示这些。
 */

let timer: NodeJS.Timeout | null = null;
let lastError = '';
let lastReportAt = 0;

function localIPv4(): string {
  const all: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) all.push(ni.address);
    }
  }
  // 优先真实内网地址，跳过 Docker/WSL 的 172.16–172.31 虚拟网段
  const preferred = all.find((ip) => /^10\./.test(ip) || /^192\.168\./.test(ip));
  if (preferred) return preferred;
  const normal = all.find((ip) => !/^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  return normal ?? all[0] ?? '127.0.0.1';
}

function appVersion(): string {
  return process.env.SBOT_APP_VERSION || process.env.npm_package_version || '0.0.0';
}

/** 允许用户只填 http://host:8085，自动补 /item；也允许直接填到 /item/sbot */
function normalizeCenterBase(raw: string): string {
  let base = (raw ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  base = base.replace(/\/sbot(\/report)?$/i, '');
  const path = base.replace(/^https?:\/\/[^/]+/i, '');
  if (!path || path === '/') base += '/item';
  return base;
}

export interface ReportResult {
  ok: boolean;
  error?: string;
  at?: number;
}

export async function reportToCenter(): Promise<ReportResult> {
  const settings = getSettings();
  const base = normalizeCenterBase(settings.sbotCenterUrl ?? '');
  if (!base) {
    return { ok: false, error: '未配置技术组件中心地址' };
  }

  const sharedSkills = new Set(settings.sbotSharedSkills ?? []);
  const models = listModels();
  const identity = getLanIdentity();

  const agents = listAgents()
    .filter((a) => a.shared === true)
    .map((a) => {
      const model = models.find((m) => m.id === a.modelId);
      return {
        id: a.id,
        name: a.name,
        role: a.role,
        description: a.description,
        model: model?.name ?? model?.model ?? '',
        tools: Object.entries(a.tools ?? {})
          .filter(([, on]) => on)
          .map(([key]) => key),
        skills: a.skills ?? [],
        tags: a.tags ?? [],
      };
    });

  const skills = readLocalSkills()
    .filter((s) => sharedSkills.has(s.id))
    .map((s) => ({ id: s.id, name: s.name, description: s.description, content: s.content }));

  const tasks = listTasks().map((t) => {
    const assignee = t.assigneeId ? getAgent(t.assigneeId)?.name ?? '' : '';
    const conv = t.conversationId ? getConversation(t.conversationId)?.title ?? '' : '';
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee,
      conversation: conv,
      createdAt: t.createdAt,
    };
  });

  const payload = {
    instanceId: getOrCreateInstanceId(),
    name: identity.name || 'S-BOT 用户',
    ip: localIPv4(),
    port: Number(process.env.PORT ?? 8787),
    version: appVersion(),
    os: `${process.platform} ${process.arch}`,
    agents,
    skills,
    tasks,
  };

  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/sbot/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      lastError = `上报失败 ${res.status}`;
      return { ok: false, error: lastError };
    }
    lastError = '';
    lastReportAt = Date.now();
    return { ok: true, at: lastReportAt };
  } catch (e) {
    lastError = String((e as Error).message ?? e).slice(0, 200);
    return { ok: false, error: lastError };
  }
}

export function startReporter(): void {
  if (timer) return;
  // 启动后先报一次，之后每 60 秒一次
  void reportToCenter();
  timer = setInterval(() => {
    void reportToCenter().catch(() => { /* ignore */ });
  }, 60_000);
  timer.unref?.();
}

export function reporterStatus(): { configured: boolean; lastReportAt: number; lastError: string } {
  const settings = getSettings();
  return {
    configured: !!(settings.sbotCenterUrl ?? '').trim(),
    lastReportAt,
    lastError,
  };
}
