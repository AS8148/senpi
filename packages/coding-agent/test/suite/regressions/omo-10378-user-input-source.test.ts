import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// omo#10378: an extension that rebuilds per-session trust state on resume must tell a typed user
// message from one an extension injected. The live `input` event carries that source; the persisted
// user entry must carry the same value, or a resumed session cannot replay it.

function persistedUserSources(harness: Harness): { text: string; inputSource: unknown }[] {
	return harness.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		return [{ text: getMessageText(entry.message), inputSource: Reflect.get(entry.message, "inputSource") }];
	});
}

describe("omo#10378 persisted user input source", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given a typed prompt with no source #when it runs #then the entry records interactive", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("typed by a person");

		expect(persistedUserSources(harness)).toEqual([{ text: "typed by a person", inputSource: "interactive" }]);
	});

	it("#given an rpc prompt #when it runs #then the entry records rpc", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("sent by a client", { source: "rpc" });

		expect(persistedUserSources(harness)).toEqual([{ text: "sent by a client", inputSource: "rpc" }]);
	});

	it("#given an extension sendUserMessage while idle #when it runs #then the entry records extension", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		const settled = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_end") {
					unsubscribe();
					resolve();
				}
			});
		});
		api?.sendUserMessage("injected by an extension");
		await settled;
		await harness.session.waitForSettledSessionWork();

		expect(persistedUserSources(harness)).toEqual([{ text: "injected by an extension", inputSource: "extension" }]);
	});

	it("#given queued steer and follow-up input #when the run drains them #then each entry keeps its own source", async () => {
		let api: ExtensionAPI | undefined;
		let releaseTool: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after steer"),
			fauxAssistantMessage("after typed follow-up"),
			fauxAssistantMessage("after injected follow-up"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.steer("typed steer");
		await harness.session.followUp("typed follow-up");
		const injectedQueued = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "queue_update" && event.followUp.includes("injected follow-up")) {
					unsubscribe();
					resolve();
				}
			});
		});
		api?.sendUserMessage("injected follow-up", { deliverAs: "followUp" });
		await injectedQueued;
		releaseTool?.();
		await run;
		await harness.session.waitForSettledSessionWork();
		await harness.session.agent.waitForIdle();

		expect(persistedUserSources(harness)).toEqual([
			{ text: "start", inputSource: "interactive" },
			{ text: "typed steer", inputSource: "interactive" },
			{ text: "typed follow-up", inputSource: "interactive" },
			{ text: "injected follow-up", inputSource: "extension" },
		]);
	});
});
