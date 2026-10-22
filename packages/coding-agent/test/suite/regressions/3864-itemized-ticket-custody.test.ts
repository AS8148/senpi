import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SendMessageItem } from "../../../src/core/extensions/types.ts";
import { type ResumeFixture, resumeFixture, settle } from "./issue-3811-resume-support.ts";

const WAKE = "omo-senpi:wake";
const items: readonly SendMessageItem[] = [
	{ itemId: "a", producer: "task", content: "Task A finished" },
	{ itemId: "b", producer: "task", content: "Task B finished" },
];

async function textFixture(): Promise<ResumeFixture> {
	const fixture = await resumeFixture();
	fixture.h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	return fixture;
}

function sendWithTicket(fixture: ResumeFixture, ticket: string) {
	return fixture
		.api()
		.sendMessage(
			{ customType: WAKE, content: "Task A finished\n\nTask B finished", display: false },
			{ triggerTurn: true, deliverAs: "followUp", items, ticket },
		);
}

function openTicket(fixture: ResumeFixture, key: string): string {
	return fixture.api().lifecycle.obligations.open(key, "children").ticket();
}

function ticketOpen(fixture: ResumeFixture, ticket: string): boolean {
	return fixture.h.session.workObligations.active.some((record) => record.ticketId === ticket);
}

// senpi#3864 x senpi#3811: an itemized send carrying a delivery ticket settles that ticket exactly once.
describe("itemized sendMessage with a delivery ticket", () => {
	const fixtures: ResumeFixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) {
			await fixture.h.session.abort();
			fixture.h.cleanup();
		}
	});

	it("hands the ticket to the held notices, so the session is done once the resume delivers them", async () => {
		// Given a stopped session and a producer ticket for the batch
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.stop();
		const ticket = openTicket(fixture, "result:batch");

		// When the batch is sent with that ticket while the Stop holds it
		const receipts = await sendWithTicket(fixture, ticket);

		// Then every item is a held notice and the ticket is no longer open work
		expect(receipts?.map((receipt) => receipt.disposition)).toEqual(["notice_persisted", "notice_persisted"]);
		expect(ticketOpen(fixture, ticket)).toBe(false);

		// When the person resumes and the notices are delivered
		await fixture.h.session.resumeSession();
		await settle(fixture);

		// Then nothing is owed any more
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(fixture.h.session.workObligations.activeCount).toBe(0);
		expect(fixture.h.session.lifecycle.state).toBe("done");
	});

	it("keeps the ticket on a batch a newer Stop dropped during admission, and settles it once", async () => {
		// Given a batch whose admission is overtaken by a Stop while its header is written
		const fixture = await textFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:batch");
		const manager = fixture.h.sessionManager;
		const persist = manager.persistHeaderNow.bind(manager);
		let stopped = false;
		manager.persistHeaderNow = async () => {
			if (!stopped) {
				stopped = true;
				await fixture.h.session.stop();
			}
			return persist();
		};

		// When the batch is sent with that ticket
		const receipts = await sendWithTicket(fixture, ticket);

		// Then the dropped batch is decided again under the Stop: held, not rejected, and its ticket is not left open
		expect(stopped).toBe(true);
		expect(receipts?.map((receipt) => receipt.disposition)).toEqual(["notice_persisted", "notice_persisted"]);
		expect(ticketOpen(fixture, ticket)).toBe(false);

		// When the person resumes
		await fixture.h.session.resumeSession();
		await settle(fixture);

		// Then the session is done with nothing owed
		expect(fixture.h.session.workObligations.activeCount).toBe(0);
		expect(fixture.h.session.lifecycle.state).toBe("done");
	});
});
