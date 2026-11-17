/**
 * Every computer task kind (tasks.ts), loaded by the server's boot and by a computer's worker so both know the same kinds.
 * One import per module in api/work/tasks/; only this file and tasks.ts import them (prevention.test.ts).
 */
import "./tasks/design-pages";
import "./tasks/export";
import "./tasks/frames";
import "./tasks/review";
import "./tasks/social-prints";
