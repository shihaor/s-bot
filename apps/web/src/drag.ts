export type MemberPayload = {
  kind: 'agent' | 'human';
  id: string;
  name: string;
};

export const MEMBER_MIME = 'application/x-sbot-member';

export function setMemberDrag(
  e: { dataTransfer: DataTransfer },
  payload: MemberPayload,
): void {
  e.dataTransfer.setData(MEMBER_MIME, JSON.stringify(payload));
  // 兼容只读 text/plain 的旧代码路径
  e.dataTransfer.setData('text/plain', payload.id);
  e.dataTransfer.effectAllowed = 'copy';
}

export function hasMemberDrag(e: { dataTransfer: DataTransfer }): boolean {
  try {
    return Array.from(e.dataTransfer.types || []).includes(MEMBER_MIME);
  } catch {
    return false;
  }
}

export function readMemberDrag(e: { dataTransfer: DataTransfer }): MemberPayload | null {
  try {
    const raw = e.dataTransfer.getData(MEMBER_MIME);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MemberPayload>;
      if ((parsed.kind === 'agent' || parsed.kind === 'human') && typeof parsed.id === 'string') {
        return { kind: parsed.kind, id: parsed.id, name: String(parsed.name ?? '') };
      }
    }
  } catch {
    /* ignore */
  }
  const id = e.dataTransfer.getData('text/plain');
  return id ? { kind: 'agent', id, name: '' } : null;
}
