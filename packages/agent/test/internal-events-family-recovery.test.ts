import { afterEach, describe, expect, it } from "vitest";
import { stream as streamDevin } from "../../ai/src/api/devin-agent.ts";
import { getAssistantCapture } from "../../ai/src/utils/assistant-capture.ts";
import { closeStubServers, frame, MODEL, serveEdge, trailer } from "../../ai/test/devin-agent-stream-harness.ts";
import { Agent } from "../src/agent.ts";
import { type OrderedAgentRecord, subscribeInternalAgent } from "../src/internal-events.ts";

afterEach(closeStubServers);

async function channel(modelId: string): Promise<OrderedAgentRecord[]> {
	const { baseUrl } = await serveEdge({
		chat: (_req, res) => {
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.write(frame({ messageId: "m1", deltaThinking: "plan", deltaSignature: "s1" }));
			res.write(frame({ messageId: "m1", deltaText: "done" }));
			res.write(trailer());
			res.end();
		},
	});
	const model = { ...MODEL, id: modelId, baseUrl };
	const agent = new Agent({
		initialState: { model },
		streamFn: (_model, context, options) => streamDevin(model, context, { ...options, apiKey: "session-abc" }),
	});
	const records: OrderedAgentRecord[] = [];
	const unsubscribe = subscribeInternalAgent(agent, (record) => {
		records.push(record);
	});
	await agent.prompt("fixture");
	unsubscribe();
	return records;
}

function carried(records: OrderedAgentRecord[]) {
	return {
		progress: records.flatMap((record) => ("progress" in record ? [record.progress] : [])),
		carriers: records.filter((record) => "event" in record && getAssistantCapture(record.event) !== undefined).length,
	};
}

// #4272 S02a-3 makes the recovery wrappers carrier-aware; until then a wrapped stream must carry nothing.
describe("recovery wrappers and a real S02a-2 family", () => {
	it("drops a Devin stream's controls and carriers behind the empty-assistant recovery wrapper", async () => {
		const unwrapped = carried(await channel("swe-1-6"));
		// The agent's own thinking-timing records ride beside the provider's; only the provider record is asserted.
		expect(unwrapped.progress).toContainEqual({
			type: "message_block_metadata",
			contentIndex: 0,
			thinkingSignature: "s1",
		});
		expect(unwrapped.carriers).toBeGreaterThan(0);
		expect(carried(await channel("claude-sonnet-4-5"))).toEqual({ progress: [], carriers: 0 });
	});
});
