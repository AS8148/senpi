import { type BuiltinProvider, getBuiltinImageModels, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * Ids the built-in catalog ships today, for fixtures that need a real catalog model (a `modelOverrides` entry only
 * decorates an existing one). Never write a catalog id as a literal in a test: a catalog regen can drop it and the
 * test then fails on a missing model instead of on what it asserts (senpi#1955). Sorted, so the pick is stable.
 */
export function builtinChatModelIds(
	provider: BuiltinProvider,
	count: number,
	accept: (id: string) => boolean = () => true,
): string[] {
	return pick(provider, "chat", getBuiltinModels(provider).map((model) => model.id), count, accept);
}

/** One catalog id. */
export function builtinChatModelId(provider: BuiltinProvider, accept: (id: string) => boolean = () => true): string {
	const [id] = builtinChatModelIds(provider, 1, accept);
	if (id === undefined) throw new Error(`no ${provider} catalog id to pick`);
	return id;
}

/** Two distinct catalog ids, e.g. an override target and an untouched sibling. */
export function builtinChatModelIdPair(
	provider: BuiltinProvider,
	accept: (id: string) => boolean = () => true,
): readonly [string, string] {
	const [first, second] = builtinChatModelIds(provider, 2, accept);
	if (first === undefined || second === undefined) throw new Error(`no two ${provider} catalog ids to pick`);
	return [first, second];
}

/** One id the provider ships as both a chat model and an image model. */
export function builtinChatAndImageModelId(provider: BuiltinProvider): string {
	const [id] = builtinChatAndImageModelIds(provider, 1);
	if (id === undefined) throw new Error(`no ${provider} id is both a chat and an image model`);
	return id;
}

/** Ids the provider ships as both a chat model and an image model (one id, two model types). */
export function builtinChatAndImageModelIds(provider: BuiltinProvider, count: number): string[] {
	const chatIds = new Set(getBuiltinModels(provider).map((model) => model.id));
	const imageIds = getBuiltinImageModels(provider).map((model) => model.id);
	return pick(provider, "chat+image", imageIds, count, (id) => chatIds.has(id));
}

function pick(
	provider: BuiltinProvider,
	kind: string,
	ids: readonly string[],
	count: number,
	accept: (id: string) => boolean,
): string[] {
	const picked = ids.filter(accept).sort();
	if (picked.length < count) {
		throw new Error(
			`the built-in ${provider} catalog has ${picked.length} ${kind} model(s) matching this fixture's filter, it needs ${count}`,
		);
	}
	return picked.slice(0, count);
}
