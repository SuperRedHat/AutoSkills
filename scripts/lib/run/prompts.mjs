// Every prompt the long-run driver gives a session, in one place. The text is Chinese, as the owner's sessions are.
// Each session is a fresh `claude -p` in the project root; the prompt names the task, so project-next does only it.

const UNATTENDED = '这是无人值守的运行，不要提问，要我定的事写进任务备注和汇报。';

/** Do one named task (todo or in progress). */
export function taskPrompt(taskId) {
  return `用 project-next 只做 ${taskId}；做完、验证、提交、记账就结束；${UNATTENDED}`;
}

/** --tasks-per-session N > 1: start with the named task, then take ready ones, up to n in all. */
export function multiPrompt(taskId, n) {
  return `用 project-next 从 ${taskId} 开始做，最多做 ${n} 个任务（${taskId} 算第一个，之后按账本的就绪顺序取）；`
    + `每个都做完、验证、提交、记账；做满 ${n} 个或没有就绪任务就结束；${UNATTENDED}`;
}

/**
 * The driver's verification of a done task failed: a new rework task, as project-plan has it for a task that is done
 * already, and only that task. round is 1 or 2; origin is the task the rework is for.
 */
export function reworkPrompt({ failedTask, origin, round, failure }) {
  const lineage = failedTask === origin ? `${failedTask}` : `${failedTask}（${origin} 的返工）`;
  const last = round >= 2 ? `这是第 ${round} 轮，也是最后一轮：要是你自己验证也过不了，在返工任务的备注里写“受阻：…”，写明卡在哪，然后结束。` : '';
  return `驱动在提交好的代码上复验 ${lineage}${lineage.endsWith('）') ? '' : ' '}没过：${failure}。`
    + `${failedTask} 已经是完成，不改它的状态。照 project-plan 的做法新建一个返工任务：依赖为空，优先级比账本里所有任务都高，`
    + `验证命令和 ${failedTask} 的一样，标题写明是 ${origin} 的返工（第 ${round} 轮），说明里写上面这条复验结果；`
    + `然后用 project-next 只做这个返工任务；做完、验证、提交、记账就结束。别的任务这次不做。${last}${UNATTENDED}`;
}

/** Two rework rounds and the driver's verification still fails: no more fixing, the rework task gets a 受阻 note. */
export function giveUpPrompt({ taskId, origin, failure }) {
  return `${taskId} 是 ${origin} 的返工，驱动复验两轮都没过：${failure}。不要再修，也不改任何任务的状态。`
    + `在 ${taskId} 的备注里加一行“受阻：驱动复验两轮没过（${origin} 的返工），${failure}”，原有备注保留；写完就结束。${UNATTENDED}`;
}
