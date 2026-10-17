/**
 * Test-only injection switches for the tool child (senpi#3566, plan todo 4). Each is `SENPI_TOOL_CHILD_TEST_<NAME>=1`
 * (or `=<value>`); none exists in production because nothing sets them. Holds are released by control files the test
 * creates in `SENPI_TOOL_CHILD_TEST_CONTROL_DIR`, observed with `fs.watch`, never polled.
 */
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const PREFIX = "SENPI_TOOL_CHILD_TEST_";
export const TEST_CONTROL_DIR_ENV = `${PREFIX}CONTROL_DIR`;

export type TestSwitch =
	| "HOLD_LAUNCH_ACK"
	| "HOLD_HEARTBEAT"
	| "HOLD_LAUNCH_PROOF"
	| "STOP_AFTER_SPAWN"
	| "DROP_CONTROL_BEFORE_ACK"
	| "SKIP_ACK_WAIT";

export interface TestControls {
	readonly enabled: (name: TestSwitch) => boolean;
	readonly value: (name: TestSwitch) => string | undefined;
	readonly released: (file: string) => Promise<void>;
}

export function readTestControls(env: NodeJS.ProcessEnv): TestControls {
	const dir = env[TEST_CONTROL_DIR_ENV];
	const value = (name: TestSwitch): string | undefined => {
		const raw = env[`${PREFIX}${name}`];
		return raw === undefined || raw === "" || raw === "0" ? undefined : raw;
	};
	return {
		enabled: (name) => value(name) !== undefined,
		value,
		released: (file) => {
			if (dir === undefined) return Promise.reject(new Error(`${TEST_CONTROL_DIR_ENV} is not set`));
			return waitForFile(dir, file);
		},
	};
}

function waitForFile(dir: string, file: string): Promise<void> {
	const path = join(dir, file);
	// macOS drops events while a watch is still starting. The one watcher proves itself live by observing its own
	// sentinel (re-sent until seen); after that, the existence re-check covers every later creation.
	const sentinel = join(dir, `.watch-${process.pid}-${randomUUID()}`);
	return new Promise((resolve) => {
		let done = false;
		let resend: ReturnType<typeof setTimeout> | undefined;
		const finish = (): void => {
			if (done) return;
			done = true;
			clearTimeout(resend);
			watcher.close();
			rmSync(sentinel, { force: true });
			resolve();
		};
		const watcher = watch(dir, (_event, name) => {
			if (existsSync(path)) {
				finish();
				return;
			}
			if (name !== null && join(dir, name) === sentinel) clearTimeout(resend);
		});
		const touch = (): void => {
			if (done) return;
			writeFileSync(sentinel, String(Date.now()));
			if (existsSync(path)) finish();
			else resend = setTimeout(touch, 50);
		};
		touch();
	});
}
