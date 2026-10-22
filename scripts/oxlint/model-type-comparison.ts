// oxlint port of the model-type-comparison GritQL plugin (kept in scripts/oxlint/parity for the parity
// check): chat models may omit `type`, so comparing `<expr>.type` with "chat" misses them. It reports
// exactly the six shapes the Grit pattern lists, which scripts/oxlint-biome-parity.test.mjs checks.
type AstNode = { readonly type: string; readonly start?: number; readonly end?: number; readonly [key: string]: unknown };
type RuleContext = {
	readonly sourceCode?: { readonly text?: string };
	report(descriptor: { node: AstNode; message: string }): void;
};

const MESSAGE =
	"Chat models may omit type. Use isModelType(model, 'chat') or getModelType(model) instead of comparing type to 'chat'.";
const TYPE_FIRST = new Set(["===", "!==", "==", "!="]);
const CHAT_FIRST = new Set(["===", "!=="]);

const isNode = (value: unknown): value is AstNode =>
	typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";

const isChat = (node: unknown): boolean => isNode(node) && node.type === "Literal" && node["value"] === "chat";

const isTypeMember = (node: unknown): boolean => {
	if (!isNode(node) || node.type !== "MemberExpression" || node["computed"] !== false || node["optional"] === true)
		return false;
	const property = node["property"];
	return isNode(property) && property.type === "Identifier" && property["name"] === "type";
};

// oxlint's AST drops parentheses; Grit matches the written syntax, so a parenthesized operand is no match.
const parenthesized = (context: RuleContext, node: AstNode, left: AstNode, right: AstNode): boolean => {
	const text = context.sourceCode?.text;
	if (text === undefined) return false;
	return /\(/.test(text.slice(node.start ?? 0, left.start ?? 0)) || /\(/.test(text.slice(left.end ?? 0, right.start ?? 0));
};

// oxlint-disable-next-line import/no-default-export -- the oxlint plugin loader reads the default export.
export default {
	meta: { name: "senpi" },
	rules: {
		"model-type-comparison": {
			create: (context: RuleContext) => ({
				BinaryExpression: (node: AstNode) => {
					const operator = String(node["operator"]);
					const left = node["left"];
					const right = node["right"];
					if (!isNode(left) || !isNode(right) || parenthesized(context, node, left, right)) return;
					const typeFirst = TYPE_FIRST.has(operator) && isTypeMember(left) && isChat(right);
					const chatFirst = CHAT_FIRST.has(operator) && isChat(left) && isTypeMember(right);
					if (typeFirst || chatFirst) context.report({ node, message: MESSAGE });
				},
			}),
		},
	},
};
