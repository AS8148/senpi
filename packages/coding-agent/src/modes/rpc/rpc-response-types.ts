import type { RpcAttachmentResponse } from "./attachment-types.ts";

import type { RpcHostResponse } from "./rpc-host-response-types.ts";
import type { RpcMutationResponse } from "./rpc-mutation-response-types.ts";
import type { RpcReadResponse } from "./rpc-read-response-types.ts";
export type RpcResponse = RpcAttachmentResponse | RpcHostResponse | RpcReadResponse | RpcMutationResponse;
