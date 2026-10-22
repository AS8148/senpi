// oxlint port of scripts/biome/model-type-comparison.grit: chat models may omit `type`, so comparing
// `<expr>.type` with "chat" misses them. Both operand orders and all four equality operators are
// checked (the GritQL rule listed the literal-first form only for === and !==).
type AstNode = { readonly type: string; readonly [key: string]: unknown };
type RuleContext = { report(descriptor: { node: AstNode; message: string }): void };

const MESSAGE =
	"Chat models may omit type. Use isModelType(model, 'chat') or getModelType(model) instead of comparing type to 'chat'.";
const EQUALITY = new Set(["===", "!==", "==", "!="]);

const isNode = (value: unknown): value is AstNode =>
	typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";

const isChat = (node: unknown): boolean => isNode(node) && node.type === "Literal" && node["value"] === "chat";

const isTypeMember = (node: unknown): boolean => {
	if (!isNode(node) || node.type !== "MemberExpression" || node["computed"] !== false) return false;
	const property = node["property"];
	return isNode(property) && property.type === "Identifier" && property["name"] === "type";
};

// oxlint-disable-next-line import/no-default-export -- the oxlint plugin loader reads the default export.
export default {
	meta: { name: "senpi" },
	rules: {
		"model-type-comparison": {
			create: (context: RuleContext) => ({
				BinaryExpression: (node: AstNode) => {
					if (typeof node["operator"] !== "string" || !EQUALITY.has(node["operator"])) return;
					const { left, right } = { left: node["left"], right: node["right"] };
					if ((isTypeMember(left) && isChat(right)) || (isChat(left) && isTypeMember(right)))
						context.report({ node, message: MESSAGE });
				},
			}),
		},
	},
};
