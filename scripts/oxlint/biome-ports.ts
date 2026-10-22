// Biome recommended rules that oxlint 1.89.0 has no rule for, ported so replacing Biome loses no check:
// suspicious/noImplicitAnyLet and correctness/noStringCaseMismatch.
type AstNode = { readonly type: string; readonly [key: string]: unknown };
type RuleContext = {
	readonly filename?: string;
	report(descriptor: { node: AstNode; message: string }): void;
};

const isNode = (value: unknown): value is AstNode =>
	typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";
const child = (node: AstNode, key: string): AstNode | undefined => {
	const value = node[key];
	return isNode(value) ? value : undefined;
};
const nodes = (value: unknown): readonly AstNode[] => (Array.isArray(value) ? value.filter(isNode) : []);

const caseOf = (node: AstNode | undefined): "upper" | "lower" | undefined => {
	const callee = node?.type === "CallExpression" ? child(node, "callee") : undefined;
	const property = callee?.type === "MemberExpression" ? child(callee, "property") : undefined;
	const name = property?.type === "Identifier" ? property["name"] : undefined;
	return name === "toUpperCase" ? "upper" : name === "toLowerCase" ? "lower" : undefined;
};

const mismatches = (text: unknown, expected: "upper" | "lower"): boolean =>
	typeof text === "string" && text !== (expected === "upper" ? text.toUpperCase() : text.toLowerCase());

// oxlint-disable-next-line import/no-default-export -- the oxlint plugin loader reads the default export.
export default {
	meta: { name: "biome-port" },
	rules: {
		"no-implicit-any-let": {
			create: (context: RuleContext) => ({
				VariableDeclaration: (node: AstNode) => {
					// JavaScript has no type annotations, so Biome checks TypeScript files only.
					if (!/\.[cm]?tsx?$/.test(context.filename ?? "")) return;
					if (node["kind"] !== "let" || node["declare"] === true) return;
					for (const declarator of nodes(node["declarations"])) {
						const id = child(declarator, "id");
						if (
							child(declarator, "init") === undefined &&
							id?.type === "Identifier" &&
							child(id, "typeAnnotation") === undefined
						)
							context.report({
								node: declarator,
								message:
									"This let has no type and no initial value, so it is implicitly any: give it a type (Biome noImplicitAnyLet).",
							});
					}
				},
			}),
		},
		"no-string-case-mismatch": {
			create: (context: RuleContext) => ({
				BinaryExpression: (node: AstNode) => {
					if (!["===", "!==", "==", "!="].includes(String(node["operator"]))) return;
					const left = child(node, "left");
					const right = child(node, "right");
					for (const [call, other] of [
						[left, right],
						[right, left],
					] as const) {
						const expected = caseOf(call);
						if (expected !== undefined && other?.type === "Literal" && mismatches(other["value"], expected))
							context.report({
								node,
								message: `This compares a ${expected}-cased string with a literal that is not ${expected}case, so it never matches (Biome noStringCaseMismatch).`,
							});
					}
				},
			}),
		},
	},
};
