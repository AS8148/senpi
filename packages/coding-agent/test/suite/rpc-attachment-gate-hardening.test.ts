import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ATTACH_GATE_EXEMPT } from "../../src/modes/rpc/session-attachment-gate.ts";
import { attachmentRig } from "./rpc-attachment-support.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";

const requireAttach = process.env.SENPI_RPC_REQUIRE_ATTACH;
afterEach(() => {
	if (requireAttach === undefined) delete process.env.SENPI_RPC_REQUIRE_ATTACH;
	else process.env.SENPI_RPC_REQUIRE_ATTACH = requireAttach;
	vi.restoreAllMocks();
});

const NOT_ATTACHED = { success: false, errorCode: "session_not_attached" };

// senpi#3814 review MEDIUM: the gate's exemptions are a reviewed list. Adding one must change this test.
it("exempts exactly the reviewed commands from the attach gate", () => {
	expect([...ATTACH_GATE_EXEMPT].sort()).toEqual(
		[
			"attach_session",
			"check_reload_veto",
			"detach_connection",
			"eval_cells.list",
			"eval_cells.peek",
			"get_auth_providers",
			"get_available_models",
			"get_available_thinking_levels",
			"get_commands",
			"get_effect_status",
			"get_entries",
			"get_fast_mode",
			"get_follow_up_messages",
			"get_fork_messages",
			"get_last_assistant_text",
			"get_loaded_surfaces",
			"get_media",
			"get_messages",
			"get_pending_inputs",
			"get_protocol_info",
			"get_provider_accounts",
			"get_session_stats",
			"get_state",
			"get_steering_messages",
			"get_subscription_limits",
			"get_tree",
			"list_sessions",
			"memory_report",
			"open_session",
			"reclaim_session",
			"record_user_activity",
			"resolve_path",
			"subscribe_sessions",
			"unsubscribe_sessions",
			"warm",
		].sort(),
	);
});

// Lead ruling 2026-10-22 (senpi#3814): record_user_activity stays ungated. The desktop prewarm path sends it
// (omo-desktop-app apps/server/src/provider/Layers/OmoAdapter.ts:7121); its only effect is one prompt-cache warm-up.
it("serves desktop prewarm draft activity (omo-desktop-app OmoAdapter.ts record_user_activity) without an attachment", async () => {
	process.env.SENPI_RPC_REQUIRE_ATTACH = "1";
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const activity = await rig.send("stranger", {
		id: "draft",
		type: "record_user_activity",
		sessionId: ref.sessionId,
		kind: "draft",
	});
	expect(activity).not.toMatchObject(NOT_ATTACHED);
	const mutations = [
		{ type: "prompt", message: "x" },
		{ type: "steer", message: "x" },
		{ type: "follow_up", message: "x" },
		{ type: "append_user_message", content: "x" },
		{ type: "abort" },
		{ type: "resume_session" },
		{ type: "set_model", provider: "p", modelId: "m" },
		{ type: "set_thinking_level", level: "low" },
		{ type: "compact" },
		{ type: "bash", command: "true" },
		{ type: "new_session" },
		{ type: "set_session_name", name: "x" },
		{ type: "unload_session" },
		{ type: "release_session", reason: "takeover" },
		{ type: "wake" },
		{ type: "extension_ui_response", confirmed: true },
		{ type: "export_jsonl" },
	];
	for (const [index, mutation] of mutations.entries()) {
		const command = { ...mutation, id: `m-${index}`, sessionId: ref.sessionId };
		expect(await rig.send("stranger", command as Parameters<typeof rig.send>[1]), mutation.type).toMatchObject(
			NOT_ATTACHED,
		);
	}
});

// senpi#3814 review LOW 2: a client-chosen sessionId cannot add lines to the host's log.
it("writes one grace line however the unattached sessionId is shaped", async () => {
	delete process.env.SENPI_RPC_REQUIRE_ATTACH;
	await using rig = await attachmentRig();
	await rig.session();
	const written: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	});
	const forged =
		"rpc-1 from a connection not attached to it (refused from the next release)\nsenpi rpc host: abort on rpc-1";
	await rig.send("stranger", { id: "forge", type: "append_user_message", sessionId: forged, content: "x" });
	const lines = written
		.join("")
		.split("\n")
		.filter((line) => line.length > 0);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("\\n");
});

// senpi#3814 review LOW 3: a stopping host is draining for every attachment command, release_attachment included.
it("never defers a release_attachment on a stopping host", async () => {
	await using rig = await attachmentRig();
	const shutdown = rig.router.dispose();
	const sessionPath = join(rig.dir, "late.jsonl");
	const late = opened(await rig.open("caller", { cwd: rig.dir, sessionPath }), 0);
	const turn = rig.turns.get(late.state.sessionFile);
	if (!turn) throw new Error("Missing live turn");
	turn.start();
	try {
		expect(
			await rig.send("caller", { id: "release", type: "release_attachment", sessionId: late.sessionId }),
		).toMatchObject({ success: true, data: { deferred: false } });
	} finally {
		turn.finish();
		await shutdown;
	}
});
