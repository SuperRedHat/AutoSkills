// The HTML of the acceptance sheet. One file, no scripts, no external resources; every task text is escaped.
export const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CSS = `
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#d6d3d1;--ok:#166534;--bad:#b91c1c;--warn:#92400e;--gate:#1d4ed8}
@media(prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--gate:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}
main{max-width:860px;margin:0 auto}
h1{font-size:1.5rem;margin:.2em 0}h2{font-size:1.25rem;margin:1.6em 0 .5em;border-bottom:1px solid var(--line);padding-bottom:.2em}
h3{font-size:1.05rem;margin:0 0 .4em}h4{font-size:.95rem;margin:1em 0 .2em;color:var(--muted)}
.meta{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0}
.warn{border-left:4px solid var(--warn);padding:8px 12px;background:var(--card);margin:12px 0}
.gate{color:var(--gate);font-weight:600}.ok{color:var(--ok)}.bad{color:var(--bad);font-weight:600}
.reply{border-left:4px solid var(--gate);padding:8px 12px;background:var(--card);margin:12px 0}
pre{white-space:pre-wrap;margin:0;font:inherit}ul,ol{margin:.2em 0;padding-left:1.4em}
.scroll{overflow-x:auto}table{border-collapse:collapse}td,th{border:1px solid var(--line);padding:4px 8px;text-align:left}
code{font-family:ui-monospace,Consolas,monospace;font-size:.9em}
`;

const list = (items, tag = 'ul') => (items.length
  ? `<${tag}>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</${tag}>`
  : '<p class="meta">（无）</p>');

function verifyBlock(v) {
  if (!v) return '<p class="meta">驱动复验：没有复验记录。</p>';
  const when = esc(v.at ?? '');
  const commit = v.commit ? `，提交 ${esc(String(v.commit).slice(0, 12))}` : '';
  if (v.passed) return `<p class="ok">驱动复验：通过（${when}${commit}）。</p>`;
  const failed = (Array.isArray(v.commands) ? v.commands : []).filter((c) => c && c.exit_code !== 0);
  const rows = failed.map((c) => `<tr><td><code>${esc(c.command)}</code></td><td>${esc(c.exit_code)}</td><td>${esc(c.log ?? '')}</td></tr>`).join('');
  const table = failed.length
    ? `<div class="scroll"><table><tr><th>没过的命令</th><th>退出码</th><th>日志位置</th></tr>${rows}</table></div>`
    : '';
  return `<p class="bad">驱动复验：没过，建议驳回（${when}${commit}）。</p>${table}`;
}

function taskBlock({ task, unblocks, verify }) {
  const gate = task.stage_gate ? ' <span class="gate">[门禁任务]</span>' : '';
  const opens = unblocks.length
    ? `<ul>${unblocks.map((u) => `<li>${esc(u.id)} ${esc(u.title)}</li>`).join('')}</ul>`
    : '<p class="meta">（不放开别的任务）</p>';
  return `<section class="card">
<h3>${esc(task.id)} ${esc(task.title)}${gate}</h3>
${verifyBlock(verify)}
<h4>验收标准</h4>${list(task.acceptance_criteria ?? [], 'ol')}
<h4>检查清单</h4>${list(task.review_checklist ?? [], 'ol')}
<h4>备注原文</h4>${task.notes ? `<pre>${esc(task.notes)}</pre>` : '<p class="meta">（无）</p>'}
<h4>通过后能放开的任务</h4>${opens}
</section>`;
}

export function renderSheet({ project, generatedAt, groups, count, running }) {
  const all = groups.flatMap((g) => g.tasks.map((t) => t.task.id));
  const [a, b] = [all[0] ?? 'T1', all[1] ?? all[0] ?? 'T2'];
  const body = count === 0
    ? '<p>没有等你验收的任务。</p>'
    : groups.map((g) => `<h2>${esc(g.module)}</h2>\n${g.tasks.map(taskBlock).join('\n')}`).join('\n');
  const reply = count === 0 ? '' : `<div class="reply"><strong>看完直接回一句，要点名任务：</strong>
<ul><li>${esc(a)}、${esc(b)} 通过</li><li>${esc(a)} 驳回：&lt;原因&gt;</li></ul>
<span class="meta">不点名的“都通过”验收技能不认。</span></div>`;
  const warn = running
    ? '<div class="warn">有长跑正在跑：先停下长跑（<code>autoskills stop</code>）再验收，两边同时写账本会丢更新。</div>'
    : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>验收包 ${esc(project)}</title><style>${CSS}</style></head>
<body><main>
<h1>验收包：${esc(project)}</h1>
<p class="meta">生成时间 ${esc(generatedAt)}　·　等你验收：${count} 个</p>
${warn}
${reply}
${body}
</main></body></html>
`;
}
