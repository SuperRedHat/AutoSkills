// report.md of a run, for the owner (Chinese). Built from the run record (driver.mjs record()) and the ledger as it
// stands at the end.
import { isBlocked, BLOCKED_MARKS, CLOSED } from '../ledger-read.mjs';

const STATUS_WORDS = {
  todo: '未开始', in_progress: '进行中', auto_verified: '已自动验证', awaiting_manual_acceptance: '待验收', done: '完成',
  cancelled: '已取消', superseded: '已被取代',
};
const END_WORDS = {
  all_done: '全部做完', owner: '只剩负责人的事', stop_file: '停止文件', interrupt: 'Ctrl+C（做完当前任务后停）',
  until: '到了 --until', max_tasks: '到了 --max-tasks', blocked: '剩下的都受阻', no_progress: '没进展（刹车）',
  error: '出错', interrupt_now: '第二次 Ctrl+C（立即停）',
};

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const short = (sha) => (sha ? sha.slice(0, 7) : '');
const num = (n) => Number(n || 0).toLocaleString('en-US');
export function duration(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
const mentions = (text, id) => new RegExp(`(^|[^A-Za-z0-9_.-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`).test(text || '');

/** The first line of a task's notes that carries the blocked mark, else ''. */
export function blockedLine(task) {
  const line = (task.notes || '').split(/\r?\n/).find((l) => BLOCKED_MARKS.some((m) => l.includes(m)));
  return line ? line.trim() : '';
}

export function verifyWords(v, reject) {
  if (!v) return '没复验';
  let s;
  if (v.passed === true) s = '通过';
  else if (v.passed === null) s = `没复验：${v.reason || '没有验证命令'}`;
  else if (!v.clean) s = `没过：工作目录不干净（${(v.dirty || []).length} 个文件没提交）`;
  else {
    const bad = v.commands.find((c) => c.exit_code !== 0);
    s = bad ? `没过：\`${bad.command}\` ${bad.timed_out ? '超时' : `退出码 ${bad.exit_code}`}，日志 ${bad.log}` : '没过';
  }
  return reject ? `${s}；**复验没过，建议驳回**` : s;
}

export function renderReport(rec, tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ids = [];
  const add = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  for (const s of rec.sessions) {
    add(s.task);
    for (const c of s.changes || []) add(c.task);
  }
  for (const id of Object.keys(rec.verifies || {})) add(id);

  const L = [];
  L.push(`# 长跑报告 ${rec.run}`, '');
  L.push(`- 项目：${rec.project}`);
  L.push(`- 开始：${rec.started_at}；结束：${rec.ended_at || '（没写到结束）'}`);
  L.push(`- 结束原因：${END_WORDS[rec.end_reason] || rec.end_reason}${rec.end_detail ? `（${rec.end_detail}）` : ''}；退出码 ${rec.exit_code}`);
  const o = rec.options || {};
  L.push(`- 命令行：${o.cli}${o.cli_version ? `（${o.cli_version}）` : ''}；权限模式 ${o.permission_mode}；模型 ${o.model || '不指定'}；档位 ${o.effort || '不指定'}；每个会话 ${o.tasks_per_session} 个任务`);
  const brakes = [o.until ? `--until ${o.until}` : null, o.max_tasks ? `--max-tasks ${o.max_tasks}` : null].filter(Boolean);
  if (brakes.length) L.push(`- 选的刹车：${brakes.join('；')}`);
  for (const n of rec.notes || []) L.push(`- ${n}`);
  L.push('');

  L.push('## 每个任务', '');
  if (!ids.length) L.push('这次没有做任务。', '');
  else {
    L.push('| 任务 | 结果 | 提交 | 复验 | token | 用时 |', '|---|---|---|---|---|---|');
    for (const id of ids) {
      const t = byId.get(id);
      const mine = rec.sessions.filter((s) => s.task === id);
      const commits = [];
      // A session's commits count for the task it was started for, and any commit counts for a task its subject names.
      for (const s of rec.sessions) {
        for (const c of s.commits || []) if ((s.task === id || mentions(c.subject, id)) && !commits.includes(c.sha)) commits.push(c.sha);
      }
      let result = t ? STATUS_WORDS[t.status] || t.status : '账本里没有';
      if (t && isBlocked(t)) result += '，受阻';
      const v = rec.verifies?.[id];
      const reject = rec.reject_suggested?.[id] !== undefined;
      L.push(`| ${cell(id)} ${cell(t?.title ? `${t.title}` : '')} | ${cell(result)} | ${cell(commits.map(short).join(' ') || '—')} | ${cell(verifyWords(v, reject))} | ${num(mine.reduce((a, s) => a + (s.tokens?.total || 0), 0))} | ${duration(mine.reduce((a, s) => a + (s.ms || 0), 0))} |`);
    }
    L.push('');
  }

  const total = rec.sessions.reduce((a, s) => a + (s.ms || 0), 0);
  const done = (rec.finished || []).length;
  L.push('## 合计', '');
  L.push(`- 会话 ${rec.sessions.length} 个，做完（完成或待验收）${done} 个任务`);
  L.push(`- token ${num(rec.tokens_total)}${done ? `，平均每个任务 ${num(Math.round(rec.tokens_total / done))}` : ''}`);
  L.push(`- 会话用时 ${duration(total)}`);
  const open = tasks.filter((t) => !CLOSED.includes(t.status) && t.status !== 'awaiting_manual_acceptance');
  if (done && open.length) L.push(`- 还有 ${open.length} 个没做完，按平均估计还要 ${num(Math.round(rec.tokens_total / done) * open.length)} token（估计）`);
  L.push('');

  const awaiting = tasks.filter((t) => t.status === 'awaiting_manual_acceptance');
  L.push('## 等你验收的', '');
  if (!awaiting.length) L.push('没有。', '');
  else {
    for (const t of awaiting) L.push(`- ${t.id} ${t.title || ''}：复验${verifyWords(rec.verifies?.[t.id], rec.reject_suggested?.[t.id] !== undefined)}`);
    L.push('', '验收用你本人的话在会话里说（project-feedback）；驱动不替你验收。', '');
  }

  const skipped = new Set(rec.skipped || []);
  const blocked = tasks.filter((t) => !CLOSED.includes(t.status) && (isBlocked(t) || skipped.has(t.id)));
  const skippedDone = [...skipped].filter((id) => !blocked.some((t) => t.id === id));
  L.push('## 受阻的', '');
  if (!blocked.length && !skippedDone.length) L.push('没有。', '');
  else {
    for (const t of blocked) L.push(`- ${t.id} ${t.title || ''}：${blockedLine(t) || '驱动跳过（复验两轮没过）'}`);
    for (const id of skippedDone) {
      const t = byId.get(id);
      L.push(`- ${id}${t ? ` ${t.title || ''}` : ''}（${t ? STATUS_WORDS[t.status] || t.status : '账本里没有'}）：驱动跳过；${t ? blockedLine(t) || '复验两轮没过' : ''}`);
    }
    L.push('');
  }

  if ((rec.rework || []).length) {
    L.push('## 返工', '');
    const closedWords = { passed: '复验通过', blocked: '两轮没过，标受阻并跳过', awaiting: '返工任务到了待验收', no_rework_task: '会话没建返工任务，放弃' };
    for (const r of rec.rework) {
      L.push(`- ${r.origin}：第 ${r.round} 轮；返工任务 ${(r.tasks || []).join('、') || '没建'}；${r.closed ? closedWords[r.closed] || r.closed : '还没收尾'}；最近一次没过：${r.failure}`);
    }
    L.push('');
  }

  L.push('## 额度等待', '');
  if (!(rec.waits || []).length) L.push('没有等过。', '');
  else {
    L.push(`等了 ${rec.waits.length} 次，合计 ${rec.waits.reduce((a, w) => a + w.minutes, 0)} 分钟：`);
    for (const w of rec.waits) L.push(`- ${w.at} 起等 ${w.minutes} 分钟（${w.task}）`);
    L.push('');
  }

  L.push('## 会话', '');
  if (!rec.sessions.length) L.push('没有起会话。', '');
  else {
    L.push('| # | 任务 | 怎么结束 | token | 用时 | 新提交 | 日志 |', '|---|---|---|---|---|---|---|');
    for (const s of rec.sessions) {
      const how = s.error_kind ? `${s.error_kind}（退出码 ${s.exit_code}）` : `正常（退出码 ${s.exit_code}）`;
      L.push(`| ${s.n} | ${cell(s.kind === 'task' ? s.task : `${s.task}（${s.kind}）`)} | ${cell(how)} | ${num(s.tokens?.total)} | ${duration(s.ms)} | ${(s.commits || []).map((c) => short(c.sha)).join(' ') || '—'} | ${cell(s.stdout)} |`);
    }
    L.push('');
  }

  L.push('## 验收包', '');
  if (!rec.accept) L.push('没出。', '');
  else if (rec.accept.exit_code === 0) L.push(`出了（日志 ${rec.accept.log}）。`, '');
  else L.push(`没出成：accept 命令退出码 ${rec.accept.exit_code}，日志 ${rec.accept.log}。不影响这次运行的退出码。`, '');
  return `${L.join('\n')}\n`;
}
