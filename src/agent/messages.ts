/**
 * Message model of a session transcript.
 *
 * Contract: `specs/20-agent-loop.md` §B6–B11. This module is pure data and pure
 * functions: no I/O, no clock (timestamps are supplied by the caller), no
 * provider knowledge beyond what the spec states.
 *
 * Two rules are load-bearing downstream:
 *  - a tool call's id is derived from the assistant message id and the block
 *    slot, so replaying the same stream re-derives the same ids (§B9);
 *  - visibility decides what a provider sees, and `user_only` must never leave
 *    the machine (§B10).
 */
import { createHash } from "node:crypto";

export type Role = "user" | "assistant" | "tool" | "system";

/** Absent means `both` (§B10). */
export type Visibility = "both" | "llm_only" | "user_only";

export interface TextBlock {
  readonly type: "text";
  readonly text: string;
  readonly id?: string;
}

export interface ImageBlock {
  readonly type: "image";
  readonly source: {
    readonly type: "base64";
    readonly mediaType: ImageMediaType;
    readonly data: string;
  };
  readonly generated?: boolean;
  readonly id?: string;
}

export interface ThinkingBlock {
  readonly type: "thinking";
  readonly thinking: string;
  readonly signature: string;
  readonly signatureProvider?: string;
  readonly durationMs?: number;
  readonly progressUpdate?: string;
  readonly id?: string;
}

export interface RedactedThinkingBlock {
  readonly type: "redacted_thinking";
  readonly data: string;
  readonly id?: string;
}

export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export type ToolResultContent =
  string | ReadonlyArray<TextBlock | ImageBlock | DocumentBlock>;

export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content?: ToolResultContent;
  readonly isError?: boolean;
  /** What the model reads when it differs from what a transcript shows. */
  readonly modelContent?: string;
  readonly respondedBy?: string;
  readonly id?: string;
}

export interface DocumentBlock {
  readonly type: "document";
  readonly source:
    | {
        readonly type: "base64";
        readonly mediaType: "application/pdf";
        readonly data: string;
        readonly parsedData?: unknown;
      }
    | {
        readonly type: "text";
        readonly mediaType: "text/plain";
        readonly data: string;
      };
  readonly id?: string;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | DocumentBlock;

export interface Message {
  readonly id: string;
  readonly role: Role;
  readonly content: readonly ContentBlock[];
  /** Unix ms. */
  readonly createdAt: number;
  /** Unix ms. */
  readonly updatedAt: number;
  readonly parentId?: string;
  readonly seq?: number;
  readonly visibility?: Visibility;
  readonly userMessageSource?: string;
  readonly sender?: string;
  readonly author?: string;
  readonly interactionMode?: string;
}

export type ImageMediaType =
  "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** How much media may survive into one provider request (§B11). */
export interface MediaCaps {
  readonly images: number;
  readonly documents: number;
}

export const DEFAULT_MEDIA_CAPS: MediaCaps = { images: 10, documents: 5 };

/**
 * Decoded-byte ceiling for one image a caller attaches to a turn (§B11).
 *
 * The ceiling is an input guard: the surface that admits an image refuses one
 * above it before the turn starts, so an oversized payload never reaches a
 * provider. 5 MiB keeps a single image well inside ACP's 8 MiB frame.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * `call_<8-byte blake2b of the assistant message id, hex>_<slot>` (§B9).
 *
 * The spec states the digest width but not the parameterisation; a 64-byte
 * BLAKE2b truncated to eight bytes is used and the ambiguity is recorded in the
 * spec's open questions, so a future golden that disagrees changes one constant.
 */
export function toolCallId(messageId: string, slot: number): string {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new RangeError(
      `tool call slot must be a non-negative integer, got ${slot}`,
    );
  }
  const digest = createHash("blake2b512").update(messageId, "utf8").digest();
  return `call_${digest.subarray(0, 8).toString("hex")}_${slot}`;
}

/** Whether a provider may receive this message (§B10). */
export function isSendableToProvider(message: Message): boolean {
  return message.visibility !== "user_only";
}

/** Whether the user transcript shows this message (§B10). */
export function isVisibleToUser(message: Message): boolean {
  return message.visibility !== "llm_only";
}

function blocksOf(message: Message): readonly ContentBlock[] {
  const collected: ContentBlock[] = [...message.content];
  for (const block of message.content) {
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      for (const nested of block.content) collected.push(nested);
    }
  }
  return collected;
}

/** Media carried by one message, in document order. */
function mediaOf(message: Message): ReadonlyArray<ImageBlock | DocumentBlock> {
  return blocksOf(message).filter(
    (block): block is ImageBlock | DocumentBlock =>
      block.type === "image" || block.type === "document",
  );
}

export interface MediaLimitResult {
  /** Messages with older media removed; the input is unchanged. */
  readonly messages: readonly Message[];
  readonly droppedImages: number;
  readonly droppedDocuments: number;
}

/**
 * Keep at most `caps` images and `caps` documents, counting backwards from the
 * newest message (§B11). Older media is removed from the request; the caller
 * adds the media-limit reminder to the prompt.
 */
export function limitMedia(
  messages: readonly Message[],
  caps: MediaCaps = DEFAULT_MEDIA_CAPS,
): MediaLimitResult {
  if (caps.images < 0 || caps.documents < 0) {
    throw new RangeError("media caps must be non-negative");
  }

  const keepImage = new Set<ImageBlock>();
  const keepDocument = new Set<DocumentBlock>();
  let images = 0;
  let documents = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const media = mediaOf(messages[index] as Message);
    for (let position = media.length - 1; position >= 0; position -= 1) {
      const block = media[position] as ImageBlock | DocumentBlock;
      if (block.type === "image") {
        if (images < caps.images) {
          images += 1;
          keepImage.add(block);
        }
      } else if (documents < caps.documents) {
        documents += 1;
        keepDocument.add(block);
      }
    }
  }

  const droppedImages = new Set<ImageBlock>();
  const droppedDocuments = new Set<DocumentBlock>();

  const isDropped = (block: ContentBlock): boolean => {
    if (block.type === "image" && !keepImage.has(block)) {
      droppedImages.add(block);
      return true;
    }
    if (block.type === "document" && !keepDocument.has(block)) {
      droppedDocuments.add(block);
      return true;
    }
    return false;
  };

  const limited = messages.map((message) => {
    let changed = false;
    const content = message.content.flatMap((block): ContentBlock[] => {
      if (isDropped(block)) {
        changed = true;
        return [];
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        const nested = block.content.filter((inner) => !isDropped(inner));
        if (nested.length !== block.content.length) {
          changed = true;
          return [{ ...block, content: nested }];
        }
      }
      return [block];
    });
    return changed ? { ...message, content } : message;
  });

  return {
    messages: limited,
    droppedImages: droppedImages.size,
    droppedDocuments: droppedDocuments.size,
  };
}
