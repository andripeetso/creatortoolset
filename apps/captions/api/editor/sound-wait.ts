/** How long a measuring task may wait for a computer with the file before it is dropped (sound.ts answers then). Its own
 *  module with no imports: the task (work/tasks/loudness.ts) and the editor's route (sound.ts) both read it without
 *  either importing the other (only work/task-kinds.ts imports a task module; prevention.test T1). */
export const LOUD_WAIT_MS = 10 * 60_000;
